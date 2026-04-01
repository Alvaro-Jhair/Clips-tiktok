import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  analyzeFramingPlan,
  framingPlanToFilter,
  type FramingPlan,
  getVideoDimensions,
} from "../captionedvideo/CaptionedVideo/facetrack";

type Caption = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number;
};

type SelectionSegment = {
  startChunkId: number;
  endChunkId: number;
  startMs: number;
  endMs: number;
  durationSec: number;
};

type ClipMetadata = {
  clipNumber: number;
  title: string;
  hook: string;
  description: string;
  hashtags: string[];
  metadataSource: "model" | "fallback";
  metadataError: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  viralityScore: number;
  normalizedScore: number;
  promoPenalty: number;
  sponsorLikelihood: number;
  audienceAppealScore: number;
};

type ClipMetadataResult = Omit<
  ClipMetadata,
  | "clipNumber"
  | "startMs"
  | "endMs"
  | "durationMs"
  | "viralityScore"
  | "normalizedScore"
  | "promoPenalty"
  | "sponsorLikelihood"
  | "audienceAppealScore"
>;

const DEFAULT_MIN_SECONDS = 18;
const DEFAULT_TARGET_SECONDS = 30;
const DEFAULT_MAX_SECONDS = 55;
const DEFAULT_COUNT = 1;
const DEFAULT_MAX_ITERATIONS = 3;
const MAX_ITERATIONS = 10;
const MAX_COUNT = 100;
const DEFAULT_DIVERSITY_BUFFER_SECONDS = 15;
const SUPPORTED_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov"]);
const YT_MAX_HEIGHT = "720";
const YT_PROXY_HEIGHT = "480";
const PREVIEW_SECS = 180;
const MIN_ANALYSIS_ITERATIONS = 5;
const METADATA_MODEL_DEFAULT = "gpt-5-mini";
const TARGET_HEIGHT = 1920;
const TARGET_WIDTH = 1080;
const DEFAULT_OUTRO = process.env.OUTRO_VIDEO_PATH ?? "assets/outro.mp4";

type SelectionAnalysis = {
  segments: SelectionSegment[];
  viralityScore: number;
  normalizedScore: number;
  promoPenalty: number;
  sponsorLikelihood: number;
  audienceAppealScore: number;
  hook: string;
  reason: string;
};

type ClipFramingMetadata = {
  clipNumber: number;
  mode: FramingPlan["mode"];
  cropWidth: number;
  dominantTrack: number | null;
  fallback: boolean;
  confidence: number;
  keyframesCount: number;
};

const usage = () => {
  return "Usage: bun src/cli/short-url.ts <youtube-url> [--count <1-100>] [--min-seconds <number>] [--target-seconds <number>] [--max-seconds <number>] [--skip-start-seconds <number>] [--diversity-buffer-seconds <number>] [--model <name>] [--max-iterations <1-10>] [--subtitle-color <hex>] [--subtitle-preset <name>] [--fast]";
};

const run = (command: string, args: string[], cwd?: string) => {
  const result = spawnSync(command, args, {
    cwd: cwd ?? process.cwd(),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
};

const isFiniteNumber = (value: unknown): value is number => {
  return typeof value === "number" && Number.isFinite(value);
};

const normalizeSubtitleColor = (value: string) => {
  const trimmed = value.trim();
  const withoutHash = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]{6}$/.test(withoutHash)) {
    throw new Error(
      "--subtitle-color must be a 6-digit hexadecimal value like #39E508.",
    );
  }

  return `#${withoutHash.toUpperCase()}`;
};

const normalizeYoutubeUrl = (value: string) => {
  const trimmed = value.trim();
  const withoutAngles =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1).trim()
      : trimmed;

  if (!withoutAngles) {
    throw new Error("You must provide a valid YouTube URL.");
  }

  return withoutAngles;
};

const parseArgs = (args: string[]) => {
  let urlArg: string | null = null;
  let minSeconds = DEFAULT_MIN_SECONDS;
  let targetSeconds = DEFAULT_TARGET_SECONDS;
  let maxSeconds = DEFAULT_MAX_SECONDS;
  let skipStartSeconds = 0;
  let diversityBufferSeconds = DEFAULT_DIVERSITY_BUFFER_SECONDS;
  let modelArg: string | null = null;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let subtitleColorArg: string | null = null;
  let count = DEFAULT_COUNT;
  let fastMode = false;
  let subtitlePreset: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--min-seconds") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --min-seconds.");
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--min-seconds must be a positive number.");
      }

      minSeconds = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--min-seconds=")) {
      const rawValue = arg.slice("--min-seconds=".length);
      const parsed = Number(rawValue);
      if (!rawValue || !Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--min-seconds must be a positive number.");
      }

      minSeconds = parsed;
      continue;
    }

    if (arg === "--target-seconds") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --target-seconds.");
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--target-seconds must be a positive number.");
      }

      targetSeconds = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--target-seconds=")) {
      const rawValue = arg.slice("--target-seconds=".length);
      const parsed = Number(rawValue);
      if (!rawValue || !Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--target-seconds must be a positive number.");
      }

      targetSeconds = parsed;
      continue;
    }

    if (arg === "--max-seconds") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --max-seconds.");
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--max-seconds must be a positive number.");
      }

      maxSeconds = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--max-seconds=")) {
      const rawValue = arg.slice("--max-seconds=".length);
      const parsed = Number(rawValue);
      if (!rawValue || !Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--max-seconds must be a positive number.");
      }

      maxSeconds = parsed;
      continue;
    }

    if (arg === "--count") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --count.");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_COUNT) {
        throw new Error(`--count must be an integer between 1 and ${MAX_COUNT}.`);
      }
      count = parsed;
      index += 1;
      continue;
    }

    if (arg === "--skip-start-seconds") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --skip-start-seconds.");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--skip-start-seconds must be a number >= 0.");
      }
      skipStartSeconds = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--skip-start-seconds=")) {
      const rawValue = arg.slice("--skip-start-seconds=".length);
      const parsed = Number(rawValue);
      if (!rawValue || !Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--skip-start-seconds must be a number >= 0.");
      }
      skipStartSeconds = parsed;
      continue;
    }

    if (arg === "--diversity-buffer-seconds") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --diversity-buffer-seconds.");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--diversity-buffer-seconds must be a number >= 0.");
      }
      diversityBufferSeconds = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--diversity-buffer-seconds=")) {
      const rawValue = arg.slice("--diversity-buffer-seconds=".length);
      const parsed = Number(rawValue);
      if (!rawValue || !Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--diversity-buffer-seconds must be a number >= 0.");
      }
      diversityBufferSeconds = parsed;
      continue;
    }

    if (arg.startsWith("--count=")) {
      const raw = arg.slice("--count=".length);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_COUNT) {
        throw new Error(`--count must be an integer between 1 and ${MAX_COUNT}.`);
      }
      count = parsed;
      continue;
    }

    if (arg === "--model") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --model.");
      }

      if (value.trim().length === 0) {
        throw new Error("--model must be a non-empty string.");
      }

      modelArg = value.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length).trim();
      if (!value) {
        throw new Error("--model must be a non-empty string.");
      }

      modelArg = value;
      continue;
    }

    if (arg === "--max-iterations") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --max-iterations.");
      }

      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ITERATIONS) {
        throw new Error(
          `--max-iterations must be an integer between 1 and ${MAX_ITERATIONS}.`,
        );
      }

      maxIterations = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--max-iterations=")) {
      const rawValue = arg.slice("--max-iterations=".length);
      const parsed = Number(rawValue);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ITERATIONS) {
        throw new Error(
          `--max-iterations must be an integer between 1 and ${MAX_ITERATIONS}.`,
        );
      }

      maxIterations = parsed;
      continue;
    }

    if (arg === "--subtitle-color") {
      if (subtitleColorArg) {
        throw new Error("The --subtitle-color option can only be provided once.");
      }

      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --subtitle-color.");
      }

      subtitleColorArg = normalizeSubtitleColor(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--subtitle-color=")) {
      if (subtitleColorArg) {
        throw new Error("The --subtitle-color option can only be provided once.");
      }

      const value = arg.slice("--subtitle-color=".length);
      if (!value) {
        throw new Error("Missing value for --subtitle-color.");
      }

      subtitleColorArg = normalizeSubtitleColor(value);
      continue;
    }

    if (arg === "--subtitle-preset") {
      if (subtitlePreset) {
        throw new Error("The --subtitle-preset option can only be provided once.");
      }

      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --subtitle-preset.");
      }

      subtitlePreset = value.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith("--subtitle-preset=")) {
      if (subtitlePreset) {
        throw new Error("The --subtitle-preset option can only be provided once.");
      }

      const value = arg.slice("--subtitle-preset=".length).trim();
      if (!value) {
        throw new Error("Missing value for --subtitle-preset.");
      }

      subtitlePreset = value;
      continue;
    }

    if (arg === "--fast") {
      fastMode = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (urlArg) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    urlArg = normalizeYoutubeUrl(arg);
  }

  if (!urlArg) {
    throw new Error(usage());
  }

  if (minSeconds > targetSeconds) {
    throw new Error("--min-seconds must be <= --target-seconds.");
  }

  if (targetSeconds > maxSeconds) {
    throw new Error("--target-seconds must be <= --max-seconds.");
  }

  if (maxIterations < MIN_ANALYSIS_ITERATIONS) {
    maxIterations = MIN_ANALYSIS_ITERATIONS;
  }

  return {
    urlArg,
    minSeconds,
    targetSeconds,
    maxSeconds,
    skipStartSeconds,
    diversityBufferSeconds,
    modelArg,
    maxIterations,
    subtitleColorArg,
    count,
    fastMode,
    subtitlePreset,
  };
};

const ensureOutputDirs = () => {
  const outDir = path.join(process.cwd(), "out");
  const publicDir = path.join(process.cwd(), "public");
  const outputDir = path.join(process.cwd(), "output");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  return { outDir, publicDir, outputDir };
};

const hashUrl = (url: string) => {
  const hash = createHash("sha1").update(url).digest("hex");
  return hash.slice(0, 12);
};

const downloadYoutube = (
  url: string,
  outDir: string,
  height: string,
  sectionSeconds?: number,
) => {
  const safeName = `yt_${hashUrl(url)}_${height}`;
  const outputTemplate = path.join(outDir, `${safeName}.%(ext)s`);

  const downloadArgs = [
    "-f",
    `bestvideo[ext=mp4][vcodec^=avc][height<=${height}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${height}]`,
    "--merge-output-format",
    "mp4",
    "--no-playlist",
    "--no-check-certificate",
    "--concurrent-fragments",
    "8",
    "--throttled-rate",
    "1000M",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--buffer-size",
    "32M",
    "--downloader",
    "ffmpeg",
    "--downloader-args",
    "ffmpeg_i:-threads 2 -loglevel warning",
    "-o",
    outputTemplate,
    url,
  ];

  if (typeof sectionSeconds === "number" && sectionSeconds > 0) {
    downloadArgs.push("--download-sections", `*0-${Math.round(sectionSeconds)}`);
  }

  run("yt-dlp", downloadArgs);

  const candidates = [
    path.join(outDir, `${safeName}.mp4`),
    path.join(outDir, `${safeName}.mkv`),
    path.join(outDir, `${safeName}.webm`),
  ];

  const found = candidates.find((file) => existsSync(file));
  if (!found) {
    throw new Error("yt-dlp did not produce a media file.");
  }
  return found;
};

const downloadYoutubeAudio = (url: string, outDir: string) => {
  const safeName = `yt_${hashUrl(url)}_audio`;
  const outputTemplate = path.join(outDir, `${safeName}.%(ext)s`);
  const args = [
    "-f",
    "bestaudio[ext=m4a]/bestaudio",
    "--no-playlist",
    "--no-check-certificate",
    "--concurrent-fragments",
    "8",
    "--throttled-rate",
    "1000M",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--buffer-size",
    "32M",
    "-o",
    outputTemplate,
    url,
  ];

  run("yt-dlp", args);
  const candidates = [
    path.join(outDir, `${safeName}.m4a`),
    path.join(outDir, `${safeName}.webm`),
    path.join(outDir, `${safeName}.mp3`),
  ];
  const found = candidates.find((file) => existsSync(file));
  if (!found) {
    throw new Error("yt-dlp did not produce an audio file.");
  }
  return found;
};

const downloadYoutubeVideoSection = (
  url: string,
  outDir: string,
  startSec: number,
  endSec: number,
  tag: string,
) => {
  const safeTag = tag.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeName = `yt_${hashUrl(url)}_720_${safeTag}`;
  const outputTemplate = path.join(outDir, `${safeName}.%(ext)s`);
  const args = [
    "-f",
    `bestvideo[ext=mp4][vcodec^=avc][height<=${YT_MAX_HEIGHT}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${YT_MAX_HEIGHT}]`,
    "--merge-output-format",
    "mp4",
    "--no-playlist",
    "--no-check-certificate",
    "--concurrent-fragments",
    "8",
    "--throttled-rate",
    "1000M",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--buffer-size",
    "32M",
    "--downloader",
    "ffmpeg",
    "--downloader-args",
    "ffmpeg_i:-threads 2 -loglevel warning",
    "--download-sections",
    `*${startSec.toFixed(3)}-${endSec.toFixed(3)}`,
    "-o",
    outputTemplate,
    url,
  ];

  run("yt-dlp", args);

  const candidates = [
    path.join(outDir, `${safeName}.mp4`),
    path.join(outDir, `${safeName}.mkv`),
    path.join(outDir, `${safeName}.webm`),
  ];
  const found = candidates.find((file) => existsSync(file));
  if (!found) {
    throw new Error("yt-dlp did not produce a section video file.");
  }
  return found;
};

const resolveAnalysisAndMasterVideos = (
  url: string,
  outDir: string,
  tempDir: string,
  fastMode: boolean,
) => {
  const cacheKey = hashUrl(url);
  const analysisCache = path.join(outDir, `${cacheKey}.audio.m4a`);
  const masterCache = path.join(outDir, `${cacheKey}.master.mp4`);

  let analysisVideo = analysisCache;
  let masterVideo = masterCache;

  if (!existsSync(analysisCache)) {
    console.log("Descargando audio para analisis (rapido)...");
    const downloaded = downloadYoutubeAudio(url, tempDir);
    run("mv", [downloaded, analysisCache]);
  } else {
    console.log(`Reutilizando audio de analisis cacheado: ${analysisCache}`);
  }

  if (existsSync(masterCache)) {
    console.log(`Reutilizando master cacheado: ${masterCache}`);
  }

  if (!existsSync(analysisVideo)) {
    throw new Error(`Proxy de analisis no encontrado: ${analysisVideo}`);
  }
  return { analysisVideo, masterVideo };
};

const ensureVideoFile = (videoPath: string) => {
  if (!existsSync(videoPath)) {
    throw new Error(`Video file not found after download: ${videoPath}`);
  }
  const stat = lstatSync(videoPath);
  if (stat.isDirectory()) {
    throw new Error(`Expected a file but got a directory: ${videoPath}`);
  }
  const ext = path.extname(videoPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Downloaded file has unsupported extension "${ext}". Expected one of: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}`,
    );
  }
};

const ensureMediaFile = (mediaPath: string) => {
  if (!existsSync(mediaPath)) {
    throw new Error(`Media file not found: ${mediaPath}`);
  }
  const stat = lstatSync(mediaPath);
  if (stat.isDirectory()) {
    throw new Error(`Expected a file but got a directory: ${mediaPath}`);
  }
};

const shiftSegmentsToLocalTimeline = (
  segments: SelectionSegment[],
  offsetMs: number,
): SelectionSegment[] => {
  return segments.map((segment) => ({
    ...segment,
    startMs: Math.max(0, segment.startMs - offsetMs),
    endMs: Math.max(1, segment.endMs - offsetMs),
  }));
};

const validateSubtitleJson = (subtitleJsonPath: string): Caption[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(subtitleJsonPath, "utf8"));
  } catch {
    throw new Error(`Subtitle JSON is not valid JSON: ${subtitleJsonPath}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Invalid subtitle JSON format in ${subtitleJsonPath}. Expected an array of captions.`,
    );
  }

  const subtitles = parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `Invalid caption at index ${index} in ${subtitleJsonPath}. Expected an object.`,
      );
    }

    const caption = entry as Record<string, unknown>;
    if (typeof caption.text !== "string") {
      throw new Error(
        `Invalid caption.text at index ${index} in ${subtitleJsonPath}. Expected a string.`,
      );
    }
    if (!isFiniteNumber(caption.startMs)) {
      throw new Error(
        `Invalid caption.startMs at index ${index} in ${subtitleJsonPath}. Expected a number.`,
      );
    }
    if (!isFiniteNumber(caption.endMs)) {
      throw new Error(
        `Invalid caption.endMs at index ${index} in ${subtitleJsonPath}. Expected a number.`,
      );
    }
    if (caption.timestampMs !== null && !isFiniteNumber(caption.timestampMs)) {
      throw new Error(
        `Invalid caption.timestampMs at index ${index} in ${subtitleJsonPath}. Expected a number or null.`,
      );
    }
    if (!isFiniteNumber(caption.confidence)) {
      throw new Error(
        `Invalid caption.confidence at index ${index} in ${subtitleJsonPath}. Expected a number.`,
      );
    }
    if (caption.endMs < caption.startMs) {
      throw new Error(
        `Invalid caption range at index ${index} in ${subtitleJsonPath}. endMs must be >= startMs.`,
      );
    }

    return {
      text: caption.text,
      startMs: caption.startMs,
      endMs: caption.endMs,
      timestampMs: caption.timestampMs,
      confidence: caption.confidence,
    };
  });

  if (subtitles.length === 0) {
    throw new Error(`Subtitle JSON has no captions: ${subtitleJsonPath}`);
  }

  return subtitles;
};

const readSelectionMetadata = (metadataPath: string): SelectionSegment[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    throw new Error(`Selection metadata is not valid JSON: ${metadataPath}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid selection metadata format in ${metadataPath}.`);
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.segments)) {
    throw new Error(`Missing "segments" array in ${metadataPath}.`);
  }

  const segments = record.segments.map((segment, index) => {
    if (
      typeof segment !== "object" ||
      segment === null ||
      Array.isArray(segment)
    ) {
      throw new Error(`Invalid segment at index ${index} in ${metadataPath}.`);
    }

    const value = segment as Record<string, unknown>;
    if (!Number.isInteger(value.startChunkId)) {
      throw new Error(
        `Invalid segments[${index}].startChunkId in ${metadataPath}. Expected an integer.`,
      );
    }
    if (!Number.isInteger(value.endChunkId)) {
      throw new Error(
        `Invalid segments[${index}].endChunkId in ${metadataPath}. Expected an integer.`,
      );
    }
    if (!isFiniteNumber(value.startMs)) {
      throw new Error(
        `Invalid segments[${index}].startMs in ${metadataPath}. Expected a number.`,
      );
    }
    if (!isFiniteNumber(value.endMs)) {
      throw new Error(
        `Invalid segments[${index}].endMs in ${metadataPath}. Expected a number.`,
      );
    }
    if (!isFiniteNumber(value.durationSec)) {
      throw new Error(
        `Invalid segments[${index}].durationSec in ${metadataPath}. Expected a number.`,
      );
    }
    if (value.endMs <= value.startMs) {
      throw new Error(
        `Invalid segment range at index ${index} in ${metadataPath}. endMs must be > startMs.`,
      );
    }

    return {
      startChunkId: Number(value.startChunkId),
      endChunkId: Number(value.endChunkId),
      startMs: value.startMs,
      endMs: value.endMs,
      durationSec: value.durationSec,
    };
  });

  if (segments.length === 0) {
    throw new Error(`No selection segments found in ${metadataPath}.`);
  }

  return segments;
};

const readSelectionAnalysis = (metadataPath: string): SelectionAnalysis => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    throw new Error(`Selection metadata is not valid JSON: ${metadataPath}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid selection metadata format in ${metadataPath}.`);
  }

  const record = parsed as Record<string, unknown>;
  const segments = readSelectionMetadata(metadataPath);

  const normalizeScore = (value: unknown) => {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(100, value))
      : 0;
  };

  return {
    segments,
    viralityScore: normalizeScore(record.viralityScore),
    normalizedScore: normalizeScore(record.normalizedScore),
    promoPenalty: normalizeScore(record.promoPenalty),
    sponsorLikelihood: normalizeScore(record.sponsorLikelihood),
    audienceAppealScore: normalizeScore(record.audienceAppealScore),
    hook: typeof record.hook === "string" ? record.hook : "",
    reason: typeof record.reason === "string" ? record.reason : "",
  };
};

const formatSecondsForFileName = (seconds: number) => {
  const rounded = Number(seconds.toFixed(3));
  if (Number.isInteger(rounded)) {
    return `${rounded}`;
  }

  return `${rounded}`.replace(".", "_");
};

const runCreateSubtitles = (videoPath: string, outputPath: string) => {
  run("bun", ["run", "create-subtitles", videoPath, outputPath]);
};

const runCreateShort = (
  subtitlePath: string,
  minSeconds: number,
  targetSeconds: number,
  maxSeconds: number,
  skipStartSeconds: number,
  maxIterations: number,
  modelArg: string | null,
  tag: string,
  excludeRanges: Array<{ start: number; end: number }>,
  excludeTimeRanges: Array<{ startSec: number; endSec: number }>,
) => {
  const args = [
    "run",
    "create-short",
    subtitlePath,
    "--min-seconds",
    `${minSeconds}`,
    "--target-seconds",
    `${targetSeconds}`,
    "--max-seconds",
    `${maxSeconds}`,
    "--skip-start-seconds",
    `${skipStartSeconds}`,
    "--max-iterations",
    `${maxIterations}`,
    "--tag",
    tag,
  ];

  if (modelArg) {
    args.push("--model", modelArg);
  }

  if (excludeRanges.length > 0) {
    const rawRanges = excludeRanges
      .map((range) => `${range.start}-${range.end}`)
      .join(",");
    args.push("--exclude-chunks", rawRanges);
  }

  if (excludeTimeRanges.length > 0) {
    const rawTimeRanges = excludeTimeRanges
      .map((range) => `${range.startSec.toFixed(3)}-${range.endSec.toFixed(3)}`)
      .join(",");
    args.push("--exclude-time-ranges", rawTimeRanges);
  }

  run("bun", args);
};

const toExcludeChunkRanges = (usedSegments: SelectionSegment[]) => {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const segment of usedSegments) {
    ranges.push({
      start: Math.max(0, segment.startChunkId - 2),
      end: Math.max(segment.startChunkId, segment.endChunkId + 2),
    });
  }
  return ranges;
};

const toExcludeTimeRanges = (
  usedSegments: SelectionSegment[],
  bufferSeconds: number,
) => {
  const ranges: Array<{ startSec: number; endSec: number }> = [];
  for (const segment of usedSegments) {
    const startSec = Math.max(0, segment.startMs / 1000 - bufferSeconds);
    const endSec = segment.endMs / 1000 + bufferSeconds;
    ranges.push({ startSec, endSec });
  }
  return ranges;
};

const saveFramingPlan = (
  outDir: string,
  clipBaseName: string,
  plan: FramingPlan,
) => {
  const planPath = path.join(outDir, `${clipBaseName}.framing.json`);
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  return planPath;
};

const createSegmentClips = (
  inputVideoPath: string,
  segments: SelectionSegment[],
  tempDir: string,
  baseTag: string,
) => {
  const segmentFiles: string[] = [];

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const durationMs = segment.endMs - segment.startMs;
    if (durationMs <= 0) {
      throw new Error(`Selection segment ${index} has invalid duration.`);
    }

    const segmentFilePath = path.join(
      tempDir,
      `${baseTag}-segment-${String(index + 1).padStart(2, "0")}.mp4`,
    );

    run("bunx", [
      "remotion",
      "ffmpeg",
      "-y",
      "-i",
      inputVideoPath,
      "-ss",
      (segment.startMs / 1000).toFixed(3),
      "-t",
      (durationMs / 1000).toFixed(3),
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-movflags",
      "+faststart",
      segmentFilePath,
    ]);

    segmentFiles.push(segmentFilePath);
  }

  return segmentFiles;
};

const joinSegmentClips = (
  segmentFiles: string[],
  outputVideoPath: string,
  baseTag: string,
) => {
  if (segmentFiles.length === 1) {
    run("bunx", [
      "remotion",
      "ffmpeg",
      "-y",
      "-i",
      segmentFiles[0],
      "-c",
      "copy",
      outputVideoPath,
    ]);
    return;
  }

  const listFilePath = path.join(
    path.dirname(outputVideoPath),
    `${baseTag}-concat-list.txt`,
  );
  const listContent = segmentFiles
    .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
    .join("\n");
  writeFileSync(listFilePath, `${listContent}\n`);

  run("bunx", [
    "remotion",
    "ffmpeg",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFilePath,
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-movflags",
    "+faststart",
    outputVideoPath,
  ]);
};

const runAddSubtitles = (
  videoPath: string,
  subtitlePath: string,
  subtitleColorArg: string | null,
  subtitlePreset: string | null,
) => {
  const args = [
    "run",
    "add-subtitle-to-video",
    videoPath,
    "--subtitle",
    subtitlePath,
    "--no-clean-public",
  ];
  if (subtitleColorArg) {
    args.push("--subtitle-color", subtitleColorArg);
  }
  if (subtitlePreset) {
    args.push("--subtitle-preset", subtitlePreset);
  }

  run("bun", args);

  const captionedPath = path.join(
    process.cwd(),
    "out",
    `${path.basename(videoPath, path.extname(videoPath))}-captioned.mp4`,
  );

  return captionedPath;
};

const safeOutroPath = () => {
  if (!DEFAULT_OUTRO) return null;
  const full = path.resolve(process.cwd(), DEFAULT_OUTRO);
  if (!existsSync(full)) return null;
  const stat = lstatSync(full);
  if (stat.isDirectory()) return null;
  return full;
};

const normalizeOutroToClip = (clipPath: string, outroPath: string) => {
  const clipDims = getVideoDimensions(clipPath);
  const outroDims = getVideoDimensions(outroPath);

  if (!clipDims || !outroDims) return outroPath;
  if (clipDims.width === outroDims.width && clipDims.height === outroDims.height) {
    return outroPath;
  }

  const adjustedOutro = path.join(
    path.dirname(clipPath),
    `outro_${clipDims.width}x${clipDims.height}_${Date.now().toString(36)}.mp4`,
  );

  const scalePad = `scale=${clipDims.width}:${clipDims.height}:force_original_aspect_ratio=decrease,pad=${clipDims.width}:${clipDims.height}:(ow-iw)/2:(oh-ih)/2:black`;

  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-i",
    outroPath,
    "-vf",
    scalePad,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    adjustedOutro,
  ]);

  return adjustedOutro;
};

const concatWithOutro = (captionedClipPath: string, rawClipPath: string) => {
  const outro = safeOutroPath();
  if (!outro) return captionedClipPath;

  const finalOutputPath = rawClipPath.replace(/\.mp4$/, "-final.mp4");

  console.log("Concatenating outro...");
  console.log(`- Raw clip: ${rawClipPath}`);
  console.log(`- Captioned clip: ${captionedClipPath}`);
  console.log(`- Outro: ${outro}`);
  console.log(`- Final output: ${finalOutputPath}`);

  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-i",
    captionedClipPath,
    "-i",
    outro,
    "-filter_complex",
    "[0:v]fps=30,format=yuv420p,scale=1080:1920[v0];[1:v]fps=30,format=yuv420p,scale=1080:1920[v1];[v0][v1]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    finalOutputPath,
  ]);

  return finalOutputPath;
};

const ensureOpenAi = () => {
  const baseUrl = process.env.OPENAI_BASE_URL ?? "http://localhost:3000";
  const apiKey = process.env.OPENAI_API_KEY ?? null;
  const model =
    process.env.OPENAI_SHORT_MODEL ??
    process.env.OPENAI_MODEL ??
    METADATA_MODEL_DEFAULT;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid OPENAI_BASE_URL: ${baseUrl}`);
  }

  const endpoint = new URL("/v1/chat/completions", parsed).toString();
  return { endpoint, apiKey, model };
};

const loadCaptionsText = (subtitlePath: string) => {
  const captions = validateSubtitleJson(subtitlePath);
  const merged = captions
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return merged.slice(0, 8000); // safety cap
};

const requestClipMetadata = async (
  transcript: string,
  clipIndex: number,
  totalClips: number,
  durationMs: number,
) : Promise<ClipMetadataResult> => {
  const { endpoint, apiKey, model } = ensureOpenAi();

  const prompt = [
    "Eres un estratega de contenido corto (TikTok/Shorts) en español.",
    "Genera metadatos atractivos y distintos para este clip (no repitas entre clips).",
    `Número de clip: ${clipIndex} de ${totalClips} | Duración: ${(durationMs / 1000).toFixed(1)}s`,
    "Texto transcrito del clip:",
    transcript,
    "Devuelve solo JSON con: title, hook, description, hashtags (array de 3-6, en español, minúsculas, sin espacios, formato #ejemplo).",
    "title: hasta 70 caracteres; hook: 1 frase corta; description: tono natural TikTok, con llamada a comentar/seguir; hashtags: sin duplicar.",
  ].join("\n\n");

  const body = {
    model,
    temperature: 0.6,
    max_completion_tokens: 300,
    messages: [
      { role: "system", content: "Eres un generador de metadatos en español para videos cortos." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  } satisfies Record<string, unknown>;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Metadata request failed (${resp.status}): ${text}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Metadata response not JSON: ${text}`);
  }

  const content = parsed as { choices?: Array<{ message?: { content?: string } }>; };
  const choice = content.choices?.[0]?.message?.content;
  if (!choice || typeof choice !== "string") {
    throw new Error("Metadata response missing content.");
  }

  let meta: unknown;
  try {
    meta = JSON.parse(choice);
  } catch {
    throw new Error("Metadata content is not valid JSON.");
  }

  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new Error("Metadata JSON must be an object.");
  }

  const record = meta as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const hook = typeof record.hook === "string" ? record.hook.trim() : title;
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  const hashtagsRaw = Array.isArray(record.hashtags)
    ? record.hashtags.filter((x) => typeof x === "string").map((x) => x.trim())
    : [];

  const hashtags = hashtagsRaw
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .filter((tag) => /^#[\p{L}0-9_]+$/u.test(tag))
    .slice(0, 6);

  return {
    title: title || hook || "Clip destacado",
    hook: hook || title || "",
    description: description || "Comparte si te gustó",
    hashtags: hashtags.length > 0 ? hashtags : ["#parati", "#viral"],
    metadataSource: "model",
    metadataError: null,
  } satisfies ClipMetadataResult;
};

const buildFallbackClipMetadata = (
  clipIndex: number,
  selectionMeta: SelectionAnalysis,
  error: unknown,
): ClipMetadataResult => {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const compactError = rawMessage.replace(/\s+/g, " ").trim().slice(0, 180);
  const fallbackHook =
    selectionMeta.hook && selectionMeta.hook.trim().length > 0
      ? selectionMeta.hook.trim()
      : `Momento destacado #${clipIndex}`;

  return {
    title: `Clip viral #${clipIndex}`,
    hook: fallbackHook,
    description: "",
    hashtags: ["#parati", "#viral", "#clips"],
    metadataSource: "fallback",
    metadataError: compactError || "metadata request failed",
  };
};

const main = async () => {
  const {
    urlArg,
    minSeconds,
    targetSeconds,
    maxSeconds,
    skipStartSeconds,
    diversityBufferSeconds,
    modelArg,
    maxIterations,
    subtitleColorArg,
    count,
    fastMode,
    subtitlePreset,
  } =
    parseArgs(process.argv.slice(2));

  const { outDir, publicDir, outputDir } = ensureOutputDirs();
  const baseTag = `urlshort-${hashUrl(urlArg)}-${Date.now().toString(36)}`;
  const tempDir = path.join(outDir, `${baseTag}-temp`);
  mkdirSync(tempDir, { recursive: true });

  let analysisVideo = "";
  let masterVideo = "";

  try {
    const sourceSubtitlePath = path.join(outDir, `${hashUrl(urlArg)}.analysis.json`);

    console.log(`Preparando videos para YouTube -> ${urlArg}${fastMode ? " (modo rápido)" : ""}`);
    const resolvedVideos = resolveAnalysisAndMasterVideos(
      urlArg,
      outDir,
      tempDir,
      fastMode,
    );
    analysisVideo = resolvedVideos.analysisVideo;
    masterVideo = resolvedVideos.masterVideo;
    ensureMediaFile(analysisVideo);
    if (existsSync(masterVideo)) {
      ensureVideoFile(masterVideo);
    }

    console.log("Generando/transcribiendo subtítulos...");
    if (!existsSync(sourceSubtitlePath)) {
      runCreateSubtitles(analysisVideo, sourceSubtitlePath);
    } else {
      console.log(`Reutilizando transcripción cacheada: ${sourceSubtitlePath}`);
    }

    validateSubtitleJson(sourceSubtitlePath);

    const clips: Array<{ video: string; subtitle: string; metadata: SelectionSegment[] }> = [];
    const clipsMetadata: ClipMetadata[] = [];
    const usedSelectionSegments: SelectionSegment[] = [];
    const framingSummaries: ClipFramingMetadata[] = [];

    const secondsLabel = formatSecondsForFileName(targetSeconds);
    const inputBaseName = path.basename(sourceSubtitlePath, ".json");

    for (let clipIndex = 1; clipIndex <= count; clipIndex++) {
      const tag = `c${String(clipIndex).padStart(2, "0")}`;
      console.log(`Seleccionando segmentos para clip ${clipIndex}/${count}...`);
      const excludeRanges = toExcludeChunkRanges(usedSelectionSegments);
      const excludeTimeRanges = toExcludeTimeRanges(
        usedSelectionSegments,
        diversityBufferSeconds,
      );
      runCreateShort(
        sourceSubtitlePath,
        minSeconds,
        targetSeconds,
        maxSeconds,
        skipStartSeconds,
        maxIterations,
        modelArg,
        tag,
        excludeRanges,
        excludeTimeRanges,
      );

      const selectedSubtitlePath = path.join(
        publicDir,
        `${inputBaseName}_${secondsLabel}${tag ? `_${tag}` : ""}s.json`,
      );
      const selectionMetadataPath = path.join(
        outDir,
        `${inputBaseName}_${secondsLabel}${tag ? `_${tag}` : ""}s.selection.json`,
      );

      if (!existsSync(selectedSubtitlePath)) {
        throw new Error(
          `Selected subtitle JSON was not created: ${selectedSubtitlePath}`,
        );
      }

      if (!existsSync(selectionMetadataPath)) {
        throw new Error(
          `Short selection metadata was not created: ${selectionMetadataPath}`,
        );
      }

      validateSubtitleJson(selectedSubtitlePath);
      const selectedSegments = readSelectionMetadata(selectionMetadataPath);
      const firstSegmentStartSec = selectedSegments[0].startMs / 1000;
      const lastSegmentEndSec = selectedSegments[selectedSegments.length - 1].endMs / 1000;
      const sectionStartSec = Math.max(0, firstSegmentStartSec - 3);
      const sectionEndSec = Math.max(sectionStartSec + 5, lastSegmentEndSec + 3);

      let segmentSourceVideoPath = masterVideo;
      if (!existsSync(masterVideo)) {
        console.log(`Descargando solo sección HD para clip ${clipIndex}...`);
        segmentSourceVideoPath = downloadYoutubeVideoSection(
          urlArg,
          tempDir,
          sectionStartSec,
          sectionEndSec,
          `c${String(clipIndex).padStart(2, "0")}`,
        );
        ensureVideoFile(segmentSourceVideoPath);
      }

      const localSegments = shiftSegmentsToLocalTimeline(
        selectedSegments,
        Math.round(sectionStartSec * 1000),
      );

      const clipTempDir = path.join(tempDir, `${baseTag}-clip-${clipIndex}`);
      mkdirSync(clipTempDir, { recursive: true });

      const segmentFiles = createSegmentClips(
        segmentSourceVideoPath,
        localSegments,
        clipTempDir,
        `${baseTag}-c${clipIndex}`,
      );
      const joinedSegmentsPath = path.join(
        clipTempDir,
        `${inputBaseName}_${secondsLabel}_c${clipIndex}.mp4`,
      );
      joinSegmentClips(segmentFiles, joinedSegmentsPath, `${baseTag}-c${clipIndex}`);

      const clipFileBase = `${inputBaseName}_${secondsLabel}_c${clipIndex}`;
      const framingPlan = analyzeFramingPlan(
        joinedSegmentsPath,
        TARGET_WIDTH,
        TARGET_HEIGHT,
        selectedSubtitlePath,
      );
      const framingPlanPath = saveFramingPlan(outDir, clipFileBase, framingPlan);
      const cropFilter = framingPlanToFilter(framingPlan);
      console.log(
        `[framing] clip=${clipIndex} mode=${framingPlan.mode} layout=${framingPlan.layoutType} keyframes=${framingPlan.keyframes.length} fallback=${framingPlan.fallback} filter=${cropFilter}`,
      );
      if (framingPlan.fallback) {
        console.warn(
          `[framing] clip=${clipIndex} using fallback framing (mode=${framingPlan.mode}) – check detection logs`,
        );
      }
      framingSummaries.push({
        clipNumber: clipIndex,
        mode: framingPlan.mode,
        cropWidth: framingPlan.cropWidth,
        dominantTrack: framingPlan.dominantTrack,
        fallback: framingPlan.fallback,
        confidence: framingPlan.confidence,
        keyframesCount: framingPlan.keyframes.length,
      });
      console.log(
        `Framing plan clip ${clipIndex}: mode=${framingPlan.mode} confidence=${framingPlan.confidence.toFixed(2)} keyframes=${framingPlan.keyframes.length} dominantTrack=${framingPlan.dominantTrack ?? "none"} fallback=${framingPlan.fallback} plan=${framingPlanPath}`,
      );

      const finalClipPath = path.join(
        outputDir,
        `clip_${String(clipIndex).padStart(2, "0")}.mp4`,
      );

      run("bunx", [
        "remotion",
        "ffmpeg",
        "-y",
        "-i",
        joinedSegmentsPath,
        "-vf",
        cropFilter,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "21",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        finalClipPath,
      ]);

      const clipSubtitlePath = path.join(
        outputDir,
        `clip_${String(clipIndex).padStart(2, "0")}.json`,
      );
      console.log(`Re-generando subtítulos para el clip ${clipIndex}...`);
      runCreateSubtitles(finalClipPath, clipSubtitlePath);
      validateSubtitleJson(clipSubtitlePath);

      console.log(`Quemando subtítulos en clip ${clipIndex}...`);
      const captionedClipPath = runAddSubtitles(finalClipPath, clipSubtitlePath, subtitleColorArg, subtitlePreset);

      // Concatenar outro si existe usando el clip con subtítulos
      const deliveredPath = concatWithOutro(captionedClipPath, finalClipPath);

      const selectionMeta = readSelectionAnalysis(selectionMetadataPath);
      usedSelectionSegments.push(...selectionMeta.segments);

      const firstSegment = selectionMeta.segments[0];
      const lastSegment = selectionMeta.segments[selectionMeta.segments.length - 1];
      const durationMs = lastSegment.endMs - firstSegment.startMs;

      const transcript = loadCaptionsText(clipSubtitlePath);
      let clipMeta: ClipMetadataResult;
      try {
        clipMeta = await requestClipMetadata(
          transcript,
          clipIndex,
          count,
          durationMs,
        );
      } catch (error) {
        clipMeta = buildFallbackClipMetadata(clipIndex, selectionMeta, error);
        console.warn(
          `Metadata fallback for clip ${clipIndex}: ${clipMeta.metadataError ?? "unknown error"}`,
        );
      }

      clips.push({
        video: deliveredPath,
        subtitle: clipSubtitlePath,
        metadata: selectionMeta.segments,
      });

      clipsMetadata.push({
        clipNumber: clipIndex,
        title: clipMeta.title,
        hook: clipMeta.hook,
        description: clipMeta.description,
        hashtags: clipMeta.hashtags,
        metadataSource: clipMeta.metadataSource,
        metadataError: clipMeta.metadataError,
        startMs: firstSegment.startMs,
        endMs: lastSegment.endMs,
        durationMs,
        viralityScore: selectionMeta.viralityScore,
        normalizedScore: selectionMeta.normalizedScore,
        promoPenalty: selectionMeta.promoPenalty,
        sponsorLikelihood: selectionMeta.sponsorLikelihood,
        audienceAppealScore: selectionMeta.audienceAppealScore,
      });

      console.log(
        `clip_${String(clipIndex).padStart(2, "0")}: crop=${framingPlan.mode} confidence=${framingPlan.confidence.toFixed(2)} score=${selectionMeta.normalizedScore.toFixed(2)} promoPenalty=${selectionMeta.promoPenalty.toFixed(2)} sponsor=${selectionMeta.sponsorLikelihood.toFixed(2)} appeal=${selectionMeta.audienceAppealScore.toFixed(2)} metadata=${clipMeta.metadataSource}`,
      );
    }

    const metadataPath = path.join(outputDir, "clips_metadata.json");
    writeFileSync(metadataPath, JSON.stringify({ clips: clipsMetadata }, null, 2));
    const framingPath = path.join(outputDir, "clips_framing.json");
    writeFileSync(framingPath, JSON.stringify({ clips: framingSummaries }, null, 2));

    console.log("Listo. Clips generados en output/:");
    clipsMetadata.forEach((clip) => {
      console.log(
        `clip_${String(clip.clipNumber).padStart(2, "0")}.mp4 (${clip.durationMs}ms) score=${clip.normalizedScore.toFixed(2)} virality=${clip.viralityScore.toFixed(2)} promoPenalty=${clip.promoPenalty.toFixed(2)} sponsor=${clip.sponsorLikelihood.toFixed(2)} appeal=${clip.audienceAppealScore.toFixed(2)} metadata=${clip.metadataSource}`,
      );
    });
    console.log(`Metadata: ${metadataPath}`);
    console.log(`Framing: ${framingPath}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  console.error(usage());
  process.exit(1);
});
