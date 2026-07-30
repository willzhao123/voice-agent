import WebSocket, { type RawData } from "ws";

import type {
  RealtimeEventListener,
  RealtimeProvider,
  RealtimeProviderEvent,
  RealtimeSession,
  RealtimeSessionOptions,
} from "../../ports/realtimeProvider.js";
import {
  ConfigurationError,
  ExternalProviderUnavailableError,
} from "../../shared/errors.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const DEFAULT_SESSION_READY_TIMEOUT_MS = 10_000;
const BUSINESS_ROUTER_TOOL_NAME = "route_business_request";
const FINAL_SPEAKING_STAGE = "final_speaking";
const FINAL_SPEAKING_INSTRUCTIONS = `
Speak only the authoritative function result already present in the conversation.
Do not add a preamble, acknowledgement, explanation, summary, or new facts.
Do not call any tool. Keep the spoken response short and natural.
`.trim();
const INVALID_ROUTING_MESSAGE =
  "I'm sorry, I couldn't process that request. Please try again.";

export interface OpenAIRealtimeSocket {
  open(): Promise<void>;
  send(message: string): void;
  close(): Promise<void>;
  onMessage(listener: (message: string) => void): void;
  onError(listener: (error: Error) => void): void;
  onClose(listener: () => void): void;
}

export type OpenAIRealtimeSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => OpenAIRealtimeSocket;

export interface OpenAIRealtimeProviderOptions {
  apiKey?: string;
  model: string;
  socketFactory?: OpenAIRealtimeSocketFactory;
  sessionReadyTimeoutMs?: number;
}

export class OpenAIRealtimeProvider implements RealtimeProvider {
  private readonly socketFactory: OpenAIRealtimeSocketFactory;
  private readonly sessionReadyTimeoutMs: number;

  constructor(
    private readonly options: OpenAIRealtimeProviderOptions,
  ) {
    this.socketFactory =
      options.socketFactory ?? createNodeOpenAIRealtimeSocket;
    this.sessionReadyTimeoutMs =
      options.sessionReadyTimeoutMs ??
      DEFAULT_SESSION_READY_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    this.assertConfigured();
  }

  async openSession(
    options: RealtimeSessionOptions,
    onEvent: RealtimeEventListener,
  ): Promise<RealtimeSession> {
    this.assertConfigured();
    const apiKey = this.options.apiKey;
    if (apiKey === undefined) {
      throw new ConfigurationError("OPENAI_API_KEY is required");
    }

    const url = new URL(OPENAI_REALTIME_URL);
    url.searchParams.set("model", this.options.model);
    const socket = this.socketFactory(url.toString(), {
      Authorization: `Bearer ${apiKey}`,
    });

    let closed = false;
    let closing = false;
    let inputAudioStarted = false;
    let readySettled = false;
    const strictRouting =
      options.handleBusinessRequest !== undefined;
    const handledToolCallIds = new Set<string>();
    const finalSpeakingResponseIds = new Set<string>();
    let toolCallChain = Promise.resolve();
    let resolveReady = (): void => {};
    let rejectReady: (error: Error) => void = () => {};
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const emit = (event: RealtimeProviderEvent): void => {
      try {
        onEvent(event);
      } catch {
        // A consumer listener must not crash the provider receive loop.
      }
    };

    const emitConnectionError = (
      code: string,
      message: string,
    ): void => {
      emit({
        type: "error",
        code,
        message,
        recoverable: false,
      });
    };

    socket.onMessage((message) => {
      try {
        const providerEvent = parseProviderEvent(message);
        if (providerEvent.type === "session.updated") {
          if (!readySettled) {
            readySettled = true;
            emit({
              type: "session.ready",
              sessionId: options.sessionId,
            });
            resolveReady();
          }
          return;
        }

        if (
          strictRouting &&
          providerEvent.type === "response.created"
        ) {
          const finalResponseId =
            readFinalSpeakingResponseId(providerEvent);
          if (finalResponseId !== undefined) {
            finalSpeakingResponseIds.add(finalResponseId);
          }
        }

        if (
          shouldForwardProviderEvent(
            providerEvent,
            strictRouting,
            finalSpeakingResponseIds,
          )
        ) {
          const normalizedEvent =
            normalizeProviderEvent(providerEvent);
          if (normalizedEvent !== undefined) {
            emit(normalizedEvent);
          }
        }

        const responseId = readProviderResponseId(providerEvent);
        const isFinalSpeakingResponse =
          responseId !== undefined &&
          finalSpeakingResponseIds.has(responseId);
        if (
          providerEvent.type === "response.done" &&
          options.handleBusinessRequest !== undefined &&
          !isFinalSpeakingResponse
        ) {
          const toolCalls = readFunctionCalls(providerEvent);
          for (const toolCall of toolCalls) {
            if (handledToolCallIds.has(toolCall.callId)) {
              continue;
            }
            handledToolCallIds.add(toolCall.callId);
            toolCallChain = toolCallChain
              .then(async () => {
                const output = await executeBusinessRouting(
                  toolCall,
                  options.handleBusinessRequest!,
                );
                sendProviderEvent({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: toolCall.callId,
                    output: JSON.stringify({ response: output }),
                  },
                });
                sendProviderEvent(
                  createFinalSpeakingResponseEvent(
                    toolCall.callId,
                  ),
                );
              })
              .catch(() => {
                emit({
                  type: "error",
                  code: "business_request_routing_failed",
                  message: "Failed to return the routed business result",
                  recoverable: true,
                });
              });
          }
        }

        if (
          providerEvent.type === "response.done" &&
          isFinalSpeakingResponse &&
          responseId !== undefined
        ) {
          finalSpeakingResponseIds.delete(responseId);
        }

        if (
          providerEvent.type === "error" &&
          !readySettled
        ) {
          readySettled = true;
          rejectReady(
            new ExternalProviderUnavailableError(
              "OpenAI rejected the realtime session configuration",
            ),
          );
        }
      } catch {
        emit({
          type: "error",
          code: "invalid_provider_event",
          message: "OpenAI sent an invalid realtime event",
          recoverable: true,
        });
      }
    });

    socket.onError(() => {
      emitConnectionError(
        "provider_connection_error",
        "The OpenAI realtime connection failed",
      );
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new ExternalProviderUnavailableError(
            "Unable to connect to the OpenAI Realtime API",
          ),
        );
      }
    });

    socket.onClose(() => {
      closed = true;
      if (!closing) {
        emitConnectionError(
          "provider_connection_closed",
          "The OpenAI realtime connection closed unexpectedly",
        );
      }
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new ExternalProviderUnavailableError(
            "The OpenAI realtime connection closed before it was ready",
          ),
        );
      }
    });

    const sendProviderEvent = (event: object): void => {
      if (closed || closing) {
        throw new ExternalProviderUnavailableError(
          "The OpenAI realtime session is closed",
        );
      }

      try {
        socket.send(JSON.stringify(event));
      } catch {
        emitConnectionError(
          "provider_send_failed",
          "Failed to send an event to the OpenAI Realtime API",
        );
        throw new ExternalProviderUnavailableError(
          "Failed to send an event to the OpenAI Realtime API",
        );
      }
    };

    try {
      await socket.open();
      sendProviderEvent(createSessionUpdateEvent(options));
      await withTimeout(
        readyPromise,
        this.sessionReadyTimeoutMs,
        "Timed out waiting for the OpenAI realtime session",
      );
    } catch (error) {
      closing = true;
      await socket.close().catch(() => {});
      closed = true;
      if (error instanceof ConfigurationError) {
        throw error;
      }
      throw new ExternalProviderUnavailableError(
        error instanceof Error
          ? error.message
          : "Unable to open the OpenAI realtime session",
      );
    }

    return {
      async sendInputAudio(audio) {
        sendProviderEvent({
          type: "input_audio_buffer.append",
          audio: audio.toString("base64"),
        });
        if (!inputAudioStarted) {
          inputAudioStarted = true;
          emit({ type: "input_audio.started" });
        }
      },

      async commitInputAudio() {
        sendProviderEvent({
          type: "input_audio_buffer.commit",
        });
        sendProviderEvent({
          type: "response.create",
        });
        if (inputAudioStarted) {
          inputAudioStarted = false;
          emit({ type: "input_audio.stopped" });
        }
      },

      async sendText(text) {
        sendProviderEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text,
              },
            ],
          },
        });
        emit({
          type: "transcript.user.final",
          transcript: text,
        });
        sendProviderEvent({
          type: "response.create",
        });
      },

      async interrupt() {
        sendProviderEvent({
          type: "response.cancel",
        });
      },

      async close() {
        if (closed || closing) {
          return;
        }
        closing = true;
        await socket.close();
        closed = true;
      },
    };
  }

  private assertConfigured(): void {
    if (this.options.apiKey === undefined) {
      throw new ConfigurationError(
        "OPENAI_API_KEY is required when REALTIME_PROVIDER=openai",
      );
    }
    if (this.options.model.trim() === "") {
      throw new ConfigurationError(
        "OPENAI_REALTIME_MODEL must not be empty",
      );
    }
    if (
      !Number.isFinite(this.sessionReadyTimeoutMs) ||
      this.sessionReadyTimeoutMs <= 0
    ) {
      throw new ConfigurationError(
        "OpenAI realtime session timeout must be positive",
      );
    }
  }
}

interface ProviderEvent {
  type: string;
  [key: string]: unknown;
}

function createSessionUpdateEvent(
  options: RealtimeSessionOptions,
): object {
  const audioFormat = options.audioFormat ?? {
    encoding: "pcm16",
    sampleRate: 24_000,
  };
  return {
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities:
        options.handleBusinessRequest === undefined
          ? ["audio"]
          : ["text"],
      ...(options.instructions === undefined
        ? {}
        : { instructions: options.instructions }),
      ...(options.handleBusinessRequest === undefined
        ? {}
        : {
            tools: [createBusinessRouterTool()],
            tool_choice: "required",
          }),
      audio: {
        input: {
          format: toOpenAIAudioFormat(audioFormat),
          transcription: {
            model: "gpt-4o-mini-transcribe",
          },
          turn_detection:
            options.turnDetection === "server_vad"
              ? {
                  type: "server_vad",
                  create_response: true,
                  interrupt_response: true,
                }
              : null,
        },
        output: {
          format: toOpenAIAudioFormat(audioFormat),
        },
      },
    },
  };
}

function createFinalSpeakingResponseEvent(
  routeToolCallId: string,
): object {
  return {
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: FINAL_SPEAKING_INSTRUCTIONS,
      tools: [],
      tool_choice: "none",
      metadata: {
        voice_stage: FINAL_SPEAKING_STAGE,
        route_tool_call_id: routeToolCallId,
      },
    },
  };
}

function createBusinessRouterTool(): object {
  return {
    type: "function",
    name: BUSINESS_ROUTER_TOOL_NAME,
    description:
      "Route every caller request, including greetings and repeat requests, through approved local handling or the business backend. Always pass the caller's complete request.",
    parameters: {
      type: "object",
      properties: {
        user_message: {
          type: "string",
          description: "The caller's complete request",
        },
      },
      required: ["user_message"],
      additionalProperties: false,
    },
  };
}

interface BusinessRouterToolCall {
  callId: string;
  name: string;
  arguments: string;
}

function readFunctionCalls(
  event: ProviderEvent,
): BusinessRouterToolCall[] {
  const response = requireRecord(event, "response");
  const output = response.output;
  if (!Array.isArray(output)) {
    return [];
  }

  const calls: BusinessRouterToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "function_call") {
      continue;
    }
    calls.push({
      callId: requireString(item, "call_id"),
      name: requireString(item, "name"),
      arguments: requireString(item, "arguments"),
    });
  }
  return calls;
}

function shouldForwardProviderEvent(
  event: ProviderEvent,
  strictRouting: boolean,
  finalSpeakingResponseIds: ReadonlySet<string>,
): boolean {
  if (!strictRouting || !event.type.startsWith("response.")) {
    return true;
  }
  const responseId = readProviderResponseId(event);
  return responseId !== undefined &&
    finalSpeakingResponseIds.has(responseId);
}

function readFinalSpeakingResponseId(
  event: ProviderEvent,
): string | undefined {
  const response = event.response;
  if (!isRecord(response)) {
    return undefined;
  }
  const metadata = response.metadata;
  if (
    !isRecord(metadata) ||
    metadata.voice_stage !== FINAL_SPEAKING_STAGE
  ) {
    return undefined;
  }
  return optionalString(response, "id");
}

function readProviderResponseId(
  event: ProviderEvent,
): string | undefined {
  if (
    event.type === "response.created" ||
    event.type === "response.done"
  ) {
    return isRecord(event.response)
      ? optionalString(event.response, "id")
      : undefined;
  }
  return optionalString(event, "response_id");
}

async function executeBusinessRouting(
  toolCall: BusinessRouterToolCall,
  handleBusinessRequest: (userMessage: string) => Promise<string>,
): Promise<string> {
  if (toolCall.name !== BUSINESS_ROUTER_TOOL_NAME) {
    return INVALID_ROUTING_MESSAGE;
  }

  try {
    const value: unknown = JSON.parse(toolCall.arguments);
    if (
      !isRecord(value) ||
      typeof value.user_message !== "string" ||
      value.user_message.trim() === ""
    ) {
      return INVALID_ROUTING_MESSAGE;
    }
    return await handleBusinessRequest(value.user_message);
  } catch {
    return INVALID_ROUTING_MESSAGE;
  }
}

function toOpenAIAudioFormat(
  format: NonNullable<RealtimeSessionOptions["audioFormat"]>,
): object {
  if (format.encoding === "g711_ulaw") {
    return { type: "audio/pcmu" };
  }
  return {
    type: "audio/pcm",
    rate: format.sampleRate,
  };
}

function parseProviderEvent(message: string): ProviderEvent {
  const value: unknown = JSON.parse(message);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid provider event");
  }
  return value as ProviderEvent;
}

function normalizeProviderEvent(
  event: ProviderEvent,
): RealtimeProviderEvent | undefined {
  switch (event.type) {
    case "input_audio_buffer.speech_started":
      return { type: "input_audio.started" };
    case "input_audio_buffer.speech_stopped":
      return { type: "input_audio.stopped" };
    case "conversation.item.input_audio_transcription.completed":
      return {
        type: "transcript.user.final",
        transcript: requireString(event, "transcript"),
      };
    case "response.created":
      return { type: "response.started" };
    case "response.output_audio.delta":
      return {
        type: "output_audio.delta",
        audio: Buffer.from(requireString(event, "delta"), "base64"),
      };
    case "response.output_audio.done":
      return { type: "output_audio.completed" };
    case "response.output_audio_transcript.delta":
    case "response.output_text.delta":
      return {
        type: "transcript.agent.delta",
        transcript: requireString(event, "delta"),
      };
    case "response.output_audio_transcript.done":
      return {
        type: "transcript.agent.final",
        transcript: requireString(event, "transcript"),
      };
    case "response.output_text.done":
      return {
        type: "transcript.agent.final",
        transcript: requireString(event, "text"),
      };
    case "response.done":
      return normalizeResponseDone(event);
    case "error":
      return normalizeProviderError(event);
    default:
      return undefined;
  }
}

function normalizeResponseDone(
  event: ProviderEvent,
): RealtimeProviderEvent {
  const response = requireRecord(event, "response");
  const status = requireString(response, "status");

  if (status === "completed") {
    return { type: "response.completed" };
  }
  if (status === "cancelled") {
    return { type: "response.interrupted" };
  }

  return {
    type: "error",
    code: `response_${status}`,
    message:
      readResponseErrorMessage(response) ??
      `OpenAI realtime response ended with status ${status}`,
    recoverable: status === "incomplete",
  };
}

function normalizeProviderError(
  event: ProviderEvent,
): RealtimeProviderEvent {
  const error = requireRecord(event, "error");
  const errorType =
    optionalString(error, "code") ??
    optionalString(error, "type") ??
    "openai_realtime_error";

  return {
    type: "error",
    code: errorType,
    message: requireString(error, "message"),
    recoverable: true,
  };
}

function readResponseErrorMessage(
  response: Record<string, unknown>,
): string | undefined {
  const statusDetails = response.status_details;
  if (!isRecord(statusDetails)) {
    return undefined;
  }
  const error = statusDetails.error;
  return isRecord(error)
    ? optionalString(error, "message")
    : undefined;
}

function requireRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const nested = value[key];
  if (!isRecord(nested)) {
    throw new Error(`Expected ${key} to be an object`);
  }
  return nested;
}

function requireString(
  value: Record<string, unknown>,
  key: string,
): string {
  const nested = value[key];
  if (typeof nested !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return nested;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const nested = value[key];
  return typeof nested === "string" ? nested : undefined;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new ExternalProviderUnavailableError(message));
    }, timeoutMs);
  });

  try {
    await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

class NodeOpenAIRealtimeSocket implements OpenAIRealtimeSocket {
  private readonly socket: WebSocket;
  private readonly openPromise: Promise<void>;

  constructor(
    url: string,
    headers: Readonly<Record<string, string>>,
  ) {
    this.socket = new WebSocket(url, { headers });
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
  }

  async open(): Promise<void> {
    await this.openPromise;
  }

  send(message: string): void {
    this.socket.send(message);
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate();
      return;
    }

    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }

  onMessage(listener: (message: string) => void): void {
    this.socket.on("message", (data: RawData) => {
      listener(data.toString());
    });
  }

  onError(listener: (error: Error) => void): void {
    this.socket.on("error", listener);
  }

  onClose(listener: () => void): void {
    this.socket.on("close", listener);
  }
}

function createNodeOpenAIRealtimeSocket(
  url: string,
  headers: Readonly<Record<string, string>>,
): OpenAIRealtimeSocket {
  return new NodeOpenAIRealtimeSocket(url, headers);
}
