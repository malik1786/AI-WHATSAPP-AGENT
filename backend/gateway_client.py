from __future__ import annotations

from dataclasses import dataclass
import requests


@dataclass(frozen=True)
class GatewayClient:
    base_url: str
    token: str = ""

    def _headers(self) -> dict[str, str]:
        if not self.token:
            return {"Content-Type": "application/json"}
        return {"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"}

    def status(self, user_id: str = "default") -> dict:
        res = requests.get(f"{self.base_url}/status", params={"userId": user_id}, headers=self._headers(), timeout=10)
        res.raise_for_status()
        return res.json()

    def qr(self, user_id: str = "default") -> dict:
        res = requests.get(f"{self.base_url}/qr", params={"userId": user_id}, headers=self._headers(), timeout=10)
        res.raise_for_status()
        return res.json()

    def chats(self, user_id: str = "default") -> dict:
        res = requests.get(f"{self.base_url}/chats", params={"userId": user_id}, headers=self._headers(), timeout=30)
        res.raise_for_status()
        return res.json()

    def send(self, to: str, text: str, simulate_typing: bool = True, timeout_s: int = 90, user_id: str = "default") -> dict:
        res = requests.post(
            f"{self.base_url}/send",
            json={"to": to, "text": text, "simulateTyping": simulate_typing, "userId": user_id},
            headers=self._headers(),
            timeout=timeout_s,
        )
        res.raise_for_status()
        return res.json()

    def logout(self, user_id: str = "default") -> dict:
        res = requests.post(f"{self.base_url}/logout", json={"userId": user_id}, headers=self._headers(), timeout=20)
        res.raise_for_status()
        return res.json()

    def pairing_code(self, phone_number: str, user_id: str = "default") -> dict:
        res = requests.post(f"{self.base_url}/pairing-code", json={"phoneNumber": phone_number, "userId": user_id}, headers=self._headers(), timeout=30)
        res.raise_for_status()
        return res.json()

    def cancel_pairing(self, user_id: str = "default") -> dict:
        res = requests.post(f"{self.base_url}/cancel-pairing", json={"userId": user_id}, headers=self._headers(), timeout=10)
        res.raise_for_status()
        return res.json()

    def reset(self, user_id: str = "default") -> dict:
        res = requests.post(f"{self.base_url}/reset", json={"userId": user_id}, headers=self._headers(), timeout=30)
        res.raise_for_status()
        return res.json()
