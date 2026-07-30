import { randomUUID } from "node:crypto";

import type { ServerVoiceEvent } from "../domain/voiceEvents.js";
import {
  closeVoiceSession,
  createVoiceSession,
  type VoiceSession,
} from "../domain/voiceSession.js";
import {
  type VoiceRequestDecision,
  VoiceFaqRouter,
} from "./voiceFaqRouter.js";
import type {
  BackendAgent,
  BackendAgentContext,
  BackendAgentFactory,
} from "../ports/backendAgent.js";
import type {
  RealtimeAudioFormat,
  RealtimeProvider,
  RealtimeProviderEvent,
  RealtimeSession,
} from "../ports/realtimeProvider.js";
import type { SessionStore } from "../ports/sessionStore.js";
import {
  SessionClosedError,
  SessionNotFoundError,
} from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";

export type VoiceSessionEvent = ServerVoiceEvent | RealtimeProviderEvent;
export type VoiceSessionEventListener = (event: VoiceSessionEvent) => void;

interface ActiveSession {
  readonly realtimeSession: RealtimeSession;
  readonly backendAgent?: BackendAgent;
  readonly listeners: Set<VoiceSessionEventListener>;
  closePromise: Promise<void> | undefined;
}

interface LocalFaqHistoryTurn {
  readonly localAnswer: string;
  readonly faqIds: readonly string[];
  readonly faqVersion: string;
}

interface VoiceConversationState {
  readonly localFaqHistory: LocalFaqHistoryTurn[];
  lastAuthoritativeResponse?: string;
}

export const BACKEND_FAILURE_MESSAGE =
  "I'm sorry, I can't access that information right now. Please try again in a moment.";

export class VoiceSessionManager {
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly allocatedSessionIds = new Set<string>();

  constructor(
    private readonly realtimeProvider: RealtimeProvider,
    private readonly sessionStore: SessionStore,
    private readonly logger: Logger,
    private readonly createId: () => string = randomUUID,
    private readonly backendAgentFactory?: BackendAgentFactory,
    private readonly backendTimeoutMs = 8_000,
    private readonly faqRouter?: VoiceFaqRouter,
  ) {}

  async createSession(
    initialListener?: VoiceSessionEventListener,
    instructions?: string,
    mediaOptions: {
      audioFormat?: RealtimeAudioFormat;
      turnDetection?: "manual" | "server_vad";
      backendContext?: Omit<BackendAgentContext, "sessionId">;
    } = {},
  ): Promise<VoiceSession> {
    const session = createVoiceSession(await this.createUniqueId());
    const {
      backendContext,
      ...realtimeMediaOptions
    } = mediaOptions;
    const listeners = new Set<VoiceSessionEventListener>();
    if (initialListener !== undefined) {
      listeners.add(initialListener);
    }

    await this.sessionStore.save(session);
    let backendAgent: BackendAgent | undefined;
    const conversationState: VoiceConversationState = {
      localFaqHistory: [],
    };

    try {
      if (backendContext !== undefined) {
        backendAgent = await this.backendAgentFactory?.create({
          sessionId: session.id,
          ...backendContext,
        });
      }
      const realtimeSession = await this.realtimeProvider.openSession(
        {
          sessionId: session.id,
          ...(instructions === undefined ? {} : { instructions }),
          ...realtimeMediaOptions,
          ...(backendContext === undefined
            ? {}
            : {
                handleBusinessRequest: (userMessage: string) =>
                  this.handleBusinessRequest(
                    session.id,
                    backendContext,
                    backendAgent,
                    conversationState,
                    userMessage,
                  ),
              }),
        },
        (event) => this.emit(session.id, event, listeners),
      );

      this.activeSessions.set(session.id, {
        realtimeSession,
        ...(backendAgent === undefined ? {} : { backendAgent }),
        listeners,
        closePromise: undefined,
      });
    } catch (error) {
      await backendAgent?.close?.().catch(() => {});
      listeners.clear();
      await this.sessionStore.delete(session.id);
      throw error;
    }

    this.emit(session.id, {
      type: "session.started",
      sessionId: session.id,
      startedAt: session.startedAt.toISOString(),
    });
    this.logger.info({ sessionId: session.id }, "Voice session started");

    return session;
  }

  async getSession(sessionId: string): Promise<VoiceSession> {
    const session = await this.sessionStore.findById(sessionId);
    if (session === undefined) {
      throw new SessionNotFoundError(sessionId);
    }

    return session;
  }

  async addEventListener(
    sessionId: string,
    listener: VoiceSessionEventListener,
  ): Promise<() => void> {
    const activeSession = await this.getActiveSession(sessionId);
    activeSession.listeners.add(listener);

    return () => {
      activeSession.listeners.delete(listener);
    };
  }

  async sendAudio(sessionId: string, audio: Buffer): Promise<void> {
    const activeSession = await this.getActiveSession(sessionId);
    await activeSession.realtimeSession.sendInputAudio(audio);
  }

  async commitAudio(sessionId: string): Promise<void> {
    const activeSession = await this.getActiveSession(sessionId);
    await activeSession.realtimeSession.commitInputAudio();
  }

  async sendText(sessionId: string, text: string): Promise<void> {
    const activeSession = await this.getActiveSession(sessionId);
    await activeSession.realtimeSession.sendText(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const activeSession = await this.getActiveSession(sessionId);
    await activeSession.realtimeSession.interrupt();
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session.status === "closed") {
      return;
    }

    const activeSession = this.activeSessions.get(sessionId);
    if (activeSession === undefined) {
      throw new SessionClosedError(sessionId);
    }

    activeSession.closePromise ??= this.closeActiveSession(
      session,
      activeSession,
    );
    await activeSession.closePromise;
  }

  async closeAllSessions(): Promise<void> {
    const sessionIds = [...this.activeSessions.keys()];
    await Promise.all(sessionIds.map(async (sessionId) => {
      try {
        await this.closeSession(sessionId);
      } catch (error) {
        this.logger.error(
          { err: error, sessionId },
          "Failed to close voice session during shutdown",
        );
      }
    }));
  }

  private async createUniqueId(): Promise<string> {
    while (true) {
      const sessionId = this.createId();
      if (this.allocatedSessionIds.has(sessionId)) {
        continue;
      }

      this.allocatedSessionIds.add(sessionId);
      if (await this.sessionStore.findById(sessionId) === undefined) {
        return sessionId;
      }
    }
  }

  private async getActiveSession(
    sessionId: string,
  ): Promise<ActiveSession> {
    const session = await this.getSession(sessionId);
    if (session.status === "closed") {
      throw new SessionClosedError(sessionId);
    }

    const activeSession = this.activeSessions.get(sessionId);
    if (
      activeSession === undefined ||
      activeSession.closePromise !== undefined
    ) {
      throw new SessionClosedError(sessionId);
    }

    return activeSession;
  }

  private async closeActiveSession(
    session: VoiceSession,
    activeSession: ActiveSession,
  ): Promise<void> {
    let closeError: unknown;

    try {
      await activeSession.realtimeSession.close();
    } catch (error) {
      closeError = error;
      this.logger.error(
        { err: error, sessionId: session.id },
        "Failed to close realtime session",
      );
    }

    try {
      await activeSession.backendAgent?.close?.();
    } catch (error) {
      closeError ??= error;
      this.logger.error(
        { err: error, sessionId: session.id },
        "Failed to close backend agent",
      );
    }

    const closedSession = closeVoiceSession(session);
    try {
      await this.sessionStore.save(closedSession);
    } catch (error) {
      closeError ??= error;
      this.logger.error(
        { err: error, sessionId: session.id },
        "Failed to persist closed voice session",
      );
    }

    this.emit(session.id, {
      type: "session.ended",
      sessionId: session.id,
    });
    activeSession.listeners.clear();
    this.activeSessions.delete(session.id);
    this.logger.info({ sessionId: session.id }, "Voice session ended");

    if (closeError !== undefined) {
      throw closeError;
    }
  }

  private emit(
    sessionId: string,
    event: VoiceSessionEvent,
    pendingListeners?: Set<VoiceSessionEventListener>,
  ): void {
    const listeners =
      this.activeSessions.get(sessionId)?.listeners ?? pendingListeners;

    if (listeners === undefined) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(
          { err: error, sessionId },
          "Voice session listener failed",
        );
      }
    }
  }

  private async handleBusinessRequest(
    sessionId: string,
    context: Omit<BackendAgentContext, "sessionId">,
    backendAgent: BackendAgent | undefined,
    conversationState: VoiceConversationState,
    userMessage: string,
  ): Promise<string> {
    const startedAt = Date.now();
    const decision = this.faqRouter?.route(userMessage, {
      ...(conversationState.lastAuthoritativeResponse === undefined
        ? {}
        : {
            lastAuthoritativeResponse:
              conversationState.lastAuthoritativeResponse,
          }),
    }) ??
      createBackendOnlyDecision(userMessage);
    let response: string;

    switch (decision.route) {
      case "local_social":
        response = decision.localResponse ?? BACKEND_FAILURE_MESSAGE;
        break;
      case "local_faq":
        response = decision.localResponse ?? BACKEND_FAILURE_MESSAGE;
        recordLocalFaqTurn(
          conversationState.localFaqHistory,
          response,
          decision,
        );
        break;
      case "clarification":
        response = decision.localResponse ?? BACKEND_FAILURE_MESSAGE;
        break;
      case "backend":
        response = await this.delegateToBackend(
          sessionId,
          context,
          backendAgent,
          buildBackendRequest(
            decision.backendRequest ?? userMessage,
            conversationState.localFaqHistory,
          ),
        );
        break;
      case "mixed": {
        const localResponse =
          decision.localResponse ?? BACKEND_FAILURE_MESSAGE;
        recordLocalFaqTurn(
          conversationState.localFaqHistory,
          localResponse,
          decision,
        );
        const backendResponse = await this.delegateToBackend(
          sessionId,
          context,
          backendAgent,
          buildBackendRequest(
            decision.backendRequest ?? userMessage,
            conversationState.localFaqHistory,
          ),
        );
        response = `${localResponse} ${backendResponse}`;
        break;
      }
    }
    conversationState.lastAuthoritativeResponse = response;

    this.logger.info(
      {
        sessionId,
        callSid: context.callSid,
        streamSid: context.streamSid,
        route: decision.route,
        faqId: decision.faqIds[0] ?? null,
        faqIds: decision.faqIds,
        faqVersion: decision.faqVersion,
        latencyMs: Date.now() - startedAt,
        fallbackReason: decision.fallbackReason,
      },
      "Voice business request routed",
    );
    return response;
  }

  private async delegateToBackend(
    sessionId: string,
    context: Omit<BackendAgentContext, "sessionId">,
    backendAgent: BackendAgent | undefined,
    userMessage: string,
  ): Promise<string> {
    const startedAt = Date.now();
    const logContext = {
      sessionId,
      callSid: context.callSid,
      streamSid: context.streamSid,
      operation: "backend_agent.chat",
    };

    if (backendAgent === undefined) {
      this.logger.error(
        logContext,
        "Backend delegation requested but no backend agent is configured",
      );
      return BACKEND_FAILURE_MESSAGE;
    }

    try {
      const abortController = new AbortController();
      const response = await withTimeout(
        backendAgent.chat(userMessage, {
          signal: abortController.signal,
        }),
        this.backendTimeoutMs,
        abortController,
      );
      if (response.trim() === "") {
        throw new Error("Backend agent returned an empty response");
      }
      this.logger.info(
        {
          ...logContext,
          latencyMs: Date.now() - startedAt,
        },
        "Backend delegation completed",
      );
      return response;
    } catch (error) {
      this.logger.error(
        {
          err: error,
          ...logContext,
          latencyMs: Date.now() - startedAt,
        },
        "Backend delegation failed",
      );
      return BACKEND_FAILURE_MESSAGE;
    }
  }
}

function createBackendOnlyDecision(
  userMessage: string,
): VoiceRequestDecision {
  return {
    route: "backend",
    faqIds: [],
    faqVersion: "unavailable",
    fallbackReason: "faq_router_unavailable",
    backendRequest: userMessage.trim(),
  };
}

function recordLocalFaqTurn(
  history: LocalFaqHistoryTurn[],
  localAnswer: string,
  decision: VoiceRequestDecision,
): void {
  history.push({
    localAnswer,
    faqIds: decision.faqIds,
    faqVersion: decision.faqVersion,
  });
}

function buildBackendRequest(
  currentRequest: string,
  history: readonly LocalFaqHistoryTurn[],
): string {
  if (history.length === 0) {
    return currentRequest;
  }

  return [
    "Answer the current request using this approved local FAQ context from the same voice session.",
    JSON.stringify({
      priorApprovedFaqTurns: history,
      currentRequest,
    }),
  ].join("\n");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abortController.abort();
      reject(new Error("Backend agent request timed out"));
    }, timeoutMs);
    timeout.unref();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
