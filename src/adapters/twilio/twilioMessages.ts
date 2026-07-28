import { z } from "zod";

const twilioConnectedMessageSchema = z.object({
  event: z.literal("connected"),
  protocol: z.string(),
  version: z.string(),
}).passthrough();

const twilioStartMessageSchema = z.object({
  event: z.literal("start"),
  sequenceNumber: z.string(),
  streamSid: z.string().min(1),
  start: z.object({
    accountSid: z.string().min(1),
    streamSid: z.string().min(1),
    callSid: z.string().min(1),
    tracks: z.array(z.string()),
    mediaFormat: z.object({
      encoding: z.literal("audio/x-mulaw"),
      sampleRate: z.literal(8_000),
      channels: z.literal(1),
    }).passthrough(),
    customParameters: z.record(z.string(), z.string()).optional(),
  }).passthrough(),
}).passthrough();

const twilioMediaMessageSchema = z.object({
  event: z.literal("media"),
  sequenceNumber: z.string(),
  streamSid: z.string().min(1),
  media: z.object({
    track: z.string(),
    chunk: z.string(),
    timestamp: z.string(),
    payload: z.string().min(1),
  }).passthrough(),
}).passthrough();

const twilioStopMessageSchema = z.object({
  event: z.literal("stop"),
  sequenceNumber: z.string(),
  streamSid: z.string().min(1),
  stop: z.object({
    accountSid: z.string().min(1),
    callSid: z.string().min(1),
  }).passthrough(),
}).passthrough();

const twilioMarkMessageSchema = z.object({
  event: z.literal("mark"),
  streamSid: z.string().min(1),
  mark: z.object({
    name: z.string(),
  }).passthrough(),
}).passthrough();

const twilioDtmfMessageSchema = z.object({
  event: z.literal("dtmf"),
  streamSid: z.string().min(1),
  dtmf: z.object({
    track: z.string(),
    digit: z.string(),
  }).passthrough(),
}).passthrough();

const twilioInboundMessageSchema = z.discriminatedUnion("event", [
  twilioConnectedMessageSchema,
  twilioStartMessageSchema,
  twilioMediaMessageSchema,
  twilioStopMessageSchema,
  twilioMarkMessageSchema,
  twilioDtmfMessageSchema,
]);

export type TwilioInboundMessage = z.infer<
  typeof twilioInboundMessageSchema
>;

export interface TwilioMediaOutputMessage {
  event: "media";
  streamSid: string;
  media: {
    payload: string;
  };
}

export interface TwilioClearOutputMessage {
  event: "clear";
  streamSid: string;
}

export function parseTwilioMessage(
  value: unknown,
): TwilioInboundMessage {
  return twilioInboundMessageSchema.parse(value);
}

export function createTwilioMediaMessage(
  streamSid: string,
  audio: Buffer,
): TwilioMediaOutputMessage {
  return {
    event: "media",
    streamSid,
    media: {
      payload: audio.toString("base64"),
    },
  };
}

export function createTwilioClearMessage(
  streamSid: string,
): TwilioClearOutputMessage {
  return {
    event: "clear",
    streamSid,
  };
}
