import { describe, expect, it } from "vitest";

import { MockRealtimeProvider } from "../src/adapters/realtime/mockRealtimeProvider.js";
import { MemorySessionStore } from "../src/adapters/storage/memorySessionStore.js";
import {
  VoiceSessionManager,
  type VoiceSessionEvent,
} from "../src/application/voiceSessionManager.js";
import {
  SessionClosedError,
  SessionNotFoundError,
} from "../src/shared/errors.js";
import { createLogger } from "../src/shared/logger.js";

const silentLogger = createLogger("silent");

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
});
