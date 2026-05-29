import React from "react";
import {
  Mail,
  MessageSquare,
  Bell,
  Calendar,
  FileText,
  Heart,
  Briefcase,
  Megaphone,
} from "lucide-react";

type Template = {
  id: string;
  icon: React.ReactNode;
  title: string;
  prompt: string;
  color: string;
};

const templates: Template[] = [
  {
    id: "follow-up",
    icon: <Mail size={16} />,
    title: "Follow Up",
    prompt: "Write a polite follow-up message asking about the status of our last conversation",
    color: "from-blue-500/20 to-cyan-500/20",
  },
  {
    id: "thank-you",
    icon: <Heart size={16} />,
    title: "Thank You",
    prompt: "Write a warm thank you message for their help with the recent project",
    color: "from-pink-500/20 to-rose-500/20",
  },
  {
    id: "meeting",
    icon: <Calendar size={16} />,
    title: "Schedule Meeting",
    prompt: "Write a message proposing a meeting time tomorrow at 3 PM and asking if that works",
    color: "from-purple-500/20 to-violet-500/20",
  },
  {
    id: "reminder",
    icon: <Bell size={16} />,
    title: "Gentle Reminder",
    prompt: "Write a friendly reminder about the pending task without being pushy",
    color: "from-amber-500/20 to-orange-500/20",
  },
  {
    id: "proposal",
    icon: <Briefcase size={16} />,
    title: "Business Proposal",
    prompt: "Write a professional message introducing our services and proposing a collaboration call",
    color: "from-emerald-500/20 to-teal-500/20",
  },
  {
    id: "casual",
    icon: <MessageSquare size={16} />,
    title: "Casual Check-in",
    prompt: "Write a casual, friendly message checking in on how they're doing",
    color: "from-green-500/20 to-lime-500/20",
  },
  {
    id: "update",
    icon: <FileText size={16} />,
    title: "Project Update",
    prompt: "Write a message giving a brief update on the project progress and next steps",
    color: "from-indigo-500/20 to-blue-500/20",
  },
  {
    id: "announcement",
    icon: <Megaphone size={16} />,
    title: "Announcement",
    prompt: "Write a professional announcement message about an upcoming event or launch",
    color: "from-red-500/20 to-pink-500/20",
  },
];

type Props = {
  onSelect: (prompt: string) => void;
};

export default function ChatTemplates({ onSelect }: Props) {
  return (
    <div className="grid gap-1.5">
      <div className="px-1 pb-2">
        <h3 className="text-xs font-semibold text-wa-text">Quick Templates</h3>
        <p className="text-[10px] text-wa-subtext mt-0.5">Click to use as agent prompt</p>
      </div>
      {templates.map((t) => (
        <button
          key={t.id}
          className={`template-card flex items-start gap-3 bg-gradient-to-br ${t.color}`}
          onClick={() => onSelect(t.prompt)}
        >
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-white/5 text-wa-subtext shrink-0">
            {t.icon}
          </div>
          <div className="min-w-0 text-left">
            <div className="text-xs font-semibold text-wa-text">{t.title}</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-wa-subtext line-clamp-2">{t.prompt}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
