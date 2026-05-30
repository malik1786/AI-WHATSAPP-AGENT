import React, { useCallback, useEffect, useMemo, useState } from "react";
import { QrCode, Smartphone, Copy, Check, RefreshCw, ArrowRight } from "lucide-react";
import { qrToDataUrl } from "../lib/qr";
import { api } from "../api/client";

type Props = {
  qr: string | null;
  statusText?: string;
};

type Mode = "qr" | "code";

export default function QrCard({ qr, statusText }: Props) {
  const [mode, setMode] = useState<Mode>("qr");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const value = useMemo(() => (qr ? String(qr) : null), [qr]);

  useEffect(() => {
    let alive = true;
    setDataUrl(null);
    if (!value) return;
    qrToDataUrl(value).then((url) => { if (alive) setDataUrl(url); }).catch(() => { if (alive) setDataUrl(null); });
    return () => { alive = false; };
  }, [value]);

  const requestPairingCode = useCallback(async () => {
    const digits = phoneNumber.replace(/\D/g, "");
    if (!digits || digits.length < 10) { setPairingError("Enter a valid phone number with country code"); return; }
    setPairingLoading(true); setPairingError(null); setPairingCode(null);
    try {
      const res = await api.gatewayPairingCode(digits);
      if (res.ok && res.code) setPairingCode(res.code);
      else setPairingError(res.error || "Failed to get pairing code");
    } catch (e: any) {
      const msg = e?.message || "Failed to get pairing code";
      if (msg.includes("not loaded yet")) setPairingError("Wait for the QR code to appear first, then try again.");
      else setPairingError(msg);
    } finally { setPairingLoading(false); }
  }, [phoneNumber]);

  const copyCode = useCallback(() => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }, [pairingCode]);

  const cancelPairing = useCallback(async () => {
    try { await api.gatewayCancelPairing(); } catch {}
    setPairingCode(null); setPairingError(null);
  }, []);

  const switchMode = useCallback((newMode: Mode) => {
    if (newMode === mode) return;
    if (mode === "code") cancelPairing();
    setMode(newMode);
  }, [mode, cancelPairing]);

  return (
    <div className="grid gap-4">
      {/* Mode toggle */}
      <div className="flex rounded-xl bg-wa-panel2/50 p-1">
        <button
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium transition-all duration-200 ${
            mode === "qr" ? "bg-wa-green text-black shadow-lg shadow-wa-green/20" : "text-wa-subtext hover:text-wa-text"
          }`}
          onClick={() => switchMode("qr")}
        >
          <QrCode size={14} />
          Scan QR
        </button>
        <button
          className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium transition-all duration-200 ${
            mode === "code" ? "bg-wa-green text-black shadow-lg shadow-wa-green/20" : "text-wa-subtext hover:text-wa-text"
          }`}
          onClick={() => switchMode("code")}
        >
          <Smartphone size={14} />
          Enter Code
        </button>
      </div>

      {/* QR mode */}
      {mode === "qr" && (
        <div className="relative grid aspect-square w-full max-w-[320px] place-items-center justify-self-center rounded-2xl bg-white p-5">
          {dataUrl ? (
            <img src={dataUrl} alt="WhatsApp QR" className="h-auto w-full rounded-xl" />
          ) : value ? (
            <div className="qr-loading-ring">
              <div className="qr-loading-ring-inner" />
              <QrCode className="absolute text-gray-700" size={36} />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <div className="splash-ring">
                <div className="splash-ring-inner" />
                <div className="splash-ring-dot" />
              </div>
              <span className="text-xs text-gray-500 animate-pulse">Initializing...</span>
            </div>
          )}
        </div>
      )}

      {/* Pairing code mode */}
      {mode === "code" && (
        <div className="grid gap-4">
          {!pairingCode && !pairingLoading && (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-wa-subtext">Phone number</label>
                <input
                  className="wa-input"
                  placeholder="+91 919876543210"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter") requestPairingCode(); }}
                  inputMode="numeric"
                />
                {phoneNumber && (
                  <div className="mt-1.5 text-[11px] text-wa-subtext">
                    Will send to: <span className="font-mono text-wa-green">+{phoneNumber}</span>
                  </div>
                )}
              </div>
              <button
                className="wa-btn-primary w-full justify-center py-3"
                onClick={requestPairingCode}
                disabled={!phoneNumber.trim()}
              >
                <Smartphone size={16} />
                Generate Pairing Code
                <ArrowRight size={14} />
              </button>
            </>
          )}

          {pairingLoading && (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="splash-ring">
                <div className="splash-ring-inner" />
                <div className="splash-ring-dot" />
              </div>
              <span className="text-xs text-wa-subtext animate-pulse">Generating code...</span>
            </div>
          )}

          {pairingCode && (
            <div className="flex flex-col items-center gap-4">
              <div className="text-center text-xs text-wa-subtext">
                On your phone: <strong className="text-wa-text">WhatsApp</strong> &rarr; Linked Devices &rarr; Link with Phone Number
              </div>
              <div className="relative w-full">
                <div className="flex items-center justify-center rounded-2xl border-2 border-dashed border-wa-green/40 bg-wa-green3/30 py-7">
                  <span className="font-mono text-4xl font-bold tracking-[0.3em] text-wa-green select-all drop-shadow-lg">
                    {pairingCode}
                  </span>
                </div>
                <button
                  className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg bg-wa-panel2/80 text-wa-subtext transition-all hover:bg-wa-panel2 hover:text-wa-text"
                  onClick={copyCode}
                  title="Copy code"
                >
                  {copied ? <Check size={15} className="text-wa-green" /> : <Copy size={15} />}
                </button>
              </div>
              <button className="wa-btn-ghost text-xs" onClick={() => { cancelPairing(); setPairingCode(null); }}>
                <RefreshCw size={13} />
                New code
              </button>
            </div>
          )}

          {pairingError && (
            <div className="rounded-xl bg-wa-danger/10 border border-wa-danger/20 px-4 py-3 text-center text-xs text-wa-danger">
              {pairingError}
            </div>
          )}

          <div className="rounded-xl bg-wa-panel2/30 p-4 text-xs text-wa-subtext">
            <div className="mb-2.5 font-semibold text-wa-text">How to link:</div>
            <ol className="space-y-1.5">
              <li className="flex items-start gap-2"><span className="mt-0.5 text-wa-green">1.</span> Open WhatsApp on your phone</li>
              <li className="flex items-start gap-2"><span className="mt-0.5 text-wa-green">2.</span> Go to <strong>Settings</strong> &rarr; <strong>Linked Devices</strong></li>
              <li className="flex items-start gap-2"><span className="mt-0.5 text-wa-green">3.</span> Tap <strong>Link a Device</strong></li>
              <li className="flex items-start gap-2"><span className="mt-0.5 text-wa-green">4.</span> Tap <strong>Link with Phone Number Instead</strong></li>
              <li className="flex items-start gap-2"><span className="mt-0.5 text-wa-green">5.</span> Enter the code shown above</li>
            </ol>
            <p className="mt-3 text-[11px] text-wa-subtext/50">Format: digits only with country code (e.g. 919876543210)</p>
          </div>
        </div>
      )}

      <div className="min-h-[18px] text-center text-xs text-wa-subtext">
        {statusText ?? (
          <span className="inline-flex items-center gap-1">
            Waiting
            <span className="loading-dots"><span>.</span><span>.</span><span>.</span></span>
          </span>
        )}
      </div>
    </div>
  );
}
