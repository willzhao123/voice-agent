export interface BackendAgentContext {
  readonly sessionId: string;
  readonly callSid?: string;
  readonly streamSid?: string;
}

export interface BackendAgent {
  chat(
    message: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<string>;
  close?(): Promise<void>;
}

export interface BackendAgentFactory {
  create(context: BackendAgentContext): Promise<BackendAgent> | BackendAgent;
}
