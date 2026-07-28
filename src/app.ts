import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();

  await app.register(websocket);

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ws", { websocket: true }, (socket) => {
    socket.on("message", (message) => {
      socket.send(message);
    });
  });

  return app;
}
