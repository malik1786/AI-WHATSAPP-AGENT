import React from "react";
import { X } from "lucide-react";
import QrCard from "./QrCard";

type Props = {
  open: boolean;
  qr: string | null;
  statusText?: string;
  onClose: () => void;
};

export default function QrModal({ open, qr, statusText, onClose }: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="wa-panel w-[min(520px,calc(100vw-2rem))] overflow-hidden animate-scale-in">
        <div className="flex items-center justify-between gap-2 border-b border-wa-border px-5 py-4">
          <div>
            <div className="truncate text-sm font-semibold text-wa-text">Connect WhatsApp</div>
            <div className="mt-1 text-xs text-wa-subtext">Scan QR or use pairing code</div>
          </div>
          <button className="wa-btn-ghost !p-2 -mr-1 -mt-1" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">
          <QrCard qr={qr} statusText={statusText} />
        </div>
      </div>
    </div>
  );
}
