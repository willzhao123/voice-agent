import type {
  BackendAgent,
  BackendAgentContext,
  BackendAgentFactory,
} from "../../ports/backendAgent.js";
import {
  ConfigurationError,
  ExternalProviderUnavailableError,
} from "../../shared/errors.js";

export interface HttpBackendAgentFactoryOptions {
  url: string;
  authorization?: string;
  fetch?: typeof globalThis.fetch;
}

export class HttpBackendAgentFactory implements BackendAgentFactory {
  private readonly fetch: typeof globalThis.fetch;

  constructor(
    private readonly options: HttpBackendAgentFactoryOptions,
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    const url = new URL(options.url);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new ConfigurationError(
        "BACKEND_AGENT_URL must use HTTP or HTTPS",
      );
    }
  }

  create(context: BackendAgentContext): BackendAgent {
    return new HttpBackendAgent(this.options, context, this.fetch);
  }
}

class HttpBackendAgent implements BackendAgent {
  constructor(
    private readonly options: HttpBackendAgentFactoryOptions,
    private readonly context: BackendAgentContext,
    private readonly fetch: typeof globalThis.fetch,
  ) {}

  async chat(
    message: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.fetch(this.options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.authorization === undefined
          ? {}
          : { authorization: this.options.authorization }),
      },
      body: JSON.stringify({
        message,
        sessionId: this.context.sessionId,
        ...(this.context.callSid === undefined
          ? {}
          : { callSid: this.context.callSid }),
      }),
      ...(options.signal === undefined
        ? {}
        : { signal: options.signal }),
    });

    if (!response.ok) {
      throw new ExternalProviderUnavailableError(
        `Backend agent returned HTTP ${response.status}`,
      );
    }

    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("response" in body) ||
      typeof body.response !== "string" ||
      body.response.trim() === ""
    ) {
      throw new ExternalProviderUnavailableError(
        "Backend agent returned an invalid response",
      );
    }

    return body.response;
  }
}
