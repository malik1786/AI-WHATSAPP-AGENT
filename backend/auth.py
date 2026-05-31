from __future__ import annotations
import hashlib
import hmac
import os
import time
from functools import wraps

SECRET_KEY = os.getenv("JWT_SECRET", "wa-agent-secret-key-change-in-production")

def hash_password(password: str) -> str:
    salt = os.urandom(16).hex()
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return f"{salt}:{h.hex()}"

def verify_password(password: str, stored: str) -> bool:
    try:
        salt, h = stored.split(":", 1)
        check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
        return hmac.compare_digest(check.hex(), h)
    except Exception:
        return False

def create_token(user_id: int, email: str) -> str:
    import json, base64
    payload = {"uid": user_id, "email": email, "exp": int(time.time()) + 86400 * 30}
    data = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    sig = hmac.new(SECRET_KEY.encode(), data.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{data}.{sig}"

def decode_token(token: str) -> dict | None:
    try:
        import json, base64
        data, sig = token.split(".", 1)
        check = hmac.new(SECRET_KEY.encode(), data.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, check):
            return None
        payload = json.loads(base64.urlsafe_b64decode(data))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None

def require_auth(f):
    from flask import request, jsonify
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        token = auth.replace("Bearer ", "").strip()
        if not token:
            return jsonify({"error": "unauthorized"}), 401
        user = decode_token(token)
        if not user:
            return jsonify({"error": "invalid token"}), 401
        request.user_id = user["uid"]
        request.user_email = user["email"]
        return f(*args, **kwargs)
    return decorated
