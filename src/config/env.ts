import "dotenv/config";
import { z } from "zod";

const optionalSecretSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const booleanEnvironmentSchema = z.preprocess(
  (value) => {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    return value;
  },
  z.boolean(),
);

const environmentSchema = z
  .object({
    HOST: z.string().trim().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z
      .enum([
        "fatal",
        "error",
        "warn",
        "info",
        "debug",
        "trace",
        "silent",
      ])
      .default("info"),
    REALTIME_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
    OPENAI_API_KEY: optionalSecretSchema,
    BACKEND_AGENT_URL: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().url().optional(),
    ),
    BACKEND_AGENT_AUTHORIZATION: optionalSecretSchema,
    BACKEND_AGENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(8_000),
    TWILIO_ENABLED: booleanEnvironmentSchema.default(false),
    TWILIO_AUTH_TOKEN: optionalSecretSchema,
    PUBLIC_BASE_URL: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().url().optional(),
    ),
    TWILIO_VALIDATE_SIGNATURES:
      booleanEnvironmentSchema.default(true),
    OPENAI_REALTIME_MODEL: z
      .string()
      .trim()
      .min(1)
      .default("gpt-realtime-2.1"),
    VOICE_INSTRUCTIONS: z
      .string()
      .trim()
      .min(1)
      .default("You are a helpful voice assistant."),
    MAX_JSON_MESSAGE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(64 * 1024),
    MAX_AUDIO_FRAME_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(256 * 1024),
    IDLE_SESSION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    MAX_SESSION_DURATION_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 60_000),
    WEBSOCKET_HEARTBEAT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30_000),
    WEBSOCKET_MAX_PENDING_MESSAGES: z.coerce
      .number()
      .int()
      .positive()
      .default(32),
    WEBSOCKET_MAX_BUFFERED_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
  })
  .superRefine((configuration, context) => {
    if (
      configuration.REALTIME_PROVIDER === "openai" &&
      configuration.OPENAI_API_KEY === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message:
          "is required when REALTIME_PROVIDER is set to openai",
      });
    }
    if (configuration.TWILIO_ENABLED) {
      if (configuration.TWILIO_AUTH_TOKEN === undefined) {
        context.addIssue({
          code: "custom",
          path: ["TWILIO_AUTH_TOKEN"],
          message: "is required when TWILIO_ENABLED is true",
        });
      }
      if (configuration.PUBLIC_BASE_URL === undefined) {
        context.addIssue({
          code: "custom",
          path: ["PUBLIC_BASE_URL"],
          message: "is required when TWILIO_ENABLED is true",
        });
      } else if (
        new URL(configuration.PUBLIC_BASE_URL).protocol !== "https:"
      ) {
        context.addIssue({
          code: "custom",
          path: ["PUBLIC_BASE_URL"],
          message: "must be an HTTPS URL when TWILIO_ENABLED is true",
        });
      } else if (
        !configuration.TWILIO_VALIDATE_SIGNATURES &&
        !isLoopbackHostname(
          new URL(configuration.PUBLIC_BASE_URL).hostname,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["TWILIO_VALIDATE_SIGNATURES"],
          message:
            "can be false only for local automated testing",
        });
      }
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(
  values: Record<string, unknown>,
): Environment {
  const result = environmentSchema.safeParse(values);
  if (result.success) {
    return result.data;
  }

  const details = result.error.issues
    .map((issue) => {
      const field = issue.path.join(".") || "environment";
      return `${field}: ${issue.message}`;
    })
    .join("; ");

  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = parseEnvironment(process.env);

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}
