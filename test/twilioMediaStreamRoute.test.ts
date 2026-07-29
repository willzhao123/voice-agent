import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import type {
  TwilioSignatureInput,
  TwilioSignatureValidator,
} from "../src/adapters/twilio/twilioSignatureValidator.js";
import { buildApp } from "../src/app.js";
import type {
  RealtimeEventListener,
  RealtimeProvider,
  RealtimeSession,
  RealtimeSessionOptions,
} from "../src/ports/realtimeProvider.js";
import { createLogger } from "../src/shared/logger.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const silentLogger = createLogger("silent");

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

class AllowSignatureValidator
implements TwilioSignatureValidator {
  input: TwilioSignatureInput | undefined;

  isConfigured(): boolean {
    return true;
  }

  validate(input: TwilioSignatureInput): boolean {
    this.input = input;
    return true;
  }
}

class MediaTrackingProvider implements RealtimeProvider {
  options: RealtimeSessionOptions | undefined;
  listener: RealtimeEventListener | undefined;
  readonly audio: Buffer[] = [];
  closeCalls = 0;
  openCalls = 0;
  interruptCalls = 0;
  interruptPromise: Promise<void> | undefined;

  async initialize(): Promise<void> {}

  async openSession(
    options: RealtimeSessionOptions,
    listener: RealtimeEventListener,
  ): Promise<RealtimeSession> {
    this.openCalls += 1;
    this.options = options;
    this.listener = listener;
    listener({
      type: "session.ready",
      sessionId: options.sessionId,
    });

    return {
      sendInputAudio: async (audio) => {
        this.audio.push(Buffer.from(audio));
      },
      async commitInputAudio() {},
      async sendText() {},
      interrupt: async () => {
        this.interruptCalls += 1;
        await this.interruptPromise;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }
}

async function createHarness(
  options: {
    maxMessageBytes?: number;
    idleTimeoutMs?: number;
    maxSessionDurationMs?: number;
    heartbeatIntervalMs?: number;
  } = {},
) {
  const provider = new MediaTrackingProvider();
  const validator = new AllowSignatureValidator();
  const app = await buildApp({
    logger: silentLogger,
    realtimeProvider: provider,
    twilioEnabled: true,
    twilioSignatureValidator: validator,
    publicBaseUrl: "https://voice.example.com",
    twilioMediaStreamOptions: {
      heartbeatIntervalMs: 10_000,
      ...options,
    },
  });
  apps.push(app);
  await app.ready();

  const messages: Record<string, unknown>[] = [];
  const socket = await app.injectWS(
    "/v1/twilio/media",
    {
      headers: {
        "x-twilio-signature": "media-signature",
      },
    },
    {
      onInit(websocket) {
        websocket.on("message", (data) => {
          messages.push(
            JSON.parse(data.toString()) as Record<string, unknown>,
          );
        });
      },
    },
  );

  return { app, messages, provider, socket, validator };
}

function sendConnected(socket: WebSocket): void {
  socket.send(JSON.stringify({
    event: "connected",
    protocol: "Call",
    version: "1.0.0",
  }));
}

function sendStart(socket: WebSocket): void {
  socket.send(JSON.stringify({
    event: "start",
    sequenceNumber: "1",
    streamSid: "MZ123",
    start: {
      accountSid: "AC123",
      streamSid: "MZ123",
      callSid: "CA123",
      tracks: ["inbound"],
      mediaFormat: {
        encoding: "audio/x-mulaw",
        sampleRate: 8_000,
        channels: 1,
      },
      customParameters: {},
    },
  }));
}

function sendMedia(
  socket: WebSocket,
  sequenceNumber: number,
  audio: Buffer,
): void {
  socket.send(JSON.stringify({
    event: "media",
    sequenceNumber: String(sequenceNumber),
    streamSid: "MZ123",
    media: {
      track: "inbound",
      chunk: String(sequenceNumber - 1),
      timestamp: String((sequenceNumber - 2) * 20),
      payload: audio.toString("base64"),
    },
  }));
}

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

describe("GET /v1/twilio/media", () => {
  it("relays μ-law audio bidirectionally and closes on stop", async () => {
    const {
      messages,
      provider,
      socket,
      validator,
    } = await createHarness();
    sendConnected(socket);
    sendStart(socket);

    const inboundAudio = Buffer.from([0xff, 0x7f, 0x00, 0x80]);
    socket.send(JSON.stringify({
      event: "dtmf",
      sequenceNumber: "2",
      streamSid: "MZ123",
      dtmf: {
        track: "inbound_track",
        digit: "1",
      },
    }));
    socket.send(JSON.stringify({
      event: "mark",
      sequenceNumber: "3",
      streamSid: "MZ123",
      mark: {
        name: "assistant-audio-1",
      },
    }));
    socket.send(JSON.stringify({
      event: "media",
      sequenceNumber: "4",
      streamSid: "MZ123",
      media: {
        track: "inbound",
        chunk: "1",
        timestamp: "0",
        payload: inboundAudio.toString("base64"),
      },
    }));

    await waitFor(() => provider.audio.length === 1);
    expect(provider.options).toMatchObject({
      sessionId: expect.any(String),
      audioFormat: {
        encoding: "g711_ulaw",
        sampleRate: 8_000,
      },
      turnDetection: "server_vad",
    });
    expect(provider.audio).toEqual([inboundAudio]);
    expect(validator.input).toEqual({
      signature: "media-signature",
      url: "wss://voice.example.com/v1/twilio/media",
    });

    const outboundAudio = Buffer.from([0x10, 0x20, 0x30]);
    provider.listener?.({
      type: "output_audio.delta",
      audio: outboundAudio,
    });
    await waitFor(() => messages.length === 1);
    expect(messages[0]).toEqual({
      event: "media",
      streamSid: "MZ123",
      media: {
        payload: outboundAudio.toString("base64"),
      },
    });

    const closePromise = once(socket, "close");
    socket.send(JSON.stringify({
      event: "stop",
      sequenceNumber: "5",
      streamSid: "MZ123",
      stop: {
        accountSid: "AC123",
        callSid: "CA123",
      },
    }));
    await closePromise;
    await waitFor(() => provider.closeCalls === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(provider.closeCalls).toBe(1);
  });

  it("closes the provider session when Twilio disconnects", async () => {
    const { provider, socket } = await createHarness();
    sendConnected(socket);
    sendStart(socket);
    await waitFor(() => provider.options !== undefined);

    socket.terminate();
    await waitFor(() => provider.closeCalls === 1);
  });

  it("clears playback, interrupts once, and keeps accepting caller audio", async () => {
    const { messages, provider, socket } = await createHarness();
    sendConnected(socket);
    sendStart(socket);
    await waitFor(() => provider.listener !== undefined);

    provider.listener?.({ type: "response.started" });
    const outboundAudio = Buffer.from([0x10, 0x20, 0x30]);
    provider.listener?.({
      type: "output_audio.delta",
      audio: outboundAudio,
    });
    provider.listener?.({ type: "output_audio.completed" });

    await waitFor(() => messages.length === 2);
    expect(messages[0]).toEqual({
      event: "media",
      streamSid: "MZ123",
      media: {
        payload: outboundAudio.toString("base64"),
      },
    });
    expect(messages[1]).toEqual({
      event: "mark",
      streamSid: "MZ123",
      mark: {
        name: "assistant-response-1",
      },
    });

    provider.listener?.({ type: "input_audio.started" });
    provider.listener?.({ type: "input_audio.started" });
    await waitFor(() => provider.interruptCalls === 1);
    expect(
      messages.filter((message) => message.event === "clear"),
    ).toHaveLength(2);

    socket.send(JSON.stringify({
      event: "mark",
      sequenceNumber: "2",
      streamSid: "MZ123",
      mark: {
        name: "assistant-response-1",
      },
    }));
    const firstCallerAudio = Buffer.from([0xff, 0x7f]);
    const nextCallerAudio = Buffer.from([0x00, 0x80]);
    sendMedia(socket, 3, firstCallerAudio);
    sendMedia(socket, 4, nextCallerAudio);

    await waitFor(() => provider.audio.length === 2);
    expect(provider.audio).toEqual([
      firstCallerAudio,
      nextCallerAudio,
    ]);

    provider.listener?.({ type: "response.interrupted" });
    expect(
      messages.filter((message) => message.event === "clear"),
    ).toHaveLength(2);
  });

  it("cleans up exactly once when the socket closes during interruption", async () => {
    const { provider, socket } = await createHarness();
    let releaseInterrupt: (() => void) | undefined;
    provider.interruptPromise = new Promise<void>((resolve) => {
      releaseInterrupt = resolve;
    });
    sendConnected(socket);
    sendStart(socket);
    await waitFor(() => provider.listener !== undefined);

    provider.listener?.({ type: "response.started" });
    provider.listener?.({ type: "input_audio.started" });
    await waitFor(() => provider.interruptCalls === 1);

    socket.terminate();
    releaseInterrupt?.();
    await waitFor(() => provider.closeCalls === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(provider.closeCalls).toBe(1);
  });

  it("rejects media before start without creating a session", async () => {
    const { provider, socket } = await createHarness();
    sendConnected(socket);
    const closePromise = once(socket, "close");
    socket.send(JSON.stringify({
      event: "media",
      sequenceNumber: "1",
      streamSid: "MZ123",
      media: {
        track: "inbound",
        chunk: "1",
        timestamp: "0",
        payload: Buffer.from([0xff]).toString("base64"),
      },
    }));

    const [code] = await closePromise;
    expect(code).toBe(1008);
    expect(provider.openCalls).toBe(0);
    expect(provider.audio).toEqual([]);
  });

  it("rejects an invalid Twilio audio format", async () => {
    const { provider, socket } = await createHarness();
    sendConnected(socket);
    const closePromise = once(socket, "close");
    socket.send(JSON.stringify({
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ123",
      start: {
        accountSid: "AC123",
        streamSid: "MZ123",
        callSid: "CA123",
        tracks: ["inbound"],
        mediaFormat: {
          encoding: "audio/pcm",
          sampleRate: 16_000,
          channels: 2,
        },
      },
    }));

    const [code] = await closePromise;
    expect(code).toBe(1008);
    expect(provider.openCalls).toBe(0);
  });

  it("rejects duplicate start and closes its one session once", async () => {
    const { provider, socket } = await createHarness();
    sendConnected(socket);
    sendStart(socket);
    await waitFor(() => provider.openCalls === 1);

    const closePromise = once(socket, "close");
    socket.send(JSON.stringify({
      event: "start",
      sequenceNumber: "2",
      streamSid: "MZ123",
      start: {
        accountSid: "AC123",
        streamSid: "MZ123",
        callSid: "CA123",
        tracks: ["inbound"],
        mediaFormat: {
          encoding: "audio/x-mulaw",
          sampleRate: 8_000,
          channels: 1,
        },
      },
    }));

    const [code] = await closePromise;
    expect(code).toBe(1008);
    await waitFor(() => provider.closeCalls === 1);
    expect(provider.openCalls).toBe(1);
  });

  it("rejects oversized messages", async () => {
    const { provider, socket } = await createHarness({
      maxMessageBytes: 16,
    });
    const closePromise = once(socket, "close");
    sendConnected(socket);

    const [code] = await closePromise;
    expect(code).toBe(1009);
    expect(provider.openCalls).toBe(0);
  });

  it("closes an idle session and its provider connection", async () => {
    const { provider, socket } = await createHarness({
      idleTimeoutMs: 30,
      maxSessionDurationMs: 10_000,
    });
    sendConnected(socket);
    sendStart(socket);
    await waitFor(() => provider.openCalls === 1);
    const closePromise = once(socket, "close");

    await closePromise;
    await waitFor(() => provider.closeCalls === 1);
  });
});
