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
| `TWILIO_ENABLED` | `false` | Register the Twilio webhook and Media Stream routes |
| `TWILIO_AUTH_TOKEN` | unset | Server-only secret used to validate Twilio signatures |
| `PUBLIC_BASE_URL` | unset | Configured public HTTPS origin used for Twilio signatures and TwiML |
| `TWILIO_VALIDATE_SIGNATURES` | `true` | Validate Twilio webhook and WebSocket signatures |
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

### Architecture

Twilio support uses a bidirectional Media Stream without changing the browser
protocol:

```text
Caller
  │
  ▼
Twilio Programmable Voice
  │  signed form POST /v1/twilio/voice
  ▼
Fastify ──► TwiML <Response><Connect><Stream>
  ▲
  │  signed WSS GET /v1/twilio/media
  │  connected/start/media/mark/stop JSON
  ▼
Twilio media adapter
  │  raw G.711 μ-law/8 kHz audio
  ▼
VoiceSessionManager ──► RealtimeProvider ──► OpenAI Realtime
```

The webhook and Media Stream upgrade have independent Twilio signature checks.
Each `start` event creates one isolated voice session and one realtime-provider
connection. A Twilio `stop`, WebSocket disconnect, provider failure, timeout,
or application shutdown closes that provider connection exactly once.

### Environment configuration

The Twilio-related variables are:

| Variable | Required value |
| --- | --- |
| `TWILIO_ENABLED` | `true` to register both Twilio routes |
| `TWILIO_AUTH_TOKEN` | The server-only primary Auth Token for the Twilio project receiving the call |
| `PUBLIC_BASE_URL` | The exact externally visible HTTPS origin, without either route path |
| `TWILIO_VALIDATE_SIGNATURES` | Keep `true`; `false` is restricted to explicit loopback automated tests |
| `REALTIME_PROVIDER` | Use `openai` for a conversational phone call |
| `OPENAI_API_KEY` | Server-only key required when the provider is `openai` |
| `OPENAI_REALTIME_MODEL` | Realtime model selected for the provider connection |

Neither Twilio nor OpenAI credentials are sent to `public/` or included in
WebSocket messages. Do not put the ngrok authtoken in this application's
`.env`; keep it in ngrok's own configuration.

### Incoming-call and Twilio Console setup

1. Use an upgraded Twilio project with a voice-capable Twilio phone number.
2. Expose this application at a stable public HTTPS/WSS origin.
3. Set `PUBLIC_BASE_URL` to that exact origin. For example, if the webhook is
   `https://voice.example.com/v1/twilio/voice`, set
   `PUBLIC_BASE_URL=https://voice.example.com`.
4. Set `TWILIO_AUTH_TOKEN` to the primary Auth Token belonging to the same
   Twilio project as the phone number. Test credentials and API-key secrets do
   not validate inbound webhook signatures.
5. Set `TWILIO_ENABLED=true`, `TWILIO_VALIDATE_SIGNATURES=true`,
   `REALTIME_PROVIDER=openai`, and `OPENAI_API_KEY`.
6. In Twilio Console, open **Phone Numbers → Manage → Active numbers**, select
   the number, and find its incoming Voice configuration.
7. For **A call comes in**, select **Webhook**, enter
   `https://your-public-host/v1/twilio/voice`, select **HTTP POST**, and save.
8. Call the Twilio number. Twilio should receive XML from the webhook and then
   open the Media Stream automatically.

The signed incoming webhook returns:

```xml
<Response>
  <Connect>
    <Stream url="wss://your-public-host/v1/twilio/media"/>
  </Connect>
</Response>
```

`<Connect><Stream>` is bidirectional: Twilio sends caller audio to the
application and accepts assistant audio for playback. It also blocks later
TwiML until the stream disconnects. See Twilio's
[Media Streams overview](https://www.twilio.com/docs/voice/media-streams).

### Local testing with ngrok

An ngrok tunnel can expose the local Fastify port while leaving the application
on plain HTTP locally:

```sh
# In terminal 1
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
ngrok http 3000
```

Copy the HTTPS forwarding origin printed by ngrok, then configure the
application:

```dotenv
TWILIO_ENABLED=true
TWILIO_AUTH_TOKEN=your-primary-twilio-auth-token
PUBLIC_BASE_URL=https://your-current-ngrok-domain.ngrok.app
TWILIO_VALIDATE_SIGNATURES=true
REALTIME_PROVIDER=openai
OPENAI_API_KEY=your-server-only-openai-key
```

```sh
# In terminal 2, after updating .env
npm run dev
```

Set the Twilio Console incoming-call webhook to
`https://your-current-ngrok-domain.ngrok.app/v1/twilio/voice` using `POST`.
Restart the application and update the Console URL whenever a non-static ngrok
domain changes. Keep signature validation enabled: ngrok terminates public TLS,
but signatures still validate because `PUBLIC_BASE_URL` reconstructs the exact
public URL Twilio used. Twilio recommends a public tunnel such as ngrok for
[local webhook testing](https://www.twilio.com/docs/voice/troubleshooting).

### Trial-account restrictions

Current Twilio trial accounts cannot run this integration because the
`<Stream>` verb is blocked in trial TwiML. Upgrade the project before testing a
Media Stream. Trial Voice also limits calls to verified numbers, limits
geography and call usage, and applies other account restrictions. Consult the
current [Twilio Voice trial restrictions](https://www.twilio.com/docs/usage/trials/try-out-voice)
before assuming a Console or carrier failure is an application bug.

### Media event flow

1. Twilio sends `connected`.
2. Twilio sends `start`; the application validates `audio/x-mulaw`, 8,000 Hz,
   and one channel, captures `streamSid`/`callSid`, and starts a realtime
   session with server VAD.
3. Each inbound `media.payload` is base64-decoded and forwarded as unchanged
   μ-law bytes. The application does not commit individual Twilio media frames;
   OpenAI server VAD creates turns and responses.
4. OpenAI `output_audio.delta` bytes are base64-encoded into Twilio `media`
   events for playback.
5. At an assistant audio boundary, the application sends a `mark`. A returned
   mark identifies normally completed playback or a mark released by `clear`.
6. Inbound `dtmf` and returned `mark` events are validated and sequenced but do
   not currently invoke business logic.
7. Twilio `stop` or WebSocket close ends the voice session and closes its
   OpenAI connection.

Twilio event schemas, stream SIDs, sequence numbers, ordering, frame size,
backpressure, idle timeout, maximum duration, and heartbeat state are all
validated or bounded.

### Audio-format differences

| Path | Input and output encoding | Turn detection |
| --- | --- | --- |
| Browser `/v1/voice` | Headerless mono signed PCM16 little-endian at 24 kHz | Manual; stopping the microphone sends `input_audio.commit` |
| Twilio `/v1/twilio/media` | Headerless G.711 μ-law (`audio/x-mulaw` / OpenAI `audio/pcmu`) at 8 kHz, mono | OpenAI `server_vad` with automatic response creation and interruption |

No transcoding occurs on the Twilio path: decoded inbound μ-law bytes go
directly to OpenAI, and OpenAI μ-law output goes directly back to Twilio.
Twilio `media.payload` must not include WAV or other file headers. The browser
path remains independent and continues to resample microphone input to
PCM16/24 kHz.

### Barge-in behavior

When OpenAI reports that caller speech started during an active response, the
application:

1. sends Twilio `clear` to discard buffered assistant playback;
2. cancels the active OpenAI response once, without redundant cancellation when
   no response is active; and
3. continues forwarding new caller media.

Assistant response boundaries produce Twilio marks. Marks returned after a
clear are tracked separately from normal playback completion, matching
Twilio's documented [media, mark, and clear behavior](https://www.twilio.com/docs/voice/media-streams/websocket-messages).

This basic barge-in implementation does not yet truncate conversation items
using the precisely played audio duration. Duration-aware item truncation can
be added later if exact provider conversation history alignment is required.

Twilio webhook and WebSocket signatures are validated with the server-only auth
token. Neither Twilio nor OpenAI credentials are exposed to the browser.
The signed URLs are constructed only from `PUBLIC_BASE_URL` and fixed route
paths; request host and forwarded headers are not trusted for signature
validation or TwiML generation. The Voice webhook is validated against its
public `https://` URL. The Media Stream upgrade is validated against the
configured `wss://` stream URL, even though the WebSocket handshake travels
over HTTPS, using the official Twilio Node request validator.

`TWILIO_VALIDATE_SIGNATURES=false` is provided only for explicit local
automated tests and is rejected unless `PUBLIC_BASE_URL` uses an HTTPS loopback
host. `TWILIO_AUTH_TOKEN` and an HTTPS `PUBLIC_BASE_URL` remain required
whenever Twilio is enabled.

### Troubleshooting

- **Webhook returns 403:** confirm `TWILIO_AUTH_TOKEN` is the primary Auth Token
  for the correct project; confirm the Console URL, method (`POST`), and
  `PUBLIC_BASE_URL` match exactly. Do not derive the public URL from proxy
  headers.
- **Webhook works but the Media Stream closes with policy violation:** confirm
  the WSS handshake signature is calculated for the exact `wss://` stream URL
  produced in the TwiML, and that the ngrok/public hostname did not change.
- **Twilio reports that Stream is unavailable:** trial accounts currently block
  `<Stream>`; upgrade the project.
- **No WebSocket connection appears:** verify the public endpoint supports WSS
  on port 443, has a trusted TLS certificate, and forwards WebSocket upgrades
  to port 3000.
- **Call connects but no assistant audio is heard:** confirm
  `REALTIME_PROVIDER=openai`, the OpenAI key/model are valid, and the provider
  accepted `audio/pcmu` input/output with server VAD.
- **Audio is distorted:** send raw headerless μ-law/8 kHz audio only. Do not
  send PCM16, WAV headers, or arbitrary encoded files through the Twilio path.
- **Barge-in does not clear playback:** look for OpenAI speech-start events and
  Twilio `clear`/returned `mark` traffic; confirm server VAD is enabled.
- **A call stops unexpectedly:** check application logs for the session ID and
  timeout/backpressure reason. Then inspect Twilio Console's **Debugger** and
  the call's **Request Inspector**, as recommended in Twilio's
  [Voice troubleshooting guide](https://www.twilio.com/docs/voice/troubleshooting).
- **ngrok worked previously:** free/non-static tunnel domains can change.
  Update both `PUBLIC_BASE_URL` and the Twilio Console webhook, then restart the
  application.

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
