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

type SubtitleCaption = {
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

const SUPPORTED_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov"]);
const DEFAULT_SECONDS = 20;
const DEFAULT_MAX_ITERATIONS = 3;
const MAX_ITERATIONS = 10;

const usage = () => {
  return "Usage: bun src/cli/short.ts <path-to-video> [--seconds <number>] [--model <name>] [--max-iterations <1-10>] [--subtitle-color <hex>]";
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

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
};

const parseArgs = (args: string[]) => {
  let videoArg: string | null = null;
  let seconds = DEFAULT_SECONDS;
  let modelArg: string | null = null;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let subtitleColorArg: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--seconds") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --seconds.");
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--seconds must be a positive number.");
      }

      seconds = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--seconds=")) {
      const rawValue = arg.slice("--seconds=".length);
      const parsed = Number(rawValue);
      if (!rawValue || !Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--seconds must be a positive number.");
      }

      seconds = parsed;
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
        throw new Error(
          "The --subtitle-color option can only be provided once.",
        );
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
        throw new Error(
          "The --subtitle-color option can only be provided once.",
        );
      }

      const value = arg.slice("--subtitle-color=".length);
      if (!value) {
        throw new Error("Missing value for --subtitle-color.");
      }

      subtitleColorArg = normalizeSubtitleColor(value);
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (videoArg) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    videoArg = arg;
  }

  if (!videoArg) {
    throw new Error(usage());
  }

  return {
    videoArg,
    seconds,
    modelArg,
    maxIterations,
    subtitleColorArg,
  };
};

const resolveInputVideo = (videoArg: string) => {
  const videoPath = path.resolve(process.cwd(), videoArg);

  if (!existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const stat = lstatSync(videoPath);
  if (stat.isDirectory()) {
    throw new Error(`Expected a file but got a directory: ${videoPath}`);
  }

  const extension = path.extname(videoPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported extension "${extension}". Use: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}`,
    );
  }

  return videoPath;
};

const formatSecondsForFileName = (seconds: number) => {
  const rounded = Number(seconds.toFixed(3));
  if (Number.isInteger(rounded)) {
    return `${rounded}`;
  }

  return `${rounded}`.replace(".", "_");
};

const validateSubtitleJson = (subtitleJsonPath: string): SubtitleCaption[] => {
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

const validateSelectionMetadata = (
  metadataPath: string,
): SelectionSegment[] => {
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

const escapeConcatFilePath = (value: string) => {
  return value.replace(/'/g, "'\\''");
};

const createSegmentClips = (
  inputVideoPath: string,
  segments: SelectionSegment[],
  tempDir: string,
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
      `segment-${String(index + 1).padStart(2, "0")}.mp4`,
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

const joinSegmentClips = (segmentFiles: string[], outputVideoPath: string) => {
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
    "concat-list.txt",
  );
  const listContent = segmentFiles
    .map((segmentPath) => `file '${escapeConcatFilePath(segmentPath)}'`)
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

const main = async () => {
  const { videoArg, seconds, modelArg, maxIterations, subtitleColorArg } =
    parseArgs(process.argv.slice(2));

  const inputVideoPath = resolveInputVideo(videoArg);
  const inputBaseName = path.basename(
    inputVideoPath,
    path.extname(inputVideoPath),
  );
  const secondsLabel = formatSecondsForFileName(seconds);

  const outDir = path.join(process.cwd(), "out");
  mkdirSync(outDir, { recursive: true });

  const sourceSubtitlePath = path.join(outDir, `${inputBaseName}.json`);
  const selectedSubtitlePath = path.join(
    process.cwd(),
    "public",
    `${inputBaseName}_${secondsLabel}s.json`,
  );
  const selectionMetadataPath = path.join(
    outDir,
    `${inputBaseName}_${secondsLabel}s.selection.json`,
  );
  const shortVideoPath = path.join(
    outDir,
    `${inputBaseName}_${secondsLabel}s.mp4`,
  );
  const shortSubtitlePath = path.join(
    outDir,
    `${inputBaseName}_${secondsLabel}s.json`,
  );

  const tempDir = path.join(
    outDir,
    `temp-short-${inputBaseName}-${Date.now().toString(36)}`,
  );
  mkdirSync(tempDir, { recursive: true });

  try {
    run("bun", ["run", "create-subtitles", inputVideoPath, sourceSubtitlePath]);

    const createShortArgs = [
      "run",
      "create-short",
      sourceSubtitlePath,
      "--seconds",
      `${seconds}`,
      "--max-iterations",
      `${maxIterations}`,
    ];

    if (modelArg) {
      createShortArgs.push("--model", modelArg);
    }

    run("bun", createShortArgs);

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
    const selectedSegments = validateSelectionMetadata(selectionMetadataPath);

    const segmentFiles = createSegmentClips(
      inputVideoPath,
      selectedSegments,
      tempDir,
    );
    const joinedSegmentsPath = path.join(
      tempDir,
      `${inputBaseName}_${secondsLabel}s.mp4`,
    );
    joinSegmentClips(segmentFiles, joinedSegmentsPath);

    run("bunx", [
      "remotion",
      "ffmpeg",
      "-y",
      "-i",
      joinedSegmentsPath,
      "-c",
      "copy",
      shortVideoPath,
    ]);

    run("bun", ["run", "create-subtitles", shortVideoPath, shortSubtitlePath]);
    validateSubtitleJson(shortSubtitlePath);

    const addSubtitleArgs = [
      "run",
      "add-subtitle-to-video",
      shortVideoPath,
      "--subtitle",
      shortSubtitlePath,
    ];
    if (subtitleColorArg) {
      addSubtitleArgs.push("--subtitle-color", subtitleColorArg);
    }

    run("bun", addSubtitleArgs);

    console.log(`Input video: ${inputVideoPath}`);
    console.log(`Source subtitles: ${sourceSubtitlePath}`);
    console.log(`Selected subtitles: ${selectedSubtitlePath}`);
    console.log(`Selection metadata: ${selectionMetadataPath}`);
    console.log(`Created short video: ${shortVideoPath}`);
    console.log(`Created short subtitles: ${shortSubtitlePath}`);
    console.log(
      `Created captioned short video: ${path.join(outDir, `${inputBaseName}_${secondsLabel}s-captioned.mp4`)}`,
    );
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
