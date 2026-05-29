# WhatsApp Agent - Codebase & Architecture Guide

This repo is a 3-service WhatsApp "agent" stack:

- `gateway/` (Node + whatsapp-web.js): logs into WhatsApp Web, receives inbound messages, and sends outbound messages.
- `backend/` (Flask + SQLite + Groq): plans/drafts messages with Groq, applies policies (quiet hours/rate limits), stores state, and calls the gateway.
- `frontend/` (React + Vite + Tailwind): UI with "Connect WhatsApp" (QR in website) and an "Agent Command" box to send real messages.

## Quick start (dev)

1) Make sure Python deps are installed and the venv exists at `backend/.venv`.
2) From repo root run:

`npm run dev`

This starts Backend + Frontend + Gateway together. If a gateway is already running on port 3001, it will be reused instead of crashing.

If you only want the UI + backend (no gateway), run:

`npm run dev:ui`

## Connect WhatsApp (QR in the website)

- Open the UI: `http://localhost:5173`
- Click "Connect WhatsApp" (Linked devices icon)
- Scan the QR with your phone:
  WhatsApp -> Linked devices -> Link a device
- When the gateway becomes ready, the UI syncs chats and your real WhatsApp chat list appears on the left sidebar.

## Agent Command (send messages agent-style)

In the left sidebar there is an "Agent Command" box.

Typical workflow:

1) Select a real chat/contact from the left sidebar.
2) Type an instruction, e.g. `tell Amol Sir I successfully created a WhatsApp AI agent`
3) Click Run -> review preview -> click YES to send (NO to cancel).

Recipient resolution rules:

- If you selected a chat on the left, that chat is used as the default recipient.
- If you type a phone number, it will send to that number.
- If you type a name, the backend tries to match it against synced WhatsApp chat names.

## File structure (important parts)

```text
WHATSAPP_AGENT/
  .env
  .env.example
  package.json
  start.ps1
  start.sh
  scripts/
    dev-gateway.mjs              # Starts gateway only if port is free

  backend/
    app.py                       # Flask API, UI agent endpoints, webhook
    ai_engine.py                 # Groq planner + drafter (safe logging for Windows consoles)
    config.py                    # Loads settings from .env
    db.py                        # SQLite: users, conversations, pending_messages
    gateway_client.py            # HTTP client for gateway (/status, /qr, /send, /chats)
    policy.py                    # Quiet hours, yes/no parsing, phone extraction
    requirements.txt

  gateway/
    server.mjs                   # WhatsApp Web gateway (QR, webhook forward, send, chats)
    package.json

  frontend/
    package.json
    vite.config.ts
    src/
      App.tsx                    # UI (Connect WhatsApp modal + Agent Command)
      api/client.ts              # Typed API client
      api/types.ts               # Types for chats/messages/agent/gateway APIs
      components/QrModal.tsx     # Shows pairing QR inside the website
      components/Toast.tsx
      lib/qr.ts                  # Tiny QR renderer (no external deps)
```

## Main HTTP endpoints

Backend (Flask):

- `POST /webhook` - called by the gateway for inbound WhatsApp messages
- `POST /api/agent/instruction` - agent (plan + draft) returns a preview/pending confirmation
- `POST /api/agent/confirm` - YES/NO confirm; YES triggers real send via gateway
- `GET /api/gateway/status` - proxy gateway status to the UI
- `GET /api/gateway/qr` - proxy gateway QR text to the UI
- `POST /api/gateway/sync-chats` - imports chat names from gateway into SQLite `users`
- `GET /api/chats` / `GET /api/chats/:id/messages` - frontend chat UI reads from SQLite

Gateway (Node):

- `GET /status` - ready/auth state, whether QR is available
- `GET /qr` - QR text (when not ready)
- `GET /chats` - list chats (id + name + last message)
- `POST /send` - send WhatsApp message to a chat id (`...@c.us` / `...@g.us`)
- `POST /logout`

## Common configuration knobs (.env)

- `GROQ_API_KEY`, `GROQ_MODEL`
- `GATEWAY_BASE_URL` (default `http://127.0.0.1:3001`)
- `REPLY_ONLY_MODE` (set `false` to allow messaging new contacts during testing)
- `QUIET_HOURS_START`, `QUIET_HOURS_END`
- `MAX_OUTGOING_PER_HOUR_TOTAL`, `MAX_OUTGOING_PER_HOUR_PER_RECIPIENT`
