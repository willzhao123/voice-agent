import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { MockRealtimeProvider } from "../src/adapters/realtime/mockRealtimeProvider.js";
import { MemorySessionStore } from "../src/adapters/storage/memorySessionStore.js";
import { buildApp } from "../src/app.js";
import { createLogger } from "../src/shared/logger.js";

interface WireMessage {
  type: string;
  [key: string]: unknown;
}

const silentLogger = createLogger("silent");
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function createTestSocket() {
  const app = await buildApp({
    logger: silentLogger,
    realtimeProvider: new MockRealtimeProvider(),
    sessionStore: new MemorySessionStore(),
  });
  apps.push(app);
  await app.ready();

  const collector = createMessageCollector();
  const socket = await app.injectWS("/v1/voice", {}, {
    onInit: (websocket) => collector.listen(websocket),
  });

  return { collector, socket };
}

function createMessageCollector() {
  const jsonMessages: WireMessage[] = [];
  const binaryMessages: Buffer[] = [];
  let notify = (): void => {};

  return {
    listen(socket: WebSocket): void {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          binaryMessages.push(Buffer.from(data as Buffer));
        } else {
          jsonMessages.push(
            JSON.parse(data.toString()) as WireMessage,
          );
        }
        notify();
        notify = (): void => {};
      });
    },
    async nextJson(type: string): Promise<WireMessage> {
      while (true) {
        const index = jsonMessages.findIndex(
          (message) => message.type === type,
        );
        if (index >= 0) {
          const message = jsonMessages.splice(index, 1)[0];
          if (message !== undefined) {
            return message;
          }
        }

        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
    async nextBinary(): Promise<Buffer> {
      while (true) {
        const message = binaryMessages.shift();
        if (message !== undefined) {
          return message;
        }

        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  const closePromise = once(socket, "close");
  socket.close();
  await closePromise;
}

describe("GET /v1/voice", () => {
  it("supports the JSON session, text, and interruption protocol", async () => {
    const { collector, socket } = await createTestSocket();

    socket.send(JSON.stringify({
      type: "session.start",
      requestId: "request-1",
      instructions: "You are a helpful voice assistant.",
    }));

    await expect(collector.nextJson("session.created")).resolves.toMatchObject({
      type: "session.created",
      requestId: "request-1",
      sessionId: expect.any(String),
    });

    socket.send(JSON.stringify({
      type: "input.text",
      text: "Hello",
    }));
    await expect(
      collector.nextJson("transcript.user.final"),
    ).resolves.toEqual({
      type: "transcript.user.final",
      transcript: "Hello",
    });
    await expect(
      collector.nextJson("transcript.agent.delta"),
    ).resolves.toMatchObject({
      type: "transcript.agent.delta",
    });
    await expect(
      collector.nextJson("transcript.agent.final"),
    ).resolves.toMatchObject({
      type: "transcript.agent.final",
    });
    await expect(
      collector.nextJson("output_audio.completed"),
    ).resolves.toEqual({
      type: "output_audio.completed",
    });
    await expect(
      collector.nextJson("response.started"),
    ).resolves.toEqual({
      type: "response.started",
    });
    await expect(
      collector.nextJson("response.completed"),
    ).resolves.toEqual({
      type: "response.completed",
    });

    socket.send(JSON.stringify({ type: "response.interrupt" }));
    await expect(
      collector.nextJson("response.interrupted"),
    ).resolves.toEqual({
      type: "response.interrupted",
    });

    socket.send(JSON.stringify({ type: "session.end" }));
    await closeSocket(socket);
  });

  it("streams binary audio and recovers from invalid JSON messages", async () => {
    const { collector, socket } = await createTestSocket();

    socket.send(JSON.stringify({
      type: "input.text",
    }));
    await expect(collector.nextJson("error")).resolves.toMatchObject({
      type: "error",
      code: "invalid_message",
      recoverable: true,
    });

    socket.send(Buffer.from("audio-before-start"), { binary: true });
    await expect(collector.nextJson("error")).resolves.toEqual({
      type: "error",
      code: "session_not_started",
      message: "Send session.start before sending input",
      recoverable: true,
    });

    socket.send(JSON.stringify({
      type: "session.start",
      requestId: "request-2",
      instructions: "Test binary audio.",
    }));
    await collector.nextJson("session.created");

    const callerAudio = Buffer.from("caller-audio");
    socket.send(callerAudio, { binary: true });
    socket.send(JSON.stringify({ type: "input_audio.commit" }));

    await expect(collector.nextBinary()).resolves.toEqual(callerAudio);
    await expect(
      collector.nextJson("output_audio.completed"),
    ).resolves.toEqual({
      type: "output_audio.completed",
    });

    await closeSocket(socket);
  });
});
