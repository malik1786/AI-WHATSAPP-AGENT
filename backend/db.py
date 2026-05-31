from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import os
import json
import requests

DATABASE_URL = os.getenv("DATABASE_URL", "")
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")

# Auto-detect Supabase URL from DATABASE_URL
if DATABASE_URL and not SUPABASE_URL:
    try:
        from urllib.parse import urlparse
        parsed = urlparse(DATABASE_URL)
        # Extract project ref from hostname: db.pzoonasapykuatqfkrli.supabase.co
        parts = parsed.hostname.split(".")
        project_ref = parts[0].replace("db.", "") if parts[0] == "db" else parts[0]
        SUPABASE_URL = f"https://{project_ref}.supabase.co"
    except Exception:
        pass

USE_POSTGREST = bool(SUPABASE_URL and SUPABASE_KEY)


def _pg_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


if USE_POSTGREST:
    # ---- PostgreSQL via Supabase REST API ----

    def connect(db_path: Path = None):
        r = requests.get(f"{SUPABASE_URL}/rest/v1/", headers=_pg_headers(), timeout=10)
        if r.status_code != 200:
            raise ConnectionError(f"Supabase REST failed: {r.status_code} {r.text[:200]}")
        return True

    def init_schema(conn=None):
        pass

    def _rest_get(table, params=""):
        r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}?{params}", headers=_pg_headers(), timeout=15)
        r.raise_for_status()
        return r.json()

    def _rest_insert(table, data):
        r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers={**_pg_headers(), "Prefer": "return=representation"}, json=data, timeout=15)
        r.raise_for_status()
        return r.json()

    def _rest_upsert(table, data, on_conflict=""):
        url = f"{SUPABASE_URL}/rest/v1/{table}"
        headers = {**_pg_headers(), "Prefer": "return=representation,resolution=merge-duplicates"}
        if on_conflict:
            url += f"?on_conflict={on_conflict}"
        r = requests.post(url, headers=headers, json=data, timeout=15)
        r.raise_for_status()
        return r.json()

    def _rest_update(table, data, filter_str):
        r = requests.patch(f"{SUPABASE_URL}/rest/v1/{table}?{filter_str}", headers={**_pg_headers(), "Prefer": "return=representation"}, json=data, timeout=15)
        r.raise_for_status()
        return r.json()

    def upsert_user(conn=None, wa_id=None, display_name=None, timezone_name=None):
        now = utcnow_iso()
        _rest_upsert("users", {"wa_id": wa_id, "display_name": display_name, "timezone": timezone_name, "created_at": now, "last_seen_at": now}, on_conflict="wa_id")

    def set_user_instructions(conn=None, wa_id=None, instructions=None):
        _rest_update("users", {"instructions": instructions}, f"wa_id=eq.{wa_id}")

    def get_user_instructions(conn=None, wa_id=None):
        rows = _rest_get("users", f"wa_id=eq.{wa_id}&select=instructions")
        return rows[0]["instructions"] if rows and rows[0].get("instructions") else None

    def add_conversation(conn=None, wa_id=None, direction=None, text=None, message_id=None):
        result = _rest_insert("conversations", {"wa_id": wa_id, "direction": direction, "text": text, "message_id": message_id, "created_at": utcnow_iso()})
        return result[0]["id"] if result else 0

    def get_last_messages(conn=None, wa_id=None, limit=5):
        rows = _rest_get("conversations", f"wa_id=eq.{wa_id}&order=created_at.desc&limit={limit}")
        rows.reverse()
        return rows

    def cleanup_expired_pending(conn=None):
        now = utcnow_iso()
        _rest_update("pending_messages", {"status": "expired"}, f"status=eq.pending&expires_at=lte.{now}")
        return 0

    def create_pending(conn=None, controller_wa_id=None, recipient_wa_id=None, original_request=None, final_message=None, ttl_seconds=600):
        now = datetime.now(timezone.utc)
        expires = datetime.fromtimestamp(now.timestamp() + ttl_seconds, tz=timezone.utc).isoformat()
        result = _rest_insert("pending_messages", {"controller_wa_id": controller_wa_id, "recipient_wa_id": recipient_wa_id, "original_request": original_request, "final_message": final_message, "created_at": now.isoformat(), "expires_at": expires, "status": "pending"})
        return result[0]["id"] if result else 0

    def get_latest_pending(conn=None, controller_wa_id=None):
        now = utcnow_iso()
        rows = _rest_get("pending_messages", f"controller_wa_id=eq.{controller_wa_id}&status=eq.pending&expires_at=gt.{now}&order=created_at.desc&limit=1")
        return rows[0] if rows else None

    def set_pending_status(conn=None, pending_id=None, status=None):
        _rest_update("pending_messages", {"status": status}, f"id=eq.{pending_id}")

    def count_outgoing_last_hour(conn=None, wa_id=None):
        cutoff_iso = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() - 3600, tz=timezone.utc).isoformat()
        if wa_id:
            rows = _rest_get("conversations", f"wa_id=eq.{wa_id}&direction=eq.out&created_at=gte.{cutoff_iso}&select=id")
        else:
            rows = _rest_get("conversations", f"direction=eq.out&created_at=gte.{cutoff_iso}&select=id")
        return len(rows)

    def get_app_state(conn=None, key=None):
        rows = _rest_get("app_state", f"key=eq.{key}&select=value")
        return rows[0]["value"] if rows else None

    def set_app_state(conn=None, key=None, value=None):
        _rest_upsert("app_state", {"key": key, "value": value, "updated_at": utcnow_iso()}, on_conflict="key")

    def is_away_mode(conn=None):
        return get_app_state(conn, "away_mode") == "on"

    def set_away_mode(conn=None, enabled=False):
        set_app_state(conn, "away_mode", "on" if enabled else "off")

    def store_away_message(conn=None, wa_id=None, text=None, message_id=None):
        result = _rest_insert("away_messages", {"wa_id": wa_id, "message_id": message_id, "text": text, "received_at": utcnow_iso()})
        return result[0]["id"] if result else 0

    def get_away_messages(conn=None, limit=50):
        return _rest_get("away_messages", f"order=received_at.desc&limit={limit}")

    def get_user_reply_info(conn=None, wa_id=None):
        rows = _rest_get("users", f"wa_id=eq.{wa_id}&select=reply_count,max_replies,is_unlimited,coupon_code")
        if not rows:
            return {"reply_count": 0, "max_replies": 15, "is_unlimited": False, "coupon_code": None}
        r = rows[0]
        return {"reply_count": r.get("reply_count", 0), "max_replies": r.get("max_replies", 15), "is_unlimited": bool(r.get("is_unlimited", False)), "coupon_code": r.get("coupon_code")}

    def can_user_reply(conn=None, wa_id=None):
        info = get_user_reply_info(conn, wa_id)
        return info["is_unlimited"] or info["reply_count"] < info["max_replies"]

    def increment_reply_count(conn=None, wa_id=None):
        info = get_user_reply_info(conn, wa_id)
        _rest_update("users", {"reply_count": info["reply_count"] + 1}, f"wa_id=eq.{wa_id}")

    def apply_coupon_code(conn=None, wa_id=None, code=None):
        from policy import is_valid_coupon
        if not is_valid_coupon(code):
            return False
        _rest_update("users", {"coupon_code": code.strip().lower(), "is_unlimited": True, "max_replies": 999999}, f"wa_id=eq.{wa_id}")
        return True

    def user_exists(conn=None, wa_id=None):
        rows = _rest_get("users", f"wa_id=eq.{wa_id}&select=wa_id")
        return len(rows) > 0

    def count_pending_messages(conn=None):
        rows = _rest_get("pending_messages", "status=eq.pending&select=id")
        return len(rows)

    def search_users_by_name(conn=None, tokens=None):
        if not tokens:
            return []
        rows = _rest_get("users", "select=wa_id,display_name,last_seen_at")
        results = []
        for r in rows:
            name = (r.get("display_name") or "").lower()
            if all(t in name for t in tokens):
                results.append(r)
        results.sort(key=lambda x: x.get("last_seen_at") or "", reverse=True)
        return results[:5]

    def list_chats(conn=None):
        users = _rest_get("users", "select=wa_id,display_name&order=last_seen_at.desc")
        result = []
        for u in users:
            w = u["wa_id"]
            convs = _rest_get("conversations", f"wa_id=eq.{w}&order=created_at.desc&limit=1&select=text,created_at")
            last = convs[0] if convs else {}
            result.append({
                "id": w,
                "name": u.get("display_name") or w,
                "avatarUrl": None,
                "lastMessage": last.get("text"),
                "lastMessageAt": last.get("created_at"),
                "unreadCount": 0,
            })
        result.sort(key=lambda x: (x["lastMessageAt"] is None, x["lastMessageAt"] or ""), reverse=False)
        result.sort(key=lambda x: x["lastMessageAt"] is None)
        result.sort(key=lambda x: (0 if x["lastMessageAt"] else 1, x["lastMessageAt"] or ""), reverse=True)
        return result

    def list_messages(conn=None, wa_id=None, limit=200):
        rows = _rest_get("conversations", f"wa_id=eq.{wa_id}&order=created_at.asc&limit={limit}&select=id,wa_id,direction,text,created_at")
        return rows

else:
    # ---- SQLite fallback ----
    import sqlite3

    def connect(db_path: Path) -> sqlite3.Connection:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path), timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;"); conn.execute("PRAGMA synchronous=NORMAL;"); conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def init_schema(conn: sqlite3.Connection) -> None:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT NOT NULL UNIQUE, display_name TEXT, timezone TEXT, instructions TEXT, reply_count INTEGER NOT NULL DEFAULT 0, max_replies INTEGER NOT NULL DEFAULT 15, coupon_code TEXT, is_unlimited INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('in','out')), text TEXT NOT NULL, message_id TEXT, created_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_conv_wa ON conversations(wa_id, created_at);
            CREATE TABLE IF NOT EXISTS pending_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, controller_wa_id TEXT NOT NULL, recipient_wa_id TEXT NOT NULL, original_request TEXT NOT NULL, final_message TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','canceled','expired')));
            CREATE INDEX IF NOT EXISTS idx_pend_ctrl ON pending_messages(controller_wa_id, expires_at);
            CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS away_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT NOT NULL, message_id TEXT, text TEXT NOT NULL, received_at TEXT NOT NULL, notified_owner INTEGER NOT NULL DEFAULT 0);
        """)
        for col, d in [("reply_count","0"),("max_replies","15"),("coupon_code","NULL"),("is_unlimited","0")]:
            try: conn.execute(f"ALTER TABLE users ADD COLUMN {col} INTEGER DEFAULT {d};"); conn.commit()
            except sqlite3.OperationalError: pass
        conn.commit()

    def upsert_user(conn, wa_id, display_name, timezone_name):
        now = utcnow_iso(); conn.execute("INSERT INTO users (wa_id,display_name,timezone,created_at,last_seen_at) VALUES (?,?,?,?,?) ON CONFLICT(wa_id) DO UPDATE SET display_name=COALESCE(excluded.display_name,users.display_name),timezone=COALESCE(users.timezone,excluded.timezone),last_seen_at=excluded.last_seen_at;",(wa_id,display_name,timezone_name,now,now)); conn.commit()
    def set_user_instructions(conn, wa_id, instructions): conn.execute("UPDATE users SET instructions=? WHERE wa_id=?;",(instructions,wa_id)); conn.commit()
    def get_user_instructions(conn, wa_id):
        cur = conn.execute("SELECT instructions FROM users WHERE wa_id=?;",(wa_id,)); row = cur.fetchone(); return row["instructions"] if row and row["instructions"] else None
    def add_conversation(conn, wa_id, direction, text, message_id=None):
        cur = conn.execute("INSERT INTO conversations (wa_id,direction,text,message_id,created_at) VALUES (?,?,?,?,?);",(wa_id,direction,text,message_id,utcnow_iso())); conn.commit(); return int(cur.lastrowid)
    def get_last_messages(conn, wa_id, limit):
        cur = conn.execute("SELECT direction,text,created_at FROM conversations WHERE wa_id=? ORDER BY created_at DESC LIMIT ?;",(wa_id,limit)); rows = cur.fetchall(); rows.reverse(); return rows
    def cleanup_expired_pending(conn):
        cur = conn.execute("UPDATE pending_messages SET status='expired' WHERE status='pending' AND expires_at<=?;",(utcnow_iso(),)); conn.commit(); return cur.rowcount
    def create_pending(conn=None, controller_wa_id=None, recipient_wa_id=None, original_request=None, final_message=None, ttl_seconds=600):
        ttl = ttl_seconds
        cwid, rid, orig, final = controller_wa_id, recipient_wa_id, original_request, final_message
        created = datetime.now(timezone.utc); expires = datetime.fromtimestamp(created.timestamp()+ttl,tz=timezone.utc).isoformat()
        cur = conn.execute("INSERT INTO pending_messages (controller_wa_id,recipient_wa_id,original_request,final_message,created_at,expires_at,status) VALUES (?,?,?,?,?,?,?);",(cwid,rid,orig,final,created.isoformat(),expires,"pending")); conn.commit(); return int(cur.lastrowid)
    def get_latest_pending(conn, cwid):
        cur = conn.execute("SELECT * FROM pending_messages WHERE controller_wa_id=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1;",(cwid,utcnow_iso())); return cur.fetchone()
    def set_pending_status(conn, pid, status): conn.execute("UPDATE pending_messages SET status=? WHERE id=?;",(status,pid)); conn.commit()
    def count_outgoing_last_hour(conn, wa_id=None):
        ci = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp()-3600,tz=timezone.utc).isoformat()
        if wa_id: cur = conn.execute("SELECT COUNT(*) AS c FROM conversations WHERE direction='out' AND wa_id=? AND created_at>=?;",(wa_id,ci))
        else: cur = conn.execute("SELECT COUNT(*) AS c FROM conversations WHERE direction='out' AND created_at>=?;",(ci,))
        return int(cur.fetchone()["c"])
    def get_app_state(conn, key):
        cur = conn.execute("SELECT value FROM app_state WHERE key=?;",(key,)); row = cur.fetchone(); return row["value"] if row else None
    def set_app_state(conn, key, value): conn.execute("INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;",(key,value,utcnow_iso())); conn.commit()
    def is_away_mode(conn): return get_app_state(conn,"away_mode")=="on"
    def set_away_mode(conn, e): set_app_state(conn,"away_mode","on" if e else "off")
    def store_away_message(conn, wa_id, text, mid):
        cur = conn.execute("INSERT INTO away_messages (wa_id,message_id,text,received_at) VALUES (?,?,?,?);",(wa_id,mid,text,utcnow_iso())); conn.commit(); return int(cur.lastrowid)
    def get_away_messages(conn, limit=50): return conn.execute("SELECT * FROM away_messages ORDER BY received_at DESC LIMIT ?;",(limit,)).fetchall()
    def get_user_reply_info(conn, wa_id):
        cur = conn.execute("SELECT reply_count,max_replies,is_unlimited,coupon_code FROM users WHERE wa_id=?;",(wa_id,)); row = cur.fetchone()
        if not row: return {"reply_count":0,"max_replies":15,"is_unlimited":False,"coupon_code":None}
        return {"reply_count":row["reply_count"],"max_replies":row["max_replies"],"is_unlimited":bool(row["is_unlimited"]),"coupon_code":row["coupon_code"]}
    def can_user_reply(conn, wa_id):
        info = get_user_reply_info(conn,wa_id); return info["is_unlimited"] or info["reply_count"]<info["max_replies"]
    def increment_reply_count(conn, wa_id): conn.execute("UPDATE users SET reply_count=reply_count+1 WHERE wa_id=?;",(wa_id,)); conn.commit()
    def apply_coupon_code(conn, wa_id, code):
        from policy import is_valid_coupon
        if not is_valid_coupon(code): return False
        conn.execute("UPDATE users SET coupon_code=?,is_unlimited=1,max_replies=999999 WHERE wa_id=?;",(code.strip().lower(),wa_id)); conn.commit(); return True

    def user_exists(conn, wa_id):
        cur = conn.execute("SELECT 1 FROM users WHERE wa_id=? LIMIT 1;", (wa_id,))
        return cur.fetchone() is not None

    def count_pending_messages(conn):
        row = conn.execute("SELECT COUNT(*) AS c FROM pending_messages WHERE status='pending';").fetchone()
        return int(row["c"])

    def search_users_by_name(conn, tokens):
        if not tokens:
            return []
        where = " AND ".join(["LOWER(COALESCE(display_name,'')) LIKE ?"] * len(tokens))
        params = [f"%{t}%" for t in tokens]
        cur = conn.execute(f"SELECT wa_id, display_name, last_seen_at FROM users WHERE {where} ORDER BY last_seen_at DESC LIMIT 5;", params)
        return [dict(r) for r in cur.fetchall()]

    def list_chats(conn):
        cur = conn.execute("""
            SELECT u.wa_id AS id, COALESCE(u.display_name, u.wa_id) AS name, NULL AS avatarUrl,
              (SELECT c.text FROM conversations c WHERE c.wa_id=u.wa_id ORDER BY c.created_at DESC LIMIT 1) AS lastMessage,
              (SELECT c.created_at FROM conversations c WHERE c.wa_id=u.wa_id ORDER BY c.created_at DESC LIMIT 1) AS lastMessageAt
            FROM users u ORDER BY (lastMessageAt IS NULL) ASC, lastMessageAt DESC;
        """)
        return [{"id": r["id"], "name": r["name"], "avatarUrl": r["avatarUrl"], "lastMessage": r["lastMessage"], "lastMessageAt": r["lastMessageAt"], "unreadCount": 0} for r in cur.fetchall()]

    def list_messages(conn, wa_id, limit=200):
        cur = conn.execute("SELECT id, wa_id, direction, text, created_at FROM conversations WHERE wa_id=? ORDER BY created_at ASC LIMIT ?;", (wa_id, limit))
        return [dict(r) for r in cur.fetchall()]
