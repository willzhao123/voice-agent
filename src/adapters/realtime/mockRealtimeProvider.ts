import type {
  RealtimeConnection,
  RealtimeEventListener,
  RealtimeProvider,
} from "../../ports/realtimeProvider.js";

export class MockRealtimeProvider implements RealtimeProvider {
  async connect(
    _session: Parameters<RealtimeProvider["connect"]>[0],
    onEvent: RealtimeEventListener,
  ): Promise<RealtimeConnection> {
    let isClosed = false;

    const ensureOpen = (): void => {
      if (isClosed) {
        throw new Error("Mock realtime connection is closed");
      }
    };

    return {
      async appendAudio(audio) {
        ensureOpen();
        onEvent({ type: "audio.delta", audio });
      },
      async commitAudio() {
        ensureOpen();
        onEvent({ type: "response.done" });
      },
      async close() {
        isClosed = true;
      },
    };
  }
}
