import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { resolve } from "node:path";

import { VoiceSessionManager } from "./application/voiceSessionManager.js";
import { MockRealtimeProvider } from "./adapters/realtime/mockRealtimeProvider.js";
import { OpenAIRealtimeProvider } from "./adapters/realtime/openaiRealtimeProvider.js";
import { MemorySessionStore } from "./adapters/storage/memorySessionStore.js";
import {
  registerTwilioMediaStreamRoute,
  type TwilioMediaStreamRouteOptions,
} from "./adapters/twilio/twilioMediaStreamRoute.js";
import {
  DefaultTwilioSignatureValidator,
  type TwilioSignatureValidator,
} from "./adapters/twilio/twilioSignatureValidator.js";
import { registerTwilioVoiceRoute } from "./adapters/twilio/twilioVoiceRoute.js";
import {
  registerVoiceWebsocketRoute,
  type VoiceWebsocketOptions,
} from "./adapters/websocket/voiceWebsocketRoute.js";
import { env } from "./config/env.js";
import type { RealtimeProvider } from "./ports/realtimeProvider.js";
import type { SessionStore } from "./ports/sessionStore.js";
import {
  createLoggerOptions,
  type Logger,
} from "./shared/logger.js";

export interface AppDependencies {
  logger?: Logger;
  realtimeProvider?: RealtimeProvider;
  sessionStore?: SessionStore;
  voiceWebsocketOptions?: Partial<VoiceWebsocketOptions>;
  twilioSignatureValidator?: TwilioSignatureValidator;
  twilioPublicBaseUrl?: string;
  twilioMediaStreamOptions?: Partial<
    Pick<
      TwilioMediaStreamRouteOptions,
      "maxMessageBytes" | "maxPendingMessages" | "maxBufferedBytes"
    >
  >;
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
        ? createLoggerOptions(env.LOG_LEVEL)
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
  const twilioSignatureValidator =
    dependencies.twilioSignatureValidator ??
    new DefaultTwilioSignatureValidator(env.TWILIO_AUTH_TOKEN);
  const twilioPublicBaseUrl =
    dependencies.twilioPublicBaseUrl ??
    env.TWILIO_PUBLIC_BASE_URL;

  await app.register(websocket, {
    options: {
      maxPayload: Math.max(
        env.MAX_JSON_MESSAGE_BYTES,
        env.MAX_AUDIO_FRAME_BYTES,
      ),
    },
  });
  await app.register(formbody);
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
    {
      maxJsonMessageBytes: env.MAX_JSON_MESSAGE_BYTES,
      maxAudioFrameBytes: env.MAX_AUDIO_FRAME_BYTES,
      idleTimeoutMs: env.IDLE_SESSION_TIMEOUT_MS,
      maxSessionDurationMs: env.MAX_SESSION_DURATION_MS,
      heartbeatIntervalMs: env.WEBSOCKET_HEARTBEAT_INTERVAL_MS,
      maxPendingMessages: env.WEBSOCKET_MAX_PENDING_MESSAGES,
      maxBufferedBytes: env.WEBSOCKET_MAX_BUFFERED_BYTES,
      ...dependencies.voiceWebsocketOptions,
    },
  );
  registerTwilioVoiceRoute(app, {
    signatureValidator: twilioSignatureValidator,
    ...(twilioPublicBaseUrl === undefined
      ? {}
      : { publicBaseUrl: twilioPublicBaseUrl }),
  });
  registerTwilioMediaStreamRoute(
    app,
    sessionManager,
    {
      signatureValidator: twilioSignatureValidator,
      instructions: env.VOICE_INSTRUCTIONS,
      maxMessageBytes: env.MAX_JSON_MESSAGE_BYTES,
      maxPendingMessages: env.WEBSOCKET_MAX_PENDING_MESSAGES,
      maxBufferedBytes: env.WEBSOCKET_MAX_BUFFERED_BYTES,
      ...(twilioPublicBaseUrl === undefined
        ? {}
        : { publicBaseUrl: twilioPublicBaseUrl }),
      ...dependencies.twilioMediaStreamOptions,
    },
  );

  app.addHook("onClose", async () => {
    await sessionManager.closeAllSessions();
  });

  return app;
}
