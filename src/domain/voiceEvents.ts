import { z } from "zod";
import { Buffer } from "node:buffer";

const clientVoiceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("audio.append"),
    audio: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, "Audio must be base64 encoded")
      .transform((audio) => Buffer.from(audio, "base64")),
  }),
  z.object({
    type: z.literal("audio.commit"),
  }),
  z.object({
    type: z.literal("text.send"),
    text: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("response.interrupt"),
  }),
  z.object({
    type: z.literal("session.end"),
  }),
  z.object({
    type: z.literal("ping"),
  }),
]);

export type ClientVoiceEvent = z.infer<typeof clientVoiceEventSchema>;

export type ServerVoiceEvent =
  | {
      type: "session.started";
      sessionId: string;
      startedAt: string;
    }
  | { type: "session.ended"; sessionId: string }
  | { type: "pong" };

export function parseClientVoiceEvent(value: unknown): ClientVoiceEvent {
  return clientVoiceEventSchema.parse(value);
}
