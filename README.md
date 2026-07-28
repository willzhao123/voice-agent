# voice-agent

A provider-agnostic voice session service built with Node.js 22+, TypeScript,
Fastify, and WebSockets. It includes a minimal browser harness for exercising
audio and text turns during development.

## Architecture overview

The service uses ports and adapters:

```text
Browser
  │  JSON control events + binary PCM audio
  ▼
Fastify WebSocket adapter
  ▼
VoiceSessionManager
  ├── SessionStore port ──► in-memory adapter
  └── RealtimeProvider port
                         ├── mock adapter
                         └── OpenAI Realtime adapter ──► OpenAI

Twilio incoming call
  │  signed webhook ──► TwiML <Connect><Stream>
  │  signed Media Stream WebSocket
  ▼
Twilio adapter ──► VoiceSessionManager
```

The domain and application layers do not import OpenAI types, WebSocket types,
or Fastify types. They communicate with realtime implementations through the
generic `RealtimeProvider` and `RealtimeSession` interfaces. Provider event
payloads are normalized before they reach the application.

Each browser connection owns one voice session. Incoming frames for that
session are processed sequentially, and sessions have independent provider
connections, listeners, state, and buffered audio. The session manager can
close all active provider connections during application shutdown.

There is no order, cart, payment, inventory, or other business-backend
integration in this repository.

## Directory structure

```text
public/
  index.html                         # Minimal browser test UI
  app.js                             # WebSocket, microphone, and audio playback
src/
  adapters/
    realtime/
      mockRealtimeProvider.ts        # Credential-free deterministic test provider
      openaiRealtimeProvider.ts      # OpenAI Realtime protocol adapter
    storage/
      memorySessionStore.ts          # Process-local session persistence
    twilio/
      twilioVoiceRoute.ts            # Signed incoming-call webhook and TwiML
      twilioMediaStreamRoute.ts      # Bidirectional Media Stream bridge
      twilioMessages.ts              # Validated Twilio stream messages
      twilioSignatureValidator.ts    # Twilio request authentication
    websocket/
      voiceWebsocketRoute.ts         # Validated public WebSocket protocol
  application/
    voiceSessionManager.ts           # Session orchestration and isolation
  config/
    env.ts                           # Environment parsing and validation
  domain/
    voiceEvents.ts                   # Client message schema and domain events
    voiceSession.ts                  # Voice session model
  ports/
    realtimeProvider.ts              # Provider-neutral realtime contract
    sessionStore.ts                  # Storage contract
  shared/
    errors.ts
    logger.ts
  app.ts                             # Fastify composition root
  gracefulShutdown.ts                # Idempotent SIGINT/SIGTERM shutdown
  server.ts                          # Process entry point
test/                                # Unit, protocol, and lifecycle tests
```

## Environment variables

Copy `.env.example` to `.env`. The local `.env` file is ignored by Git.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP listen address |
| `PORT` | `3000` | HTTP listen port |
| `LOG_LEVEL` | `info` | Pino log level |
| `REALTIME_PROVIDER` | `mock` | `mock` or `openai` |
| `OPENAI_API_KEY` | unset | Server-only OpenAI credential; required for `openai` |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | OpenAI Realtime model name |
| `TWILIO_AUTH_TOKEN` | unset | Server-only secret used to validate Twilio signatures |
| `TWILIO_PUBLIC_BASE_URL` | unset | Public HTTPS origin Twilio uses for webhooks and Media Streams |
| `VOICE_INSTRUCTIONS` | `You are a helpful voice assistant.` | Base instructions applied to every session |
| `MAX_JSON_MESSAGE_BYTES` | `65536` | Maximum incoming JSON frame size |
| `MAX_AUDIO_FRAME_BYTES` | `262144` | Maximum incoming binary audio-frame size |
| `IDLE_SESSION_TIMEOUT_MS` | `60000` | Close a connection with no client frames |
| `MAX_SESSION_DURATION_MS` | `1800000` | Absolute connection lifetime |
| `WEBSOCKET_HEARTBEAT_INTERVAL_MS` | `30000` | Server ping interval |
| `WEBSOCKET_MAX_PENDING_MESSAGES` | `32` | Maximum queued incoming frames per connection |
| `WEBSOCKET_MAX_BUFFERED_BYTES` | `1048576` | Maximum buffered outgoing WebSocket data |

Environment values are validated at startup. Provider credentials are used only
by server-side adapters and are never included in browser assets or public
protocol messages. Default logs redact OpenAI and Twilio secrets plus common
authorization fields; raw audio and full provider payloads are not logged.

## Local startup

Requirements:

- Node.js 22 or newer
- npm

Install and run:

```sh
cp .env.example .env
npm install
npm run dev
```

The default configuration uses the mock provider and needs no API key. The
service is available at `http://localhost:3000`.

Useful endpoints:

- `GET /health` returns process health.
- `GET /ready` verifies that the configured provider can initialize.
- `GET /v1/voice` upgrades to the voice WebSocket protocol.
- `POST /v1/twilio/voice` accepts signed incoming-call webhooks.
- `GET /v1/twilio/media` upgrades signed Twilio Media Streams.
- `GET /` serves the browser test client.

For a non-watching process, use `npm start`. To compile TypeScript into `dist/`,
use `npm run build`.

## Browser test instructions

1. Start the service with `REALTIME_PROVIDER=mock`.
2. Open `http://localhost:3000`.
3. Select **Connect** and wait for the status to become **Connected**.
4. Use the text field to test a turn without microphone input.
5. Select **Start microphone**, speak, then select **Stop microphone**. Stopping
   sends `input_audio.commit`, which creates the response turn.
6. Select **Interrupt assistant** to cancel a response and stop queued local
   playback.
7. Select **Disconnect** when finished.

The browser stops microphone tracks when the WebSocket disconnects. Microphone
access generally requires localhost or HTTPS and explicit browser permission.

With the mock provider, microphone audio is echoed to verify binary streaming
and playback. Mock text responses are deterministic test payloads, not
synthesized speech.

## WebSocket protocol

Connect using a WebSocket upgrade:

```text
GET /v1/voice
```

The first application message must start the session:

```json
{
  "type": "session.start",
  "requestId": "client-generated-id",
  "instructions": "You are a helpful voice assistant."
}
```

The server confirms creation:

```json
{
  "type": "session.created",
  "requestId": "client-generated-id",
  "sessionId": "server-generated-id"
}
```

Client JSON messages:

```json
{ "type": "input.text", "text": "Development test message" }
{ "type": "input_audio.commit" }
{ "type": "response.interrupt" }
{ "type": "session.end" }
```

Client schemas are strict and validated with Zod. Unknown fields, missing
fields, malformed JSON, out-of-order commands, and oversized frames produce
structured `error` events. Binary frames are treated as caller audio and are
accepted only after `session.start`.

Server JSON events:

- `session.created`
- `transcript.user.final`
- `response.started`
- `transcript.agent.delta`
- `transcript.agent.final`
- `output_audio.completed`
- `response.completed`
- `response.interrupted`
- `error`

Assistant audio is sent as binary frames. A server `error` contains `code`,
`message`, and `recoverable`. Unrecoverable provider errors close the browser
connection and clean up its provider session.

### Audio format

Audio in both directions is assumed to be raw signed 16-bit little-endian mono
PCM at 24 kHz, without a WAV or other container header.

The browser captures at the device's Web Audio sample rate, linearly resamples
each chunk to 24 kHz, converts it to PCM16, and sends binary WebSocket frames.
Assistant binary frames are decoded using the same PCM16/24 kHz assumption and
scheduled for playback.

## Twilio Programmable Voice

Twilio support uses bidirectional Media Streams without changing the browser
protocol:

1. Configure a Twilio phone number's incoming-call webhook as
   `POST https://your-public-host/v1/twilio/voice`.
2. Set `TWILIO_AUTH_TOKEN` to that Twilio account's auth token.
3. Set `TWILIO_PUBLIC_BASE_URL` to the externally visible HTTPS origin, such as
   `https://voice.example.com`. This ensures signature validation uses the
   exact URL Twilio signed when the application is behind a proxy.
4. Set `REALTIME_PROVIDER=openai` and configure `OPENAI_API_KEY`.
5. Expose the application over HTTPS/WSS on public port 443.

The signed webhook returns TwiML containing:

```xml
<Response>
  <Connect>
    <Stream url="wss://your-public-host/v1/twilio/media"/>
  </Connect>
</Response>
```

Twilio then opens the signed Media Stream WebSocket. Its `start` event creates
an isolated voice session configured for G.711 μ-law at 8 kHz and server-side
voice activity detection. Incoming base64 media payloads are decoded and passed
unchanged to the realtime provider. Provider audio deltas are encoded into
Twilio `media` messages and sent back for call playback. Speech-start and
interruption events send Twilio `clear` messages to discard buffered assistant
audio. A Twilio `stop` event or WebSocket disconnect closes the realtime
session.

Twilio webhook and WebSocket signatures are validated with the server-only auth
token. Neither Twilio nor OpenAI credentials are exposed to the browser.

Twilio Media Streams require raw headerless `audio/x-mulaw` at 8 kHz. The
OpenAI adapter selects `audio/pcmu` for both input and output, so this path does
not transcode audio. Browser sessions continue to use PCM16/24 kHz.

## Selecting a realtime provider

### Mock provider

The mock provider is the default:

```sh
REALTIME_PROVIDER=mock npm run dev
```

It requires no external service or credentials. It emits normalized transcript,
response, interruption, and audio events, making it suitable for local protocol
and lifecycle testing.

### OpenAI Realtime provider

Set the provider, server-only API key, and optionally the model:

```sh
REALTIME_PROVIDER=openai \
OPENAI_API_KEY=your-server-only-key \
OPENAI_REALTIME_MODEL=gpt-realtime-2.1 \
npm run dev
```

The backend opens the authenticated provider WebSocket. The browser connects
only to this service and never receives the provider URL headers, API key, or
provider-specific event payloads.

## Production-safety behavior

- Incoming JSON and audio frames have independent size limits.
- Incoming work is sequential per session and has a bounded queue.
- Outgoing data is stopped when the WebSocket buffered-byte limit is reached.
- Idle and maximum-duration timers close sessions.
- Server ping/pong heartbeats terminate unresponsive connections.
- Client disconnects and fatal provider disconnects close session resources.
- `SIGINT` and `SIGTERM` close Fastify and all active realtime connections.
- Session lifecycle and failures use structured logs with `sessionId` where one
  has been allocated.

## Known limitations

- Session state is process-local and is lost on restart.
- The browser development route has no authentication or tenant isolation.
  Twilio routes validate Twilio signatures but do not add application-level
  caller authorization.
- The service is single-process; active sessions cannot migrate between
  instances.
- Browser audio is assumed to be PCM16/24 kHz and Twilio audio is assumed to be
  G.711 μ-law/8 kHz after message and frame validation. The server does not
  transcode audio.
- Browser capture uses the deprecated `ScriptProcessorNode` and performs simple
  per-chunk linear resampling rather than production-grade audio processing.
- Browser turn detection is manual; Twilio sessions use OpenAI server VAD.
- The mock provider verifies protocol flow and audio echoing but does not
  synthesize natural speech.
- The OpenAI adapter targets its configured Realtime protocol; provider API
  changes may require adapter updates.
- Twilio deployment requires a stable public HTTPS/WSS origin and does not
  currently expose call-status callbacks, recording, or DTMF application logic.
- There is no order/backend integration or tool-calling workflow.

## Future integration points

- Implement `SessionStore` with a durable shared store.
- Add other realtime vendors behind `RealtimeProvider`.
- Add authentication and tenant-aware policy in Fastify hooks.
- Add metrics, tracing, and provider latency/error telemetry without recording
  audio or full provider payloads.
- Replace browser audio processing with an `AudioWorklet`.
- Add server-side audio validation/transcoding and automatic voice activity
  detection.
- Introduce business tools—such as a future ordering backend—through a separate
  application port and adapter. No such integration exists today.

## Commands

```sh
npm run dev
npm start
npm run typecheck
npm run lint
npm test
npm run test:watch
npm run build
```
