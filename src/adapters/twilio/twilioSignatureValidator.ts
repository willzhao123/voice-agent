import twilio from "twilio";

export interface TwilioSignatureInput {
  signature: string | undefined;
  url: string;
  params?: Readonly<Record<string, unknown>>;
}

export interface TwilioSignatureValidator {
  isConfigured(): boolean;
  validate(input: TwilioSignatureInput): boolean;
}

export class DefaultTwilioSignatureValidator
implements TwilioSignatureValidator {
  constructor(private readonly authToken: string | undefined) {}

  isConfigured(): boolean {
    return this.authToken !== undefined;
  }

  validate(input: TwilioSignatureInput): boolean {
    if (
      this.authToken === undefined ||
      input.signature === undefined
    ) {
      return false;
    }

    return twilio.validateRequest(
      this.authToken,
      input.signature,
      input.url,
      { ...input.params },
    );
  }
}
