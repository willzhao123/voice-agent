import pino, { type Logger as PinoLogger } from "pino";

export interface Logger {
  info(bindings: object, message: string): void;
  error(error: unknown, message?: string): void;
}

export function createLogger(level: string): PinoLogger {
  return pino({ level });
}
