import { describe, expect, it } from "vitest";

import {
  OpenAIRealtimeProvider,
  type OpenAIRealtimeSocket,
  type OpenAIRealtimeSocketFactory,
} from "../src/adapters/realtime/openaiRealtimeProvider.js";
import type { RealtimeProviderEvent } from "../src/ports/realtimeProvider.js";

class FakeOpenAIRealtimeSocket implements OpenAIRealtimeSocket {
  readonly sentMessages: string[] = [];
  closed = false;

  private readonly messageListeners = new Set<
    (message: string) => void
  >();
  private readonly errorListeners = new Set<
    (error: Error) => void
  >();
  private readonly closeListeners = new Set<() => void>();

  async open(): Promise<void> {}

  send(message: string): void {
    this.sentMessages.push(message);
    const event = JSON.parse(message) as { type?: string };
    if (event.type === "session.update") {
      queueMicrotask(() => {
        this.emitMessage({
          type: "session.updated",
          session: { id: "provider-session-1" },
        });
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  onMessage(listener: (message: string) => void): void {
    this.messageListeners.add(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.add(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  emitMessage(message: object | string): void {
    const serialized =
      typeof message === "string"
        ? message
        : JSON.stringify(message);
    for (const listener of this.messageListeners) {
      listener(serialized);
    }
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

function createProviderHarness() {
  const socket = new FakeOpenAIRealtimeSocket();
  let capturedUrl = "";
  let capturedHeaders: Readonly<Record<string, string>> = {};
  const socketFactory: OpenAIRealtimeSocketFactory = (
    url,
    headers,
  ) => {
    capturedUrl = url;
    capturedHeaders = headers;
    return socket;
  };
  const provider = new OpenAIRealtimeProvider({
    apiKey: "server-only-test-key",
    model: "gpt-realtime-2.1",
    socketFactory,
    sessionReadyTimeoutMs: 100,
  });

  return {
    provider,
    socket,
    get url() {
      return capturedUrl;
    },
    get headers() {
      return capturedHeaders;
    },
  };
}

function parseSentMessages(
  socket: FakeOpenAIRealtimeSocket,
): Record<string, unknown>[] {
  return socket.sentMessages.map(
    (message) => JSON.parse(message) as Record<string, unknown>,
  );
}

describe("OpenAIRealtimeProvider", () => {
  it("maps normalized commands to current OpenAI Realtime events", async () => {
    const harness = createProviderHarness();
    const events: RealtimeProviderEvent[] = [];

    await harness.provider.initialize();
    const session = await harness.provider.openSession(
      {
        sessionId: "voice-session-1",
        instructions: "Be concise and helpful.",
      },
      (event) => events.push(event),
    );

    expect(harness.url).toBe(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
    );
    expect(harness.headers).toEqual({
      Authorization: "Bearer server-only-test-key",
    });

    const sessionUpdate = parseSentMessages(harness.socket)[0];
    expect(sessionUpdate).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions: "Be concise and helpful.",
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24_000,
            },
            transcription: {
              model: "gpt-4o-mini-transcribe",
            },
            turn_detection: null,
          },
          output: {
            format: {
              type: "audio/pcm",
              rate: 24_000,
            },
          },
        },
      },
    });

    const audio = Buffer.from([1, 2, 3, 4]);
    await session.sendInputAudio(audio);
    await session.commitInputAudio();
    await session.sendText("Hello from a test");
    await session.interrupt();
    await session.close();

    expect(parseSentMessages(harness.socket).slice(1)).toEqual([
      {
        type: "input_audio_buffer.append",
        audio: audio.toString("base64"),
      },
      { type: "input_audio_buffer.commit" },
      { type: "response.create" },
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Hello from a test",
            },
          ],
        },
      },
      { type: "response.create" },
      { type: "response.cancel" },
    ]);
    expect(events).toEqual([
      {
        type: "session.ready",
        sessionId: "voice-session-1",
      },
      { type: "input_audio.started" },
      { type: "input_audio.stopped" },
      {
        type: "transcript.user.final",
        transcript: "Hello from a test",
      },
    ]);
    expect(harness.socket.closed).toBe(true);
    expect(harness.socket.sentMessages.join("")).not.toContain(
      "server-only-test-key",
    );
  });

  it("normalizes streamed output, transcripts, completion, and errors", async () => {
    const harness = createProviderHarness();
    const events: RealtimeProviderEvent[] = [];
    const session = await harness.provider.openSession(
      { sessionId: "voice-session-2" },
      (event) => events.push(event),
    );
    events.length = 0;

    const outputAudio = Buffer.from("assistant audio");
    expect(() => {
      harness.socket.emitMessage({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "User transcript",
      });
      harness.socket.emitMessage({
        type: "response.created",
        response: { id: "response-1" },
      });
      harness.socket.emitMessage({
        type: "response.output_audio_transcript.delta",
        delta: "Assistant ",
      });
      harness.socket.emitMessage({
        type: "response.output_audio.delta",
        delta: outputAudio.toString("base64"),
      });
      harness.socket.emitMessage({
        type: "response.output_audio_transcript.done",
        transcript: "Assistant response",
      });
      harness.socket.emitMessage({
        type: "response.output_audio.done",
      });
      harness.socket.emitMessage({
        type: "response.done",
        response: { status: "completed" },
      });
      harness.socket.emitMessage({
        type: "response.done",
        response: { status: "cancelled" },
      });
      harness.socket.emitMessage({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_event",
          message: "The event was invalid",
        },
      });
      harness.socket.emitMessage("not-json");
      harness.socket.emitError(new Error("socket failure"));
    }).not.toThrow();

    expect(events).toEqual([
      {
        type: "transcript.user.final",
        transcript: "User transcript",
      },
      { type: "response.started" },
      {
        type: "transcript.agent.delta",
        transcript: "Assistant ",
      },
      {
        type: "output_audio.delta",
        audio: outputAudio,
      },
      {
        type: "transcript.agent.final",
        transcript: "Assistant response",
      },
      { type: "output_audio.completed" },
      { type: "response.completed" },
      { type: "response.interrupted" },
      {
        type: "error",
        code: "invalid_event",
        message: "The event was invalid",
        recoverable: true,
      },
      {
        type: "error",
        code: "invalid_provider_event",
        message: "OpenAI sent an invalid realtime event",
        recoverable: true,
      },
      {
        type: "error",
        code: "provider_connection_error",
        message: "The OpenAI realtime connection failed",
        recoverable: false,
      },
    ]);

    await session.close();
  });
});
