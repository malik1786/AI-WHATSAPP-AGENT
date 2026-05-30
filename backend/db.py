from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    wa_id TEXT NOT NULL UNIQUE,
                    display_name TEXT,
                    timezone TEXT,
                    instructions TEXT,
                    reply_count INTEGER NOT NULL DEFAULT 0,
                    max_replies INTEGER NOT NULL DEFAULT 15,
                    coupon_code TEXT,
                    is_unlimited INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL
                );

        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wa_id TEXT NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('in','out')),
          text TEXT NOT NULL,
          message_id TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_conversations_wa_id_created_at
          ON conversations(wa_id, created_at);

        CREATE TABLE IF NOT EXISTS pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          controller_wa_id TEXT NOT NULL,
          recipient_wa_id TEXT NOT NULL,
          original_request TEXT NOT NULL,
          final_message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','canceled','expired'))
        );

        CREATE INDEX IF NOT EXISTS idx_pending_controller_expires
          ON pending_messages(controller_wa_id, expires_at);

        CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS away_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wa_id TEXT NOT NULL,
            message_id TEXT,
            text TEXT NOT NULL,
            received_at TEXT NOT NULL,
            notified_owner INTEGER NOT NULL DEFAULT 0
        );
        """
    )

    for col, default in [
        ("reply_count", "0"),
        ("max_replies", "15"),
        ("coupon_code", "NULL"),
        ("is_unlimited", "0"),
    ]:
        try:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} INTEGER DEFAULT {default};")
            conn.commit()
        except sqlite3.OperationalError:
            pass

    conn.commit()


def upsert_user(conn: sqlite3.Connection, wa_id: str, display_name: str | None, timezone_name: str) -> None:
    now = utcnow_iso()
    conn.execute(
        """
        INSERT INTO users (wa_id, display_name, timezone, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(wa_id) DO UPDATE SET
          display_name=COALESCE(excluded.display_name, users.display_name),
          timezone=COALESCE(users.timezone, excluded.timezone),
          last_seen_at=excluded.last_seen_at;
        """,
        (wa_id, display_name, timezone_name, now, now),
    )
    conn.commit()


def set_user_instructions(conn: sqlite3.Connection, wa_id: str, instructions: str) -> None:
    conn.execute("UPDATE users SET instructions=? WHERE wa_id=?;", (instructions, wa_id))
    conn.commit()


def get_user_instructions(conn: sqlite3.Connection, wa_id: str) -> str | None:
    cur = conn.execute("SELECT instructions FROM users WHERE wa_id=?;", (wa_id,))
    row = cur.fetchone()
    return row["instructions"] if row and row["instructions"] else None


def add_conversation(
    conn: sqlite3.Connection, wa_id: str, direction: str, text: str, message_id: str | None = None
) -> int:
    cur = conn.execute(
        "INSERT INTO conversations (wa_id, direction, text, message_id, created_at) VALUES (?, ?, ?, ?, ?);",
        (wa_id, direction, text, message_id, utcnow_iso()),
    )
    conn.commit()
    return int(cur.lastrowid)


def get_last_messages(conn: sqlite3.Connection, wa_id: str, limit: int) -> list[sqlite3.Row]:
    cur = conn.execute(
        "SELECT direction, text, created_at FROM conversations WHERE wa_id=? ORDER BY created_at DESC LIMIT ?;",
        (wa_id, limit),
    )
    rows = cur.fetchall()
    rows.reverse()
    return rows


def cleanup_expired_pending(conn: sqlite3.Connection) -> int:
    now = utcnow_iso()
    cur = conn.execute(
        "UPDATE pending_messages SET status='expired' WHERE status='pending' AND expires_at <= ?;",
        (now,),
    )
    conn.commit()
    return cur.rowcount


def create_pending(
    conn: sqlite3.Connection,
    controller_wa_id: str,
    recipient_wa_id: str,
    original_request: str,
    final_message: str,
    ttl_seconds: int,
) -> int:
    created = datetime.now(timezone.utc)
    expires = created.timestamp() + ttl_seconds
    expires_at = datetime.fromtimestamp(expires, tz=timezone.utc).isoformat()
    cur = conn.execute(
        """
        INSERT INTO pending_messages
          (controller_wa_id, recipient_wa_id, original_request, final_message, created_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending');
        """,
        (controller_wa_id, recipient_wa_id, original_request, final_message, created.isoformat(), expires_at),
    )
    conn.commit()
    return int(cur.lastrowid)


def get_latest_pending(conn: sqlite3.Connection, controller_wa_id: str) -> sqlite3.Row | None:
    now = utcnow_iso()
    cur = conn.execute(
        """
        SELECT *
        FROM pending_messages
        WHERE controller_wa_id=? AND status='pending' AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1;
        """,
        (controller_wa_id, now),
    )
    return cur.fetchone()


def set_pending_status(conn: sqlite3.Connection, pending_id: int, status: str) -> None:
    conn.execute("UPDATE pending_messages SET status=? WHERE id=?;", (status, pending_id))
    conn.commit()


def count_outgoing_last_hour(conn: sqlite3.Connection, wa_id: str | None = None) -> int:
    cutoff = datetime.now(timezone.utc).timestamp() - 3600
    cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()
    if wa_id:
        cur = conn.execute(
            """
            SELECT COUNT(*) AS c
            FROM conversations
            WHERE direction='out' AND wa_id=? AND created_at >= ?;
            """,
            (wa_id, cutoff_iso),
        )
    else:
        cur = conn.execute(
            """
            SELECT COUNT(*) AS c
            FROM conversations
            WHERE direction='out' AND created_at >= ?;
            """,
            (cutoff_iso,),
        )
    return int(cur.fetchone()["c"])


def get_app_state(conn: sqlite3.Connection, key: str) -> str | None:
    cur = conn.execute("SELECT value FROM app_state WHERE key=?;", (key,))
    row = cur.fetchone()
    return row["value"] if row else None


def set_app_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    now = utcnow_iso()
    conn.execute(
        "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;",
        (key, value, now),
    )
    conn.commit()


def is_away_mode(conn: sqlite3.Connection) -> bool:
    return get_app_state(conn, "away_mode") == "on"


def set_away_mode(conn: sqlite3.Connection, enabled: bool) -> None:
    set_app_state(conn, "away_mode", "on" if enabled else "off")


def store_away_message(conn: sqlite3.Connection, wa_id: str, text: str, message_id: str | None) -> int:
    cur = conn.execute(
        "INSERT INTO away_messages (wa_id, message_id, text, received_at) VALUES (?, ?, ?, ?);",
        (wa_id, message_id, text, utcnow_iso()),
    )
    conn.commit()
    return int(cur.lastrowid)


def get_away_messages(conn: sqlite3.Connection, limit: int = 50) -> list[sqlite3.Row]:
    cur = conn.execute(
        "SELECT * FROM away_messages ORDER BY received_at DESC LIMIT ?;", (limit,)
    )
    return cur.fetchall()


def get_user_reply_info(conn: sqlite3.Connection, wa_id: str) -> dict:
    cur = conn.execute(
        "SELECT reply_count, max_replies, is_unlimited, coupon_code FROM users WHERE wa_id=?;",
        (wa_id,),
    )
    row = cur.fetchone()
    if not row:
        return {"reply_count": 0, "max_replies": 15, "is_unlimited": False, "coupon_code": None}
    return {
        "reply_count": row["reply_count"],
        "max_replies": row["max_replies"],
        "is_unlimited": bool(row["is_unlimited"]),
        "coupon_code": row["coupon_code"],
    }


def can_user_reply(conn: sqlite3.Connection, wa_id: str) -> bool:
    info = get_user_reply_info(conn, wa_id)
    if info["is_unlimited"]:
        return True
    return info["reply_count"] < info["max_replies"]


def increment_reply_count(conn: sqlite3.Connection, wa_id: str) -> None:
    conn.execute(
        "UPDATE users SET reply_count = reply_count + 1 WHERE wa_id=?;",
        (wa_id,),
    )
    conn.commit()


def apply_coupon_code(conn: sqlite3.Connection, wa_id: str, code: str) -> bool:
    from policy import is_valid_coupon
    if not is_valid_coupon(code):
        return False
    
    conn.execute(
        "UPDATE users SET coupon_code=?, is_unlimited=1, max_replies=999999 WHERE wa_id=?;",
        (code.strip().lower(), wa_id),
    )
    conn.commit()
    return True
