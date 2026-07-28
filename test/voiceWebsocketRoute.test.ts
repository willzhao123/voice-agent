import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { MockRealtimeProvider } from "../src/adapters/realtime/mockRealtimeProvider.js";
import { MemorySessionStore } from "../src/adapters/storage/memorySessionStore.js";
import { buildApp } from "../src/app.js";
import type { VoiceSessionEvent } from "../src/application/voiceSessionManager.js";
import { createLogger } from "../src/shared/logger.js";

const silentLogger = createLogger("silent");
type WireVoiceSessionEvent =
  | Exclude<VoiceSessionEvent, { type: "output_audio.delta" }>
  | { type: "output_audio.delta"; audio: string };

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function createMessageCollector() {
  const events: WireVoiceSessionEvent[] = [];
  let notify = (): void => {};

  return {
    listen(socket: WebSocket): void {
      socket.on("message", (data) => {
        events.push(JSON.parse(data.toString()) as WireVoiceSessionEvent);
        notify();
        notify = (): void => {};
      });
    },
    async next(
      type: WireVoiceSessionEvent["type"],
    ): Promise<WireVoiceSessionEvent> {
      while (true) {
        const index = events.findIndex((event) => event.type === type);
        if (index >= 0) {
          const event = events.splice(index, 1)[0];
          if (event !== undefined) {
            return event;
          }
        }

        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };
}

describe("voice WebSocket route", () => {
  it("runs a session with the functional mock provider", async () => {
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
      sessionStore: new MemorySessionStore(),
    });
    apps.push(app);
    await app.ready();

    const collector = createMessageCollector();
    const socket = await app.injectWS("/ws", {}, {
      onInit: (websocket) => collector.listen(websocket),
    });

    await expect(collector.next("session.started")).resolves.toMatchObject({
      type: "session.started",
    });

    socket.send(JSON.stringify({
      type: "audio.append",
      audio: Buffer.from("test-audio").toString("base64"),
    }));
    await expect(collector.next("input_audio.started")).resolves.toEqual({
      type: "input_audio.started",
    });

    socket.send(JSON.stringify({ type: "audio.commit" }));
    await expect(collector.next("output_audio.delta")).resolves.toEqual({
      type: "output_audio.delta",
      audio: Buffer.from("test-audio").toString("base64"),
    });
    await expect(collector.next("response.completed")).resolves.toEqual({
      type: "response.completed",
    });

    const closePromise = once(socket, "close");
    socket.close();
    await closePromise;
  });
});
