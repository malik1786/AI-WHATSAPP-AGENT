import React, { useState } from "react";
import { api, setToken } from "../api/client";
import { Loader2, Bot } from "lucide-react";

type Props = {
  onLogin: () => void;
};

export default function LoginPage({ onLogin }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleGoogleLogin() {
    setLoading(true);
    setError("");
    try {
      const res = await api.authGoogleClientId();
      const clientId = res.clientId;
      const redirectUri = encodeURIComponent(window.location.origin + "/api/auth/google/callback");
      const scope = encodeURIComponent("email profile");
      const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;
      window.location.href = url;
    } catch (e: any) {
      setError(e?.message || "Failed to start Google login");
      setLoading(false);
    }
  }

  // Check if we have a token from callback
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get("token");
  if (token) {
    setToken(token);
    window.history.replaceState({}, "", window.location.pathname);
    setTimeout(() => onLogin(), 0);
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-wa-bg p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-green-500 to-emerald-600 mx-auto mb-4">
            <Bot size={28} className="text-white" />
          </div>
          <h1 className="text-xl font-bold text-wa-text">WA Agent</h1>
          <p className="text-xs text-wa-subtext mt-1">AI Assistant</p>
        </div>

        <div className="wa-panel p-6">
          <p className="text-sm text-wa-subtext text-center mb-5">Sign in with your Google account</p>

          {error && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-2.5 text-center text-xs text-red-500 mb-4">{error}</div>
          )}

          <button
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 rounded-xl border border-wa-border bg-white py-3 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-all disabled:opacity-50"
          >
            {loading ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.05z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            )}
            Continue with Google
          </button>

          <p className="text-[10px] text-wa-subtext/50 text-center mt-4">By signing in you agree to our terms</p>
        </div>
      </div>
    </div>
  );
}
