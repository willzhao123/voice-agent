import type {
  RealtimeEventListener,
  RealtimeProvider,
  RealtimeSession,
  RealtimeSessionOptions,
} from "../../ports/realtimeProvider.js";

export class MockRealtimeProvider implements RealtimeProvider {
  async initialize(): Promise<void> {}

  async openSession(
    options: RealtimeSessionOptions,
    onEvent: RealtimeEventListener,
  ): Promise<RealtimeSession> {
    let isClosed = false;
    let isReceivingAudio = false;
    let audioChunks: Buffer[] = [];

    const ensureOpen = (): void => {
      if (isClosed) {
        const error = new Error("Mock realtime session is closed");
        onEvent({
          type: "error",
          message: error.message,
          code: "session_closed",
          recoverable: false,
        });
        throw error;
      }
    };

    const emitResponse = (transcript: string, audio: Buffer): void => {
      const response = `Mock response: ${transcript}`;

      onEvent({ type: "response.started" });
      onEvent({
        type: "transcript.agent.delta",
        transcript: response,
      });
      onEvent({
        type: "transcript.agent.final",
        transcript: response,
      });
      onEvent({
        type: "output_audio.delta",
        audio: Buffer.from(audio),
      });
      onEvent({ type: "output_audio.completed" });
      onEvent({ type: "response.completed" });
    };

    onEvent({
      type: "session.ready",
      sessionId: options.sessionId,
    });

    return {
      async sendInputAudio(audio) {
        ensureOpen();
        if (!isReceivingAudio) {
          isReceivingAudio = true;
          onEvent({ type: "input_audio.started" });
        }
        audioChunks.push(Buffer.from(audio));
      },
      async commitInputAudio() {
        ensureOpen();
        const audio = Buffer.concat(audioChunks);
        audioChunks = [];

        if (isReceivingAudio) {
          isReceivingAudio = false;
          onEvent({ type: "input_audio.stopped" });
        }

        const transcript = `[mock audio: ${audio.byteLength} bytes]`;
        onEvent({
          type: "transcript.user.final",
          transcript,
        });
        emitResponse(transcript, audio);
      },
      async sendText(text) {
        ensureOpen();
        onEvent({
          type: "transcript.user.final",
          transcript: text,
        });
        emitResponse(text, Buffer.from(text));
      },
      async interrupt() {
        ensureOpen();
        onEvent({ type: "response.interrupted" });
      },
      async close() {
        isClosed = true;
        audioChunks = [];
      },
    };
  }
}
