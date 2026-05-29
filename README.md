# WhatsApp AI Agent

A self-hosted WhatsApp AI assistant built with Flask, whatsapp-web.js, and Groq AI. The agent connects to your WhatsApp account via QR code, auto-replies to casual and factual questions, searches the web for real-time information, and drafts messages for you with a 2-phase confirmation flow.

**Note:** `whatsapp-web.js` is an unofficial integration and may violate WhatsApp's terms. Use at your own risk.

---

## Table of Contents

1. [Features](#features)
2. [Project Structure](#project-structure)
3. [How It Works](#how-it-works)
4. [Message Classification](#message-classification)
5. [Plans & Pricing](#plans--pricing)
6. [Away Mode](#away-mode)
7. [Setup Guide](#setup-guide)
8. [Deploy to Vercel](#deploy-to-vercel)
9. [Configuration](#configuration)
10. [API Reference](#api-reference)
11. [Confirmation Flow](#confirmation-flow)
12. [Troubleshooting](#troubleshooting)

---

## Features

### Smart Message Classification

The agent automatically classifies incoming messages into four categories and handles each differently:

| Type | Examples | Behavior |
|------|----------|----------|
| **Time** | "what time is it", "what's the date" | Instant reply from system clock |
| **Casual** | "hi", "hello", "how are you" | AI-generated friendly reply |
| **Factual** | "who is Claude AI", "what is Python" | DuckDuckGo search + AI summary |
| **Decision** | "tell Ahmad I'll be late" | 2-phase confirmation (YES/NO) |

### Real-Time Clock

No API calls needed. The agent answers time and date questions instantly using the system clock:

- "what time is it" -> "It's 3:45 PM (Asia/Calcutta)."
- "what's the date today" -> "Today is Friday, 29 May 2026."
- "what day is it" -> "It's Friday."

### DuckDuckGo Web Search

For factual questions, the agent searches DuckDuckGo and uses AI to summarize the results:

- "who is Claude AI" -> Searches web -> AI summarizes -> Sends reply
- "what is Python" -> Searches web -> AI summarizes -> Sends reply

### Away Mode

When you're unavailable, enable away mode to auto-reply and store messages:

- Send `away on` via WhatsApp to enable
- Send `away off` via WhatsApp to disable
- Auto-reply template: "I'm currently unavailable. I will inform {owner_name} about this."
- Owner name auto-fetched from WhatsApp account

### 2-Phase Confirmation

For important messages (sending to others), the agent drafts a message and asks for confirmation:

1. You send: "tell Ahmad I'll be late"
2. Agent replies: "Here's the message I drafted: Hey Ahmad, I'll be late. Reply YES to send, or NO to cancel."
3. You reply: `YES` to send or `NO` to cancel

### Group Message Safety

Messages from WhatsApp groups always require confirmation. The agent never auto-replies in groups.

### Web Interface

Optional React + Vite + Tailwind frontend with WhatsApp-style UI:

- View all conversations
- Send messages from the browser
- Demo chat for testing without WhatsApp

---

## Project Structure

```
WHATSAPP_AGENT/
├── .env                        # Environment variables
├── .env.example                # Example env file
├── .gitignore
├── README.md                   # This file
├── package.json                # Root package scripts
├── start.ps1                   # PowerShell start script
├── start.sh                    # Bash start script
│
├── backend/
│   ├── app.py                  # Flask API (main entry point)
│   ├── ai_engine.py            # Groq AI + DuckDuckGo search
│   ├── config.py               # Settings from environment
│   ├── db.py                   # SQLite database operations
│   ├── gateway_client.py       # HTTP client to gateway
│   ├── policy.py               # Policies + message classification
│   ├── requirements.txt        # Python dependencies
│   ├── .env                    # Backend env overrides
│   └── data/
│       └── agent.db            # SQLite database file
│
├── gateway/
│   ├── server.mjs              # WhatsApp Web gateway
│   ├── package.json            # Node.js dependencies
│   └── .wwebjs_auth/           # WhatsApp session data
│
└── frontend/
    ├── index.html              # Entry HTML
    ├── package.json            # React + Vite + Tailwind
    ├── vite.config.ts          # Vite config with API proxy
    ├── src/                    # React source code
    └── dist/                   # Built frontend
```

### Key Files Explained

**backend/app.py** - The main Flask application. Handles all HTTP endpoints including the webhook for incoming WhatsApp messages, chat API for the frontend, and status endpoints. Contains the message classification logic that decides whether to auto-reply or request confirmation.

**backend/ai_engine.py** - Integrates with Groq AI for message drafting and DuckDuckGo for web searches. The `GroqChat` class handles all AI interactions. The `search_duckduckgo()` function searches the web, and `answer_factual_question()` combines search results with AI summarization.

**backend/policy.py** - Contains all policy logic including quiet hours, message classification (`classify_message()`), time questions (`answer_time_question()`), away mode, and yes/no normalization. This is the brain that decides how to handle each message type.

**backend/db.py** - SQLite database operations. Stores users, conversations, pending messages, app state (away mode), and away messages. Uses WAL mode for better concurrent access.

**backend/config.py** - Loads all settings from environment variables and `.env` files. Provides sensible defaults for all options.

**backend/gateway_client.py** - HTTP client that communicates with the gateway server. Handles sending messages, fetching chats, and status checks.

**gateway/server.mjs** - Node.js server that connects to WhatsApp Web using whatsapp-web.js. Forwards incoming messages to the backend webhook, handles sending messages, and manages the WhatsApp session.

---

## How It Works

### Message Flow

```
WhatsApp Message Received
        |
        v
[Gateway server.mjs]
        |
        v
[Backend /webhook endpoint]
        |
        v
+-------------------+
| Check Away Mode   |
+-------------------+
        |
        v
+-------------------+
| Classify Message  |
+-------------------+
        |
   +----+----+----+
   |         |         |         |
   v         v         v         v
 Time     Casual    Factual   Decision
   |         |         |         |
   v         v         v         v
 Clock    AI Draft  DDG+AI   Confirmation
 Reply     Reply    Summary    Flow
```

### Step-by-Step Processing

1. **Message arrives** at gateway via WhatsApp Web
2. **Gateway forwards** to backend `/webhook` endpoint
3. **Backend checks** if away mode is enabled
   - If yes: send away reply + store message
4. **Backend classifies** the message type:
   - **Time**: Answer instantly from system clock
   - **Casual**: AI drafts a friendly reply
   - **Factual**: Search DuckDuckGo, AI summarizes
   - **Decision**: Enter 2-phase confirmation flow
5. **Reply sent** back to WhatsApp via gateway

### Group Message Handling

Messages from WhatsApp groups (`@g.us`) are always classified as "decision" type, meaning they always go through the 2-phase confirmation flow. The agent never auto-replies in groups.

---

## Message Classification

The `classify_message()` function in `policy.py` categorizes messages using keyword matching and regex patterns.

### Classification Rules

**Time/Date Questions** (checked first):
- Patterns: "what time", "what's the date", "what day", "today's date"
- Action: Instant reply from system clock
- No AI or internet needed

**Casual Messages**:
- Keywords: hi, hello, hey, how are you, thanks, bye, good morning, etc.
- Action: AI drafts a friendly reply
- No web search needed

**Factual Questions**:
- Patterns: "who is", "what is", "how does", "why do", "explain", "define"
- Action: DuckDuckGo search + AI summary
- Uses web search for accurate info

**Decision Messages**:
- Keywords: tell, send, message, inform, forward, say to
- Also: any message in a group
- Action: 2-phase confirmation flow

### Default Behavior

If a message doesn't match any pattern, it defaults to "decision" type. This is the safest approach - requiring confirmation for ambiguous messages.

---

## Plans & Pricing

### Free Plan (Default)

Every user gets **15 free replies** when they first message the agent.

| Feature | Free Plan |
|---------|-----------|
| Auto-reply (casual/time) | 15 replies |
| Factual search (DuckDuckGo) | 15 replies |
| Message drafting | 15 replies |
| Away mode | Included |
| 2-phase confirmation | Included |

**How it works:**
1. User messages the agent for the first time
2. Counter starts at 0/15 replies used
3. Each auto-reply uses 1 reply from the counter
4. After 15 replies, agent stops responding
5. User must enter coupon code to continue

**When limit is reached:**
Agent replies: "You've used all 15 free replies. Enter coupon code to get unlimited access."

### Coupon Code System

Enter a coupon code to unlock unlimited access.

**How to redeem:**
1. Send: `coupon <your-code>`
2. Agent replies: "Coupon applied! You now have unlimited access."
3. All limits removed for this user

**Coupon rules:**
- Code must be in lowercase
- One coupon per user
- Once applied, unlimited access forever
- No expiration

> **Note:** Contact the developer to get your coupon code.

### Unlimited Plan (with Coupon)

| Feature | Free Plan | With Coupon |
|---------|-----------|-------------|
| Auto-reply (casual/time) | 15 replies | Unlimited |
| Factual search (DuckDuckGo) | 15 replies | Unlimited |
| Message drafting | 15 replies | Unlimited |
| Away mode | Included | Included |
| 2-phase confirmation | Included | Included |
| Group replies | Confirmation only | Confirmation only |

### Payment Integration (Coming Soon)

> **Note:** Paid plans and payment integration are coming soon. Currently, only the free plan with coupon code system is available.

**Planned features:**
- Secure online payments
- Multiple subscription tiers
- Auto-renewal
- Invoice generation
- Payment history

### Reply Counter

The reply counter tracks usage per user:

```sql
-- Stored in users table
CREATE TABLE users (
    wa_id TEXT PRIMARY KEY,
    reply_count INTEGER DEFAULT 0,
    max_replies INTEGER DEFAULT 15,
    coupon_code TEXT,
    is_unlimited BOOLEAN DEFAULT 0
);
```

**Counter logic:**
- New user: `reply_count = 0`, `max_replies = 15`
- Each reply: `reply_count += 1`
- Coupon entered: `is_unlimited = 1`, `max_replies = 999999`
- Check before reply: `if reply_count >= max_replies and not is_unlimited: stop`

---

## Away Mode

Away mode lets you auto-reply when you're unavailable. Messages received during away mode are stored for later review.

### How to Use

**Enable away mode:**
Send via WhatsApp: `away on`

**Disable away mode:**
Send via WhatsApp: `away off`

### What Happens When Away

1. Incoming message arrives
2. Agent sends auto-reply: "I'm currently unavailable. I will inform {owner_name} about this."
3. Message is stored in the database
4. Owner can review stored messages later via API

### Owner Name

The owner's name is automatically fetched from the WhatsApp account's display name (pushname). If unavailable, it defaults to "the owner".

### Customizing the Away Message

Set in `.env`:
```env
AWAY_MESSAGE_TEMPLATE=Hey, Malik is currently unavailable. I will inform him about this.
```

Use `{owner_name}` as a placeholder for the owner's name.

---

## Setup Guide

### Prerequisites

- Python 3.10+
- Node.js 18+
- WhatsApp account (for QR code scanning)
- Groq API key (free at console.groq.com)

### 1. Environment Variables

Copy `.env.example` to `.env` and edit:

```env
# Required: Groq API key for AI features
GROQ_API_KEY=your_groq_key_here

# Optional: Security tokens
GATEWAY_TOKEN=optional_gateway_token
BACKEND_API_TOKEN=optional_api_token

# Optional: Customize behavior
AWAY_MESSAGE_TEMPLATE=I'm currently unavailable. I will inform {owner_name} about this.
DEFAULT_TIMEZONE=Asia/Calcutta
```

### 2. Backend Setup

```powershell
cd backend
python -m venv venv
venv\Scripts\pip.exe install -r requirements.txt
venv\Scripts\python.exe app.py
```

Backend runs on `http://127.0.0.1:5000`.

### 3. Gateway Setup

```powershell
cd gateway
npm.cmd install
$env:BACKEND_WEBHOOK_URL="http://127.0.0.1:5000/webhook"
npm.cmd run start
```

Gateway runs on `http://127.0.0.1:3001`. On first run, scan the QR code with WhatsApp (Settings -> Linked Devices -> Link a Device).

### 4. Frontend Setup (Optional)

```powershell
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173` in your browser.

### 5. One-Command Start

**PowerShell:**
```powershell
.\start.ps1
```

**Bash:**
```bash
chmod +x start.sh
./start.sh
```

Logs are saved to:
- `backend/backend.out.log`
- `backend/backend.err.log`
- `frontend/frontend.out.log`
- `frontend/frontend.err.log`

---

## Deploy to Vercel

### Prerequisites

- Vercel account (free at vercel.com)
- Vercel CLI installed: `npm i -g vercel`
- GitHub repository (recommended)

### Step 1: Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/whatsapp-agent.git
git push -u origin main
```

### Step 2: Import to Vercel

1. Go to vercel.com/new
2. Import your GitHub repository
3. Vercel auto-detects the project
4. Click "Deploy"

### Step 3: Set Environment Variables

In Vercel dashboard -> Settings -> Environment Variables:

| Variable | Value |
|----------|-------|
| `GROQ_API_KEY` | Your Groq API key |
| `GATEWAY_TOKEN` | Optional gateway token |
| `BACKEND_API_TOKEN` | Optional API token |

### Step 4: Deploy

```bash
vercel --prod
```

Your app is now live at `https://your-project.vercel.app`

### What Works on Vercel

| Feature | Status |
|---------|--------|
| Frontend (React) | Works |
| Backend API | Works (serverless) |
| AI Drafting | Works |
| DuckDuckGo Search | Works |
| Time Questions | Works |
| Away Mode | Works |
| Coupon System | Works |
| WhatsApp Gateway | **Does NOT work** (needs local machine) |

### Important Notes

1. **WhatsApp Gateway must run locally** - Vercel cannot run WhatsApp Web (needs Chrome). Run gateway on your machine.

2. **SQLite limitations** - Vercel serverless functions have ephemeral storage. For production, consider:
   - PostgreSQL (Supabase, Neon)
   - MySQL (PlanetScale)
   - Turso (SQLite edge)

3. **Update gateway URL** - After deployment, update `BACKEND_WEBHOOK_URL` in your local gateway to point to your Vercel backend:

```powershell
$env:BACKEND_WEBHOOK_URL="https://your-project.vercel.app/webhook"
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | (required) | Groq API key for AI features |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | AI model to use |
| `GATEWAY_TOKEN` | (empty) | Token for gateway authentication |
| `BACKEND_API_TOKEN` | (empty) | Token for backend API authentication |
| `DB_PATH` | `backend/data/agent.db` | SQLite database path |
| `GATEWAY_BASE_URL` | `http://127.0.0.1:3001` | Gateway server URL |
| `DEFAULT_TIMEZONE` | `Asia/Calcutta` | Timezone for time answers |
| `AWAY_MESSAGE_TEMPLATE` | `I'm currently unavailable. I will inform {owner_name} about this.` | Away mode reply template |
| `QUIET_HOURS_START` | `2` | Quiet hours start (24h format) |
| `QUIET_HOURS_END` | `6` | Quiet hours end (24h format) |
| `REPLY_ONLY_MODE` | `true` | Only send to users who messaged first |
| `MAX_OUTGOING_PER_HOUR_TOTAL` | `50` | Global rate limit |
| `MAX_OUTGOING_PER_HOUR_PER_RECIPIENT` | `30` | Per-recipient rate limit |
| `PENDING_TTL_SECONDS` | `600` | Confirmation timeout (10 minutes) |
| `MEMORY_LIMIT` | `5` | Context lines for AI drafting |

---

## API Reference

### WhatsApp Agent API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook` | POST | Internal webhook for gateway messages |
| `/status` | GET | Gateway + backend status |
| `/send` | POST | Send message via gateway |
| `/logout` | POST | Logout WhatsApp session |

### Frontend API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/chats` | GET | List all chats |
| `/api/chats/:id/messages` | GET | Get messages for a chat |
| `/api/chats/:id/messages` | POST | Send message to a chat |
| `/api/chats/:id/inbound` | POST | Simulate inbound message |
| `/api/away-messages` | GET | Get messages received during away mode |
| `/api/user/:wa_id/instructions` | GET/POST | Get/set user instructions |

### Gateway API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Gateway status + user info |
| `/send` | POST | Send WhatsApp message |
| `/chats` | GET | List WhatsApp chats |
| `/qr` | GET | Get current QR code |
| `/logout` | POST | Logout WhatsApp |
| `/pairing-code` | POST | Request pairing code |

---

## Confirmation Flow

The 2-phase confirmation flow prevents accidental messages.

### How It Works

1. **You send an instruction:**
   "tell Ahmad I'll be late"

2. **Agent drafts a message:**
   "Hey Ahmad, I'll be running a bit late. Sorry for the delay."

3. **Agent asks for confirmation:**
   "Here's the message I drafted:
   
   Hey Ahmad, I'll be running a bit late. Sorry for the delay.
   
   Reply YES to send, or NO to cancel. (Expires in 10 minutes.)"

4. **You confirm:**
   - Reply `YES` -> Message sent
   - Reply `NO` -> Message canceled
   - No reply -> Expires after 10 minutes

### Bypassing Confirmation

Say "send immediately" or "no need to confirm" to skip the confirmation flow:
"send immediately to Ahmad that I'll be late"

---

## Troubleshooting

### Common Issues

**Gateway won't connect:**
- Make sure Chrome is installed
- Check if port 3001 is available
- Try deleting `.wwebjs_auth` folder and re-scanning QR

**AI not responding:**
- Verify `GROQ_API_KEY` is set correctly
- Check if Groq API is accessible
- Look at `backend/backend.err.log` for errors

**Messages not sending:**
- Check if WhatsApp Web is connected (scan QR)
- Verify rate limits aren't exceeded
- Check quiet hours settings

**DuckDuckGo search not working:**
- Verify internet connection
- Check if `duckduckgo-search` is installed: `pip install duckduckgo-search`

### Checking Status

Visit `http://127.0.0.1:5000/status` to see:
- Gateway connection status
- WhatsApp authentication status
- Away mode status
- Pending messages count

---

## License

This project is for educational purposes. Use responsibly and at your own risk.
