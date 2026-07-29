import pino, { type Logger as PinoLogger } from "pino";

export interface Logger {
  info(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

export function createLogger(level: string): PinoLogger {
  return pino(createLoggerOptions(level));
}

export function createLoggerOptions(level: string): pino.LoggerOptions {
  return {
    level,
    redact: {
      paths: [
        "apiKey",
        "*.apiKey",
        "OPENAI_API_KEY",
        "*.OPENAI_API_KEY",
        "BACKEND_AGENT_AUTHORIZATION",
        "*.BACKEND_AGENT_AUTHORIZATION",
        "TWILIO_AUTH_TOKEN",
        "*.TWILIO_AUTH_TOKEN",
        "authorization",
        "*.authorization",
        "headers.authorization",
        "req.headers.authorization",
        "headers[\"x-twilio-signature\"]",
        "req.headers[\"x-twilio-signature\"]",
        "signature",
        "*.signature",
      ],
      censor: "[Redacted]",
    },
  };
}
