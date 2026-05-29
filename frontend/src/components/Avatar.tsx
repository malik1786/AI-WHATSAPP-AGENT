import React from "react";

type Props = { name: string; url?: string | null; size?: number };

const gradients = [
  "from-emerald-500 to-teal-600",
  "from-violet-500 to-purple-600",
  "from-blue-500 to-indigo-600",
  "from-rose-500 to-pink-600",
  "from-amber-500 to-orange-600",
  "from-cyan-500 to-sky-600",
];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + second).toUpperCase();
}

export default function Avatar({ name, url, size = 40 }: Props) {
  if (url) {
    return <img src={url} alt={name} width={size} height={size} className="rounded-xl object-cover ring-1 ring-white/5" />;
  }
  const grad = gradients[hashName(name) % gradients.length];
  return (
    <div
      className={`grid place-items-center rounded-xl bg-gradient-to-br ${grad} text-white text-[11px] font-bold ring-1 ring-white/5`}
      style={{ width: size, height: size }}
      title={name}
    >
      {initials(name)}
    </div>
  );
}
