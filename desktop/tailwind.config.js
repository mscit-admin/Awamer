/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Custom palette for NetSphere — refined dark with phosphor accent
        bg: {
          DEFAULT: "#0a0c10",
          surface: "#11141a",
          elevated: "#161a22",
          overlay: "rgba(10, 12, 16, 0.7)",
        },
        border: {
          DEFAULT: "#1f242e",
          strong: "#2a313e",
        },
        fg: {
          DEFAULT: "#e6e8ec",
          muted: "#8a93a3",
          subtle: "#5a6273",
        },
        accent: {
          DEFAULT: "#7dd3a0", // phosphor green, refined
          dim: "#4a8b66",
          glow: "rgba(125, 211, 160, 0.15)",
        },
        danger: {
          DEFAULT: "#ef4444",
          dim: "#7f1d1d",
        },
        warning: {
          DEFAULT: "#f59e0b",
          dim: "#78350f",
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', '"Inter"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', "ui-monospace", "monospace"],
        display: ['"Inter Variable"', "system-ui", "sans-serif"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.02em" }],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(125, 211, 160, 0.3), 0 0 20px rgba(125, 211, 160, 0.15)",
        focus: "0 0 0 3px rgba(125, 211, 160, 0.25)",
        elevated: "0 4px 20px rgba(0, 0, 0, 0.4)",
      },
      animation: {
        "fade-in": "fadeIn 200ms ease-out",
        "slide-up": "slideUp 240ms cubic-bezier(0.16, 1, 0.3, 1)",
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      keyframes: {
        fadeIn: { from: { opacity: "0" }, to: { opacity: "1" } },
        slideUp: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
