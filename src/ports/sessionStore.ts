import type { VoiceSession } from "../domain/voiceSession.js";

export interface SessionStore {
  save(session: VoiceSession): Promise<void>;
  findById(sessionId: string): Promise<VoiceSession | undefined>;
  delete(sessionId: string): Promise<void>;
}
