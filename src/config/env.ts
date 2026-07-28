import "dotenv/config";
import { z } from "zod";

const optionalSecretSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().trim().min(1).optional(),
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
