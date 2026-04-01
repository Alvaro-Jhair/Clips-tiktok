import { makeTransform, scale, translateY } from "@remotion/animation-utils";
import { TikTokPage } from "@remotion/captions";
import { fitText } from "@remotion/layout-utils";
import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { TheBoldFont } from "../load-font";
import { useSubtitlePreset } from "./presets/context";

const fontFamily = TheBoldFont;

const DEFAULT_HIGHLIGHT_COLOR = "#39E508";

export const Page: React.FC<{
  readonly enterProgress: number;
  readonly page: TikTokPage;
  readonly subtitleColor?: string;
}> = ({ enterProgress, page, subtitleColor }) => {
  const frame = useCurrentFrame();
  const { width, fps } = useVideoConfig();
  const preset = useSubtitlePreset();
  const timeInMs = (frame / fps) * 1000;
  const highlightColor = subtitleColor ?? preset?.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR;

  const container: React.CSSProperties = {
    justifyContent: "center",
    alignItems: "center",
    top: undefined,
    bottom: preset?.position === "low" ? 220 : preset?.position === "mid" ? 420 : 350,
    height: preset?.height ?? 180,
    padding: "0 60px",
  };

  const desiredFontSize = preset?.fontSize ?? 120;
  const strokeWidth = preset?.strokeWidth ?? 20;
  const shadow = preset?.shadow ?? "0px 0px 24px rgba(0,0,0,0.45)";
  const weight = preset?.fontWeight ?? 700;
  const uppercase = preset?.uppercase ?? true;
  const wordEmphasisColor = preset?.wordEmphasisColor ?? highlightColor;
  const letterSpacing = preset?.letterSpacing ?? 0;

  const fittedText = fitText({
    fontFamily,
    text: page.text,
    withinWidth: width * 0.9,
    textTransform: uppercase ? "uppercase" : "none",
  });

  const fontSize = Math.min(desiredFontSize, fittedText.fontSize);

  return (
    <AbsoluteFill style={container}>
      <div
        style={{
          fontSize,
          color: preset?.color ?? "white",
          WebkitTextStroke: `${strokeWidth}px ${preset?.strokeColor ?? "black"}`,
          paintOrder: "stroke",
          textShadow: shadow,
          transform: makeTransform([
            scale(interpolate(enterProgress, [0, 1], [0.8, 1])),
            translateY(interpolate(enterProgress, [0, 1], [50, 0])),
          ]),
          fontFamily,
          textTransform: uppercase ? "uppercase" : "none",
          fontWeight: weight,
          lineHeight: 1.05,
          letterSpacing,
        }}
      >
        <span
          style={{
            transform: makeTransform([
              scale(interpolate(enterProgress, [0, 1], [0.8, 1])),
              translateY(interpolate(enterProgress, [0, 1], [50, 0])),
            ]),
          }}
        >
          {page.tokens.map((t) => {
            const startRelativeToSequence = t.fromMs - page.startMs;
            const endRelativeToSequence = t.toMs - page.startMs;

            const active =
              startRelativeToSequence <= timeInMs &&
              endRelativeToSequence > timeInMs;

            return (
              <span
                key={t.fromMs}
                style={{
                  display: "inline",
                  whiteSpace: "pre",
                  color: active ? wordEmphasisColor : preset?.color ?? "white",
                  transition: "color 120ms ease-out",
                }}
              >
                {t.text}
              </span>
            );
          })}
        </span>
      </div>
    </AbsoluteFill>
  );
};
