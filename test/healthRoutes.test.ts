import { afterEach, describe, expect, it } from "vitest";

import { MockRealtimeProvider } from "../src/adapters/realtime/mockRealtimeProvider.js";
import { buildApp } from "../src/app.js";
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

describe("health endpoints", () => {
  it("serves the browser test client from the public directory", async () => {
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
    });
    apps.push(app);

    const page = await app.inject("/");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Voice Agent Test Client");

    const script = await app.inject("/app.js");
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("javascript");
    expect(script.body).toContain('type: "session.start"');
  });

  it("reports health and mock-provider readiness", async () => {
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: new MockRealtimeProvider(),
    });
    apps.push(app);

    const health = await app.inject("/health");
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const readiness = await app.inject("/ready");
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toEqual({
      status: "ready",
      provider: "mock",
    });
  });

  it("returns 503 without leaking provider errors", async () => {
    const providerError = "secret provider initialization detail";
    const unavailableProvider: RealtimeProvider = {
      async initialize() {
        throw new Error(providerError);
      },
      async openSession(): Promise<RealtimeSession> {
        throw new Error("not available");
      },
    };
    const app = await buildApp({
      logger: silentLogger,
      realtimeProvider: unavailableProvider,
    });
    apps.push(app);

    const readiness = await app.inject("/ready");
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({
      status: "not_ready",
      provider: "mock",
    });
    expect(readiness.body).not.toContain(providerError);
  });
});
