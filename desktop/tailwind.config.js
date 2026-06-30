/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantic palette driven by CSS variables (see styles/global.css)
        // so the whole UI re-themes via a class on <html>. Variables are
        // space-separated RGB channels to keep Tailwind's /alpha modifiers.
        bg: {
          DEFAULT: "rgb(var(--c-bg) / <alpha-value>)",
          surface: "rgb(var(--c-bg-surface) / <alpha-value>)",
          elevated: "rgb(var(--c-bg-elevated) / <alpha-value>)",
          overlay: "rgb(var(--c-bg) / 0.7)",
        },
        border: {
          DEFAULT: "rgb(var(--c-border) / <alpha-value>)",
          strong: "rgb(var(--c-border-strong) / <alpha-value>)",
        },
        fg: {
          DEFAULT: "rgb(var(--c-fg) / <alpha-value>)",
          muted: "rgb(var(--c-fg-muted) / <alpha-value>)",
          subtle: "rgb(var(--c-fg-subtle) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--c-accent) / <alpha-value>)",
          dim: "rgb(var(--c-accent-dim) / <alpha-value>)",
          glow: "rgb(var(--c-accent) / 0.15)",
        },
        danger: {
          DEFAULT: "rgb(var(--c-danger) / <alpha-value>)",
          dim: "#7f1d1d",
        },
        warning: {
          DEFAULT: "rgb(var(--c-warning) / <alpha-value>)",
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
