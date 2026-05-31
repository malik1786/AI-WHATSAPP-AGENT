import type {
  AgentConfirmRequest,
  AgentInstructionRequest,
  AgentInstructionResponse,
  ChatSummary,
  GatewayPairingCode,
  GatewayQr,
  GatewayStatus,
  GatewayChats,
  Message,
  SendMessageRequest,
} from "./types";

type ApiErrorPayload = { error?: string; message?: string };

export class ApiError extends Error {
  status: number;
  payload?: unknown;
  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

function getToken(): string | null {
  return localStorage.getItem("wa_token");
}

export function setToken(token: string) {
  localStorage.setItem("wa_token", token);
}

export function clearToken() {
  localStorage.removeItem("wa_token");
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const token = getToken();
  console.log(`[API] ${init?.method ?? "GET"} ${url}`);
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const payload = (await safeJson(res)) as ApiErrorPayload | string | undefined;
    const msg =
      typeof payload === "string"
        ? payload
        : payload?.error || payload?.message || `Request failed (${res.status})`;
    console.error(`[API] ${res.status} ${url}`, payload);
    throw new ApiError(msg, res.status, payload);
  }

  const data = (await safeJson(res)) as T;
  console.log(`[API] ${res.status} ${url}`, data);
  return data;
}

export const api = {
  health: () => request<{ ok: true; time: string }>("/api/health"),
  gatewayStatus: () => request<GatewayStatus>("/api/gateway/status"),
  gatewayQr: () => request<GatewayQr>("/api/gateway/qr"),
  gatewaySyncChats: () =>
    request<{ ok: true; synced: number }>("/api/gateway/sync-chats", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  listChats: () => request<{ chats: ChatSummary[] }>("/api/chats"),
  listMessages: (chatId: string) =>
    request<{ messages: Message[] }>(`/api/chats/${encodeURIComponent(chatId)}/messages`),
  sendMessage: (chatId: string, body: SendMessageRequest) =>
    request<{ message: Message }>(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  agentInstruction: (body: AgentInstructionRequest) =>
    request<AgentInstructionResponse>("/api/agent/instruction", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  agentConfirm: (body: AgentConfirmRequest) =>
    request<AgentInstructionResponse>("/api/agent/confirm", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  gatewayPairingCode: (phoneNumber: string) =>
    request<GatewayPairingCode>("/api/gateway/pairing-code", {
      method: "POST",
      body: JSON.stringify({ phoneNumber }),
    }),
  gatewayCancelPairing: () =>
    request<{ ok: boolean }>("/api/gateway/cancel-pairing", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  gatewayReset: () =>
    request<{ ok: boolean; message: string }>("/api/gateway/reset", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  authSignup: (email: string, password: string) =>
    request<{ token: string; email: string; id: number }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  authLogin: (email: string, password: string) =>
    request<{ token: string; email: string; id: number }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  authMe: () => request<{ id: number; email: string }>("/api/auth/me"),
};
