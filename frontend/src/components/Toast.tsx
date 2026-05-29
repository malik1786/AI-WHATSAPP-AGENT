import React, { useEffect } from "react";
import { X, AlertCircle, Info } from "lucide-react";

export type ToastState = {
  id: string;
  kind: "error" | "info";
  title: string;
  description?: string;
};

type Props = { toast: ToastState | null; onClose: () => void };

export default function Toast({ toast, onClose }: Props) {
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => onClose(), 4000);
    return () => window.clearTimeout(t);
  }, [toast, onClose]);

  if (!toast) return null;

  return (
    <div className="fixed right-4 top-4 z-50 w-[min(380px,calc(100vw-2rem))] animate-slide-up">
      <div className="glass-card overflow-hidden">
        <div className="flex items-start gap-3 p-4">
          <div className={`mt-0.5 grid h-6 w-6 place-items-center rounded-lg ${
            toast.kind === "error" ? "bg-red-500/10 text-red-400" : "bg-wa-green3 text-wa-green"
          }`}>
            {toast.kind === "error" ? <AlertCircle size={13} /> : <Info size={13} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-wa-text">{toast.title}</div>
            {toast.description && <div className="mt-0.5 text-[11px] text-wa-subtext leading-relaxed">{toast.description}</div>}
          </div>
          <button className="wa-btn-ghost !p-1 -mr-1 -mt-1" onClick={onClose}><X size={14} /></button>
        </div>
      </div>
    </div>
  );
}
