import { TikTokPage } from "@remotion/captions";
import React from "react";
import {
  AbsoluteFill,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Page } from "./Page";
import { useSubtitlePreset } from "./presets/context";

const SubtitlePage: React.FC<{
  readonly page: TikTokPage;
  readonly subtitleColor?: string;
}> = ({ page, subtitleColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const preset = useSubtitlePreset();

  const enter = spring({
    frame,
    fps,
    config: {
      damping: 200,
    },
    durationInFrames: 5,
  });

  return (
    <AbsoluteFill>
      <Page
        enterProgress={enter}
        page={page}
        subtitleColor={subtitleColor ?? preset?.highlightColor}
      />
    </AbsoluteFill>
  );
};

export default SubtitlePage;
