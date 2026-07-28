import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createGracefulShutdown } from "../src/gracefulShutdown.js";
import type {
  RealtimeProvider,
  RealtimeSession,
} from "../src/ports/realtimeProvider.js";
import { createLogger } from "../src/shared/logger.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const silentLogger = createLogger("silent");

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("graceful shutdown", () => {
  it("closes active realtime sessions and is idempotent", async () => {
    let closeCalls = 0;
    const provider: RealtimeProvider = {
      async initialize() {},
      async openSession(): Promise<RealtimeSession> {
        return {
          async sendInputAudio() {},
          async commitInputAudio() {},
          async sendText() {},
          async interrupt() {},
          async close() {
            closeCalls += 1;
          },
        };
      },
    };
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: provider,
    });
    apps.push(app);
    await app.ready();

    const socket = await app.injectWS("/v1/voice");
    socket.send(JSON.stringify({
      type: "session.start",
      requestId: "shutdown-test",
      instructions: "Test graceful shutdown.",
    }));
    await new Promise<void>((resolve) => {
      socket.once("message", () => resolve());
    });

    const shutdown = createGracefulShutdown(app);
    await Promise.all([
      shutdown("SIGTERM"),
      shutdown("SIGINT"),
    ]);

    expect(closeCalls).toBe(1);
    apps.splice(apps.indexOf(app), 1);
  });
});
