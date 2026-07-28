import { randomUUID } from "node:crypto";

import type { ServerVoiceEvent } from "../domain/voiceEvents.js";
import {
  closeVoiceSession,
  createVoiceSession,
  type VoiceSession,
} from "../domain/voiceSession.js";
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
  readonly listeners: Set<VoiceSessionEventListener>;
  closePromise: Promise<void> | undefined;
}

export class VoiceSessionManager {
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly allocatedSessionIds = new Set<string>();

  constructor(
    private readonly realtimeProvider: RealtimeProvider,
    private readonly sessionStore: SessionStore,
    private readonly logger: Logger,
    private readonly createId: () => string = randomUUID,
  ) {}

  async createSession(
    initialListener?: VoiceSessionEventListener,
    instructions?: string,
    mediaOptions: {
      audioFormat?: RealtimeAudioFormat;
      turnDetection?: "manual" | "server_vad";
    } = {},
  ): Promise<VoiceSession> {
    const session = createVoiceSession(await this.createUniqueId());
    const listeners = new Set<VoiceSessionEventListener>();
    if (initialListener !== undefined) {
      listeners.add(initialListener);
    }

    await this.sessionStore.save(session);

    try {
      const realtimeSession = await this.realtimeProvider.openSession(
        {
          sessionId: session.id,
          ...(instructions === undefined ? {} : { instructions }),
          ...mediaOptions,
        },
        (event) => this.emit(session.id, event, listeners),
      );

      this.activeSessions.set(session.id, {
        realtimeSession,
        listeners,
        closePromise: undefined,
      });
    } catch (error) {
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
}
