import { describe, expect, it } from "vitest";

import { parseEnvironment } from "../src/config/env.js";

describe("environment configuration", () => {
  it("applies safe development defaults", () => {
    expect(parseEnvironment({})).toEqual({
      HOST: "0.0.0.0",
      PORT: 3000,
      LOG_LEVEL: "info",
      REALTIME_PROVIDER: "mock",
      OPENAI_REALTIME_MODEL: "gpt-realtime-2.1",
      VOICE_INSTRUCTIONS: "You are a helpful voice assistant.",
      MAX_JSON_MESSAGE_BYTES: 65_536,
      MAX_AUDIO_FRAME_BYTES: 262_144,
      IDLE_SESSION_TIMEOUT_MS: 60_000,
      MAX_SESSION_DURATION_MS: 1_800_000,
      WEBSOCKET_HEARTBEAT_INTERVAL_MS: 30_000,
      WEBSOCKET_MAX_PENDING_MESSAGES: 32,
      WEBSOCKET_MAX_BUFFERED_BYTES: 1_048_576,
    });
  });

  it("requires an API key only for the OpenAI provider", () => {
    expect(() => parseEnvironment({
      REALTIME_PROVIDER: "openai",
    })).toThrow(
      "Invalid environment configuration: OPENAI_API_KEY: " +
        "is required when REALTIME_PROVIDER is set to openai",
    );

    expect(parseEnvironment({
      REALTIME_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
    })).toMatchObject({
      REALTIME_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
    });
  });

  it("never includes API key values in validation errors", () => {
    const secret = "sk-secret-that-must-not-be-logged";

    expect(() => parseEnvironment({
      PORT: "not-a-port",
      OPENAI_API_KEY: secret,
    })).toThrowError(
      expect.not.objectContaining({
        message: expect.stringContaining(secret),
      }),
    );
  });
});
