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

    def status(self) -> dict:
        res = requests.get(f"{self.base_url}/status", headers=self._headers(), timeout=10)
        res.raise_for_status()
        return res.json()

    def qr(self) -> dict:
        res = requests.get(f"{self.base_url}/qr", headers=self._headers(), timeout=10)
        res.raise_for_status()
        return res.json()

    def chats(self) -> dict:
        res = requests.get(f"{self.base_url}/chats", headers=self._headers(), timeout=30)
        res.raise_for_status()
        return res.json()

    def send(self, to: str, text: str, simulate_typing: bool = True, timeout_s: int = 90) -> dict:
        res = requests.post(
            f"{self.base_url}/send",
            json={"to": to, "text": text, "simulateTyping": simulate_typing},
            headers=self._headers(),
            timeout=timeout_s,
        )
        res.raise_for_status()
        return res.json()

    def logout(self) -> dict:
        res = requests.post(f"{self.base_url}/logout", json={}, headers=self._headers(), timeout=20)
        res.raise_for_status()
        return res.json()

    def pairing_code(self, phone_number: str) -> dict:
        res = requests.post(f"{self.base_url}/pairing-code", json={"phoneNumber": phone_number}, headers=self._headers(), timeout=30)
        res.raise_for_status()
        return res.json()

    def cancel_pairing(self) -> dict:
        res = requests.post(f"{self.base_url}/cancel-pairing", json={}, headers=self._headers(), timeout=10)
        res.raise_for_status()
        return res.json()

    def reset(self) -> dict:
        res = requests.post(f"{self.base_url}/reset", json={}, headers=self._headers(), timeout=30)
        res.raise_for_status()
        return res.json()
