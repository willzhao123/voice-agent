import { z } from "zod";

const faqEntrySchema = z.object({
  id: z.string().trim().min(1),
  answer: z.string().trim().min(1),
  matchPhrases: z.array(z.string().trim().min(1)).min(1),
});

const approvedFaqCatalogSchema = z.object({
  version: z.string().trim().min(1),
  restaurant: z.string().trim().min(1),
  faqs: z.array(faqEntrySchema).min(1),
}).superRefine((catalog, context) => {
  const ids = new Set<string>();
  for (const [index, faq] of catalog.faqs.entries()) {
    if (ids.has(faq.id)) {
      context.addIssue({
        code: "custom",
        path: ["faqs", index, "id"],
        message: `Duplicate FAQ ID: ${faq.id}`,
      });
    }
    ids.add(faq.id);
  }
});

export type ApprovedFaqCatalog = z.infer<
  typeof approvedFaqCatalogSchema
>;

export type VoiceRequestRoute =
  | "local_social"
  | "local_faq"
  | "backend"
  | "mixed"
  | "clarification";

export interface VoiceRequestDecision {
  readonly route: VoiceRequestRoute;
  readonly faqIds: readonly string[];
  readonly faqVersion: string;
  readonly fallbackReason: string;
  readonly localResponse?: string;
  readonly backendRequest?: string;
}

export interface VoiceRoutingContext {
  readonly lastAuthoritativeResponse?: string;
}

const DYNAMIC_REQUEST_PATTERNS = [
  /\bmenu\b/u,
  /\bfood\b/u,
  /\bdish(?:es)?\b/u,
  /\bpho\b/u,
  /\bbeef\b/u,
  /\bprice(?:s)?\b/u,
  /\bcost\b/u,
  /\bhow much\b/u,
  /\border(?:ing|s|ed)?\b/u,
  /\badd\b/u,
  /\bremove\b/u,
  /\bcart\b/u,
  /\bcheckout\b/u,
  /\bpayment(?:s)?\b/u,
  /\bpay(?:ing)?\b/u,
  /\bcredit card\b/u,
  /\bcash\b/u,
  /\bcustomer\b/u,
  /\bcustomer information\b/u,
  /\bmy\b/u,
  /\bmy name\b/u,
  /\bemail\b/u,
  /\bphone number\b/u,
  /\baddress\b/u,
  /\baccount\b/u,
  /\bprofile\b/u,
  /\bunder the name\b/u,
  /\bdelivery\b/u,
  /\bpickup\b/u,
] as const;

const GENERIC_DYNAMIC_REQUEST_PATTERNS = [
  /\bavailable\b/u,
  /\bavailability\b/u,
  /\bserve\b/u,
  /\boffer\b/u,
] as const;

const CLAUSE_SEPARATOR =
  /[.!?;]+|\b(?:and|also|plus|but)\b/giu;

const FAQ_CLARIFICATION =
  "Are you asking about our hours, parking, reservations, or restaurant name?";
const GREETING_RESPONSE = "Hi! How can I help?";
const THANKS_RESPONSE = "You're welcome.";
const GOODBYE_RESPONSE = "Goodbye!";
const REPEAT_CLARIFICATION = "What would you like me to repeat?";

export function parseApprovedFaqCatalog(
  value: unknown,
): ApprovedFaqCatalog {
  return approvedFaqCatalogSchema.parse(value);
}

export class VoiceFaqRouter {
  constructor(
    private readonly catalog: ApprovedFaqCatalog,
  ) {}

  get version(): string {
    return this.catalog.version;
  }

  get count(): number {
    return this.catalog.faqs.length;
  }

  route(
    userMessage: string,
    context: VoiceRoutingContext = {},
  ): VoiceRequestDecision {
    const socialDecision = routeLightweightSocialRequest(
      userMessage,
      context,
      this.catalog.version,
    );
    if (socialDecision !== undefined) {
      return socialDecision;
    }

    const clauses = splitClauses(userMessage);
    const matchedEntries = new Map<
      string,
      ApprovedFaqCatalog["faqs"][number]
    >();
    const backendClauses: string[] = [];

    for (const clause of clauses) {
      const matches = this.findMatches(clause);
      const isDynamic = isDynamicRequest(
        clause,
        matches.length > 0,
      );

      if (isDynamic) {
        backendClauses.push(clause);
        continue;
      }

      if (matches.length > 1) {
        return {
          route: "clarification",
          faqIds: matches.map((entry) => entry.id),
          faqVersion: this.catalog.version,
          fallbackReason: "uncertain_faq_match",
          localResponse: FAQ_CLARIFICATION,
        };
      }

      const match = matches[0];
      if (match !== undefined) {
        matchedEntries.set(match.id, match);
      } else if (!isLightweightSocialClause(clause)) {
        backendClauses.push(clause);
      }
    }

    const faqEntries = [...matchedEntries.values()];
    const faqIds = faqEntries.map((entry) => entry.id);
    const localResponse = faqEntries
      .map((entry) => entry.answer)
      .join(" ");

    if (faqEntries.length > 0 && backendClauses.length === 0) {
      return {
        route: "local_faq",
        faqIds,
        faqVersion: this.catalog.version,
        fallbackReason: "none",
        localResponse,
      };
    }

    if (faqEntries.length > 0) {
      return {
        route: "mixed",
        faqIds,
        faqVersion: this.catalog.version,
        fallbackReason: "mixed_request_backend_remainder",
        localResponse,
        backendRequest: backendClauses.join(" "),
      };
    }

    return {
      route: "backend",
      faqIds: [],
      faqVersion: this.catalog.version,
      fallbackReason:
        isDynamicRequest(userMessage, false)
          ? "dynamic_or_transactional_request"
          : "no_faq_match",
      backendRequest: userMessage.trim(),
    };
  }

  private findMatches(
    clause: string,
  ): ApprovedFaqCatalog["faqs"] {
    const normalizedClause = normalize(clause);
    return this.catalog.faqs.filter((entry) =>
      entry.matchPhrases.some((phrase) =>
        normalizedClause.includes(normalize(phrase))
      )
    );
  }
}

function splitClauses(message: string): string[] {
  const clauses = message
    .split(CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");
  return clauses.length === 0 ? [message.trim()] : clauses;
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isDynamicRequest(
  value: string,
  hasFaqMatch: boolean,
): boolean {
  const normalized = normalize(value);
  return DYNAMIC_REQUEST_PATTERNS.some(
    (pattern) => pattern.test(normalized),
  ) || (
    !hasFaqMatch &&
    GENERIC_DYNAMIC_REQUEST_PATTERNS.some(
      (pattern) => pattern.test(normalized),
    )
  );
}

function routeLightweightSocialRequest(
  userMessage: string,
  context: VoiceRoutingContext,
  faqVersion: string,
): VoiceRequestDecision | undefined {
  const normalized = normalize(userMessage);
  if (
    /\b(?:repeat|say that again|say it again|what did you say)\b/u
      .test(normalized)
  ) {
    return createSocialDecision(
      context.lastAuthoritativeResponse ?? REPEAT_CLARIFICATION,
      faqVersion,
      "repeat_request",
    );
  }

  if (!isLightweightSocialClause(normalized)) {
    return undefined;
  }
  if (/\b(?:bye|goodbye|see you|good night)\b/u.test(normalized)) {
    return createSocialDecision(
      GOODBYE_RESPONSE,
      faqVersion,
      "goodbye",
    );
  }
  if (
    /\b(?:thanks|thank you|appreciate it)\b/u.test(normalized)
  ) {
    return createSocialDecision(
      THANKS_RESPONSE,
      faqVersion,
      "thanks",
    );
  }
  if (
    /\b(?:hi|hello|hey|good morning|good afternoon|good evening)\b/u
      .test(normalized)
  ) {
    return createSocialDecision(
      GREETING_RESPONSE,
      faqVersion,
      "greeting",
    );
  }
  return undefined;
}

function createSocialDecision(
  localResponse: string,
  faqVersion: string,
  fallbackReason: string,
): VoiceRequestDecision {
  return {
    route: "local_social",
    faqIds: [],
    faqVersion,
    fallbackReason,
    localResponse,
  };
}

function isLightweightSocialClause(clause: string): boolean {
  const normalized = normalize(clause)
    .replace(
      /\b(?:hi|hello|hey|please|thanks|thank you|appreciate it|bye|goodbye|see you|good night|good morning|good afternoon|good evening)\b/gu,
      "",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return normalized === "";
}
