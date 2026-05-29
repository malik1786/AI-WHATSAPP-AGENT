from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True)
class QuietHours:
    start_hour: int
    end_hour: int
    timezone_name: str

    def is_quiet_now(self) -> bool:
        try:
            tz = ZoneInfo(self.timezone_name)
            local = datetime.now(tz=tz)
        except Exception:
            # On some Windows installs, IANA tzdata may be missing unless the
            # `tzdata` PyPI package is installed. Fall back to UTC. Also handles
            # empty/invalid timezone values gracefully.
            local = datetime.now(tz=timezone.utc)
        h = local.hour
        if self.start_hour == self.end_hour:
            return False
        if self.start_hour < self.end_hour:
            return self.start_hour <= h < self.end_hour
        # Wrap-around (e.g., 22 -> 6)
        return h >= self.start_hour or h < self.end_hour


def normalize_yes_no(text: str) -> str | None:
    t = (text or "").strip().lower()
    if t in {"yes", "y", "yeah", "yep", "confirm", "send", "ok", "okay"}:
        return "yes"
    if t in {"no", "n", "cancel", "stop"}:
        return "no"
    return None


def extract_phone_like(text: str) -> str | None:
    # Very small heuristic: looks for a +countrycode... sequence or long digit run.
    import re

    candidates = re.findall(r"(?:\+\d[\d\s\-()]{7,}\d)|(?:\b\d[\d\s\-()]{9,}\d\b)", text or "")
    if not candidates:
        return None
    raw = candidates[0]
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 10:
        return None
    return digits


def to_wa_id_from_digits(digits: str) -> str:
    return f"{digits}@c.us"


@dataclass(frozen=True)
class AwayMode:
    enabled: bool
    owner_name: str
    template: str

    def is_active(self) -> bool:
        return self.enabled

    def render_reply(self) -> str:
        return self.template.format(owner_name=self.owner_name)


def parse_away_command(text: str) -> str | None:
    """Return 'on', 'off', or None if not an away command."""
    t = (text or "").strip().lower()
    if t in {"away on", "awaymode on", "away-mode on", "set away", "away on"}:
        return "on"
    if t in {"away off", "awaymode off", "away-mode off", "unset away", "away off"}:
        return "off"
    return None


# ============================================
# Message Classification
# ============================================

# Time/Date patterns
DATE_PATTERNS = [
    r"what time",
    r"what('s| is) the (time|date)",
    r"(current|now|today)'?s? (time|date|day|month|year)",
    r"what day",
    r"what('s| is) today",
    r"tell me the (time|date)",
    r"time please",
    r"date please",
    r"time it is",
    r"what('s| is) the current",
]

# Casual keywords
CASUAL_KEYWORDS = {
    # English
    "hi", "hello", "hey", "how are you", "whats up", "what's up",
    "thanks", "thank you", "bye", "good morning", "good night",
    "good evening", "howdy", "sup", "yo", "hola", "salam",
    "jazakallah", "shukriya", "alhamdulillah", "ok", "okay",
    "nice", "great", "awesome", "cool", "wow", "haha", "lol",
    "yes", "no", "yeah", "nope", "sure", "fine", "good", "bad",
    "hmm", "huh", "oh", "wow", "oops", "sorry", "np", "nvm",
    "bye", "see you", "tc", "take care", "miss you", "love you",
    # Hindi/Urdu casual
    "acha", "achha", "accha", "theek hai", "ok hai", "thik hai",
    "arre", "are", "oye", "yaar", "bhai", "dost",
    "kya", "kaise", "kaisa", "kaisi", "kahan", "kab",
    "nahi", "haan", "ji", "haan ji", "nahi ji",
    "chal", "chalo", "aaja", "aao", "ruk", "ruko",
    "bas", "bus", "ab", "abhi", "phir", "fir",
    "sahi", "galat", "theek", "bura", "achha",
    "wah", "wah wah", "kya baat", "mast", "badhiya",
    "samajh", "pata", "malum", "maloom",
    "bhej", "bhejo", "bheja", "bhejiye",
    "bol", "bolo", "bola", "boliye",
    "sun", "suno", "suna", "sunaiye",
    "dekh", "dekho", "dekha", "dekhiye",
}

# Factual question patterns
FACTUAL_PATTERNS = [
    r"who (is|are|was|were)",
    r"what (is|are|was|were|do|does|did)",
    r"when (is|are|was|were|do|does|did)",
    r"where (is|are|was|were)",
    r"why (is|are|was|were|do|does|did)",
    r"how (do|does|did|is|are|was|were)",
    r"define",
    r"explain",
    r"tell me about",
]

# Decision keywords (send messages to others)
DECISION_KEYWORDS = {"tell", "send", "message", "inform", "forward", "say to", "reply to"}


def get_current_time(timezone_name: str = "Asia/Calcutta") -> dict:
    """Get current date and time info."""
    try:
        tz = ZoneInfo(timezone_name)
    except Exception:
        tz = timezone.utc

    now = datetime.now(tz=tz)
    return {
        "time": now.strftime("%I:%M %p"),
        "date": now.strftime("%d %B %Y"),
        "day": now.strftime("%A"),
        "month": now.strftime("%B"),
        "year": str(now.year),
        "timezone": timezone_name,
        "timestamp": now.isoformat(),
    }


def answer_time_question(question: str, timezone_name: str = "Asia/Calcutta") -> str:
    """Answer time/date questions directly from system clock."""
    info = get_current_time(timezone_name)
    q = question.strip().lower()

    if "time" in q:
        return f"It's {info['time']} ({info['timezone']})."
    if "date" in q or "today" in q:
        return f"Today is {info['day']}, {info['date']}."
    if "day" in q:
        return f"It's {info['day']}."
    if "month" in q:
        return f"The current month is {info['month']}."
    if "year" in q:
        return f"The current year is {info['year']}."

    return f"It's {info['time']}, {info['day']}, {info['date']}."


def classify_message(text: str, is_group: bool) -> str:
    """
    Classify message as:
    - 'time' → time/date questions
    - 'casual' → small talk, greetings
    - 'factual' → simple questions (who, what, etc.)
    - 'decision' → requests to send messages, instructions
    - 'coupon' → coupon code entry
    """
    if is_group:
        return "decision"

    t = text.strip().lower()
    words = t.split()

    # Check coupon code first
    if t.startswith("coupon "):
        return "coupon"

    # Check time/date questions first
    for pattern in DATE_PATTERNS:
        if re.search(pattern, t):
            return "time"

    # Check exact match or startswith for casual
    if t in CASUAL_KEYWORDS or any(t.startswith(k) for k in CASUAL_KEYWORDS):
        return "casual"

    # Short messages (1-3 words) without decision keywords = casual
    if len(words) <= 3 and not any(kw in t for kw in DECISION_KEYWORDS):
        return "casual"

    # Check factual
    for pattern in FACTUAL_PATTERNS:
        if re.search(pattern, t):
            return "factual"

    # Check decision
    if any(kw in t for kw in DECISION_KEYWORDS):
        return "decision"

    return "decision"


# ============================================
# Coupon Code System
# ============================================

VALID_COUPON_CODE = "malik ka dost"
DEFAULT_MAX_REPLIES = 15


def parse_coupon_code(text: str) -> str | None:
    """Extract coupon code from message. Returns code or None."""
    t = text.strip().lower()
    if t.startswith("coupon "):
        code = t[7:].strip()
        return code if code else None
    return None


def is_valid_coupon(code: str) -> bool:
    """Check if coupon code is valid."""
    return code.strip().lower() == VALID_COUPON_CODE
