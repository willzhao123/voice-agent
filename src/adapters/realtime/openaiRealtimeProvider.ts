import type {
  RealtimeConnection,
  RealtimeEventListener,
  RealtimeProvider,
} from "../../ports/realtimeProvider.js";
import type { VoiceSession } from "../../domain/voiceSession.js";
import {
  ConfigurationError,
  ExternalProviderUnavailableError,
} from "../../shared/errors.js";

export class OpenAIRealtimeProvider implements RealtimeProvider {
  constructor(private readonly apiKey?: string) {}

  async connect(
    _session: VoiceSession,
    _onEvent: RealtimeEventListener,
  ): Promise<RealtimeConnection> {
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
