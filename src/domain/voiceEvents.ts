import { z } from "zod";

const clientVoiceMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("session.start"),
      requestId: z.string().trim().min(1).max(200),
      instructions: z.string().trim().min(1).max(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("input.text"),
      text: z.string().trim().min(1).max(100_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("input_audio.commit"),
    })
    .strict(),
  z
    .object({
      type: z.literal("response.interrupt"),
    })
    .strict(),
  z
    .object({
      type: z.literal("session.end"),
    })
    .strict(),
]);

export type ClientVoiceMessage = z.infer<
  typeof clientVoiceMessageSchema
>;

export type ServerVoiceEvent =
  | {
      type: "session.started";
      sessionId: string;
      startedAt: string;
    }
  | { type: "session.ended"; sessionId: string };

export function parseClientVoiceMessage(
  value: unknown,
): ClientVoiceMessage {
  return clientVoiceMessageSchema.parse(value);
}
