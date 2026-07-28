# voice-agent

A provider-agnostic voice session service built with Node.js 22+, TypeScript,
Fastify, and WebSockets.

## Prerequisites

- Node.js 22 or newer
- npm

## Setup

```sh
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000` to use the small browser client. The HTTP health
check is available at `GET /health`, and voice sessions connect at
`GET /v1/voice` using a WebSocket upgrade.

The default `mock` realtime provider echoes audio events and completes responses
without external credentials. With `REALTIME_PROVIDER=openai`, the backend
opens an authenticated server-to-server Realtime WebSocket; the API key is
never sent to the browser.

`GET /ready` returns `200` when the configured provider initializes and `503`
otherwise.

## Configuration

Copy `.env.example` to `.env`. Supported settings are `HOST`, `PORT`,
`LOG_LEVEL`, `REALTIME_PROVIDER`, `OPENAI_API_KEY`,
`OPENAI_REALTIME_MODEL`, and `VOICE_INSTRUCTIONS`. `OPENAI_API_KEY` is required
only when `REALTIME_PROVIDER=openai`; configuration errors stop startup without
printing secret values.

## Architecture

```text
src/
  domain/       # Voice session entities and events
  ports/        # Provider and persistence contracts
  application/  # Provider-agnostic session orchestration
  adapters/     # Fastify/WebSocket, storage, and realtime implementations
  config/       # Environment validation
  shared/       # Errors and logging
```

Dependencies point inward: the application and domain layers do not depend on
Fastify, WebSocket, or a realtime-model SDK.

## WebSocket events

Client events:

```json
{
  "type": "session.start",
  "requestId": "client-generated-id",
  "instructions": "You are a helpful voice assistant."
}
{ "type": "input.text", "text": "Development test message" }
{ "type": "input_audio.commit" }
{ "type": "response.interrupt" }
{ "type": "session.end" }
```

Caller audio and assistant audio use binary WebSocket frames. The OpenAI
provider expects signed 16-bit mono PCM at 24 kHz; its assistant audio uses the
same format. The included browser recorder is intended for the default mock
provider until browser-side PCM capture is added. JSON server messages are
`session.created`, `transcript.user.final`,
`transcript.agent.delta`, `transcript.agent.final`,
`output_audio.completed`, `response.started`, `response.completed`,
`response.interrupted`, and `error`.

## Commands

```sh
npm run dev
npm start
npm run build
npm run typecheck
npm test
npm run test:watch
npm run lint
```

No ordering-backend integration is included.
