import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { WebSocket } from "ws";
import { ZodError } from "zod";

import type {
  VoiceSessionEvent,
  VoiceSessionManager,
} from "../../application/voiceSessionManager.js";
import { createVoiceReceptionistInstructions } from "../../application/voiceReceptionist.js";
import {
  parseClientVoiceMessage,
  type ClientVoiceMessage,
} from "../../domain/voiceEvents.js";
import { serializeError } from "../../shared/errors.js";

export interface VoiceWebsocketOptions {
  maxJsonMessageBytes: number;
  maxAudioFrameBytes: number;
  idleTimeoutMs: number;
  maxSessionDurationMs: number;
  heartbeatIntervalMs: number;
  maxPendingMessages: number;
  maxBufferedBytes: number;
}

interface ServerError {
  type: "error";
  code: string;
  message: string;
  recoverable: boolean;
  requestId?: string;
}

export function registerVoiceWebsocketRoute(
  app: FastifyInstance,
  sessionManager: VoiceSessionManager,
  defaultInstructions: string,
  options: VoiceWebsocketOptions,
): void {
  app.get("/v1/voice", { websocket: true }, (socket) => {
    let sessionId: string | undefined;
    let sessionEnded = false;
    let closing = false;
    let processing = Promise.resolve();
    let cleanupPromise: Promise<void> | undefined;
    let pendingMessages = 0;
    let isAlive = true;
    let idleTimer: NodeJS.Timeout;

    const clearConnectionTimers = (): void => {
      clearTimeout(idleTimer);
      clearTimeout(durationTimer);
      clearInterval(heartbeatTimer);
    };

    const cleanupSession = async (): Promise<void> => {
      if (cleanupPromise !== undefined) {
        return cleanupPromise;
      }

      cleanupPromise = (async () => {
        if (sessionId === undefined || sessionEnded) {
          return;
        }
        sessionEnded = true;
        try {
          await sessionManager.closeSession(sessionId);
        } catch (error) {
          app.log.error(
            { err: error, sessionId },
            "Failed to clean up voice session",
          );
        }
      })();
      return cleanupPromise;
    };

    const requestClose = (
      code: number,
      reason: string,
    ): void => {
      if (closing) {
        return;
      }
      closing = true;
      clearConnectionTimers();
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(code, reason);
      }
      processing = processing.then(cleanupSession, cleanupSession);
    };

    const hasOutboundCapacity = (bytes: number): boolean => {
      if (socket.bufferedAmount + bytes <= options.maxBufferedBytes) {
        return true;
      }

      app.log.warn(
        {
          sessionId,
          bufferedBytes: socket.bufferedAmount,
          attemptedBytes: bytes,
        },
        "Closing voice WebSocket because outbound backpressure limit was reached",
      );
      requestClose(1013, "Backpressure limit reached");
      return false;
    };

    const sendJson = (message: object): void => {
      if (socket.readyState !== WebSocket.OPEN || closing) {
        return;
      }
      const serialized = JSON.stringify(message);
      if (hasOutboundCapacity(Buffer.byteLength(serialized))) {
        socket.send(serialized);
      }
    };

    const sendError = (
      code: string,
      message: string,
      recoverable: boolean,
      requestId?: string,
    ): void => {
      const error: ServerError = {
        type: "error",
        code,
        message,
        recoverable,
        ...(requestId === undefined ? {} : { requestId }),
      };
      sendJson(error);
    };

    const resetIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        sendError(
          "idle_timeout",
          "Voice session closed after being idle",
          false,
        );
        app.log.info({ sessionId }, "Voice session idle timeout reached");
        requestClose(1000, "Idle timeout");
      }, options.idleTimeoutMs);
      idleTimer.unref();
    };

    const forwardProviderEvent = (event: VoiceSessionEvent): void => {
      switch (event.type) {
        case "transcript.user.final":
        case "transcript.agent.delta":
        case "transcript.agent.final":
        case "output_audio.completed":
        case "response.started":
        case "response.completed":
        case "response.interrupted":
          sendJson(event);
          break;
        case "output_audio.delta":
          if (
            socket.readyState === WebSocket.OPEN &&
            !closing &&
            hasOutboundCapacity(event.audio.byteLength)
          ) {
            socket.send(event.audio, { binary: true });
          }
          break;
        case "error":
          sendError(
            event.code,
            event.message,
            event.recoverable,
          );
          if (!event.recoverable) {
            app.log.warn(
              { sessionId, providerErrorCode: event.code },
              "Realtime provider connection became unavailable",
            );
            requestClose(1011, "Realtime provider disconnected");
          }
          break;
        case "session.ready":
        case "input_audio.started":
        case "input_audio.stopped":
        case "session.started":
        case "session.ended":
          break;
      }
    };

    const requireSessionId = (): string => {
      if (sessionId === undefined) {
        throw new ProtocolStateError(
          "session_not_started",
          "Send session.start before sending input",
        );
      }
      if (sessionEnded) {
        throw new ProtocolStateError(
          "session_ended",
          "The voice session has already ended",
        );
      }
      return sessionId;
    };

    const handleJsonMessage = async (
      message: ClientVoiceMessage,
    ): Promise<void> => {
      if (message.type === "session.start") {
        if (sessionId !== undefined) {
          throw new ProtocolStateError(
            "session_already_started",
            "This connection already has a voice session",
          );
        }

        const session = await sessionManager.createSession(
          forwardProviderEvent,
          createVoiceReceptionistInstructions(
            combineInstructions(
              defaultInstructions,
              message.instructions,
            ),
          ),
          { backendContext: {} },
        );
        sessionId = session.id;
        sendJson({
          type: "session.created",
          requestId: message.requestId,
          sessionId: session.id,
        });
        return;
      }

      const activeSessionId = requireSessionId();
      switch (message.type) {
        case "input.text":
          await sessionManager.sendText(
            activeSessionId,
            message.text,
          );
          break;
        case "input_audio.commit":
          await sessionManager.commitAudio(activeSessionId);
          break;
        case "response.interrupt":
          await sessionManager.interrupt(activeSessionId);
          break;
        case "session.end":
          await sessionManager.closeSession(activeSessionId);
          sessionEnded = true;
          break;
      }
    };

    const handleFrame = async (
      data: RawData,
      isBinary: boolean,
    ): Promise<void> => {
      if (isBinary) {
        await sessionManager.sendAudio(
          requireSessionId(),
          rawDataToBuffer(data),
        );
        return;
      }

      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        throw new InvalidMessageError("Message must be valid JSON");
      }

      let message: ClientVoiceMessage;
      try {
        message = parseClientVoiceMessage(value);
      } catch (error) {
        if (error instanceof ZodError) {
          throw new InvalidMessageError(
            error.issues[0]?.message ?? "Invalid message",
          );
        }
        throw error;
      }

      await handleJsonMessage(message);
    };

    const handleProcessingError = (error: unknown): void => {
      if (error instanceof ProtocolStateError) {
        sendError(error.code, error.message, true);
        return;
      }
      if (error instanceof InvalidMessageError) {
        sendError("invalid_message", error.message, true);
        return;
      }

      sendError(
        "internal_error",
        serializeError(error),
        false,
      );
      app.log.error(
        { err: error, sessionId },
        "Voice WebSocket message failed",
      );
      requestClose(1011, "Message processing failed");
    };

    resetIdleTimer();
    const durationTimer = setTimeout(() => {
      sendError(
        "session_duration_exceeded",
        "Maximum voice session duration reached",
        false,
      );
      app.log.info(
        { sessionId },
        "Maximum voice session duration reached",
      );
      requestClose(1000, "Maximum session duration");
    }, options.maxSessionDurationMs);
    durationTimer.unref();

    const heartbeatTimer = setInterval(() => {
      if (!isAlive) {
        app.log.warn(
          { sessionId },
          "Terminating unresponsive voice WebSocket",
        );
        closing = true;
        clearConnectionTimers();
        socket.terminate();
        processing = processing.then(cleanupSession, cleanupSession);
        return;
      }
      isAlive = false;
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      }
    }, options.heartbeatIntervalMs);
    heartbeatTimer.unref();

    socket.on("pong", () => {
      isAlive = true;
    });

    socket.on("message", (data, isBinary) => {
      if (closing) {
        return;
      }

      const frameBytes = rawDataByteLength(data);
      const maximumBytes = isBinary
        ? options.maxAudioFrameBytes
        : options.maxJsonMessageBytes;
      if (frameBytes > maximumBytes) {
        const errorCode = isBinary
          ? "audio_frame_too_large"
          : "message_too_large";
        sendError(
          errorCode,
          `Frame exceeds the ${maximumBytes} byte limit`,
          false,
        );
        app.log.warn(
          {
            sessionId,
            frameType: isBinary ? "audio" : "json",
            frameBytes,
            maximumBytes,
          },
          "Rejected oversized voice WebSocket frame",
        );
        requestClose(1009, "Frame too large");
        return;
      }

      if (pendingMessages >= options.maxPendingMessages) {
        sendError(
          "backpressure_limit",
          "Too many pending WebSocket messages",
          false,
        );
        app.log.warn(
          { sessionId, pendingMessages },
          "Closing voice WebSocket because incoming queue limit was reached",
        );
        requestClose(1013, "Backpressure limit reached");
        return;
      }

      resetIdleTimer();
      pendingMessages += 1;
      processing = processing
        .then(async () => {
          await handleFrame(data, isBinary);
        })
        .catch(handleProcessingError)
        .finally(() => {
          pendingMessages -= 1;
        });
    });

    socket.on("close", () => {
      closing = true;
      clearConnectionTimers();
      processing = processing.then(cleanupSession, cleanupSession);
    });
  });
}

class InvalidMessageError extends Error {
  override readonly name = "InvalidMessageError";
}

class ProtocolStateError extends Error {
  override readonly name = "ProtocolStateError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function combineInstructions(
  defaultInstructions: string,
  sessionInstructions: string,
): string {
  if (defaultInstructions === sessionInstructions) {
    return defaultInstructions;
  }

  return `${defaultInstructions}\n\n${sessionInstructions}`;
}
