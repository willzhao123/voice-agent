import websocket from "@fastify/websocket";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { VoiceSessionManager } from "./application/voiceSessionManager.js";
import { MockRealtimeProvider } from "./adapters/realtime/mockRealtimeProvider.js";
import { OpenAIRealtimeProvider } from "./adapters/realtime/openaiRealtimeProvider.js";
import { MemorySessionStore } from "./adapters/storage/memorySessionStore.js";
import { registerVoiceWebsocketRoute } from "./adapters/websocket/voiceWebsocketRoute.js";
import { env } from "./config/env.js";
import type { RealtimeProvider } from "./ports/realtimeProvider.js";
import type { SessionStore } from "./ports/sessionStore.js";
import {
  createLogger,
  type Logger,
} from "./shared/logger.js";

export interface AppDependencies {
  logger?: Logger;
  realtimeProvider?: RealtimeProvider;
  sessionStore?: SessionStore;
}

function createRealtimeProvider(): RealtimeProvider {
  if (env.REALTIME_PROVIDER === "openai") {
    return new OpenAIRealtimeProvider(env.OPENAI_API_KEY);
  }

  return new MockRealtimeProvider();
}

export async function buildApp(
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  const logger = dependencies.logger ?? createLogger(env.LOG_LEVEL);
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
  });
  const provider = dependencies.realtimeProvider ?? createRealtimeProvider();
  const sessionStore = dependencies.sessionStore ?? new MemorySessionStore();
  const sessionManager = new VoiceSessionManager(
    provider,
    sessionStore,
    logger,
  );

  await app.register(websocket);
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/", async (_request, reply) => {
    const html = await readFile(resolve("public/index.html"), "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/app.js", async (_request, reply) => {
    const javascript = await readFile(resolve("public/app.js"), "utf8");
    return reply
      .type("text/javascript; charset=utf-8")
      .send(javascript);
  });

  registerVoiceWebsocketRoute(app, sessionManager);

  return app;
}
