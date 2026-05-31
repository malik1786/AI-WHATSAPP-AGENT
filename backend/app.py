from __future__ import annotations
from datetime import datetime, timezone
import os
import re
import requests
from flask import Flask, jsonify, request, send_from_directory, g
from flask_cors import CORS

from config import load_settings
from db import (
    connect,
    init_schema,
    upsert_user,
    add_conversation,
    get_last_messages,
    cleanup_expired_pending,
    create_pending,
    get_latest_pending,
    set_pending_status,
    set_user_instructions,
    get_user_instructions,
    count_outgoing_last_hour,
    is_away_mode,
    set_away_mode,
    store_away_message,
    get_away_messages,
    can_user_reply,
    increment_reply_count,
    apply_coupon_code,
    user_exists,
    count_pending_messages,
    search_users_by_name,
    list_chats,
    list_messages,
)
from gateway_client import GatewayClient
from ai_engine import GroqChat, plan_action, polish_whatsapp_message, answer_factual_question, is_valid_reply, init_validator, get_validator, init_confidence_scorer, get_confidence_scorer
from policy import QuietHours, AwayMode, normalize_yes_no, extract_phone_like, to_wa_id_from_digits, parse_away_command, classify_message, answer_time_question, parse_coupon_code


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


settings = load_settings()
DEMO_CHAT_ID = (os.getenv("DEMO_CHAT_ID") or "demo").strip() or "demo"
DEMO_CHAT_NAME = (os.getenv("DEMO_CHAT_NAME") or "Demo Chat").strip() or "Demo Chat"

# Initialize DB schema once at startup.
_init_conn = connect(settings.db_path)
init_schema(_init_conn)
upsert_user(_init_conn, wa_id=DEMO_CHAT_ID, display_name=DEMO_CHAT_NAME, timezone_name=settings.default_timezone)
if hasattr(_init_conn, "close"):
    _init_conn.close()

gateway = GatewayClient(base_url=settings.gateway_base_url, token=settings.gateway_token)
groq = GroqChat(api_key=settings.groq_api_key, model=settings.groq_model) if settings.groq_api_key else None

# Initialize reply validator and confidence scorer
if groq:
    init_validator(groq.client, groq.model)
    init_confidence_scorer(groq.client, groq.model)

_cached_owner_name: str | None = None


def _get_owner_name() -> str:
    global _cached_owner_name
    if _cached_owner_name:
        return _cached_owner_name
    try:
        info = gateway.status()
        user_info = info.get("userInfo") if isinstance(info, dict) else None
        if user_info and user_info.get("pushname"):
            _cached_owner_name = user_info["pushname"]
            return _cached_owner_name
    except Exception:
        pass
    return "the owner"

app = Flask(__name__, static_folder=None)
CORS(app, resources={r"/api/*": {"origins": "*"}})


# ---------------------------
# User Personalization API
# ---------------------------

@app.route("/api/user/<wa_id>/instructions", methods=["POST"])
def set_instructions(wa_id):
    if not request.is_json:
        return jsonify({"ok": False, "error": "Expected JSON body"}), 400
    data = request.get_json()
    instructions = data.get("instructions", "").strip()
    if not instructions:
        return jsonify({"ok": False, "error": "Instructions required"}), 400
    conn = get_db()
    set_user_instructions(conn, wa_id, instructions)
    return jsonify({"ok": True, "wa_id": wa_id, "instructions": instructions})


@app.route("/api/user/<wa_id>/instructions", methods=["GET"])
def get_instructions(wa_id):
    conn = get_db()
    instructions = get_user_instructions(conn, wa_id)
    return jsonify({"ok": True, "wa_id": wa_id, "instructions": instructions})


def get_db():
    if "db" not in g:
        g.db = connect(settings.db_path)
    return g.db


@app.teardown_appcontext
def _close_db(_exc):
    db = g.pop("db", None)
    if db is not None and hasattr(db, "close"):
        db.close()


def _require_token(expected: str) -> bool:
    if not expected:
        return True
    auth = request.headers.get("Authorization", "")
    return auth == f"Bearer {expected}"


def _user_exists(conn, wa_id: str) -> bool:
    return user_exists(conn, wa_id)


def _resolve_recipient(
    conn, recipient_hint: str | None, fallback_to: str, original_text: str
) -> str | None:
    if not recipient_hint:
        return fallback_to

    hint = str(recipient_hint).strip()
    if hint.endswith("@c.us") or hint.endswith("@g.us"):
        return hint

    digits_in_hint = re.sub(r"\D", "", hint)
    if digits_in_hint.isdigit() and len(digits_in_hint) >= 10:
        return to_wa_id_from_digits(digits_in_hint)

    digits = extract_phone_like(original_text)
    if digits:
        return to_wa_id_from_digits(digits)

    # Try to resolve by contact/chat name from synced WhatsApp chats.
    normalized = re.sub(r"[^a-z0-9]+", " ", hint.lower()).strip()
    tokens = [t for t in normalized.split() if t]
    if tokens:
        rows = search_users_by_name(conn, tokens)
        if len(rows) == 1:
            return str(rows[0]["wa_id"])

    return fallback_to or None


def _send_with_policies(
    conn, controller_wa_id: str, recipient_wa_id: str, text: str
) -> tuple[bool, str | None, int | None]:
    qh = QuietHours(
        start_hour=settings.quiet_hours_start,
        end_hour=settings.quiet_hours_end,
        timezone_name=settings.default_timezone,
    )
    if qh.is_quiet_now():
        return (
            False,
            f"Blocked by quiet hours ({settings.quiet_hours_start:02d}:00-{settings.quiet_hours_end:02d}:00).",
            None,
        )

    if settings.reply_only_mode and not _user_exists(conn, recipient_wa_id):
        return False, "Reply-only mode: recipient must message you first.", None

    if count_outgoing_last_hour(conn, None) >= settings.max_outgoing_per_hour_total:
        return False, "Rate limit hit: too many outgoing messages in the last hour.", None
    if count_outgoing_last_hour(conn, recipient_wa_id) >= settings.max_outgoing_per_hour_per_recipient:
        return False, "Rate limit hit: too many messages to this recipient in the last hour.", None

    try:
        gateway.send(to=recipient_wa_id, text=text, simulate_typing=True)
    except Exception as e:
        return False, f"Gateway error: {e}", None
    convo_id = add_conversation(conn, recipient_wa_id, "out", text, message_id=None)
    return True, None, convo_id


def _http_status_for_send_error(err: str | None) -> int:
    if not err:
        return 500
    if err.startswith("Gateway error:"):
        return 502
    return 429


def _gateway_error_response(e: Exception) -> tuple[dict, int]:
    if isinstance(e, requests.exceptions.ConnectionError):
        return (
            {
                "ok": False,
                "code": "GATEWAY_OFFLINE",
                "error": "Gateway is offline. Start it with `npm run dev:gateway` (or `npm run dev:all`).",
            },
            502,
        )
    if isinstance(e, requests.exceptions.Timeout):
        return (
            {
                "ok": False,
                "code": "GATEWAY_TIMEOUT",
                "error": "Gateway timed out. Check if the gateway process is healthy.",
            },
            504,
        )
    if isinstance(e, requests.exceptions.HTTPError) and getattr(e.response, "status_code", None) == 404:
        return ({"ok": False, "code": "NOT_FOUND", "error": "not found"}, 404)
    return ({"ok": False, "code": "GATEWAY_ERROR", "error": str(e)}, 502)


def _require_backend_api_token() -> bool:
    return _require_token(settings.backend_api_token)


# ---------------------------
# WhatsApp Agent API
# ---------------------------

@app.post("/webhook")
def webhook():
    if settings.gateway_token and not _require_token(settings.gateway_token):
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    wa_from = str(payload.get("from") or "").strip()
    body = str(payload.get("body") or "").strip()
    message_id = payload.get("id")

    if not wa_from or not body:
        return jsonify({"ok": True, "ignored": True})

    conn = get_db()

    cleanup_expired_pending(conn)
    upsert_user(conn, wa_id=wa_from, display_name=None, timezone_name=settings.default_timezone)
    add_conversation(conn, wa_from, "in", body, message_id=message_id)

    # --- Away mode toggle command ---
    away_cmd = parse_away_command(body)
    if away_cmd is not None:
        new_state = away_cmd == "on"
        set_away_mode(conn, new_state)
        if new_state:
            reply = "Away mode ON. I'll auto-reply and store messages until you turn it off."
        else:
            reply = "Away mode OFF. Resuming normal operation."
        try:
            gateway.send(to=wa_from, text=reply, simulate_typing=True)
        except Exception:
            pass
        add_conversation(conn, wa_from, "out", reply, message_id=None)
        return jsonify({"ok": True})

    # --- Away mode active: auto-reply and store ---
    if is_away_mode(conn):
        owner_name = _get_owner_name()
        away_policy = AwayMode(
            enabled=True,
            owner_name=owner_name,
            template=settings.away_message_template,
        )
        away_reply = away_policy.render_reply()
        try:
            gateway.send(to=wa_from, text=away_reply, simulate_typing=True)
        except Exception:
            pass
        add_conversation(conn, wa_from, "out", away_reply, message_id=None)
        store_away_message(conn, wa_from, body, message_id)
        return jsonify({"ok": True, "away_mode": True})

    # --- Message classification ---
    is_group = payload.get("isGroup", False)
    msg_type = classify_message(body, is_group=is_group)

    # --- Coupon code handling ---
    if msg_type == "coupon":
        coupon_code = parse_coupon_code(body)
        if coupon_code and apply_coupon_code(conn, wa_from, coupon_code):
            reply = "Coupon applied! You now have unlimited access."
        else:
            reply = "Invalid coupon code. Please try again."
        try:
            gateway.send(to=wa_from, text=reply, simulate_typing=True)
        except Exception:
            pass
        add_conversation(conn, wa_from, "out", reply, message_id=None)
        return jsonify({"ok": True, "coupon": True})

    # --- Check reply limit (only for auto-reply types) ---
    if msg_type in ("casual", "factual", "time") and not is_group:
        if not can_user_reply(conn, wa_from):
            reply = "You've used all 15 free replies. Enter coupon code to get unlimited access."
            try:
                gateway.send(to=wa_from, text=reply, simulate_typing=True)
            except Exception:
                pass
            add_conversation(conn, wa_from, "out", reply, message_id=None)
            return jsonify({"ok": True, "limit_reached": True})

    # --- Auto-reply to casual/factual/time ---
    if msg_type in ("casual", "factual", "time") and not is_group:
        if msg_type == "time":
            reply = answer_time_question(body, settings.default_timezone)
        elif msg_type == "factual" and groq:
            reply = answer_factual_question(groq, body)
        elif groq:
            reply = polish_whatsapp_message(groq, instruction=body)
        else:
            reply = "Hi! How can I help you?"

        # Validate reply before sending
        if not is_valid_reply(reply):
            print(f"[APP] Invalid reply detected: {reply!r}, using fallback")
            reply = "Got it!"

        # Check confidence score
        scorer = get_confidence_scorer()
        confidence = scorer.score(body, reply, msg_type)
        print(f"[APP] Confidence: {confidence['score']}% ({confidence['level']}) - {confidence['reason']}")

        # If confidence is low, ask for confirmation
        if not confidence["should_auto_send"]:
            confirm = (
                f"I'm not sure how to reply to this.\n\n"
                f"My draft: {reply}\n\n"
                f"Reply YES to send, or NO to cancel."
            )
            try:
                gateway.send(to=wa_from, text=confirm, simulate_typing=True)
            except Exception:
                pass
            add_conversation(conn, wa_from, "out", confirm, message_id=None)
            # Store as pending for confirmation
            create_pending(
                conn,
                controller_wa_id=wa_from,
                recipient_wa_id=wa_from,
                original_request=body,
                final_message=reply,
                ttl_seconds=settings.pending_ttl_seconds,
            )
            return jsonify({"ok": True, "auto_replied": False, "confidence": confidence["score"]})

        # High confidence - auto-send
        increment_reply_count(conn, wa_from)

        try:
            gateway.send(to=wa_from, text=reply, simulate_typing=True)
        except Exception:
            pass
        add_conversation(conn, wa_from, "out", reply, message_id=None)
        return jsonify({"ok": True, "auto_replied": True, "type": msg_type, "confidence": confidence["score"]})

    yn = normalize_yes_no(body)
    if yn is not None:
        pending = get_latest_pending(conn, wa_from)
        if not pending:
            reply = "No pending message. Send a new instruction."
            gateway.send(to=wa_from, text=reply, simulate_typing=True)
            add_conversation(conn, wa_from, "out", reply, message_id=None)
            return jsonify({"ok": True})

        pending_id = int(pending["id"])
        if yn == "no":
            set_pending_status(conn, pending_id, "canceled")
            reply = "Okay — canceled. I won't send anything."
            gateway.send(to=wa_from, text=reply, simulate_typing=True)
            add_conversation(conn, wa_from, "out", reply, message_id=None)
            return jsonify({"ok": True})

        recipient = str(pending["recipient_wa_id"])
        final_message = str(pending["final_message"])
        ok, err, _convo_id = _send_with_policies(conn, wa_from, recipient, final_message)
        if ok:
            set_pending_status(conn, pending_id, "sent")
            reply = "Sent."
        else:
            reply = f"Sorry — I couldn't send that. {err}"
        try:
            gateway.send(to=wa_from, text=reply, simulate_typing=True)
        except Exception:
            pass
        add_conversation(conn, wa_from, "out", reply, message_id=None)
        return jsonify({"ok": True})

    if not groq:
        reply = "AI is not configured. Set GROQ_API_KEY in your environment."
        gateway.send(to=wa_from, text=reply, simulate_typing=True)
        add_conversation(conn, wa_from, "out", reply, message_id=None)
        return jsonify({"ok": True})

    action = plan_action(groq, body)
    recipient_hint = action.get("recipient")
    # Use original text for drafting to avoid overly-short "intent" outputs.
    message_intent = str(action.get("message_intent") or body)
    send_immediately = bool(action.get("send_immediately"))

    recipient_wa_id = _resolve_recipient(conn, recipient_hint, fallback_to=wa_from, original_text=body)
    if not recipient_wa_id:
        reply = "Which WhatsApp number should I send to? Reply with a phone number including country code (e.g. +9198xxxxxxx)."
        gateway.send(to=wa_from, text=reply, simulate_typing=True)
        add_conversation(conn, wa_from, "out", reply, message_id=None)
        return jsonify({"ok": True})

    ctx_rows = get_last_messages(conn, wa_from, settings.memory_limit)
    ctx_lines = [f"{r['direction']}: {r['text']}" for r in ctx_rows]
    # Fetch user instructions for personalization
    user_instructions = get_user_instructions(conn, wa_from)
    final_message = polish_whatsapp_message(
        groq,
        instruction=body,
        context_lines=ctx_lines,
        custom_behavior=user_instructions,
    )

    if send_immediately:
        ok, err, _convo_id = _send_with_policies(conn, wa_from, recipient_wa_id, final_message)
        reply = "Sent." if ok else f"Sorry — I couldn't send that. {err}"
        try:
            gateway.send(to=wa_from, text=reply, simulate_typing=True)
        except Exception:
            pass
        add_conversation(conn, wa_from, "out", reply, message_id=None)
        return jsonify({"ok": True})

    create_pending(
        conn,
        controller_wa_id=wa_from,
        recipient_wa_id=recipient_wa_id,
        original_request=body,
        final_message=final_message,
        ttl_seconds=settings.pending_ttl_seconds,
    )
    confirm = (
        "Here's the message I drafted:\n\n"
        f"{final_message}\n\n"
        "Reply YES to send, or NO to cancel. (Expires in 10 minutes.)"
    )
    gateway.send(to=wa_from, text=confirm, simulate_typing=True)
    add_conversation(conn, wa_from, "out", confirm, message_id=None)
    return jsonify({"ok": True})


# ---------------------------
# UI Agent API (instruction box)
# ---------------------------

@app.post("/api/agent/instruction")
def api_agent_instruction():
    if settings.backend_api_token and not _require_backend_api_token():
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    instruction = str(payload.get("text") or "").strip()
    if not instruction:
        return jsonify({"error": "text is required"}), 400

    conn = get_db()
    cleanup_expired_pending(conn)

    if not groq:
        return jsonify({"error": "Groq is not configured. Set GROQ_API_KEY to enable AI."}), 503

    action = plan_action(groq, instruction)
    recipient_hint = action.get("recipient")
    # Use original instruction for drafting so details/names aren't lost.
    message_intent = str(action.get("message_intent") or instruction)
    send_immediately = bool(action.get("send_immediately"))
    custom_behavior = str(payload.get("customBehavior") or "").strip() or None

    default_recipient = str(payload.get("defaultRecipient") or "").strip()
    recipient_wa_id = _resolve_recipient(conn, recipient_hint, fallback_to=default_recipient, original_text=instruction)
    if not recipient_wa_id:
        return jsonify(
            {
                "mode": "need_recipient",
                "message": "Recipient not found. Select a chat on the left, or type a phone number with country code (e.g. +9198xxxxxxx).",
            }
        )

    if recipient_wa_id == DEMO_CHAT_ID:
        return jsonify(
            {
                "mode": "need_recipient",
                "message": "Select a real WhatsApp chat on the left (not Demo Chat), or type a phone number with country code (e.g. +9198xxxxxxx).",
            }
        )

    ctx_rows = get_last_messages(conn, recipient_wa_id, settings.memory_limit)
    ctx_lines = [f"{r['direction']}: {r['text']}" for r in ctx_rows]
    final_message = polish_whatsapp_message(
        groq,
        instruction=instruction,
        context_lines=ctx_lines,
        custom_behavior=custom_behavior,
    )

    if send_immediately:
        ok, err, convo_id = _send_with_policies(
            conn, controller_wa_id="ui", recipient_wa_id=recipient_wa_id, text=final_message
        )
        if not ok:
            return jsonify({"mode": "error", "error": err}), _http_status_for_send_error(err)
        return jsonify({"mode": "sent", "to": recipient_wa_id, "conversationId": convo_id})

    pending_id = create_pending(
        conn,
        controller_wa_id="ui",
        recipient_wa_id=recipient_wa_id,
        original_request=instruction,
        final_message=final_message,
        ttl_seconds=settings.pending_ttl_seconds,
    )
    return jsonify(
        {
            "mode": "need_confirm",
            "pendingId": pending_id,
            "to": recipient_wa_id,
            "message": final_message,
            "expiresInSeconds": settings.pending_ttl_seconds,
        }
    )


@app.post("/api/agent/confirm")
def api_agent_confirm():
    if settings.backend_api_token and not _require_backend_api_token():
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    answer = str(payload.get("answer") or "").strip().lower()
    if answer not in {"yes", "no"}:
        return jsonify({"error": "answer must be 'yes' or 'no'"}), 400

    conn = get_db()
    cleanup_expired_pending(conn)

    pending = get_latest_pending(conn, "ui")
    if not pending:
        return jsonify({"error": "No pending message to confirm."}), 409

    pending_id = int(pending["id"])
    if answer == "no":
        set_pending_status(conn, pending_id, "canceled")
        return jsonify({"mode": "canceled"})

    recipient = str(pending["recipient_wa_id"])
    final_message = str(pending["final_message"])
    ok, err, convo_id = _send_with_policies(conn, controller_wa_id="ui", recipient_wa_id=recipient, text=final_message)
    if ok:
        set_pending_status(conn, pending_id, "sent")
        return jsonify({"mode": "sent", "to": recipient, "conversationId": convo_id})
    return jsonify({"mode": "error", "error": err}), _http_status_for_send_error(err)


@app.get("/api/away-messages")
def api_away_messages():
    if settings.backend_api_token and not _require_backend_api_token():
        return jsonify({"error": "unauthorized"}), 401
    conn = get_db()
    rows = get_away_messages(conn)
    messages = []
    for r in rows:
        messages.append({
            "id": r["id"],
            "wa_id": r["wa_id"],
            "text": r["text"],
            "receivedAt": r["received_at"],
        })
    return jsonify({"ok": True, "messages": messages})


@app.get("/status")
def status():
    try:
        gw = gateway.status()
    except Exception as e:
        gw = {"ok": False, "error": str(e)}

    conn = get_db()
    cleanup_expired_pending(conn)
    pending_count = count_pending_messages(conn)

    return jsonify(
        {
            "ok": True,
            "time": utcnow_iso(),
            "gateway": gw,
            "pendingMessages": pending_count,
            "awayMode": is_away_mode(conn),
            "ownerName": _get_owner_name(),
        }
    )


@app.post("/send")
def send_direct():
    if settings.backend_api_token and not _require_token(settings.backend_api_token):
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    to = str(payload.get("to") or "").strip()
    text = str(payload.get("text") or "").strip()
    if not to or not text:
        return jsonify({"error": "`to` and `text` are required"}), 400

    conn = get_db()
    cleanup_expired_pending(conn)
    ok, err, _convo_id = _send_with_policies(conn, controller_wa_id="api", recipient_wa_id=to, text=text)
    if not ok:
        return jsonify({"ok": False, "error": err}), 429
    return jsonify({"ok": True})


@app.post("/logout")
def logout():
    if settings.backend_api_token and not _require_token(settings.backend_api_token):
        return jsonify({"error": "unauthorized"}), 401
    try:
        return jsonify(gateway.logout())
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ---------------------------
# Frontend + UI API
# ---------------------------

@app.get("/api/health")
def api_health():
    return jsonify({"ok": True, "time": utcnow_iso()})


@app.get("/api/gateway/status")
def api_gateway_status():
    if settings.backend_api_token and not _require_backend_api_token():
        return jsonify({"error": "unauthorized"}), 401
    try:
        return jsonify(gateway.status())
    except Exception as e:
        payload, status = _gateway_error_response(e)
        return jsonify(payload), status


@app.get("/api/gateway/qr")
def api_gateway_qr():
    if settings.backend_api_token and not _require_backend_api_token():
        return jsonify({"error": "unauthorized"}), 401
    try:
        return jsonify(gateway.qr())
    except Exception as e:
        payload, status = _gateway_error_response(e)
        return jsonify(payload), status


@app.post("/api/gateway/sync-chats")
def api_gateway_sync_chats():
    if settings.backend_api_token and not _require_backend_api_token():
        return jsonify({"error": "unauthorized"}), 401

    conn = get_db()
    try:
        res = gateway.chats()
        items = res.get("chats") if isinstance(res, dict) else None
        if not isinstance(items, list):
            return jsonify({"error": "invalid gateway response"}), 502

        synced = 0
        for c in items:
            wa_id = str(c.get("id") or "").strip()
            if not wa_id:
                continue
            name = c.get("name")
            display_name = str(name).strip() if name else None
            upsert_user(conn, wa_id=wa_id, display_name=display_name, timezone_name=settings.default_timezone)
            synced += 1

        return jsonify({"ok": True, "synced": synced})
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.post("/api/gateway/pairing-code")
def api_gateway_pairing_code():
    if settings.backend_api_token and not _require_backend_api_token():
        return jsonify({"error": "unauthorized"}), 401
    payload = request.get_json(silent=True) or {}
    phone_number = str(payload.get("phoneNumber") or "").strip()
    if not phone_number:
        return jsonify({"error": "phoneNumber is required"}), 400
    try:
        return jsonify(gateway.pairing_code(phone_number))
    except Exception as e:
        payload, status = _gateway_error_response(e)
        return jsonify(payload), status


@app.post("/api/gateway/cancel-pairing")
def api_gateway_cancel_pairing():
    if settings.backend_api_token and not _require_backend_api_token():
        return jsonify({"error": "unauthorized"}), 401
    try:
        return jsonify(gateway.cancel_pairing())
    except Exception as e:
        payload, status = _gateway_error_response(e)
        return jsonify(payload), status


@app.post("/api/gateway/reset")
def api_gateway_reset():
    if settings.backend_api_token and not _require_backend_api_token():
        return jsonify({"error": "unauthorized"}), 401
    try:
        return jsonify(gateway.reset())
    except Exception as e:
        payload, status = _gateway_error_response(e)
        return jsonify(payload), status


@app.get("/api/chats")
def api_list_chats():
    conn = get_db()
    chats = list_chats(conn)
    return jsonify({"chats": chats})


@app.get("/api/chats/<chat_id>/messages")
def api_list_messages(chat_id: str):
    conn = get_db()
    rows = list_messages(conn, chat_id)
    messages = [
        {
            "id": str(r["id"]),
            "chatId": r["wa_id"],
            "direction": r["direction"],
            "text": r["text"],
            "createdAt": r["created_at"],
            "status": "sent",
        }
        for r in rows
    ]
    return jsonify({"messages": messages})


@app.post("/api/chats/<chat_id>/messages")
def api_send_message(chat_id: str):
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400

    conn = get_db()
    
    if chat_id == DEMO_CHAT_ID:
        upsert_user(conn, wa_id=DEMO_CHAT_ID, display_name=DEMO_CHAT_NAME, timezone_name=settings.default_timezone)
        out_id = add_conversation(conn, DEMO_CHAT_ID, "out", text, message_id=None)

        # No demo/fake replies: only reply if Groq is configured and the API call succeeds.
        if not groq:
            return jsonify({"error": "Groq is not configured. Set GROQ_API_KEY to enable AI replies."}), 503

        try:
            ctx_rows = get_last_messages(conn, DEMO_CHAT_ID, settings.memory_limit)
            ctx_lines = [f"{r['direction']}: {r['text']}" for r in ctx_rows]
            reply_text = polish_whatsapp_message(groq, instruction=text, context_lines=ctx_lines)
            add_conversation(conn, DEMO_CHAT_ID, "in", reply_text, message_id=None)
        except Exception:
            return jsonify({"error": "Groq is configured but the AI request failed. Check GROQ_API_KEY/GROQ_MODEL and server logs."}), 502

        msg = {
            "id": str(out_id),
            "chatId": DEMO_CHAT_ID,
            "direction": "out",
            "text": text,
            "createdAt": utcnow_iso(),
            "status": "sent",
        }
        return jsonify({"message": msg})

    ok, err, convo_id = _send_with_policies(conn, controller_wa_id="ui", recipient_wa_id=chat_id, text=text)
    if not ok:
        return jsonify({"error": err}), _http_status_for_send_error(err)

    msg = {
        "id": str(convo_id) if convo_id is not None else utcnow_iso(),
        "chatId": chat_id,
        "direction": "out",
        "text": text,
        "createdAt": utcnow_iso(),
        "status": "sent",
    }
    return jsonify({"message": msg})


@app.post("/api/chats/<chat_id>/inbound")
def api_inbound_message(chat_id: str):
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400

    conn = get_db()
    upsert_user(conn, wa_id=chat_id, display_name=None, timezone_name=settings.default_timezone)
    msg_id = add_conversation(conn, chat_id, "in", text, message_id=None)

    msg = {
        "id": str(msg_id),
        "chatId": chat_id,
        "direction": "in",
        "text": text,
        "createdAt": utcnow_iso(),
        "status": "sent",
    }
    return jsonify({"message": msg})


@app.get("/")
def index():
    if settings.frontend_dist.exists():
        return send_from_directory(settings.frontend_dist, "index.html")
    return jsonify({"ok": True, "message": "Frontend not built yet. Run `npm run build` in `frontend`."})


@app.get("/<path:path>")
def static_files(path: str):
    if not settings.frontend_dist.exists():
        return jsonify({"error": "not found"}), 404

    file_path = settings.frontend_dist / path
    if file_path.exists() and file_path.is_file():
        return send_from_directory(settings.frontend_dist, path)
    return send_from_directory(settings.frontend_dist, "index.html")


if __name__ == "__main__":
    port = int(os.getenv("BACKEND_PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True, use_reloader=False)
