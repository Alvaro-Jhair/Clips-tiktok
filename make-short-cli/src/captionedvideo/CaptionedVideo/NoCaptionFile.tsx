import React from "react";
import { AbsoluteFill } from "remotion";
import { useSubtitlePreset } from "./presets/context";

export const NoCaptionFile: React.FC = () => {
  const preset = useSubtitlePreset();
  return (
    <AbsoluteFill
      style={{
        height: "auto",
        width: "100%",
        backgroundColor: preset?.strokeColor ?? "#0b84f3",
        color: "white",
        fontSize: 50,
        padding: 30,
        top: undefined,
        fontFamily: "sans-serif",
      }}
    >
      No caption file found in public. <br /> Add a JSON subtitle file in
      {" `public/` with the same video filename (only extension changes to `"}
      {".json`)."}
    </AbsoluteFill>
  );
};
