import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";

import type { VoiceSessionManager } from "../../application/voiceSessionManager.js";
import { parseClientVoiceEvent } from "../../domain/voiceEvents.js";
import { serializeError } from "../../shared/errors.js";

export function registerVoiceWebsocketRoute(
  app: FastifyInstance,
  sessionManager: VoiceSessionManager,
): void {
  app.get("/ws", { websocket: true }, (socket) => {
    const send = (event: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    };

    const handlePromise = sessionManager
      .startSession(send)
      .catch((error: unknown) => {
        send({ type: "error", message: serializeError(error) });
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
          send({ type: "error", message: serializeError(error) });
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
