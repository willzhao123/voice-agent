import { afterEach, describe, expect, it } from "vitest";
import twilio from "twilio";

import type {
  TwilioSignatureInput,
  TwilioSignatureValidator,
} from "../src/adapters/twilio/twilioSignatureValidator.js";
import { DefaultTwilioSignatureValidator } from "../src/adapters/twilio/twilioSignatureValidator.js";
import { MockRealtimeProvider } from "../src/adapters/realtime/mockRealtimeProvider.js";
import { buildApp } from "../src/app.js";
import { createLogger } from "../src/shared/logger.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const silentLogger = createLogger("silent");

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

class RecordingSignatureValidator
implements TwilioSignatureValidator {
  readonly inputs: TwilioSignatureInput[] = [];

  constructor(private readonly valid: boolean) {}

  isConfigured(): boolean {
    return true;
  }

  validate(input: TwilioSignatureInput): boolean {
    this.inputs.push(input);
    return this.valid;
  }
}

describe("POST /v1/twilio/voice", () => {
  it("accepts a valid official Twilio webhook signature", async () => {
    const authToken = "test-only-twilio-auth-token";
    const publicUrl =
      "https://voice.example.com/v1/twilio/voice";
    const params = {
      CallSid: "CA123",
      From: "+15551234567",
    };
    const signature = twilio.getExpectedTwilioSignature(
      authToken,
      publicUrl,
      params,
    );
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
      twilioEnabled: true,
      twilioSignatureValidator:
        new DefaultTwilioSignatureValidator(authToken),
      publicBaseUrl: "https://voice.example.com",
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/twilio/voice",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
      payload: "CallSid=CA123&From=%2B15551234567",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/xml");
    expect(response.body).toContain("<Connect>");
    expect(response.body).toContain(
      '<Stream url="wss://voice.example.com/v1/twilio/media"/>',
    );
  });

  it("rejects an invalid official Twilio webhook signature", async () => {
    const authToken = "test-only-twilio-auth-token";
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
      twilioEnabled: true,
      twilioSignatureValidator:
        new DefaultTwilioSignatureValidator(authToken),
      publicBaseUrl: "https://voice.example.com",
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/twilio/voice",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "invalid",
      },
      payload: "CallSid=CA123",
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects a missing Twilio webhook signature", async () => {
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
      twilioEnabled: true,
      twilioSignatureValidator:
        new DefaultTwilioSignatureValidator(
          "test-only-twilio-auth-token",
        ),
      publicBaseUrl: "https://voice.example.com",
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/twilio/voice",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "CallSid=CA123",
    });

    expect(response.statusCode).toBe(403);
  });

  it("allows an explicit signature bypass for local automated tests", async () => {
    const validator = new RecordingSignatureValidator(false);
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
      twilioEnabled: true,
      twilioValidateSignatures: false,
      twilioSignatureValidator: validator,
      publicBaseUrl: "https://localhost",
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/twilio/voice",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "CallSid=CA-test",
    });

    expect(response.statusCode).toBe(200);
    expect(validator.inputs).toEqual([]);
  });

  it("refuses to disable signatures for a non-loopback public URL", async () => {
    await expect(buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
      twilioEnabled: true,
      twilioValidateSignatures: false,
      publicBaseUrl: "https://voice.example.com",
    })).rejects.toThrow(
      "Twilio signature validation can be disabled only for local automated testing",
    );
  });

  it("does not register the webhook when Twilio is disabled", async () => {
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/twilio/voice",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "CallSid=CA-test",
    });

    expect(response.statusCode).toBe(404);
  });
});
