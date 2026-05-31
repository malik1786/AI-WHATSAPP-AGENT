import React, { useState } from "react";
import { api, setToken } from "../api/client";
import { Mail, Lock, UserPlus, LogIn, Loader2 } from "lucide-react";

type Props = {
  onLogin: () => void;
};

export default function LoginPage({ onLogin }: Props) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { setError("Fill all fields"); return; }
    setLoading(true);
    setError("");
    try {
      const res = mode === "login"
        ? await api.authLogin(email, password)
        : await api.authSignup(email, password);
      setToken(res.token);
      onLogin();
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-wa-bg p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-green-500 to-emerald-600 mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          </div>
          <h1 className="text-xl font-bold text-wa-text">WA Agent</h1>
          <p className="text-xs text-wa-subtext mt-1">AI Assistant</p>
        </div>

        <div className="wa-panel p-6">
          <div className="flex gap-2 mb-5">
            <button
              onClick={() => { setMode("login"); setError(""); }}
              className={cx("flex-1 flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all", mode === "login" ? "bg-wa-green text-black" : "text-wa-subtext hover:text-wa-text")}
            >
              <LogIn size={16} /> Login
            </button>
            <button
              onClick={() => { setMode("signup"); setError(""); }}
              className={cx("flex-1 flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all", mode === "signup" ? "bg-wa-green text-black" : "text-wa-subtext hover:text-wa-text")}
            >
              <UserPlus size={16} /> Sign Up
            </button>
          </div>

          <form onSubmit={handleSubmit} className="grid gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-wa-subtext">Email</label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-wa-subtext" />
                <input
                  type="email"
                  className="w-full rounded-xl bg-wa-panel2/50 py-2.5 pl-10 pr-4 text-sm text-wa-text outline-none focus:ring-2 focus:ring-wa-green/50"
                  placeholder="you@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-wa-subtext">Password</label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-wa-subtext" />
                <input
                  type="password"
                  className="w-full rounded-xl bg-wa-panel2/50 py-2.5 pl-10 pr-4 text-sm text-wa-text outline-none focus:ring-2 focus:ring-wa-green/50"
                  placeholder="Min 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>

            {error && (
              <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-2.5 text-center text-xs text-red-500">{error}</div>
            )}

            <button
              type="submit"
              className="wa-btn-primary w-full justify-center py-3"
              disabled={loading}
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : mode === "login" ? <><LogIn size={16} /> Login</> : <><UserPlus size={16} /> Create Account</>}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function cx(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
