import { describe, expect, it } from "vitest";

import { MockRealtimeProvider } from "../src/adapters/realtime/mockRealtimeProvider.js";
import type { RealtimeProviderEvent } from "../src/ports/realtimeProvider.js";

describe("RealtimeProvider", () => {
  it("normalizes the complete mock session lifecycle", async () => {
    const provider = new MockRealtimeProvider();
    const events: RealtimeProviderEvent[] = [];
    const session = await provider.openSession(
      { sessionId: "realtime-session-1" },
      (event) => events.push(event),
    );
    const inputAudio = Buffer.from([1, 2, 3, 4]);

    await session.sendInputAudio(inputAudio);
    await session.commitInputAudio();
    await session.sendText("Hello mock provider");
    await session.interrupt();
    await session.close();

    await expect(
      session.sendText("This session is closed"),
    ).rejects.toThrow("Mock realtime session is closed");

    expect(events.map((event) => event.type)).toEqual([
      "session.ready",
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
      "error",
    ]);

    const outputAudioEvents = events.filter(
      (event) => event.type === "output_audio.delta",
    );
    expect(outputAudioEvents).toHaveLength(2);
    expect(Buffer.isBuffer(outputAudioEvents[0]?.audio)).toBe(true);
    expect(outputAudioEvents[0]?.audio).toEqual(inputAudio);
    expect(outputAudioEvents[0]?.audio).not.toBe(inputAudio);
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Mock realtime session is closed",
      code: "session_closed",
      recoverable: false,
    });
  });
});
