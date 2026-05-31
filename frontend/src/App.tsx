import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Loader2,
  MessageCircle,
  PanelLeft,
  RefreshCw,
  Search,
  Send,
  Smartphone,
  WifiOff,
  X,
  Sparkles,
  ArrowUp,
  Settings2,
  LayoutTemplate,
  ChevronDown,
  Wand2,
  User,
  Zap,
} from "lucide-react";
import { ApiError, api } from "./api/client";
import type { ChatSummary, Message } from "./api/types";
import ChatListItem from "./components/ChatListItem";
import MessageBubble from "./components/MessageBubble";
import EmptyState from "./components/EmptyState";
import Toast, { type ToastState } from "./components/Toast";
import QrModal from "./components/QrModal";
import QrCard from "./components/QrCard";
import ChatTemplates from "./components/ChatTemplates";
import PersonalizationPanel from "./components/PersonalizationPanel";
import { cx } from "./lib/cls";

type Health = { ok: true; time: string };

type Panel = "chats" | "templates" | "settings";

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [gatewayReady, setGatewayReady] = useState(false);
  const [gatewayStatusText, setGatewayStatusText] = useState("Checking gateway...");
  const [qrText, setQrText] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<Panel>("chats");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [search, setSearch] = useState("");
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);

  const [agentDraft, setAgentDraft] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentPending, setAgentPending] = useState<{ pendingId: number; to: string; message: string } | null>(null);

  // Personalization
  const [personaName, setPersonaName] = useState("Assistant");
  const [personaStyle, setPersonaStyle] = useState("professional");
  const [customInstructions, setCustomInstructions] = useState("");
  const [personaTags, setPersonaTags] = useState<string[]>(["friendly", "concise"]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const syncedChatsRef = useRef(false);
  const lastQrRef = useRef<string | null>(null);
  const staleQrCountRef = useRef(0);

  const filteredChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => c.name.toLowerCase().includes(q) || (c.lastMessage ?? "").toLowerCase().includes(q));
  }, [chats, search]);

  const selectedChat = useMemo(
    () => (selectedChatId ? chats.find((c) => c.id === selectedChatId) ?? null : null),
    [chats, selectedChatId],
  );

  async function refreshHealth() { try { setHealth(await api.health()); } catch { setHealth(null); } }
  async function syncGatewayChats() { try { await api.gatewaySyncChats(); await loadChats({ quiet: true }); } catch {} }

  async function refreshGateway() {
    try {
      const status = await api.gatewayStatus();
      console.log("[GW STATUS]", JSON.stringify(status));
      const ready = !!status.ready;
      setGatewayReady(ready);
      if (ready) {
        setQrText(null);
        setGatewayStatusText("Connected");
        lastQrRef.current = null;
        staleQrCountRef.current = 0;
        if (!syncedChatsRef.current) { syncedChatsRef.current = true; await syncGatewayChats(); }
        return;
      }
      syncedChatsRef.current = false;
      if (status.hasQr) {
        try {
          const qr = await api.gatewayQr();
          const qrVal = qr.qr;
          console.log("[GW QR] received, length:", qrVal?.length);

          if (qrVal && qrVal === lastQrRef.current) {
            staleQrCountRef.current++;
          } else {
            staleQrCountRef.current = 0;
          }
          lastQrRef.current = qrVal;

          if (staleQrCountRef.current >= 15) {
            console.log("[GW QR] stale QR detected, auto-resetting");
            setGatewayStatusText("QR expired — resetting...");
            setQrText(null);
            staleQrCountRef.current = 0;
            lastQrRef.current = null;
            try { await api.gatewayReset(); } catch {}
            return;
          }

          if (staleQrCountRef.current >= 8) {
            setGatewayStatusText("QR may be stale — resetting...");
          } else {
            setGatewayStatusText("Scan QR to connect");
          }
          setQrText(qrVal);
        } catch (e: any) {
          console.error("[GW QR] error:", e?.status, e?.message, e?.payload);
          if (e instanceof ApiError && e.status === 404) { setQrText(null); setGatewayStatusText("Waiting... (QR not ready yet)"); }
          else setGatewayStatusText(`QR error: ${e?.message ?? "unknown"}`);
        }
      } else {
        const parts = ["Waiting for QR..."];
        if (status.lastDisconnect) parts.push(`last: ${status.lastDisconnect.reason}`);
        if (status.connecting) parts.push("(connecting)");
        if (status.userInfo) parts.push(`user: ${status.userInfo.pushname}`);
        setQrText(null);
        lastQrRef.current = null;
        staleQrCountRef.current = 0;
        setGatewayStatusText(parts.join(" "));
      }
    } catch (e: any) {
      console.error("[GW STATUS] error:", e?.status, e?.message, e?.payload);
      setGatewayReady(false); setQrText(null);
      setGatewayStatusText(`Error: ${e?.message ?? "Gateway offline."}`);
    }
  }

  async function loadChats(opts?: { quiet?: boolean }) {
    const quiet = opts?.quiet ?? false;
    if (!quiet) setLoadingChats(true);
    try {
      const res = await api.listChats();
      setChats(res.chats);
      if (!selectedChatId && res.chats[0]) setSelectedChatId(res.chats[0].id);
    } catch (e: any) {
      setToast({ id: crypto.randomUUID(), kind: "error", title: "Failed to load chats", description: e?.message ?? "" });
    } finally { if (!quiet) setLoadingChats(false); }
  }

  async function loadMessages(chatId: string, { quiet, scroll }: { quiet?: boolean; scroll?: "always" | "if-near-bottom" | "never" } = {}) {
    if (!quiet) setLoadingMessages(true);
    const el = listRef.current;
    const wasNearBottom = !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    try {
      const res = await api.listMessages(chatId);
      if (res.messages.length > 0) {
        setMessages(res.messages);
      } else if (quiet) {
        // Don't clear messages on quiet poll if server returns empty (ephemeral DB issue)
      } else {
        setMessages(res.messages);
      }
      const behavior = scroll ?? (quiet ? "if-near-bottom" : "always");
      queueMicrotask(() => {
        const l = listRef.current;
        if (!l || behavior === "never") return;
        if (behavior === "if-near-bottom" && !wasNearBottom) return;
        l.scrollTop = l.scrollHeight;
      });
    } catch (e: any) {
      if (!quiet) setToast({ id: crypto.randomUUID(), kind: "error", title: "Failed to load messages", description: e?.message ?? "" });
    } finally { if (!quiet) setLoadingMessages(false); }
  }

  useEffect(() => {
    refreshHealth(); refreshGateway(); loadChats();
    const h = window.setInterval(refreshHealth, 4000);
    const g = window.setInterval(refreshGateway, 2000);
    const c = window.setInterval(() => loadChats({ quiet: true }), 6000);
    return () => { window.clearInterval(h); window.clearInterval(g); window.clearInterval(c); };
  }, []);

  useEffect(() => {
    if (!selectedChatId) { setMessages([]); return; }
    loadMessages(selectedChatId, { scroll: "always" });
    const p = window.setInterval(() => loadMessages(selectedChatId, { quiet: true, scroll: "if-near-bottom" }), 2500);
    return () => window.clearInterval(p);
  }, [selectedChatId]);

  const onSend = useCallback(async () => {
    const chatId = selectedChatId;
    const text = draft.trim();
    if (!chatId || !text) return;
    setSending(true); setDraft("");
    const optimistic: Message = { id: crypto.randomUUID(), chatId, direction: "out", text, createdAt: new Date().toISOString(), status: "queued" };
    setMessages((prev) => [...prev, optimistic]);
    queueMicrotask(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; });
    try {
      const res = await api.sendMessage(chatId, { text });
      setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? res.message : m)));
      loadChats({ quiet: true });
    } catch (e: any) {
      setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? { ...m, status: "error" } : m)));
      setToast({ id: crypto.randomUUID(), kind: "error", title: "Send failed", description: e?.message ?? "" });
    } finally { setSending(false); }
  }, [selectedChatId, draft]);

  const onRunAgent = useCallback(async () => {
    const text = agentDraft.trim();
    if (!text) return;
    setAgentBusy(true); setAgentPending(null);
    try {
      const systemPrompt = personaName && customInstructions ? `[You are ${personaName}. ${customInstructions}]` : undefined;
      const res = await api.agentInstruction({ text, defaultRecipient: selectedChatId ?? undefined, customBehavior: systemPrompt });
      if (res.mode === "need_confirm") setAgentPending({ pendingId: res.pendingId, to: res.to, message: res.message });
      else if (res.mode === "need_recipient") { setToast({ id: crypto.randomUUID(), kind: "info", title: "Select a chat", description: res.message }); setSidebarOpen(true); setActivePanel("chats"); }
      else if (res.mode === "sent") { setToast({ id: crypto.randomUUID(), kind: "info", title: "Sent", description: `Sent to ${res.to}` }); setAgentDraft(""); loadChats({ quiet: true }); }
      else if (res.mode === "error") setToast({ id: crypto.randomUUID(), kind: "error", title: "Agent error", description: res.error });
    } catch (e: any) {
      setToast({ id: crypto.randomUUID(), kind: "error", title: "Agent failed", description: e?.message ?? "" });
    } finally { setAgentBusy(false); }
  }, [agentDraft, selectedChatId, personaName, customInstructions]);

  const onConfirmAgent = useCallback(async (answer: "yes" | "no") => {
    setAgentBusy(true);
    try {
      const res = await api.agentConfirm({ answer });
      if (res.mode === "sent") { setToast({ id: crypto.randomUUID(), kind: "info", title: "Sent", description: `Sent to ${res.to}` }); setAgentPending(null); setAgentDraft(""); loadChats({ quiet: true }); }
      else if (res.mode === "canceled") { setToast({ id: crypto.randomUUID(), kind: "info", title: "Canceled" }); setAgentPending(null); }
      else if (res.mode === "error") setToast({ id: crypto.randomUUID(), kind: "error", title: "Blocked", description: res.error });
    } catch (e: any) { setToast({ id: crypto.randomUUID(), kind: "error", title: "Failed", description: e?.message ?? "" }); }
    finally { setAgentBusy(false); }
  }, []);

  function selectChat(chatId: string) { setSelectedChatId(chatId); setSidebarOpen(false); }
  function onTemplateSelect(template: string) { setAgentDraft(template); setSidebarOpen(false); }

  /* ─── SIDEBAR ─── */
  const sidebarContent = (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className="px-5 pt-5 pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-green-500 to-emerald-600">
              <Bot size={18} className="text-white" />
            </div>
            <div>
              <div className="text-sm font-bold tracking-tight">WA Agent</div>
              <div className="text-[10px] text-wa-subtext">AI Assistant</div>
            </div>
          </div>
          <div className="flex gap-1">
            <button
              className={cx("grid h-8 w-8 place-items-center rounded-lg transition-all", activePanel === "templates" ? "bg-wa-accent3 text-wa-accent2" : "text-wa-subtext hover:text-wa-text hover:bg-wa-hover")}
              onClick={() => setActivePanel(activePanel === "templates" ? "chats" : "templates")}
              title="Templates"
            >
              <LayoutTemplate size={15} />
            </button>
            <button
              className={cx("grid h-8 w-8 place-items-center rounded-lg transition-all", activePanel === "settings" ? "bg-wa-accent3 text-wa-accent2" : "text-wa-subtext hover:text-wa-text hover:bg-wa-hover")}
              onClick={() => setActivePanel(activePanel === "settings" ? "chats" : "settings")}
              title="Persona"
            >
              <Settings2 size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* Templates panel (overlay) */}
      {activePanel === "templates" && (
        <div className="border-b border-wa-border px-4 pb-3 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-wa-text">Templates</span>
            <button className="text-[10px] text-wa-subtext hover:text-wa-text" onClick={() => setActivePanel("chats")}>Close</button>
          </div>
          <div className="max-h-[300px] overflow-auto -mx-1 px-1">
            <ChatTemplates onSelect={(t) => { setAgentDraft(t); setActivePanel("chats"); setPanelOpen(false); }} />
          </div>
        </div>
      )}

      {/* Persona panel (overlay) */}
      {activePanel === "settings" && (
        <div className="border-b border-wa-border px-4 pb-3 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-wa-text">Persona</span>
            <button className="text-[10px] text-wa-subtext hover:text-wa-text" onClick={() => setActivePanel("chats")}>Close</button>
          </div>
          <div className="max-h-[300px] overflow-auto -mx-1 px-1">
            <PersonalizationPanel
              personaName={personaName} setPersonaName={setPersonaName}
              personaStyle={personaStyle} setPersonaStyle={setPersonaStyle}
              customInstructions={customInstructions} setCustomInstructions={setCustomInstructions}
              personaTags={personaTags} setPersonaTags={setPersonaTags}
            />
          </div>
        </div>
      )}

      {/* Chats - ALWAYS visible */}
      <div className="px-4 pb-2 pt-1">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold text-wa-subtext uppercase tracking-wider">Chats</span>
          <button
            className="text-[10px] text-wa-green hover:text-wa-green2 font-medium flex items-center gap-1"
            onClick={() => { syncGatewayChats(); }}
          >
            <RefreshCw size={10} /> Sync
          </button>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-wa-subtext/50" />
          <input className="wa-input !py-2 pl-8 text-xs" placeholder="Search chats..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {loadingChats && chats.length === 0 ? (
          <div className="grid place-items-center p-8"><Loader2 className="animate-spin text-wa-subtext" size={20} /></div>
        ) : filteredChats.length ? (
          filteredChats.map((chat) => (
            <ChatListItem key={chat.id} chat={chat} selected={chat.id === selectedChatId} onSelect={() => selectChat(chat.id)} />
          ))
        ) : (
          <div className="px-5 py-8 text-center">
            <div className="text-xs text-wa-subtext mb-2">No chats synced yet</div>
            <button className="wa-btn-ghost !py-1.5 !px-3 text-[11px]" onClick={() => syncGatewayChats()}>
              <RefreshCw size={12} /> Sync now
            </button>
          </div>
        )}
      </div>

      {/* Templates - always visible */}
      <div className="border-t border-wa-border px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold text-wa-subtext uppercase tracking-wider">Quick Templates</span>
        </div>
        <div className="max-h-[180px] overflow-auto -mx-1 px-1">
          <ChatTemplates onSelect={(t) => { setAgentDraft(t); setSidebarOpen(false); }} />
        </div>
      </div>

      {/* Connection status */}
      <div className="border-t border-wa-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {health ? <span className="status-dot" /> : <WifiOff size={12} className="text-wa-subtext" />}
            <span className="text-[11px] text-wa-subtext">{gatewayReady ? "Connected" : "Offline"}</span>
          </div>
          <button className="wa-btn-ghost !p-1.5" onClick={() => setQrOpen(true)} title="Connect">
            <Smartphone size={14} />
          </button>
        </div>
      </div>
    </div>
  );

  /* ─── LANDING ─── */
  if (!gatewayReady) {
    return (
      <div className="min-h-dvh">
        <Toast toast={toast} onClose={() => setToast(null)} />
        <div className="mx-auto grid min-h-dvh max-w-6xl place-items-center p-6">
          <div className="w-full animate-fade-in">
            <div className="mb-8 flex justify-center">
              <div className={cx(
                "inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium",
                health ? "bg-wa-green3 text-wa-green border border-green-500/20" : "bg-wa-panel border border-wa-border text-wa-subtext"
              )}>
                {health ? <span className="status-dot" /> : <WifiOff size={12} />}
                {health ? "Backend Online" : "Backend Offline"}
              </div>
            </div>

            <div className="grid gap-8 lg:grid-cols-[1fr_440px] lg:items-center">
              <div className="text-center lg:text-left">
                <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-wa-panel border border-wa-border px-3 py-1.5 text-[11px] text-wa-subtext">
                  <Sparkles size={12} className="text-wa-green" />
                  AI-Powered WhatsApp Agent
                </div>
                <h1 className="text-4xl font-bold tracking-tight md:text-6xl">
                  <span className="text-wa-text">Your AI</span>{" "}
                  <span className="gradient-text">Assistant</span>
                </h1>
                <p className="mt-4 max-w-lg text-sm leading-7 text-wa-subtext">
                  Connect WhatsApp, personalize your AI agent, and let it handle your messages intelligently.
                </p>
                <div className="mt-6 flex flex-wrap gap-3 justify-center lg:justify-start">
                  <button className="wa-btn-primary" onClick={refreshGateway}><RefreshCw size={15} /> Refresh</button>
                  <button className="wa-btn-ghost" onClick={() => setQrOpen(true)}><Smartphone size={15} /> Connect</button>
                </div>
              </div>

              <div className="wa-panel p-6 animate-slide-up">
                <div className="mb-5 flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-wa-green3 text-wa-green">
                    <Smartphone size={18} />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">Link Your Device</div>
                    <div className="text-[11px] text-wa-subtext">Scan QR or use pairing code</div>
                  </div>
                </div>
                <QrCard qr={qrText} statusText={gatewayStatusText} />
              </div>
            </div>
          </div>
        </div>
        <QrModal open={qrOpen} qr={qrText} statusText={gatewayStatusText} onClose={() => setQrOpen(false)} />
      </div>
    );
  }

  /* ─── MAIN APP ─── */
  return (
    <div className="h-dvh overflow-hidden">
      <Toast toast={toast} onClose={() => setToast(null)} />
      <QrModal open={qrOpen} qr={qrText} statusText={gatewayStatusText} onClose={() => setQrOpen(false)} />

      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden" onClick={() => setSidebarOpen(false)} />}

      <div className="mx-auto flex h-full max-w-[1400px] gap-0">
        {/* Sidebar */}
        <aside className={cx(
          "wa-panel fixed bottom-0 left-0 top-0 z-40 w-[min(340px,calc(100vw-0px))] overflow-hidden rounded-none border-l-0 border-t-0 border-b-0 transition-transform duration-300 md:static md:block md:w-[320px]",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}>
          {sidebarContent}
        </aside>

        {/* Main chat */}
        <main className="flex min-h-0 flex-1 flex-col">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-wa-border bg-wa-bg2/50 backdrop-blur-xl px-5 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <button className="wa-btn-ghost !p-2 md:hidden" onClick={() => setSidebarOpen(true)}>
                <PanelLeft size={18} />
              </button>
              <div className="relative">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 text-white">
                  <Bot size={17} />
                </div>
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-wa-bg2 bg-wa-green" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{selectedChat?.name ?? personaName}</div>
                <div className="flex items-center gap-1.5 text-[11px] text-wa-subtext">
                  <span className="status-dot !h-1 !w-1" />
                  {selectedChat ? "WhatsApp" : "AI Agent"}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button className="wa-btn-ghost !p-2" onClick={syncGatewayChats} title="Sync"><RefreshCw size={15} /></button>
              <button className="wa-btn-ghost !p-2" onClick={() => setActivePanel(activePanel === "settings" ? "chats" : "settings")} title="Persona"><Settings2 size={15} /></button>
            </div>
          </div>

          {/* Messages */}
          <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-5 py-6">
            {selectedChat ? (
              <div className="mx-auto max-w-3xl space-y-4">
                {messages.length > 0 ? (
                  messages.map((m) => <MessageBubble key={m.id} m={m} />)
                ) : (
                  <EmptyState />
                )}
              </div>
            ) : (
              <div className="grid h-full place-items-center">
                <div className="text-center animate-fade-in">
                  <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-green-500/10 to-purple-500/10 text-wa-green">
                    <Sparkles size={28} />
                  </div>
                  <div className="text-lg font-semibold">How can I help?</div>
                  <p className="mt-1.5 text-sm text-wa-subtext">Select a chat or use the agent to send a message</p>
                </div>
              </div>
            )}

            {/* Typing indicator */}
            {agentBusy && !agentPending && (
              <div className="mx-auto max-w-3xl mt-4">
                <div className="flex items-start gap-3">
                  <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 text-white shrink-0">
                    <Bot size={14} />
                  </div>
                  <div className="msg-ai px-4 py-3">
                    <div className="typing-indicator flex gap-1.5">
                      <span /><span /><span />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t border-wa-border bg-wa-bg2/30 backdrop-blur-xl px-5 py-4">
            <div className="mx-auto max-w-3xl space-y-3">
              {/* Agent preview */}
              {agentPending && (
                <div className="glass-card p-4 animate-scale-in">
                  <div className="mb-2 flex items-center gap-2">
                    <Sparkles size={13} className="text-wa-accent2" />
                    <span className="text-[11px] font-semibold text-wa-accent2 uppercase tracking-wider">Preview</span>
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">{agentPending.message}</div>
                  <div className="mt-3 flex gap-2">
                    <button className="wa-btn-primary !py-2 !px-4 text-xs" onClick={() => onConfirmAgent("yes")} disabled={agentBusy}>
                      {agentBusy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send
                    </button>
                    <button className="wa-btn-ghost !py-2 !px-4 text-xs" onClick={() => onConfirmAgent("no")} disabled={agentBusy}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Agent input */}
              <div className="glass-card">
                <div className="flex items-start gap-3 p-3">
                  <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 text-white shrink-0 mt-0.5">
                    <Wand2 size={14} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <textarea
                      className="w-full resize-none rounded-lg bg-transparent px-0 py-1.5 text-sm outline-none placeholder:text-wa-subtext/40"
                      placeholder={personaName ? `Tell ${personaName} to write a message...` : "Tell the agent to write a message..."}
                      value={agentDraft}
                      onChange={(e) => setAgentDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onRunAgent(); } }}
                      rows={2}
                    />
                  </div>
                  <button
                    className="grid h-8 w-8 place-items-center rounded-lg text-black shrink-0 mt-0.5 transition-all disabled:opacity-20"
                    style={{ background: "linear-gradient(135deg, #22c55e, #16a34a)" }}
                    onClick={onRunAgent}
                    disabled={!agentDraft.trim() || agentBusy}
                  >
                    {agentBusy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.5} />}
                  </button>
                </div>
                {personaName && (
                  <div className="flex items-center gap-2 border-t border-wa-border px-4 py-2">
                    <User size={11} className="text-wa-subtext/50" />
                    <span className="text-[10px] text-wa-subtext/40">Persona: {personaName}</span>
                    {customInstructions && (
                      <>
                        <span className="text-wa-subtext/20">|</span>
                        <Zap size={10} className="text-wa-accent2/50" />
                        <span className="text-[10px] text-wa-accent2/40">Custom instructions active</span>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Direct message */}
              {selectedChat && (
                <div className="flex items-end gap-2">
                  <textarea
                    className="wa-input min-h-[44px] flex-1 resize-none !rounded-2xl !py-3 !px-4 text-sm"
                    placeholder={`Message ${selectedChat.name} directly...`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
                    rows={1}
                  />
                  <button
                    className="grid h-[44px] w-[44px] place-items-center rounded-2xl text-black transition-all disabled:opacity-20"
                    style={{ background: "linear-gradient(135deg, #22c55e, #16a34a)", boxShadow: draft.trim() ? "0 2px 12px rgba(34, 197, 94, 0.25)" : "none" }}
                    onClick={onSend}
                    disabled={!draft.trim() || sending}
                  >
                    {sending ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={18} strokeWidth={2.5} />}
                  </button>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
