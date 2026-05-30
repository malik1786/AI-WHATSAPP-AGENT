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
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const payload = (await safeJson(res)) as ApiErrorPayload | string | undefined;
    const msg =
      typeof payload === "string"
        ? payload
        : payload?.error || payload?.message || `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, payload);
  }

  return (await safeJson(res)) as T;
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
};
