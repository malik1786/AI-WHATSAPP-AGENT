import React from "react";
import type { Message } from "../api/types";
import { cx } from "../lib/cls";
import { Check, CheckCheck, Clock, AlertTriangle, Bot } from "lucide-react";
import { formatTime } from "../lib/time";

function StatusIcon({ status }: { status?: Message["status"] }) {
  switch (status) {
    case "queued": return <Clock size={12} className="text-wa-subtext/40" />;
    case "sent": return <Check size={12} className="text-wa-subtext/40" />;
    case "delivered": return <CheckCheck size={12} className="text-wa-subtext/40" />;
    case "read": return <CheckCheck size={12} className="text-wa-green" />;
    case "error": return <AlertTriangle size={12} className="text-wa-danger" />;
    default: return null;
  }
}

export default function MessageBubble({ m }: { m: Message }) {
  const isOut = m.direction === "out";
  return (
    <div className={cx("flex gap-2.5 animate-fade-in", isOut ? "justify-end" : "justify-start")}>
      {!isOut && (
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 text-white shrink-0 mt-1">
          <Bot size={14} />
        </div>
      )}
      <div
        className={cx(
          "max-w-[min(600px,80%)] px-4 py-2.5 text-[13px] leading-relaxed",
          isOut ? "msg-user" : "msg-ai",
        )}
      >
        <div className="whitespace-pre-wrap break-words">{m.text}</div>
        <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[10px] text-wa-subtext/40">
          <span>{formatTime(m.createdAt)}</span>
          {isOut && <StatusIcon status={m.status} />}
        </div>
      </div>
    </div>
  );
}
