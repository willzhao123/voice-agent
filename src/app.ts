import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { resolve } from "node:path";

import { VoiceSessionManager } from "./application/voiceSessionManager.js";
import { MockRealtimeProvider } from "./adapters/realtime/mockRealtimeProvider.js";
import { OpenAIRealtimeProvider } from "./adapters/realtime/openaiRealtimeProvider.js";
import { MemorySessionStore } from "./adapters/storage/memorySessionStore.js";
import { registerVoiceWebsocketRoute } from "./adapters/websocket/voiceWebsocketRoute.js";
import { env } from "./config/env.js";
import type { RealtimeProvider } from "./ports/realtimeProvider.js";
import type { SessionStore } from "./ports/sessionStore.js";
import type { Logger } from "./shared/logger.js";

export interface AppDependencies {
  logger?: Logger;
  realtimeProvider?: RealtimeProvider;
  sessionStore?: SessionStore;
}

function createRealtimeProvider(): RealtimeProvider {
  if (env.REALTIME_PROVIDER === "openai") {
    return new OpenAIRealtimeProvider({
      model: env.OPENAI_REALTIME_MODEL,
      ...(env.OPENAI_API_KEY === undefined
        ? {}
        : { apiKey: env.OPENAI_API_KEY }),
    });
  }

  return new MockRealtimeProvider();
}

export async function buildApp(
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      dependencies.logger === undefined
        ? { level: env.LOG_LEVEL }
        : false,
  });
  const logger = dependencies.logger ?? app.log;
  const provider = dependencies.realtimeProvider ?? createRealtimeProvider();
  const sessionStore = dependencies.sessionStore ?? new MemorySessionStore();
  const sessionManager = new VoiceSessionManager(
    provider,
    sessionStore,
    logger,
  );

  await app.register(websocket);
  await app.register(fastifyStatic, {
    root: resolve("public"),
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await provider.initialize();
      return {
        status: "ready",
        provider: env.REALTIME_PROVIDER,
      };
    } catch {
      return reply.code(503).send({
        status: "not_ready",
        provider: env.REALTIME_PROVIDER,
      });
    }
  });

  registerVoiceWebsocketRoute(
    app,
    sessionManager,
    env.VOICE_INSTRUCTIONS,
  );

  return app;
}
