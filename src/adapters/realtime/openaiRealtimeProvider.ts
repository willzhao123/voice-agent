import type {
  RealtimeProvider,
  RealtimeSession,
} from "../../ports/realtimeProvider.js";
import {
  ConfigurationError,
  ExternalProviderUnavailableError,
} from "../../shared/errors.js";

export class OpenAIRealtimeProvider implements RealtimeProvider {
  constructor(private readonly apiKey?: string) {}

  async openSession(): Promise<RealtimeSession> {
    if (this.apiKey === undefined) {
      throw new ConfigurationError(
        "OPENAI_API_KEY is required when REALTIME_PROVIDER=openai",
      );
    }

    throw new ExternalProviderUnavailableError(
      "The OpenAI realtime adapter is a placeholder and is not implemented yet",
    );
  }
}
