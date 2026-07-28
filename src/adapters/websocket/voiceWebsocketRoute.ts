import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";

import type {
  VoiceSessionEvent,
  VoiceSessionManager,
} from "../../application/voiceSessionManager.js";
import { parseClientVoiceEvent } from "../../domain/voiceEvents.js";
import { serializeError } from "../../shared/errors.js";

export function registerVoiceWebsocketRoute(
  app: FastifyInstance,
  sessionManager: VoiceSessionManager,
): void {
  app.get("/ws", { websocket: true }, (socket) => {
    const send = (event: VoiceSessionEvent): void => {
      if (socket.readyState === WebSocket.OPEN) {
        const wireEvent =
          event.type === "output_audio.delta"
            ? {
                ...event,
                audio: event.audio.toString("base64"),
              }
            : event;
        socket.send(JSON.stringify(wireEvent));
      }
    };

    const sessionIdPromise = sessionManager
      .createSession(send)
      .then((session) => session.id)
      .catch((error: unknown) => {
        send({
          type: "error",
          message: serializeError(error),
          code: "session_start_failed",
          recoverable: false,
        });
        socket.close(1011, "Unable to start voice session");
        throw error;
      });

    socket.on("message", (data) => {
      void (async () => {
        try {
          const rawEvent: unknown = JSON.parse(data.toString());
          const event = parseClientVoiceEvent(rawEvent);
          const sessionId = await sessionIdPromise;

          switch (event.type) {
            case "audio.append":
              await sessionManager.sendAudio(sessionId, event.audio);
              break;
            case "audio.commit":
              await sessionManager.commitAudio(sessionId);
              break;
            case "text.send":
              await sessionManager.sendText(sessionId, event.text);
              break;
            case "response.interrupt":
              await sessionManager.interrupt(sessionId);
              break;
            case "session.end":
              await sessionManager.closeSession(sessionId);
              break;
            case "ping":
              send({ type: "pong" });
              break;
          }
        } catch (error) {
          send({
            type: "error",
            message: serializeError(error),
            code: "invalid_client_event",
            recoverable: true,
          });
        }
      })();
    });

    socket.on("close", () => {
      void sessionIdPromise
        .then(async (sessionId) => {
          await sessionManager.closeSession(sessionId);
        })
        .catch((error: unknown) => {
          app.log.error(error, "Failed to close voice session");
        });
    });
  });
}
