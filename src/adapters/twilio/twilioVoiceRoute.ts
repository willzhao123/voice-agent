import type { FastifyInstance, FastifyRequest } from "fastify";
import twilio from "twilio";

import type { TwilioSignatureValidator } from "./twilioSignatureValidator.js";

export interface TwilioVoiceRouteOptions {
  signatureValidator: TwilioSignatureValidator;
  publicBaseUrl?: string;
  mediaPath?: string;
}

export function registerTwilioVoiceRoute(
  app: FastifyInstance,
  options: TwilioVoiceRouteOptions,
): void {
  app.post("/v1/twilio/voice", async (request, reply) => {
    if (!options.signatureValidator.isConfigured()) {
      return reply.code(503).send({
        error: "Twilio voice integration is not configured",
      });
    }

    const requestUrl = getPublicRequestUrl(
      request,
      options.publicBaseUrl,
    );
    if (!options.signatureValidator.validate({
      signature: readHeader(request, "x-twilio-signature"),
      url: requestUrl,
      params: toSignatureParams(request.body),
    })) {
      return reply.code(403).send({
        error: "Invalid Twilio signature",
      });
    }

    const response = new twilio.twiml.VoiceResponse();
    response
      .connect()
      .stream({
        url: getMediaStreamUrl(
          requestUrl,
          options.mediaPath ?? "/v1/twilio/media",
        ),
      });

    return reply
      .type("text/xml; charset=utf-8")
      .send(response.toString());
  });
}

export function getPublicRequestUrl(
  request: FastifyRequest,
  publicBaseUrl?: string,
): string {
  const base = publicBaseUrl === undefined
    ? `${request.protocol}://${request.host}`
    : publicBaseUrl;
  return new URL(request.raw.url ?? request.url, base).toString();
}

function getMediaStreamUrl(
  requestUrl: string,
  mediaPath: string,
): string {
  const url = new URL(mediaPath, requestUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function readHeader(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function toSignatureParams(
  body: unknown,
): Readonly<Record<string, unknown>> {
  return typeof body === "object" && body !== null
    ? body as Record<string, unknown>
    : {};
}
