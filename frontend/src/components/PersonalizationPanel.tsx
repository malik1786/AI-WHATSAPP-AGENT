import React, { useState } from "react";
import { User, Plus, X, Sparkles } from "lucide-react";

type Props = {
  personaName: string;
  setPersonaName: (v: string) => void;
  personaStyle: string;
  setPersonaStyle: (v: string) => void;
  customInstructions: string;
  setCustomInstructions: (v: string) => void;
  personaTags: string[];
  setPersonaTags: (v: string[]) => void;
};

const styles = [
  { id: "professional", label: "Professional", emoji: "💼" },
  { id: "friendly", label: "Friendly", emoji: "😊" },
  { id: "casual", label: "Casual", emoji: "✌️" },
  { id: "formal", label: "Formal", emoji: "🎩" },
  { id: "witty", label: "Witty", emoji: "😄" },
  { id: "empathetic", label: "Empathetic", emoji: "❤️" },
];

export default function PersonalizationPanel({
  personaName,
  setPersonaName,
  personaStyle,
  setPersonaStyle,
  customInstructions,
  setCustomInstructions,
  personaTags,
  setPersonaTags,
}: Props) {
  const [newTag, setNewTag] = useState("");

  function addTag() {
    const tag = newTag.trim().toLowerCase();
    if (tag && !personaTags.includes(tag)) {
      setPersonaTags([...personaTags, tag]);
    }
    setNewTag("");
  }

  function removeTag(tag: string) {
    setPersonaTags(personaTags.filter((t) => t !== tag));
  }

  return (
    <div className="grid gap-5">
      {/* Name */}
      <div>
        <label className="mb-2 flex items-center gap-2 text-xs font-semibold text-wa-text">
          <User size={13} className="text-wa-green" />
          Agent Name
        </label>
        <input
          className="wa-input text-xs"
          placeholder="e.g. Alex, Assistant..."
          value={personaName}
          onChange={(e) => setPersonaName(e.target.value)}
        />
      </div>

      {/* Style */}
      <div>
        <label className="mb-2 flex items-center gap-2 text-xs font-semibold text-wa-text">
          <Sparkles size={13} className="text-wa-accent2" />
          Communication Style
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          {styles.map((s) => (
            <button
              key={s.id}
              className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium transition-all ${
                personaStyle === s.id
                  ? "bg-wa-green3 text-wa-green border border-green-500/20"
                  : "bg-wa-panel2/30 text-wa-subtext border border-transparent hover:border-wa-border2"
              }`}
              onClick={() => setPersonaStyle(s.id)}
            >
              <span>{s.emoji}</span>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tags */}
      <div>
        <label className="mb-2 flex items-center gap-2 text-xs font-semibold text-wa-text">
          Personality Tags
        </label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {personaTags.map((tag) => (
            <span key={tag} className="persona-tag">
              {tag}
              <button onClick={() => removeTag(tag)} className="ml-0.5 hover:text-white transition-colors">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-1.5">
          <input
            className="wa-input !py-2 text-xs flex-1"
            placeholder="Add tag..."
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addTag(); }}
          />
          <button className="wa-btn-ghost !px-3 !py-2" onClick={addTag}>
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Custom instructions */}
      <div>
        <label className="mb-2 flex items-center gap-2 text-xs font-semibold text-wa-text">
          Custom Instructions
        </label>
        <textarea
          className="wa-input text-xs min-h-[100px] resize-none"
          placeholder={"e.g. Always be polite. Use emojis. Never mention competitors. Reply in Hindi when the other person writes in Hindi."}
          value={customInstructions}
          onChange={(e) => setCustomInstructions(e.target.value)}
          rows={5}
        />
        <p className="mt-1.5 text-[10px] text-wa-subtext/50">
          These instructions guide how your AI agent drafts and sends messages.
        </p>
      </div>

      {/* Preview */}
      <div className="rounded-xl bg-wa-panel2/20 p-3 border border-wa-border">
        <div className="text-[10px] font-semibold text-wa-subtext uppercase tracking-wider mb-2">Active Persona</div>
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 text-white text-xs font-bold">
            {personaName?.[0]?.toUpperCase() || "A"}
          </div>
          <div>
            <div className="text-xs font-semibold text-wa-text">{personaName || "Assistant"}</div>
            <div className="text-[10px] text-wa-subtext">{personaStyle} style</div>
          </div>
        </div>
        {personaTags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {personaTags.map((t) => (
              <span key={t} className="rounded-full bg-wa-accent3 px-2 py-0.5 text-[9px] text-wa-accent2">{t}</span>
            ))}
          </div>
        )}
        {customInstructions && (
          <div className="mt-2 text-[10px] text-wa-subtext line-clamp-2">{customInstructions}</div>
        )}
      </div>
    </div>
  );
}
