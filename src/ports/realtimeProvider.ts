import type { Buffer } from "node:buffer";

export interface RealtimeSessionOptions {
  readonly sessionId: string;
}

export type RealtimeProviderEvent =
  | {
      type: "session.ready";
      sessionId: string;
    }
  | { type: "input_audio.started" }
  | { type: "input_audio.stopped" }
  | {
      type: "transcript.user.final";
      transcript: string;
    }
  | {
      type: "transcript.agent.delta";
      transcript: string;
    }
  | {
      type: "transcript.agent.final";
      transcript: string;
    }
  | {
      type: "output_audio.delta";
      audio: Buffer;
    }
  | { type: "output_audio.completed" }
  | { type: "response.started" }
  | { type: "response.completed" }
  | { type: "response.interrupted" }
  | {
      type: "error";
      message: string;
      code: string;
      recoverable: boolean;
    };

export type RealtimeEventListener = (
  event: RealtimeProviderEvent,
) => void;

export interface RealtimeSession {
  sendInputAudio(audio: Buffer): Promise<void>;
  commitInputAudio(): Promise<void>;
  sendText(text: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeProvider {
  openSession(
    options: RealtimeSessionOptions,
    onEvent: RealtimeEventListener,
  ): Promise<RealtimeSession>;
}
