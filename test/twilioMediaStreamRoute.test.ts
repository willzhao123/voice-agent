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

  async initialize(): Promise<void> {}

  async openSession(
    options: RealtimeSessionOptions,
    listener: RealtimeEventListener,
  ): Promise<RealtimeSession> {
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
      async interrupt() {},
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }
}

async function createHarness() {
  const provider = new MediaTrackingProvider();
  const validator = new AllowSignatureValidator();
  const app = await buildApp({
    logger: silentLogger,
    realtimeProvider: provider,
    twilioSignatureValidator: validator,
    twilioPublicBaseUrl: "https://voice.example.com",
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
    sendStart(socket);

    const inboundAudio = Buffer.from([0xff, 0x7f, 0x00, 0x80]);
    socket.send(JSON.stringify({
      event: "media",
      sequenceNumber: "2",
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
      sequenceNumber: "3",
      streamSid: "MZ123",
      stop: {
        accountSid: "AC123",
        callSid: "CA123",
      },
    }));
    await closePromise;
    await waitFor(() => provider.closeCalls === 1);
  });

  it("closes the provider session when Twilio disconnects", async () => {
    const { provider, socket } = await createHarness();
    sendStart(socket);
    await waitFor(() => provider.options !== undefined);

    socket.terminate();
    await waitFor(() => provider.closeCalls === 1);
  });
});
