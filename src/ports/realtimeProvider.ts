import type {
  RealtimeEvent,
} from "../domain/voiceEvents.js";
import type {
  VoiceSession,
} from "../domain/voiceSession.js";

export type RealtimeEventListener = (event: RealtimeEvent) => void;

export interface RealtimeConnection {
  appendAudio(audio: string): Promise<void>;
  commitAudio(): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeProvider {
  connect(
    session: VoiceSession,
    onEvent: RealtimeEventListener,
  ): Promise<RealtimeConnection>;
}
