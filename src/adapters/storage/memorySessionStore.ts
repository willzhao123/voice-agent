import type { VoiceSession } from "../../domain/voiceSession.js";
import type { SessionStore } from "../../ports/sessionStore.js";

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, VoiceSession>();

  async save(session: VoiceSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async findById(sessionId: string): Promise<VoiceSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : { ...session };
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
