import { z } from "zod";

const clientVoiceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("audio.append"),
    audio: z.string().min(1),
  }),
  z.object({
    type: z.literal("audio.commit"),
  }),
  z.object({
    type: z.literal("session.end"),
  }),
  z.object({
    type: z.literal("ping"),
  }),
]);

export type ClientVoiceEvent = z.infer<typeof clientVoiceEventSchema>;

export type RealtimeEvent =
  | { type: "audio.delta"; audio: string }
  | { type: "transcript.delta"; transcript: string }
  | { type: "response.done" }
  | { type: "error"; message: string };

export type ServerVoiceEvent =
  | {
      type: "session.started";
      sessionId: string;
      startedAt: string;
    }
  | RealtimeEvent
  | { type: "session.ended"; sessionId: string }
  | { type: "pong" };

export function parseClientVoiceEvent(value: unknown): ClientVoiceEvent {
  return clientVoiceEventSchema.parse(value);
}
