import { describe, expect, it } from "vitest";
import twilio from "twilio";

import { DefaultTwilioSignatureValidator } from "../src/adapters/twilio/twilioSignatureValidator.js";

describe("DefaultTwilioSignatureValidator", () => {
  it("accepts authentic signatures and rejects tampered requests", () => {
    const authToken = "twilio-test-auth-token";
    const url = "https://voice.example.com/v1/twilio/voice";
    const params = {
      CallSid: "CA123",
      From: "+15551234567",
      To: "+15557654321",
    };
    const signature = twilio.getExpectedTwilioSignature(
      authToken,
      url,
      params,
    );
    const validator = new DefaultTwilioSignatureValidator(authToken);

    expect(validator.isConfigured()).toBe(true);
    expect(validator.validate({
      signature,
      url,
      params,
    })).toBe(true);
    expect(validator.validate({
      signature,
      url,
      params: { ...params, CallSid: "CA-tampered" },
    })).toBe(false);
  });

  it("rejects requests when the auth token or signature is absent", () => {
    const validator = new DefaultTwilioSignatureValidator(undefined);

    expect(validator.isConfigured()).toBe(false);
    expect(validator.validate({
      signature: undefined,
      url: "https://voice.example.com/v1/twilio/voice",
    })).toBe(false);
  });
});
