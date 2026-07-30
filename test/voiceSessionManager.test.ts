import { describe, expect, it } from "vitest";

import { MockRealtimeProvider } from "../src/adapters/realtime/mockRealtimeProvider.js";
import { MemorySessionStore } from "../src/adapters/storage/memorySessionStore.js";
import {
  BACKEND_FAILURE_MESSAGE,
  VoiceSessionManager,
  type VoiceSessionEvent,
} from "../src/application/voiceSessionManager.js";
import {
  parseApprovedFaqCatalog,
  VoiceFaqRouter,
} from "../src/application/voiceFaqRouter.js";
import type {
  BackendAgent,
  BackendAgentContext,
  BackendAgentFactory,
} from "../src/ports/backendAgent.js";
import type {
  RealtimeProvider,
  RealtimeSessionOptions,
} from "../src/ports/realtimeProvider.js";
import {
  SessionClosedError,
  SessionNotFoundError,
} from "../src/shared/errors.js";
import {
  createLogger,
  type Logger,
} from "../src/shared/logger.js";

const silentLogger = createLogger("silent");

class CapturingProvider implements RealtimeProvider {
  readonly options: RealtimeSessionOptions[] = [];

  async initialize(): Promise<void> {}

  async openSession(
    options: RealtimeSessionOptions,
  ) {
    this.options.push(options);
    return {
      async sendInputAudio() {},
      async commitInputAudio() {},
      async sendText() {},
      async interrupt() {},
      async close() {},
    };
  }
}

class TrackingBackendFactory implements BackendAgentFactory {
  readonly contexts: BackendAgentContext[] = [];
  readonly agents: Array<BackendAgent & {
    messages: string[];
    closeCount: number;
  }> = [];

  create(context: BackendAgentContext) {
    this.contexts.push(context);
    const agent = {
      messages: [] as string[],
      closeCount: 0,
      async chat(message: string) {
        this.messages.push(message);
        return `${context.callSid}: ${message}`;
      },
      async close() {
        this.closeCount += 1;
      },
    };
    this.agents.push(agent);
    return agent;
  }
}

class RecordingLogger implements Logger {
  readonly infos: Array<{
    bindings: Record<string, unknown>;
    message: string;
  }> = [];

  info(bindings: object, message: string): void {
    this.infos.push({
      bindings: bindings as Record<string, unknown>,
      message,
    });
  }

  error(): void {}
}

describe("VoiceSessionManager", () => {
  it("keeps two sessions and their provider events independent", async () => {
    const store = new MemorySessionStore();
    const generatedIds = ["session-1", "session-1", "session-2"];
    const firstEvents: VoiceSessionEvent[] = [];
    const secondEvents: VoiceSessionEvent[] = [];
    const manager = new VoiceSessionManager(
      new MockRealtimeProvider(),
      store,
      silentLogger,
      () => generatedIds.shift() ?? "unexpected-session-id",
    );

    const first = await manager.createSession((event) => {
      firstEvents.push(event);
    });
    const second = await manager.createSession((event) => {
      secondEvents.push(event);
    });

    expect(first.id).toBe("session-1");
    expect(second.id).toBe("session-2");
    expect(first.id).not.toBe(second.id);
    await expect(manager.getSession(first.id)).resolves.toMatchObject({
      status: "active",
    });
    await expect(manager.getSession(second.id)).resolves.toMatchObject({
      status: "active",
    });

    firstEvents.length = 0;
    secondEvents.length = 0;

    const callerAudio = Buffer.from("first caller audio");
    await manager.sendAudio(first.id, callerAudio);
    await manager.commitAudio(first.id);
    await manager.sendText(second.id, "second caller text");
    await manager.interrupt(first.id);

    expect(firstEvents.map((event) => event.type)).toEqual([
      "input_audio.started",
      "input_audio.stopped",
      "transcript.user.final",
      "response.started",
      "transcript.agent.delta",
      "transcript.agent.final",
      "output_audio.delta",
      "output_audio.completed",
      "response.completed",
      "response.interrupted",
    ]);
    expect(secondEvents.map((event) => event.type)).toEqual([
      "transcript.user.final",
      "response.started",
      "transcript.agent.delta",
      "transcript.agent.final",
      "output_audio.delta",
      "output_audio.completed",
      "response.completed",
    ]);

    const firstOutputAudio = firstEvents.find(
      (event) => event.type === "output_audio.delta",
    );
    expect(firstOutputAudio).toMatchObject({
      type: "output_audio.delta",
      audio: callerAudio,
    });
    expect(secondEvents).toContainEqual({
      type: "transcript.user.final",
      transcript: "second caller text",
    });
    expect(firstEvents).not.toContainEqual({
      type: "transcript.user.final",
      transcript: "second caller text",
    });
    expect(secondEvents.some(
      (event) => event.type === "response.interrupted",
    )).toBe(false);
  });

  it("closes and cleans up sessions and rejects invalid IDs", async () => {
    const store = new MemorySessionStore();
    const events: VoiceSessionEvent[] = [];
    const manager = new VoiceSessionManager(
      new MockRealtimeProvider(),
      store,
      silentLogger,
      () => "session-to-close",
    );
    const session = await manager.createSession((event) => {
      events.push(event);
    });

    await manager.closeSession(session.id);
    await manager.closeSession(session.id);

    await expect(manager.getSession(session.id)).resolves.toMatchObject({
      id: session.id,
      status: "closed",
    });
    expect(events.at(-1)).toEqual({
      type: "session.ended",
      sessionId: session.id,
    });
    await expect(
      manager.sendAudio(session.id, Buffer.from("late audio")),
    ).rejects.toBeInstanceOf(SessionClosedError);
    await expect(
      manager.sendText("unknown-session", "hello"),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(
      manager.interrupt("unknown-session"),
    ).rejects.toThrow("Voice session unknown-session was not found");
  });

  it("creates, delegates through, and closes one backend agent per call", async () => {
    const provider = new CapturingProvider();
    const backendFactory = new TrackingBackendFactory();
    const ids = ["session-a", "session-b"];
    const manager = new VoiceSessionManager(
      provider,
      new MemorySessionStore(),
      silentLogger,
      () => ids.shift() ?? "unexpected",
      backendFactory,
    );

    const first = await manager.createSession(undefined, undefined, {
      backendContext: {
        callSid: "CA-a",
        streamSid: "MZ-a",
      },
    });
    const second = await manager.createSession(undefined, undefined, {
      backendContext: {
        callSid: "CA-b",
        streamSid: "MZ-b",
      },
    });

    await expect(
      provider.options[0]?.handleBusinessRequest?.("first request"),
    ).resolves.toBe("CA-a: first request");
    await expect(
      provider.options[1]?.handleBusinessRequest?.("second request"),
    ).resolves.toBe("CA-b: second request");

    expect(backendFactory.contexts).toEqual([
      {
        sessionId: first.id,
        callSid: "CA-a",
        streamSid: "MZ-a",
      },
      {
        sessionId: second.id,
        callSid: "CA-b",
        streamSid: "MZ-b",
      },
    ]);
    expect(backendFactory.agents[0]?.messages).toEqual([
      "first request",
    ]);
    expect(backendFactory.agents[1]?.messages).toEqual([
      "second request",
    ]);

    await manager.closeSession(first.id);
    await manager.closeSession(second.id);
    expect(backendFactory.agents.map((agent) => agent.closeCount))
      .toEqual([1, 1]);
  });

  it("returns a short apology when backend delegation times out", async () => {
    const provider = new CapturingProvider();
    const backendFactory: BackendAgentFactory = {
      create: () => ({
        chat: () => new Promise<string>(() => {}),
      }),
    };
    const manager = new VoiceSessionManager(
      provider,
      new MemorySessionStore(),
      silentLogger,
      () => "timed-out-session",
      backendFactory,
      5,
    );
    await manager.createSession(undefined, undefined, {
      backendContext: { callSid: "CA-timeout" },
    });

    await expect(
      provider.options[0]?.handleBusinessRequest?.("menu question"),
    ).resolves.toBe(BACKEND_FAILURE_MESSAGE);
  });

  it("answers FAQs locally, routes mixed work, and carries local answers into later backend requests", async () => {
    const provider = new CapturingProvider();
    const backendFactory = new TrackingBackendFactory();
    const logger = new RecordingLogger();
    const faqRouter = new VoiceFaqRouter(
      parseApprovedFaqCatalog({
        version: "faq-v1",
        restaurant: "Haiyen",
        faqs: [
          {
            id: "restaurant.hours",
            answer: "We're open from noon to 9 PM every day.",
            matchPhrases: ["hours"],
          },
        ],
      }),
    );
    const manager = new VoiceSessionManager(
      provider,
      new MemorySessionStore(),
      logger,
      () => "faq-session",
      backendFactory,
      8_000,
      faqRouter,
    );
    await manager.createSession(undefined, undefined, {
      backendContext: {
        callSid: "CA-faq",
        streamSid: "MZ-faq",
      },
    });
    const handleBusinessRequest =
      provider.options[0]?.handleBusinessRequest;
    expect(handleBusinessRequest).toBeDefined();
    if (handleBusinessRequest === undefined) {
      throw new Error("Business request handler was not configured");
    }

    await expect(
      handleBusinessRequest("What are your hours?"),
    ).resolves.toBe(
      "We're open from noon to 9 PM every day.",
    );
    expect(backendFactory.agents[0]?.messages).toEqual([]);

    const mixedResponse = await handleBusinessRequest(
      "What are your hours and do you have beef pho?",
    );
    expect(mixedResponse).toContain(
      "We're open from noon to 9 PM every day.",
    );
    expect(backendFactory.agents[0]?.messages).toHaveLength(1);
    expect(backendFactory.agents[0]?.messages[0]).toContain(
      '"currentRequest":"do you have beef pho"',
    );
    expect(backendFactory.agents[0]?.messages[0]).toContain(
      '"faqVersion":"faq-v1"',
    );
    expect(backendFactory.agents[0]?.messages[0]).toContain(
      '"localAnswer":"We\'re open from noon to 9 PM every day."',
    );

    await handleBusinessRequest("How much is beef pho?");
    expect(backendFactory.agents[0]?.messages).toHaveLength(2);
    expect(backendFactory.agents[0]?.messages[1]).toContain(
      '"priorApprovedFaqTurns"',
    );
    expect(backendFactory.agents[0]?.messages[1]).toContain(
      '"currentRequest":"How much is beef pho?"',
    );

    const routeLogs = logger.infos.filter(
      (entry) =>
        entry.message === "Voice business request routed",
    );
    expect(routeLogs.map((entry) => entry.bindings)).toEqual([
      expect.objectContaining({
        route: "local_faq",
        faqId: "restaurant.hours",
        faqVersion: "faq-v1",
        fallbackReason: "none",
        latencyMs: expect.any(Number),
      }),
      expect.objectContaining({
        route: "mixed",
        faqId: "restaurant.hours",
        faqVersion: "faq-v1",
        fallbackReason: "mixed_request_backend_remainder",
        latencyMs: expect.any(Number),
      }),
      expect.objectContaining({
        route: "backend",
        faqVersion: "faq-v1",
        fallbackReason: "dynamic_or_transactional_request",
        latencyMs: expect.any(Number),
      }),
    ]);
  });

  it("answers a local FAQ even when no backend agent is configured", async () => {
    const provider = new CapturingProvider();
    const faqRouter = new VoiceFaqRouter(
      parseApprovedFaqCatalog({
        version: "faq-v1",
        restaurant: "Haiyen",
        faqs: [
          {
            id: "restaurant.parking",
            answer: "We don't have parking.",
            matchPhrases: ["parking"],
          },
        ],
      }),
    );
    const manager = new VoiceSessionManager(
      provider,
      new MemorySessionStore(),
      silentLogger,
      () => "local-only-session",
      undefined,
      8_000,
      faqRouter,
    );
    await manager.createSession(undefined, undefined, {
      backendContext: {},
    });
    const handleBusinessRequest =
      provider.options[0]?.handleBusinessRequest;
    expect(handleBusinessRequest).toBeDefined();
    if (handleBusinessRequest === undefined) {
      throw new Error("Business request handler was not configured");
    }

    await expect(
      handleBusinessRequest("Hello!"),
    ).resolves.toBe("Hi! How can I help?");
    await expect(
      handleBusinessRequest("Is parking available?"),
    ).resolves.toBe("We don't have parking.");
    await expect(
      handleBusinessRequest("Could you say that again?"),
    ).resolves.toBe("We don't have parking.");
  });
});
