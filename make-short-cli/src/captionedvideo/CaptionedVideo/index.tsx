import { Caption, createTikTokStyleCaptions } from "@remotion/captions";
import { getVideoMetadata } from "@remotion/media-utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AbsoluteFill,
  CalculateMetadataFunction,
  cancelRender,
  getRemotionEnvironment,
  OffthreadVideo,
  Sequence,
  useDelayRender,
  useVideoConfig,
  watchStaticFile,
} from "remotion";
import { z } from "zod";
import { loadFont } from "../load-font";
import { NoCaptionFile } from "./NoCaptionFile";
import SubtitlePage from "./SubtitlePage";
import { SubtitlePresetProvider } from "./presets/context";
import { getPreset } from "./presets/registry";

export type SubtitleProp = {
  startInSeconds: number;
  text: string;
};

export const captionedVideoSchema = z.object({
  src: z.string(),
  subtitleColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  subtitlePreset: z.string().optional(),
});

export const calculateCaptionedVideoMetadata: CalculateMetadataFunction<
  z.infer<typeof captionedVideoSchema>
> = async ({ props }) => {
  const fps = 30;
  try {
    const metadata = await getVideoMetadata(props.src);

    return {
      fps,
      durationInFrames: Math.floor(metadata.durationInSeconds * fps),
    };
  } catch {
    return {
      fps,
      durationInFrames: fps,
    };
  }
};

// How many captions should be displayed at a time?
// Try out:
// - 1500 to display a lot of words at a time
// - 200 to only display 1 word at a time
const SWITCH_CAPTIONS_EVERY_MS = 1200;

export const CaptionedVideo: React.FC<{
  src: string;
  subtitleColor?: string;
  subtitlePreset?: string;
}> = ({ src, subtitleColor, subtitlePreset }) => {
  const [subtitles, setSubtitles] = useState<Caption[]>([]);
  const [subtitleFound, setSubtitleFound] = useState(true);
  const { delayRender, continueRender } = useDelayRender();
  const [handle] = useState(() => delayRender());
  const { fps } = useVideoConfig();
  const preset = subtitlePreset ? getPreset(subtitlePreset) : null;

  const subtitlesFile = src
    .replace(/.mp4$/, ".json")
    .replace(/.mkv$/, ".json")
    .replace(/.mov$/, ".json")
    .replace(/.webm$/, ".json");

  const fetchSubtitles = useCallback(async () => {
    try {
      await loadFont();
      const res = await fetch(subtitlesFile);
      if (!res.ok) {
        setSubtitles([]);
        setSubtitleFound(false);
        return;
      }

      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) {
        setSubtitles([]);
        setSubtitleFound(false);
        return;
      }

      setSubtitles(data as Caption[]);
      setSubtitleFound(true);
    } catch {
      setSubtitles([]);
      setSubtitleFound(false);
    } finally {
      continueRender(handle);
    }
  }, [continueRender, handle, subtitlesFile]);

  useEffect(() => {
    const { isStudio } = getRemotionEnvironment();

    fetchSubtitles().catch((err) => {
      cancelRender(err);
    });

    if (!isStudio) {
      return;
    }

    const watcher = watchStaticFile(subtitlesFile, () => {
      fetchSubtitles().catch((err) => {
        cancelRender(err);
      });
    });

    return () => {
      watcher.cancel();
    };
  }, [fetchSubtitles, subtitlesFile]);

  const { pages } = useMemo(() => {
    return createTikTokStyleCaptions({
      combineTokensWithinMilliseconds: SWITCH_CAPTIONS_EVERY_MS,
      captions: subtitles ?? [],
    });
  }, [subtitles]);

  return (
    <SubtitlePresetProvider preset={preset ?? undefined} colorOverride={subtitleColor}>
      <AbsoluteFill style={{ backgroundColor: "black" }}>
        <AbsoluteFill>
          <OffthreadVideo
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center",
            }}
            src={src}
          />
        </AbsoluteFill>
        {pages.map((page, index) => {
          const nextPage = pages[index + 1] ?? null;
          const subtitleStartFrame = (page.startMs / 1000) * fps;
          const subtitleEndFrame = Math.min(
            nextPage ? (nextPage.startMs / 1000) * fps : Infinity,
            subtitleStartFrame + SWITCH_CAPTIONS_EVERY_MS,
          );
          const durationInFrames = subtitleEndFrame - subtitleStartFrame;
          if (durationInFrames <= 0) {
            return null;
          }

          return (
            <Sequence
              key={index}
              from={subtitleStartFrame}
              durationInFrames={durationInFrames}
            >
              <SubtitlePage page={page} subtitleColor={subtitleColor} />
            </Sequence>
          );
        })}
        {subtitleFound ? null : <NoCaptionFile />}
      </AbsoluteFill>
    </SubtitlePresetProvider>
  );
};
