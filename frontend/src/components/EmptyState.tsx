import React from "react";
import { Sparkles } from "lucide-react";

export default function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center py-20">
      <div className="text-center animate-fade-in">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-green-500/10 to-purple-500/10 text-wa-green">
          <Sparkles size={24} />
        </div>
        <div className="text-base font-semibold text-wa-text">No messages yet</div>
        <p className="mt-1.5 text-xs text-wa-subtext max-w-xs">Send a message or use the AI agent to start a conversation</p>
      </div>
    </div>
  );
}
