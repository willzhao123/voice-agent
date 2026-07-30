import { describe, expect, it, vi } from "vitest";

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
  it("registers only the business router tool and executes each call ID once", async () => {
    const harness = createProviderHarness();
    const delegate = vi.fn(async (message: string) =>
      `Backend answer for: ${message}`
    );
    const session = await harness.provider.openSession(
      {
        sessionId: "delegating-session",
        handleBusinessRequest: delegate,
      },
      () => {},
    );

    expect(parseSentMessages(harness.socket)[0]).toMatchObject({
      type: "session.update",
      session: {
        output_modalities: ["text"],
        tool_choice: "required",
        tools: [
          {
            type: "function",
            name: "route_business_request",
            parameters: {
              type: "object",
              required: ["user_message"],
              additionalProperties: false,
            },
          },
        ],
      },
    });

    const functionCallResponse = {
      type: "response.done",
      response: {
        id: "routing-response-1",
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "route_business_request",
            call_id: "call-1",
            arguments: JSON.stringify({
              user_message: "Hi, do you have beef pho?",
            }),
          },
        ],
      },
    };
    harness.socket.emitMessage(functionCallResponse);
    harness.socket.emitMessage(functionCallResponse);

    await waitFor(() => parseSentMessages(harness.socket).length === 3);

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate).toHaveBeenCalledWith(
      "Hi, do you have beef pho?",
    );
    expect(parseSentMessages(harness.socket)[1]).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-1",
        output: JSON.stringify({
          response:
            "Backend answer for: Hi, do you have beef pho?",
        }),
      },
    });
    expect(parseSentMessages(harness.socket)[2]).toMatchObject({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: expect.stringContaining(
          "Speak only the authoritative function result",
        ),
        tools: [],
        tool_choice: "none",
        metadata: {
          voice_stage: "final_speaking",
          route_tool_call_id: "call-1",
        },
      },
    });

    await session.close();
  });

  it("suppresses routing-stage audio and emits exactly one final local-FAQ response", async () => {
    const harness = createProviderHarness();
    const events: RealtimeProviderEvent[] = [];
    const route = vi.fn(async () =>
      "We're open from noon to 9 PM every day."
    );
    const session = await harness.provider.openSession(
      {
        sessionId: "local-faq-routing-session",
        handleBusinessRequest: route,
      },
      (event) => events.push(event),
    );
    events.length = 0;

    harness.socket.emitMessage({
      type: "response.created",
      response: {
        id: "routing-response",
        metadata: { voice_stage: "routing" },
      },
    });
    harness.socket.emitMessage({
      type: "response.output_audio.delta",
      response_id: "routing-response",
      delta: Buffer.from("forbidden preamble").toString("base64"),
    });
    harness.socket.emitMessage({
      type: "response.output_audio.done",
      response_id: "routing-response",
    });
    harness.socket.emitMessage({
      type: "response.done",
      response: {
        id: "routing-response",
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "route_business_request",
            call_id: "local-faq-call",
            arguments: JSON.stringify({
              user_message: "What are your hours?",
            }),
          },
        ],
      },
    });

    await waitFor(() => parseSentMessages(harness.socket).length === 3);
    expect(events).toEqual([]);
    expect(route).toHaveBeenCalledOnce();

    harness.socket.emitMessage({
      type: "response.created",
      response: {
        id: "final-response",
        metadata: { voice_stage: "final_speaking" },
      },
    });
    harness.socket.emitMessage({
      type: "response.output_audio_transcript.delta",
      response_id: "final-response",
      delta: "We're open from noon to 9 PM every day.",
    });
    const finalAudio = Buffer.from("authoritative final audio");
    harness.socket.emitMessage({
      type: "response.output_audio.delta",
      response_id: "final-response",
      delta: finalAudio.toString("base64"),
    });
    harness.socket.emitMessage({
      type: "response.output_audio_transcript.done",
      response_id: "final-response",
      transcript: "We're open from noon to 9 PM every day.",
    });
    harness.socket.emitMessage({
      type: "response.output_audio.done",
      response_id: "final-response",
    });
    harness.socket.emitMessage({
      type: "response.done",
      response: {
        id: "final-response",
        status: "completed",
        output: [],
      },
    });

    expect(events).toEqual([
      { type: "response.started" },
      {
        type: "transcript.agent.delta",
        transcript: "We're open from noon to 9 PM every day.",
      },
      {
        type: "output_audio.delta",
        audio: finalAudio,
      },
      {
        type: "transcript.agent.final",
        transcript: "We're open from noon to 9 PM every day.",
      },
      { type: "output_audio.completed" },
      { type: "response.completed" },
    ]);

    await session.close();
  });

  it("emits no backend preamble and prevents the final response from routing again", async () => {
    const harness = createProviderHarness();
    const events: RealtimeProviderEvent[] = [];
    let resolveBackend: (value: string) => void = () => {};
    const backendResult = new Promise<string>((resolve) => {
      resolveBackend = resolve;
    });
    const route = vi.fn(() => backendResult);
    const session = await harness.provider.openSession(
      {
        sessionId: "backend-routing-session",
        handleBusinessRequest: route,
      },
      (event) => events.push(event),
    );
    events.length = 0;

    harness.socket.emitMessage({
      type: "response.output_audio.delta",
      response_id: "backend-routing-response",
      delta: Buffer.from("premature answer").toString("base64"),
    });
    harness.socket.emitMessage({
      type: "response.done",
      response: {
        id: "backend-routing-response",
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "route_business_request",
            call_id: "backend-call",
            arguments: JSON.stringify({
              user_message: "Do you have beef pho?",
            }),
          },
        ],
      },
    });

    await waitFor(() => route.mock.calls.length === 1);
    expect(events).toEqual([]);
    expect(parseSentMessages(harness.socket)).toHaveLength(1);

    resolveBackend("Yes, Combo Beef Pho is available.");
    await waitFor(() => parseSentMessages(harness.socket).length === 3);
    const finalCreate = parseSentMessages(harness.socket)[2];
    expect(finalCreate).toMatchObject({
      type: "response.create",
      response: {
        tools: [],
        tool_choice: "none",
        metadata: {
          voice_stage: "final_speaking",
          route_tool_call_id: "backend-call",
        },
      },
    });

    harness.socket.emitMessage({
      type: "response.created",
      response: {
        id: "backend-final-response",
        metadata: { voice_stage: "final_speaking" },
      },
    });
    harness.socket.emitMessage({
      type: "response.done",
      response: {
        id: "backend-final-response",
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "route_business_request",
            call_id: "forbidden-second-call",
            arguments: JSON.stringify({
              user_message: "Route this again",
            }),
          },
        ],
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(route).toHaveBeenCalledOnce();
    expect(parseSentMessages(harness.socket)).toHaveLength(3);

    await session.close();
  });

  it("configures G.711 μ-law audio and server VAD for telephony", async () => {
    const harness = createProviderHarness();
    const session = await harness.provider.openSession(
      {
        sessionId: "twilio-voice-session",
        audioFormat: {
          encoding: "g711_ulaw",
          sampleRate: 8_000,
        },
        turnDetection: "server_vad",
      },
      () => {},
    );

    expect(parseSentMessages(harness.socket)[0]).toMatchObject({
      type: "session.update",
      session: {
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcmu" },
          },
        },
      },
    });

    await session.close();
  });

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
