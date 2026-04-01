import React, { createContext, useContext } from "react";

export type SubtitlePreset = {
  name: string;
  color: string;
  highlightColor: string;
  strokeColor: string;
  strokeWidth?: number;
  shadow?: string;
  fontWeight?: number;
  fontSize?: number;
  position?: "low" | "mid" | "high";
  height?: number;
  wordEmphasisColor?: string;
  uppercase?: boolean;
  letterSpacing?: number;
};

const PresetContext = createContext<{ preset?: SubtitlePreset; colorOverride?: string }>(
  {},
);

export const SubtitlePresetProvider: React.FC<{
  preset?: SubtitlePreset;
  colorOverride?: string;
  children: React.ReactNode;
}> = ({ preset, colorOverride, children }) => {
  return (
    <PresetContext.Provider value={{ preset, colorOverride }}>
      {children}
    </PresetContext.Provider>
  );
};

export const useSubtitlePreset = () => {
  const { preset, colorOverride } = useContext(PresetContext);
  if (!preset) {
    return undefined;
  }
  if (colorOverride) {
    return { ...preset, highlightColor: colorOverride, wordEmphasisColor: colorOverride };
  }
  return preset;
};
