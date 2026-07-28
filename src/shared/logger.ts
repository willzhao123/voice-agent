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
        "TWILIO_AUTH_TOKEN",
        "*.TWILIO_AUTH_TOKEN",
        "authorization",
        "*.authorization",
        "headers.authorization",
        "req.headers.authorization",
      ],
      censor: "[Redacted]",
    },
  };
}
