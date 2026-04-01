import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const SUPPORTED_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov"]);

type SubtitleCaption = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number;
};

const usage = () => {
  return "Usage: bun src/cli/add-subtitle-to-video.ts <path-to-video> [--subtitle <path-to-subtitle-json>] [--subtitle-color <hex>] [--subtitle-preset <name>] [--no-clean-public]";
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

const cleanDirectory = (directoryPath: string) => {
  rmSync(directoryPath, { recursive: true, force: true });
  mkdirSync(directoryPath, { recursive: true });
};

const isPathInside = (targetPath: string, parentPath: string) => {
  const relative = path.relative(parentPath, targetPath);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
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

const resolveSubtitleJson = (subtitleArg: string) => {
  const subtitlePath = path.resolve(process.cwd(), subtitleArg);

  if (!existsSync(subtitlePath)) {
    throw new Error(`Subtitle JSON file not found: ${subtitlePath}`);
  }

  const stat = lstatSync(subtitlePath);
  if (stat.isDirectory()) {
    throw new Error(`Expected a file but got a directory: ${subtitlePath}`);
  }

  if (path.extname(subtitlePath).toLowerCase() !== ".json") {
    throw new Error(`Subtitle file must be a .json file: ${subtitlePath}`);
  }

  return subtitlePath;
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

  return parsed.map((entry, index) => {
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
};

const parseArgs = (args: string[]) => {
  let videoArg: string | null = null;
  let subtitleArg: string | null = null;
  let subtitleColorArg: string | null = null;
  let subtitlePreset: string | null = null;
  let noCleanPublic = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--subtitle") {
      if (subtitleArg) {
        throw new Error("The --subtitle option can only be provided once.");
      }

      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --subtitle.");
      }

      subtitleArg = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--subtitle=")) {
      if (subtitleArg) {
        throw new Error("The --subtitle option can only be provided once.");
      }

      const value = arg.slice("--subtitle=".length);
      if (!value) {
        throw new Error("Missing value for --subtitle.");
      }

      subtitleArg = value;
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

    if (arg.startsWith("--")) {
      if (arg === "--no-clean-public") {
        noCleanPublic = true;
        continue;
      }
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
    subtitleArg,
    subtitleColorArg,
    subtitlePreset,
    noCleanPublic,
  };
};

const main = async () => {
  const { videoArg, subtitleArg, subtitleColorArg, subtitlePreset, noCleanPublic } = parseArgs(
    process.argv.slice(2),
  );

  const inputVideoPath = resolveInputVideo(videoArg);
  const providedSubtitlePath = subtitleArg
    ? resolveSubtitleJson(subtitleArg)
    : null;
  const fileName = path.basename(inputVideoPath);
  const fileNameWithoutExt = path.basename(
    inputVideoPath,
    path.extname(inputVideoPath),
  );

  const publicDir = path.join(process.cwd(), "public");
  const outDir = path.join(process.cwd(), "out");

  if (!noCleanPublic && isPathInside(inputVideoPath, publicDir)) {
    throw new Error(
      "Input video cannot be inside public/, because public/ is cleaned before each run.",
    );
  }

  if (!noCleanPublic && providedSubtitlePath && isPathInside(providedSubtitlePath, publicDir)) {
    throw new Error(
      "Subtitle JSON cannot be inside public/, because public/ is cleaned before each run.",
    );
  }

  if (noCleanPublic) {
    mkdirSync(publicDir, { recursive: true });
  } else {
    cleanDirectory(publicDir);
  }
  mkdirSync(outDir, { recursive: true });

  const publicVideoPath = path.join(publicDir, fileName);
  cpSync(inputVideoPath, publicVideoPath);

  const subtitleJsonPath = path.join(outDir, `${fileNameWithoutExt}.json`);
  let subtitlesCount = 0;

  if (providedSubtitlePath) {
    const validatedSubtitles = validateSubtitleJson(providedSubtitlePath);
    subtitlesCount = validatedSubtitles.length;

    if (providedSubtitlePath !== subtitleJsonPath) {
      cpSync(providedSubtitlePath, subtitleJsonPath);
    }
  } else {
    run("bun", ["run", "create-subtitles", publicVideoPath]);

    if (!existsSync(subtitleJsonPath)) {
      throw new Error(`Subtitle JSON was not created: ${subtitleJsonPath}`);
    }

    const validatedSubtitles = validateSubtitleJson(subtitleJsonPath);
    subtitlesCount = validatedSubtitles.length;
  }

  const subtitleJsonPublicPath = path.join(
    publicDir,
    `${fileNameWithoutExt}.json`,
  );
  cpSync(subtitleJsonPath, subtitleJsonPublicPath);

  const renderProps: { src: string; subtitleColor?: string; subtitlePreset?: string } = {
    src: `/public/${fileName}`,
  };
  if (subtitleColorArg) {
    renderProps.subtitleColor = subtitleColorArg;
  }
  if (subtitlePreset) {
    renderProps.subtitlePreset = subtitlePreset;
  }

  const outputVideoPath = path.join(
    outDir,
    `${fileNameWithoutExt}-captioned.mp4`,
  );
  run("bun", [
    "run",
    "render",
    "CaptionedVideo",
    outputVideoPath,
    `--props=${JSON.stringify(renderProps)}`,
  ]);

  if (noCleanPublic) {
    console.log(`Public directory preserved: ${publicDir}`);
  } else {
    console.log(`Cleaned public directory: ${publicDir}`);
  }
  if (providedSubtitlePath) {
    console.log(`Used provided subtitle JSON: ${providedSubtitlePath}`);
    if (providedSubtitlePath !== subtitleJsonPath) {
      console.log(`Copied subtitle JSON to out: ${subtitleJsonPath}`);
    }
  } else {
    console.log(`Created subtitle JSON: ${subtitleJsonPath}`);
  }
  if (subtitleColorArg) {
    console.log(`Subtitle highlight color: ${subtitleColorArg}`);
  }
  console.log(`Validated subtitle JSON captions: ${subtitlesCount}`);
  console.log(`Copied subtitle JSON: ${subtitleJsonPublicPath}`);
  console.log(`Created captioned video: ${outputVideoPath}`);
  if (subtitlePreset) {
    console.log(`Subtitle preset: ${subtitlePreset}`);
  }
};

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  console.error(usage());
  process.exit(1);
});
