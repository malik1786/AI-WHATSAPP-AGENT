export type ChatSummary = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  unreadCount?: number;
};

export type Message = {
  id: string;
  chatId: string;
  direction: "in" | "out";
  text: string;
  createdAt: string;
  status?: "queued" | "sent" | "delivered" | "read" | "error";
};

export type SendMessageRequest = {
  text: string;
};

export type GatewayStatus = {
  ok: boolean;
  ready?: boolean;
  authenticated?: boolean;
  hasQr?: boolean;
  connecting?: boolean;
  lastDisconnect?: { at: string; reason: string } | null;
  userInfo?: { pushname?: string | null; phone?: string | null } | null;
  error?: string;
};

export type GatewayQr = { qr: string };
export type GatewayChats = {
  ok: true;
  chats: Array<{
    id: string;
    name: string;
    isGroup: boolean;
    lastMessage?: string | null;
    lastMessageAt?: string | null;
  }>;
};

export type AgentInstructionRequest = {
  text: string;
  defaultRecipient?: string;
  customBehavior?: string;
};

export type AgentInstructionResponse =
  | { mode: "need_recipient"; message: string }
  | { mode: "need_confirm"; pendingId: number; to: string; message: string; expiresInSeconds: number }
  | { mode: "sent"; to: string; conversationId?: number | null }
  | { mode: "canceled" }
  | { mode: "error"; error: string };

export type AgentConfirmRequest = {
  answer: "yes" | "no";
};

export type GatewayPairingCode = { ok: boolean; code?: string; error?: string };
