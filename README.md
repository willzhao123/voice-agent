# voice-agent

A minimal Node.js 22+, TypeScript, ESM, Fastify, and WebSocket service scaffold.

## Prerequisites

- Node.js 22 or newer
- npm

## Setup

```sh
cp .env.example .env
npm install
npm run dev
```

The HTTP health check is available at `GET /health`. A basic WebSocket echo
endpoint is available at `/ws`.

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
