from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os


def _truthy(v: str | None) -> bool:
    if v is None:
        return False
    return v.strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass(frozen=True)
class Settings:
    repo_root: Path
    frontend_dist: Path

    db_path: Path

    gateway_base_url: str
    gateway_token: str
    backend_api_token: str

    groq_api_key: str | None
    groq_model: str

    memory_limit: int
    pending_ttl_seconds: int

    quiet_hours_start: int
    quiet_hours_end: int
    default_timezone: str

    reply_only_mode: bool
    max_outgoing_per_hour_total: int
    max_outgoing_per_hour_per_recipient: int

    away_message_template: str


def load_settings() -> Settings:
    repo_root = Path(__file__).resolve().parent.parent
    frontend_dist = repo_root / "frontend" / "dist"

    # Robust manual dotenv loading to support direct execution of app.py
    for env_path in [repo_root / ".env", Path(__file__).resolve().parent / ".env"]:
        if env_path.exists():
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip()
                            if v.startswith('"') and v.endswith('"'):
                                v = v[1:-1]
                            elif v.startswith("'") and v.endswith("'"):
                                v = v[1:-1]
                            os.environ.setdefault(k, v)
                            if k.upper() == "GROQ_API_KEY" or k.lower() == "groq_api":
                                os.environ.setdefault("GROQ_API_KEY", v)
            except Exception:
                pass

    db_path = Path(os.getenv("DB_PATH", str(Path(__file__).resolve().parent / "data" / "agent.db")))

    gateway_base_url = (os.getenv("GATEWAY_BASE_URL") or "http://127.0.0.1:3001").rstrip("/")
    gateway_token = os.getenv("GATEWAY_TOKEN", "")
    backend_api_token = os.getenv("BACKEND_API_TOKEN", "")

    groq_api_key = os.getenv("GROQ_API_KEY")
    groq_model = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")

    memory_limit = int(os.getenv("MEMORY_LIMIT", "5"))
    pending_ttl_seconds = int(os.getenv("PENDING_TTL_SECONDS", "600"))

    quiet_hours_start = int(os.getenv("QUIET_HOURS_START", "2"))
    quiet_hours_end = int(os.getenv("QUIET_HOURS_END", "6"))
    default_timezone = os.getenv("DEFAULT_TIMEZONE", "Asia/Calcutta")

    reply_only_mode = _truthy(os.getenv("REPLY_ONLY_MODE", "true"))
    max_outgoing_per_hour_total = int(os.getenv("MAX_OUTGOING_PER_HOUR_TOTAL", "50"))
    max_outgoing_per_hour_per_recipient = int(os.getenv("MAX_OUTGOING_PER_HOUR_PER_RECIPIENT", "30"))

    away_message_template = os.getenv(
        "AWAY_MESSAGE_TEMPLATE",
        "I'm currently unavailable. I will inform {owner_name} about this.",
    )

    return Settings(
        repo_root=repo_root,
        frontend_dist=frontend_dist,
        db_path=db_path,
        gateway_base_url=gateway_base_url,
        gateway_token=gateway_token,
        backend_api_token=backend_api_token,
        groq_api_key=groq_api_key,
        groq_model=groq_model,
        memory_limit=memory_limit,
        pending_ttl_seconds=pending_ttl_seconds,
        quiet_hours_start=quiet_hours_start,
        quiet_hours_end=quiet_hours_end,
        default_timezone=default_timezone,
        reply_only_mode=reply_only_mode,
        max_outgoing_per_hour_total=max_outgoing_per_hour_total,
        max_outgoing_per_hour_per_recipient=max_outgoing_per_hour_per_recipient,
        away_message_template=away_message_template,
    )
