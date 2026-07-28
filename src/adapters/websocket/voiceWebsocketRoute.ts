import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { WebSocket } from "ws";
import { ZodError } from "zod";

import type {
  VoiceSessionEvent,
  VoiceSessionManager,
} from "../../application/voiceSessionManager.js";
import {
  parseClientVoiceMessage,
  type ClientVoiceMessage,
} from "../../domain/voiceEvents.js";
import { serializeError } from "../../shared/errors.js";

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
): void {
  app.get("/v1/voice", { websocket: true }, (socket) => {
    let sessionId: string | undefined;
    let sessionEnded = false;
    let processing = Promise.resolve();

    const sendJson = (message: object): void => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
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
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(event.audio, { binary: true });
          }
          break;
        case "error":
          sendError(
            event.code,
            event.message,
            event.recoverable,
          );
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
          message.instructions,
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

    socket.on("message", (data, isBinary) => {
      processing = processing
        .then(async () => handleFrame(data, isBinary))
        .catch((error: unknown) => {
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
          app.log.error(error, "Voice WebSocket message failed");
        });
    });

    socket.on("close", () => {
      void processing
        .then(async () => {
          if (sessionId !== undefined && !sessionEnded) {
            await sessionManager.closeSession(sessionId);
            sessionEnded = true;
          }
        })
        .catch((error: unknown) => {
          app.log.error(error, "Failed to clean up voice session");
        });
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

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}
