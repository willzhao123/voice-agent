export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

export class ExternalProviderUnavailableError extends Error {
  override readonly name = "ExternalProviderUnavailableError";
}

export class SessionClosedError extends Error {
  override readonly name = "SessionClosedError";

  constructor(sessionId: string) {
    super(`Voice session ${sessionId} is closed`);
  }
}

export function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
