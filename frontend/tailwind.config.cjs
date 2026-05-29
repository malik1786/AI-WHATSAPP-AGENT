/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        wa: {
          bg: "#09090b",
          bg2: "#0f0f12",
          panel: "rgba(15, 15, 20, 0.8)",
          panel2: "rgba(24, 24, 32, 0.6)",
          panel3: "rgba(30, 30, 40, 0.5)",
          border: "rgba(255, 255, 255, 0.06)",
          border2: "rgba(255, 255, 255, 0.1)",
          text: "#fafafa",
          subtext: "#71717a",
          green: "#22c55e",
          green2: "#16a34a",
          green3: "rgba(34, 197, 94, 0.1)",
          bubbleOut: "rgba(34, 197, 94, 0.08)",
          bubbleIn: "rgba(24, 24, 32, 0.8)",
          hover: "rgba(255, 255, 255, 0.04)",
          danger: "#ef4444",
          accent: "#8b5cf6",
          accent2: "#a78bfa",
          accent3: "rgba(139, 92, 246, 0.1)",
          glass: "rgba(255, 255, 255, 0.02)",
        }
      },
      boxShadow: {
        wa: "0 4px 24px rgba(0, 0, 0, 0.4)",
        glow: "0 0 40px rgba(34, 197, 94, 0.1)",
        "glow-sm": "0 0 20px rgba(34, 197, 94, 0.08)",
        glass: "0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
      },
      animation: {
        "fade-in": "fade-in 0.4s ease-out both",
        "slide-up": "slide-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
        "scale-in": "scale-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) both",
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        typing: "typing 1.4s ease-in-out infinite",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.95)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "1" },
        },
        typing: {
          "0%": { opacity: "0.3" },
          "50%": { opacity: "1" },
          "100%": { opacity: "0.3" },
        },
      },
    }
  },
  plugins: []
};
