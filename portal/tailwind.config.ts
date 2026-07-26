import type { Config } from "tailwindcss";

// The palette mirrors tools/make-icons.py in the vassal-webswing repo, so the
// Webswing selector tiles and the portal catalog read as one platform.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        felt: {
          900: "#0b0d10",
          800: "#12151a",
          700: "#1a1f26",
          600: "#242b35",
          500: "#39434f",
        },
        parchment: {
          100: "#f2ece0",
          300: "#d8cfbd",
          500: "#a89c84",
        },
        brass: {
          400: "#c9a24d",
          600: "#9a7a33",
        },
        module: {
          his: "#8c2428",
          twilight: "#2a4a8c",
          paths: "#7d7a4a",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
      },
      boxShadow: {
        plate: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 12px 32px -12px rgba(0,0,0,0.8)",
      },
    },
  },
  plugins: [],
};

export default config;
