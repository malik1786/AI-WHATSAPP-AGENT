import React from "react";
import type { ChatSummary } from "../api/types";
import { cx } from "../lib/cls";
import Avatar from "./Avatar";

type Props = {
  chat: ChatSummary;
  selected: boolean;
  onSelect: () => void;
};

export default function ChatListItem({ chat, selected, onSelect }: Props) {
  return (
    <button
      className={cx("chat-item w-full text-left", selected && "active")}
      onClick={onSelect}
    >
      <Avatar name={chat.name} url={chat.avatarUrl ?? undefined} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-[13px] font-medium text-wa-text">{chat.name}</div>
          {chat.lastMessageAt && (
            <span className="shrink-0 text-[9px] text-wa-subtext/50">
              {new Date(chat.lastMessageAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <div className="truncate text-[11px] text-wa-subtext/60">
            {chat.lastMessage ?? "No messages"}
          </div>
          {chat.unreadCount ? (
            <span className="shrink-0 grid h-4 min-w-[16px] place-items-center rounded-full bg-wa-green px-1 text-[9px] font-bold text-black">
              {chat.unreadCount}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}
