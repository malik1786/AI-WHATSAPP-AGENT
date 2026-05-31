import React, { useEffect, useState } from "react";
import { api, setToken } from "../api/client";
import { Loader2, Bot } from "lucide-react";

declare global {
  interface Window {
    google?: any;
    googleSignIn?: (response: any) => void;
  }
}

type Props = {
  onLogin: () => void;
};

export default function LoginPage({ onLogin }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [clientId, setClientId] = useState("");

  useEffect(() => {
    api.authGoogleClientId().then((res) => {
      setClientId(res.clientId);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!clientId) return;

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      if (window.google) {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: handleGoogleResponse,
        });
        window.google.accounts.id.renderButton(
          document.getElementById("google-signin-btn"),
          { theme: "outline", size: "large", width: "100%", text: "continue_with" }
        );
      }
    };
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, [clientId]);

  async function handleGoogleResponse(response: any) {
    setLoading(true);
    setError("");
    try {
      const res = await api.authGoogle(response.credential);
      setToken(res.token);
      onLogin();
    } catch (e: any) {
      setError(e?.message || "Google login failed");
    } finally {
      setLoading(false);
    }
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

          <div className="flex justify-center">
            {loading ? (
              <div className="flex items-center gap-2 text-wa-subtext">
                <Loader2 size={20} className="animate-spin" />
                <span className="text-sm">Signing in...</span>
              </div>
            ) : (
              <div id="google-signin-btn" />
            )}
          </div>

          {!clientId && (
            <p className="text-xs text-wa-subtext text-center mt-4 animate-pulse">Loading Google Sign-In...</p>
          )}
        </div>
      </div>
    </div>
  );
}
