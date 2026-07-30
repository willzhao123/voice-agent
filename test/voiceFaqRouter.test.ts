import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { loadApprovedFaqCatalog } from "../src/adapters/faq/localFaqCatalog.js";
import {
  parseApprovedFaqCatalog,
  VoiceFaqRouter,
} from "../src/application/voiceFaqRouter.js";

const catalog = parseApprovedFaqCatalog({
  version: "test-v1",
  restaurant: "Haiyen",
  faqs: [
    {
      id: "restaurant.name",
      answer: "This is Haiyen.",
      matchPhrases: [
        "restaurant name",
        "what restaurant",
        "what is your name",
      ],
    },
    {
      id: "restaurant.hours",
      answer: "We're open from noon to 9 PM every day.",
      matchPhrases: ["hours", "are you open"],
    },
    {
      id: "restaurant.parking",
      answer: "We don't have parking.",
      matchPhrases: ["parking"],
    },
    {
      id: "restaurant.reservations",
      answer: "We accept walk-ins only.",
      matchPhrases: ["reservation", "reservations"],
    },
  ],
});

const router = new VoiceFaqRouter(catalog);

describe("VoiceFaqRouter", () => {
  it("loads the approved Haiyen FAQ catalog from local data", async () => {
    const loadedCatalog = await loadApprovedFaqCatalog(
      resolve("data/voice-faq.json"),
    );

    expect(loadedCatalog).toMatchObject({
      version: "2026-07-30",
      restaurant: "Haiyen",
      faqs: [
        {
          id: "restaurant.name",
          answer: "This is Haiyen.",
        },
        {
          id: "restaurant.hours",
          answer: "We're open from noon to 9 PM every day.",
        },
        {
          id: "restaurant.parking",
          answer: "We don't have parking.",
        },
        {
          id: "restaurant.reservations",
          answer: "We accept walk-ins only.",
        },
      ],
    });
  });

  it.each([
    [
      "What restaurant is this?",
      "restaurant.name",
      "This is Haiyen.",
    ],
    [
      "What is your name?",
      "restaurant.name",
      "This is Haiyen.",
    ],
    [
      "What are your hours?",
      "restaurant.hours",
      "We're open from noon to 9 PM every day.",
    ],
    [
      "Do you have parking?",
      "restaurant.parking",
      "We don't have parking.",
    ],
    [
      "Is parking available?",
      "restaurant.parking",
      "We don't have parking.",
    ],
    [
      "Do you take reservations?",
      "restaurant.reservations",
      "We accept walk-ins only.",
    ],
    [
      "Do you offer reservations?",
      "restaurant.reservations",
      "We accept walk-ins only.",
    ],
  ])(
    "answers a high-confidence approved FAQ locally: %s",
    (question, faqId, answer) => {
      expect(router.route(question)).toEqual({
        route: "local_faq",
        faqIds: [faqId],
        faqVersion: "test-v1",
        fallbackReason: "none",
        localResponse: answer,
      });
    },
  );

  it.each([
    [
      "Hello!",
      "Hi! How can I help?",
      "greeting",
    ],
    [
      "Thank you.",
      "You're welcome.",
      "thanks",
    ],
    [
      "Goodbye.",
      "Goodbye!",
      "goodbye",
    ],
  ])(
    "handles lightweight social routing locally: %s",
    (request, response, fallbackReason) => {
      expect(router.route(request)).toEqual({
        route: "local_social",
        faqIds: [],
        faqVersion: "test-v1",
        fallbackReason,
        localResponse: response,
      });
    },
  );

  it("repeats the last authoritative response without using the backend", () => {
    expect(
      router.route("Could you say that again?", {
        lastAuthoritativeResponse:
          "We're open from noon to 9 PM every day.",
      }),
    ).toEqual({
      route: "local_social",
      faqIds: [],
      faqVersion: "test-v1",
      fallbackReason: "repeat_request",
      localResponse: "We're open from noon to 9 PM every day.",
    });
  });

  it.each([
    "Do you have beef pho?",
    "How much is the combo pho?",
    "I want to place an order.",
    "Can I pay with a credit card?",
    "Please update my phone number.",
    "Is my reservation with parking confirmed?",
  ])("routes dynamic or transactional work to the backend: %s", (question) => {
    expect(router.route(question)).toMatchObject({
      route: "backend",
      faqIds: [],
      faqVersion: "test-v1",
      fallbackReason: "dynamic_or_transactional_request",
      backendRequest: question,
    });
  });

  it("answers the FAQ portion and isolates the backend remainder", () => {
    expect(
      router.route(
        "What are your hours, and do you have beef pho?",
      ),
    ).toEqual({
      route: "mixed",
      faqIds: ["restaurant.hours"],
      faqVersion: "test-v1",
      fallbackReason: "mixed_request_backend_remainder",
      localResponse: "We're open from noon to 9 PM every day.",
      backendRequest: "do you have beef pho",
    });
  });

  it("asks for clarification instead of guessing an ambiguous FAQ", () => {
    expect(
      router.route("Are you open for reservations?"),
    ).toEqual({
      route: "clarification",
      faqIds: [
        "restaurant.hours",
        "restaurant.reservations",
      ],
      faqVersion: "test-v1",
      fallbackReason: "uncertain_faq_match",
      localResponse:
        "Are you asking about our hours, parking, reservations, or restaurant name?",
    });
  });

  it("combines multiple approved FAQ answers without adding facts", () => {
    expect(
      router.route("What are your hours and do you have parking?"),
    ).toMatchObject({
      route: "local_faq",
      faqIds: [
        "restaurant.hours",
        "restaurant.parking",
      ],
      localResponse:
        "We're open from noon to 9 PM every day. We don't have parking.",
    });
  });

  it("routes unsupported facts to the backend rather than inventing", () => {
    expect(router.route("Do you have outdoor seating?")).toEqual({
      route: "backend",
      faqIds: [],
      faqVersion: "test-v1",
      fallbackReason: "no_faq_match",
      backendRequest: "Do you have outdoor seating?",
    });
  });

  it("rejects duplicate FAQ IDs", () => {
    expect(() => parseApprovedFaqCatalog({
      version: "bad-v1",
      restaurant: "Haiyen",
      faqs: [
        {
          id: "duplicate",
          answer: "One.",
          matchPhrases: ["one"],
        },
        {
          id: "duplicate",
          answer: "Two.",
          matchPhrases: ["two"],
        },
      ],
    })).toThrow("Duplicate FAQ ID");
  });
});
