from __future__ import annotations

from typing import Any
import requests

META_API_VERSION = "v22.0"


class WhatsAppCloudClient:
    def __init__(
        self,
        access_token: str = "",
        phone_number_id: str = "",
        verify_token: str = "",
        app_secret: str = "",
    ):
        self.access_token = access_token
        self.phone_number_id = phone_number_id
        self.verify_token = verify_token
        self.app_secret = app_secret
        self._base_url = f"https://graph.facebook.com/{META_API_VERSION}"

    def is_configured(self) -> bool:
        return bool(self.access_token and self.phone_number_id)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json",
        }

    def status(self) -> dict:
        if not self.is_configured():
            return {
                "ok": False,
                "code": "CLOUD_API_NOT_CONFIGURED",
                "error": "WhatsApp Cloud API not configured. Set CLOUD_API_ACCESS_TOKEN and CLOUD_API_PHONE_NUMBER_ID.",
                "configured": False,
            }
        return {
            "ok": True,
            "configured": True,
            "message": "WhatsApp Cloud API is configured and ready.",
        }

    def qr(self) -> dict:
        return {
            "ok": False,
            "code": "QR_NOT_AVAILABLE",
            "error": "WhatsApp Cloud API does not use QR codes. Configure API credentials instead.",
            "configured": self.is_configured(),
        }

    def send(self, to: str, text: str, **kwargs) -> dict:
        if not self.is_configured():
            raise RuntimeError("WhatsApp Cloud API is not configured")
        url = f"{self._base_url}/{self.phone_number_id}/messages"
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "text",
            "text": {"preview_url": False, "body": text},
        }
        res = requests.post(url, json=payload, headers=self._headers(), timeout=30)
        res.raise_for_status()
        return res.json()

    def chats(self) -> dict:
        return {
            "chats": [],
            "message": "Cloud API does not sync chats. Conversations are tracked locally.",
        }

    def logout(self) -> dict:
        return {"ok": True, "message": "Cloud API sessions are managed by Meta."}

    def pairing_code(self, phone_number: str) -> dict:
        return {
            "ok": False,
            "code": "PAIRING_NOT_AVAILABLE",
            "error": "Cloud API does not use pairing codes.",
        }

    def cancel_pairing(self) -> dict:
        return {
            "ok": False,
            "code": "PAIRING_NOT_AVAILABLE",
            "error": "Cloud API does not use pairing.",
        }

    def verify_webhook(self, mode: str | None, verify_token: str | None, challenge: str | None) -> tuple[int, Any]:
        if mode == "subscribe" and verify_token and verify_token == self.verify_token:
            return (200, challenge)
        return (403, {"error": "Verification failed"})

    def parse_inbound(self, body: dict) -> list[dict]:
        messages = []
        entries = body.get("entry", [])
        for entry in entries:
            changes = entry.get("changes", [])
            for change in changes:
                value = change.get("value", {})
                msgs = value.get("messages", [])
                for msg in msgs:
                    from_number = msg.get("from", "")
                    msg_id = msg.get("id", "")
                    msg_type = msg.get("type", "")
                    text = ""
                    if msg_type == "text":
                        text = msg.get("text", {}).get("body", "")
                    elif msg_type == "interactive":
                        text = msg.get("interactive", {}).get("button_reply", {}).get("title", "")
                    messages.append({
                        "from": from_number,
                        "body": text,
                        "id": msg_id,
                        "type": msg_type,
                        "timestamp": msg.get("timestamp", ""),
                    })
        return messages
