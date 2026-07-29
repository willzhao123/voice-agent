import { describe, expect, it, vi } from "vitest";

import { HttpBackendAgentFactory } from "../src/adapters/backend/httpBackendAgent.js";

describe("HttpBackendAgentFactory", () => {
  it("uses the orchestrator contract without sending StreamSid", async () => {
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({
        response: "Yes, beef pho is available.",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ));
    const factory = new HttpBackendAgentFactory({
      url: "https://backend.example.com/chat",
      authorization: "Bearer server-secret",
      fetch,
    });
    const agent = factory.create({
      sessionId: "session-1",
      callSid: "CA123",
      streamSid: "MZ123",
    });

    await expect(agent.chat("Do you have beef pho?")).resolves.toBe(
      "Yes, beef pho is available.",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://backend.example.com/chat",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer server-secret",
        },
        body: JSON.stringify({
          message: "Do you have beef pho?",
          sessionId: "session-1",
          callSid: "CA123",
        }),
      },
    );
  });

  it("rejects failed or malformed orchestrator responses", async () => {
    const failedFactory = new HttpBackendAgentFactory({
      url: "https://backend.example.com/chat",
      fetch: async () => new Response("", { status: 503 }),
    });
    const malformedFactory = new HttpBackendAgentFactory({
      url: "https://backend.example.com/chat",
      fetch: async () => new Response(
        JSON.stringify({ answer: "wrong field" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    });
    const context = { sessionId: "session-1" };

    await expect(
      failedFactory.create(context).chat("question"),
    ).rejects.toThrow("Backend agent returned HTTP 503");
    await expect(
      malformedFactory.create(context).chat("question"),
    ).rejects.toThrow("Backend agent returned an invalid response");
  });
});
