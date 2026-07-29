import { afterEach, describe, expect, it } from "vitest";

import type {
  TwilioSignatureInput,
  TwilioSignatureValidator,
} from "../src/adapters/twilio/twilioSignatureValidator.js";
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
  it("validates the webhook and returns bidirectional Stream TwiML", async () => {
    const validator = new RecordingSignatureValidator(true);
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
      twilioEnabled: true,
      twilioSignatureValidator: validator,
      publicBaseUrl: "https://voice.example.com",
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/twilio/voice",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "test-signature",
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
    expect(validator.inputs).toEqual([
      {
        signature: "test-signature",
        url: "https://voice.example.com/v1/twilio/voice",
        params: {
          CallSid: "CA123",
          From: "+15551234567",
        },
      },
    ]);
  });

  it("rejects a webhook with an invalid signature", async () => {
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
      twilioEnabled: true,
      twilioSignatureValidator:
        new RecordingSignatureValidator(false),
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
