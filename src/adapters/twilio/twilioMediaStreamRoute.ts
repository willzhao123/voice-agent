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
  createTwilioMediaMessage,
  parseTwilioMessage,
  type TwilioInboundMessage,
} from "./twilioMessages.js";
import type { TwilioSignatureValidator } from "./twilioSignatureValidator.js";
import { getPublicRequestUrl } from "./twilioVoiceRoute.js";

export interface TwilioMediaStreamRouteOptions {
  signatureValidator: TwilioSignatureValidator;
  instructions: string;
  publicBaseUrl?: string;
  maxMessageBytes: number;
  maxPendingMessages: number;
  maxBufferedBytes: number;
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
        request,
        options.publicBaseUrl,
      );
      if (
        !options.signatureValidator.isConfigured() ||
        !options.signatureValidator.validate({
          signature: readSignature(request),
          url: signatureUrl,
        })
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

      const cleanup = async (): Promise<void> => {
        cleanupPromise ??= (async () => {
          if (sessionId === undefined) {
            return;
          }
          try {
            await sessionManager.closeSession(sessionId);
          } catch (error) {
            app.log.error(
              { err: error, sessionId, streamSid, callSid },
              "Failed to close Twilio voice session",
            );
          }
        })();
        return cleanupPromise;
      };

      const close = (code: number, reason: string): void => {
        if (closing) {
          return;
        }
        closing = true;
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(code, reason);
        }
        processing = processing.then(cleanup, cleanup);
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

      const onSessionEvent = (event: VoiceSessionEvent): void => {
        if (streamSid === undefined) {
          return;
        }

        switch (event.type) {
          case "output_audio.delta":
            send(createTwilioMediaMessage(streamSid, event.audio));
            break;
          case "input_audio.started":
          case "response.interrupted":
            send(createTwilioClearMessage(streamSid));
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
          case "output_audio.completed":
          case "response.started":
          case "response.completed":
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
        app.log.info(
          { sessionId, streamSid, callSid },
          "Twilio Media Stream started",
        );
      };

      const handleMessage = async (
        message: TwilioInboundMessage,
      ): Promise<void> => {
        switch (message.event) {
          case "connected":
          case "mark":
          case "dtmf":
            break;
          case "start":
            await handleStart(message);
            break;
          case "media":
            if (
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
          case "stop":
            if (
              streamSid !== undefined &&
              message.streamSid !== streamSid
            ) {
              throw new TwilioProtocolError(
                "Twilio stop stream SID does not match",
              );
            }
            app.log.info(
              { sessionId, streamSid, callSid },
              "Twilio Media Stream stopped",
            );
            close(1000, "Twilio stream stopped");
            break;
        }
      };

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
        processing = processing.then(cleanup, cleanup);
      });
    },
  );
}

class TwilioProtocolError extends Error {
  override readonly name = "TwilioProtocolError";
}

function getWebsocketRequestUrl(
  request: FastifyRequest,
  publicBaseUrl?: string,
): string {
  const url = new URL(getPublicRequestUrl(request, publicBaseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
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
