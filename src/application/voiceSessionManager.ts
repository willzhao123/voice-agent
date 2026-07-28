import { randomUUID } from "node:crypto";

import type {
  ClientVoiceEvent,
  ServerVoiceEvent,
} from "../domain/voiceEvents.js";
import {
  closeVoiceSession,
  createVoiceSession,
  type VoiceSession,
} from "../domain/voiceSession.js";
import type {
  RealtimeProviderEvent,
  RealtimeProvider,
  RealtimeSession,
} from "../ports/realtimeProvider.js";
import type { SessionStore } from "../ports/sessionStore.js";
import { SessionClosedError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";

export type ServerEventListener = (event: ServerVoiceEvent) => void;
export type VoiceSessionEvent = ServerVoiceEvent | RealtimeProviderEvent;
export type VoiceSessionEventListener = (event: VoiceSessionEvent) => void;

export interface VoiceSessionHandle {
  readonly session: VoiceSession;
  receive(event: ClientVoiceEvent): Promise<void>;
  close(): Promise<void>;
}

export class VoiceSessionManager {
  constructor(
    private readonly realtimeProvider: RealtimeProvider,
    private readonly sessionStore: SessionStore,
    private readonly logger: Logger,
    private readonly createId: () => string = randomUUID,
  ) {}

  async startSession(
    onEvent: VoiceSessionEventListener,
  ): Promise<VoiceSessionHandle> {
    let session = createVoiceSession(this.createId());
    await this.sessionStore.save(session);

    let realtimeSession: RealtimeSession;
    try {
      realtimeSession = await this.realtimeProvider.openSession(
        { sessionId: session.id },
        onEvent,
      );
    } catch (error) {
      await this.sessionStore.delete(session.id);
      throw error;
    }

    let isClosed = false;

    const close = async (): Promise<void> => {
      if (isClosed) {
        return;
      }

      isClosed = true;
      await realtimeSession.close();
      session = closeVoiceSession(session);
      await this.sessionStore.save(session);
      onEvent({
        type: "session.ended",
        sessionId: session.id,
      });
      this.logger.info({ sessionId: session.id }, "Voice session ended");
    };

    const receive = async (event: ClientVoiceEvent): Promise<void> => {
      if (isClosed) {
        throw new SessionClosedError(session.id);
      }

      switch (event.type) {
        case "audio.append":
          await realtimeSession.sendInputAudio(event.audio);
          break;
        case "audio.commit":
          await realtimeSession.commitInputAudio();
          break;
        case "text.send":
          await realtimeSession.sendText(event.text);
          break;
        case "response.interrupt":
          await realtimeSession.interrupt();
          break;
        case "session.end":
          await close();
          break;
        case "ping":
          onEvent({ type: "pong" });
          break;
      }
    };

    onEvent({
      type: "session.started",
      sessionId: session.id,
      startedAt: session.startedAt.toISOString(),
    });
    this.logger.info({ sessionId: session.id }, "Voice session started");

    return {
      get session() {
        return session;
      },
      receive,
      close,
    };
  }
}
