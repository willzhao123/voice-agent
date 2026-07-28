import type {
  RealtimeProvider,
  RealtimeSession,
} from "../../ports/realtimeProvider.js";
import {
  ConfigurationError,
  ExternalProviderUnavailableError,
} from "../../shared/errors.js";

export interface OpenAIRealtimeProviderOptions {
  apiKey?: string;
  model: string;
}

export class OpenAIRealtimeProvider implements RealtimeProvider {
  constructor(
    private readonly options: OpenAIRealtimeProviderOptions,
  ) {}

  async initialize(): Promise<void> {
    this.assertConfigured();
    throw new ExternalProviderUnavailableError(
      "The OpenAI realtime adapter is not implemented yet",
    );
  }

  async openSession(): Promise<RealtimeSession> {
    await this.initialize();
    throw new ExternalProviderUnavailableError(
      "The OpenAI realtime adapter could not open a session",
    );
  }

  private assertConfigured(): void {
    if (this.options.apiKey === undefined) {
      throw new ConfigurationError(
        "OPENAI_API_KEY is required when REALTIME_PROVIDER=openai",
      );
    }
    if (this.options.model.trim() === "") {
      throw new ConfigurationError(
        "OPENAI_REALTIME_MODEL must not be empty",
      );
    }
  }
}
