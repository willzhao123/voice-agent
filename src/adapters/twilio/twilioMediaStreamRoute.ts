import type {
  FastifyInstance,
  FastifyRequest,
} from "fastify";
import type { RawData } from "ws";
import { WebSocket } from "ws";

import type {
  VoiceSessionEvent,
  VoiceSessionManager,
} from "../../application/voiceSessionManager.js";
import {
  createTwilioClearMessage,
  createTwilioMarkMessage,
  createTwilioMediaMessage,
  parseTwilioMessage,
  type TwilioInboundMessage,
} from "./twilioMessages.js";
import type { TwilioSignatureValidator } from "./twilioSignatureValidator.js";
import { getPublicRouteUrl } from "./twilioVoiceRoute.js";

export interface TwilioMediaStreamRouteOptions {
  signatureValidator: TwilioSignatureValidator;
  instructions: string;
  publicBaseUrl: string;
  validateSignatures: boolean;
  maxMessageBytes: number;
  maxPendingMessages: number;
  maxBufferedBytes: number;
  idleTimeoutMs: number;
  maxSessionDurationMs: number;
  heartbeatIntervalMs: number;
}

export function registerTwilioMediaStreamRoute(
  app: FastifyInstance,
  sessionManager: VoiceSessionManager,
  options: TwilioMediaStreamRouteOptions,
): void {
  app.get(
    "/v1/twilio/media",
    { websocket: true },
    (socket, request) => {
      const signatureUrl = getWebsocketRequestUrl(
        options.publicBaseUrl,
      );
      if (
        options.validateSignatures &&
        (
          !options.signatureValidator.isConfigured() ||
          !options.signatureValidator.validate({
            signature: readSignature(request),
            url: signatureUrl,
          })
        )
      ) {
        app.log.warn(
          { path: request.url },
          "Rejected Twilio Media Stream with invalid signature",
        );
        socket.close(1008, "Invalid Twilio signature");
        return;
      }

      let sessionId: string | undefined;
      let streamSid: string | undefined;
      let callSid: string | undefined;
      let closing = false;
      let pendingMessages = 0;
      let processing = Promise.resolve();
      let cleanupPromise: Promise<void> | undefined;
      let state:
        | "awaiting_connected"
        | "awaiting_start"
        | "streaming"
        | "stopped" = "awaiting_connected";
      let lastSequenceNumber = 0;
      let isAlive = true;
      let idleTimer: NodeJS.Timeout;
      let responseActive = false;
      let assistantAudioBuffered = false;
      let nextPlaybackMark = 1;
      const pendingPlaybackMarks = new Set<string>();
      const clearedPlaybackMarks = new Set<string>();

      const clearConnectionTimers = (): void => {
        clearTimeout(idleTimer);
        clearTimeout(durationTimer);
        clearInterval(heartbeatTimer);
      };

      const cleanup = async (): Promise<void> => {
        if (
          cleanupPromise === undefined &&
          sessionId !== undefined
        ) {
          const activeSessionId = sessionId;
          cleanupPromise = (async () => {
            try {
              await sessionManager.closeSession(activeSessionId);
            } catch (error) {
              app.log.error(
                {
                  err: error,
                  sessionId: activeSessionId,
                  streamSid,
                  callSid,
                },
                "Failed to close Twilio voice session",
              );
            }
          })();
        }
        await cleanupPromise;
      };

      const close = (code: number, reason: string): void => {
        if (closing) {
          return;
        }
        closing = true;
        clearConnectionTimers();
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(code, reason);
        }
        processing = processing.then(cleanup, cleanup);
      };

      const resetIdleTimer = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          app.log.info(
            { sessionId, streamSid, callSid },
            "Twilio Media Stream idle timeout reached",
          );
          close(1000, "Idle timeout");
        }, options.idleTimeoutMs);
        idleTimer.unref();
      };

      const send = (message: object): void => {
        if (
          closing ||
          socket.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        const serialized = JSON.stringify(message);
        if (
          socket.bufferedAmount +
          Buffer.byteLength(serialized) >
          options.maxBufferedBytes
        ) {
          app.log.warn(
            {
              sessionId,
              streamSid,
              callSid,
              bufferedBytes: socket.bufferedAmount,
            },
            "Closing Twilio Media Stream due to outbound backpressure",
          );
          close(1013, "Backpressure limit reached");
          return;
        }
        socket.send(serialized);
      };

      const clearAssistantPlayback = (): void => {
        if (streamSid === undefined) {
          return;
        }
        for (const markName of pendingPlaybackMarks) {
          clearedPlaybackMarks.add(markName);
        }
        pendingPlaybackMarks.clear();
        assistantAudioBuffered = false;
        send(createTwilioClearMessage(streamSid));
      };

      const markAssistantPlaybackBoundary = (): void => {
        if (
          streamSid === undefined ||
          !assistantAudioBuffered
        ) {
          return;
        }
        const markName = `assistant-response-${nextPlaybackMark}`;
        nextPlaybackMark += 1;
        pendingPlaybackMarks.add(markName);
        assistantAudioBuffered = false;
        send(createTwilioMarkMessage(streamSid, markName));
      };

      const interruptActiveResponse = (): void => {
        if (
          !responseActive ||
          sessionId === undefined ||
          closing
        ) {
          return;
        }
        responseActive = false;
        const activeSessionId = sessionId;
        processing = processing.then(async () => {
          if (closing) {
            return;
          }
          try {
            await sessionManager.interrupt(activeSessionId);
          } catch (error) {
            app.log.warn(
              {
                err: error,
                sessionId: activeSessionId,
                streamSid,
                callSid,
              },
              "Failed to interrupt active Twilio voice response",
            );
            close(1011, "Failed to interrupt response");
          }
        });
      };

      const onSessionEvent = (event: VoiceSessionEvent): void => {
        if (streamSid === undefined) {
          return;
        }

        switch (event.type) {
          case "output_audio.delta":
            assistantAudioBuffered = true;
            send(createTwilioMediaMessage(streamSid, event.audio));
            break;
          case "input_audio.started":
            clearAssistantPlayback();
            interruptActiveResponse();
            break;
          case "output_audio.completed":
            markAssistantPlaybackBoundary();
            break;
          case "response.started":
            responseActive = true;
            break;
          case "response.completed":
            responseActive = false;
            break;
          case "response.interrupted":
            responseActive = false;
            if (assistantAudioBuffered) {
              clearAssistantPlayback();
            }
            break;
          case "error":
            if (!event.recoverable) {
              app.log.warn(
                {
                  sessionId,
                  streamSid,
                  callSid,
                  providerErrorCode: event.code,
                },
                "Realtime provider disconnected from Twilio voice session",
              );
              close(1011, "Realtime provider disconnected");
            }
            break;
          case "session.ready":
          case "input_audio.stopped":
          case "transcript.user.final":
          case "transcript.agent.delta":
          case "transcript.agent.final":
          case "session.started":
          case "session.ended":
            break;
        }
      };

      const handleStart = async (
        message: Extract<TwilioInboundMessage, { event: "start" }>,
      ): Promise<void> => {
        if (sessionId !== undefined || streamSid !== undefined) {
          throw new TwilioProtocolError(
            "Twilio Media Stream was already started",
          );
        }
        if (message.start.streamSid !== message.streamSid) {
          throw new TwilioProtocolError(
            "Twilio start stream SID does not match",
          );
        }

        streamSid = message.streamSid;
        callSid = message.start.callSid;
        const session = await sessionManager.createSession(
          onSessionEvent,
          options.instructions,
          {
            audioFormat: {
              encoding: "g711_ulaw",
              sampleRate: 8_000,
            },
            turnDetection: "server_vad",
          },
        );
        sessionId = session.id;
        state = "streaming";
        if (closing) {
          await cleanup();
          return;
        }
        app.log.info(
          { sessionId, streamSid, callSid },
          "Twilio Media Stream started",
        );
      };

      const handleMessage = async (
        message: TwilioInboundMessage,
      ): Promise<void> => {
        if (message.event !== "connected") {
          const sequenceNumber = Number(message.sequenceNumber);
          if (
            !Number.isSafeInteger(sequenceNumber) ||
            sequenceNumber <= lastSequenceNumber
          ) {
            throw new TwilioProtocolError(
              "Twilio sequence number is duplicated or out of order",
            );
          }
          lastSequenceNumber = sequenceNumber;
        }

        switch (message.event) {
          case "connected":
            if (state !== "awaiting_connected") {
              throw new TwilioProtocolError(
                "Twilio connected event is duplicated or out of order",
              );
            }
            state = "awaiting_start";
            break;
          case "start":
            if (state !== "awaiting_start") {
              throw new TwilioProtocolError(
                "Twilio start event is duplicated or out of order",
              );
            }
            await handleStart(message);
            break;
          case "media":
            if (
              state !== "streaming" ||
              sessionId === undefined ||
              streamSid === undefined
            ) {
              throw new TwilioProtocolError(
                "Twilio media arrived before start",
              );
            }
            if (message.streamSid !== streamSid) {
              throw new TwilioProtocolError(
                "Twilio media stream SID does not match",
              );
            }
            await sessionManager.sendAudio(
              sessionId,
              decodeBase64Audio(message.media.payload),
            );
            break;
          case "mark":
            if (
              state !== "streaming" ||
              streamSid === undefined
            ) {
              throw new TwilioProtocolError(
                `Twilio ${message.event} arrived before start`,
              );
            }
            if (message.streamSid !== streamSid) {
              throw new TwilioProtocolError(
                `Twilio ${message.event} stream SID does not match`,
              );
            }
            if (clearedPlaybackMarks.delete(message.mark.name)) {
              break;
            }
            pendingPlaybackMarks.delete(message.mark.name);
            break;
          case "dtmf":
            if (
              state !== "streaming" ||
              streamSid === undefined
            ) {
              throw new TwilioProtocolError(
                `Twilio ${message.event} arrived before start`,
              );
            }
            if (message.streamSid !== streamSid) {
              throw new TwilioProtocolError(
                `Twilio ${message.event} stream SID does not match`,
              );
            }
            break;
          case "stop":
            if (
              state !== "streaming" ||
              sessionId === undefined ||
              streamSid === undefined
            ) {
              throw new TwilioProtocolError(
                "Twilio stop arrived before start",
              );
            }
            if (message.streamSid !== streamSid) {
              throw new TwilioProtocolError(
                "Twilio stop stream SID does not match",
              );
            }
            app.log.info(
              { sessionId, streamSid, callSid },
              "Twilio Media Stream stopped",
            );
            state = "stopped";
            close(1000, "Twilio stream stopped");
            break;
        }
      };

      resetIdleTimer();
      const durationTimer = setTimeout(() => {
        app.log.info(
          { sessionId, streamSid, callSid },
          "Maximum Twilio Media Stream duration reached",
        );
        close(1000, "Maximum session duration");
      }, options.maxSessionDurationMs);
      durationTimer.unref();

      const heartbeatTimer = setInterval(() => {
        if (!isAlive) {
          app.log.warn(
            { sessionId, streamSid, callSid },
            "Terminating unresponsive Twilio Media Stream",
          );
          closing = true;
          clearConnectionTimers();
          socket.terminate();
          processing = processing.then(cleanup, cleanup);
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

      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (closing) {
          return;
        }
        if (isBinary) {
          close(1003, "Twilio messages must be JSON");
          return;
        }

        const messageBytes = rawDataByteLength(data);
        if (messageBytes > options.maxMessageBytes) {
          close(1009, "Twilio message too large");
          return;
        }
        if (pendingMessages >= options.maxPendingMessages) {
          close(1013, "Backpressure limit reached");
          return;
        }

        resetIdleTimer();
        pendingMessages += 1;
        processing = processing
          .then(async () => {
            const value: unknown = JSON.parse(data.toString());
            await handleMessage(parseTwilioMessage(value));
          })
          .catch((error: unknown) => {
            app.log.warn(
              {
                err: error,
                sessionId,
                streamSid,
                callSid,
              },
              "Invalid Twilio Media Stream message",
            );
            close(1008, "Invalid Twilio message");
          })
          .finally(() => {
            pendingMessages -= 1;
          });
      });

      socket.on("close", () => {
        closing = true;
        clearConnectionTimers();
        processing = processing.then(cleanup, cleanup);
      });
    },
  );
}

class TwilioProtocolError extends Error {
  override readonly name = "TwilioProtocolError";
}

function getWebsocketRequestUrl(
  publicBaseUrl: string,
): string {
  const url = new URL(
    getPublicRouteUrl(publicBaseUrl, "/v1/twilio/media"),
  );
  url.protocol = "wss:";
  return url.toString();
}

function readSignature(
  request: FastifyRequest,
): string | undefined {
  const value = request.headers["x-twilio-signature"];
  return Array.isArray(value) ? value[0] : value;
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce(
      (total, chunk) => total + chunk.byteLength,
      0,
    );
  }
  return data.byteLength;
}

function decodeBase64Audio(payload: string): Buffer {
  const audio = Buffer.from(payload, "base64");
  const normalizedInput = payload.replace(/=+$/u, "");
  const normalizedOutput = audio
    .toString("base64")
    .replace(/=+$/u, "");
  if (
    audio.byteLength === 0 ||
    normalizedInput !== normalizedOutput
  ) {
    throw new TwilioProtocolError(
      "Twilio media payload must be valid base64 audio",
    );
  }
  return audio;
}
