import { describe, expect, it } from "vitest";

import { MockRealtimeProvider } from "../src/adapters/realtime/mockRealtimeProvider.js";
import { MemorySessionStore } from "../src/adapters/storage/memorySessionStore.js";
import {
  VoiceSessionManager,
  type VoiceSessionEvent,
} from "../src/application/voiceSessionManager.js";
import { createLogger } from "../src/shared/logger.js";

const silentLogger = createLogger("silent");

describe("VoiceSessionManager", () => {
  it("orchestrates a complete session through injected ports", async () => {
    const store = new MemorySessionStore();
    const events: VoiceSessionEvent[] = [];
    const manager = new VoiceSessionManager(
      new MockRealtimeProvider(),
      store,
      silentLogger,
      () => "session-1",
    );

    const handle = await manager.startSession((event) => events.push(event));
    await handle.receive({
      type: "audio.append",
      audio: Buffer.from("test-audio"),
    });
    await handle.receive({ type: "audio.commit" });
    await handle.receive({
      type: "text.send",
      text: "Hello from a test",
    });
    await handle.receive({ type: "response.interrupt" });
    await handle.receive({ type: "ping" });
    await handle.close();

    expect(events.map((event) => event.type)).toEqual([
      "session.ready",
      "session.started",
      "input_audio.started",
      "input_audio.stopped",
      "transcript.user.final",
      "response.started",
      "transcript.agent.delta",
      "transcript.agent.final",
      "output_audio.delta",
      "output_audio.completed",
      "response.completed",
      "transcript.user.final",
      "response.started",
      "transcript.agent.delta",
      "transcript.agent.final",
      "output_audio.delta",
      "output_audio.completed",
      "response.completed",
      "response.interrupted",
      "pong",
      "session.ended",
    ]);
    expect(handle.session.status).toBe("closed");
    await expect(store.findById("session-1")).resolves.toMatchObject({
      id: "session-1",
      status: "closed",
    });
  });
});
