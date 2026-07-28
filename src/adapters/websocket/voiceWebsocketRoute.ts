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

    const handlePromise = sessionManager
      .startSession(send)
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
          const handle = await handlePromise;
          await handle.receive(event);
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
      void handlePromise
        .then(async (handle) => handle.close())
        .catch((error: unknown) => {
          app.log.error(error, "Failed to close voice session");
        });
    });
  });
}
