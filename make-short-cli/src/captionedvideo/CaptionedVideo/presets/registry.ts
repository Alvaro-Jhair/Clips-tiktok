import { SubtitlePreset } from "./context";

const presets: Record<string, SubtitlePreset> = {
  "viral-bold": {
    name: "viral-bold",
    color: "#ffffff",
    highlightColor: "#39E508",
    strokeColor: "#000000",
    strokeWidth: 22,
    shadow: "0px 0px 28px rgba(0,0,0,0.55)",
    fontWeight: 800,
    fontSize: 122,
    position: "low",
    height: 190,
    wordEmphasisColor: "#39E508",
    uppercase: true,
    letterSpacing: 1.2,
  },
  "clean-premium": {
    name: "clean-premium",
    color: "#f8f8f8",
    highlightColor: "#ffd166",
    strokeColor: "#0f0f0f",
    strokeWidth: 18,
    shadow: "0px 6px 24px rgba(0,0,0,0.35)",
    fontWeight: 700,
    fontSize: 110,
    position: "mid",
    height: 170,
    wordEmphasisColor: "#ffd166",
    uppercase: false,
    letterSpacing: 0.5,
  },
  "podcast-neon": {
    name: "podcast-neon",
    color: "#e5f0ff",
    highlightColor: "#7cf5ff",
    strokeColor: "#0a0a1a",
    strokeWidth: 20,
    shadow: "0px 0px 36px rgba(0,255,255,0.35)",
    fontWeight: 800,
    fontSize: 118,
    position: "low",
    height: 200,
    wordEmphasisColor: "#ff7cf5",
    uppercase: true,
    letterSpacing: 1,
  },
  "minimal-impact": {
    name: "minimal-impact",
    color: "#ffffff",
    highlightColor: "#ff5f5f",
    strokeColor: "#000000",
    strokeWidth: 14,
    shadow: "0px 4px 18px rgba(0,0,0,0.35)",
    fontWeight: 700,
    fontSize: 108,
    position: "mid",
    height: 160,
    wordEmphasisColor: "#ff5f5f",
    uppercase: false,
    letterSpacing: 0.4,
  },
};

export const getPreset = (name: string) => {
  const key = name.trim().toLowerCase();
  return presets[key] ?? null;
};

export const listPresets = () => Object.keys(presets);
