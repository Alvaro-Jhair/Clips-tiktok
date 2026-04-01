import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  downloadWhisperModel,
  installWhisperCpp,
  toCaptions,
  transcribe,
  type Language,
  type WhisperModel,
} from "@remotion/install-whisper-cpp";

const SUPPORTED_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".mkv",
  ".mov",
  ".m4a",
  ".mp3",
  ".wav",
  ".aac",
  ".ogg",
]);

// Where to install Whisper.cpp to
const WHISPER_PATH = path.join(process.cwd(), "whisper.cpp");

// The version of Whisper.cpp to install
const WHISPER_VERSION = "1.8.3";

// Keep parity with the previous whisper-config.mjs defaults.
const WHISPER_MODEL = ((process.env.WHISPER_MODEL as
  | WhisperModel
  | undefined) ?? "medium") as WhisperModel;
const WHISPER_LANG = ((process.env.WHISPER_LANG as Language | undefined) ??
  "es") as Language;

const ensureWhisperInstallDirReady = () => {
  const expectedBinaryPath = path.join(
    WHISPER_PATH,
    "build",
    "bin",
    "whisper-cli",
  );

  if (existsSync(WHISPER_PATH) && !existsSync(expectedBinaryPath)) {
    rmSync(WHISPER_PATH, { recursive: true, force: true });
  }
};

const extractToTempAudioFile = (videoFilePath: string, tempOutFile: string) => {
  execSync(
    `bunx remotion ffmpeg -i "${videoFilePath}" -ar 16000 "${tempOutFile}" -y`,
    { stdio: "inherit" },
  );
};

const ensureInputFile = (arg: string): string => {
  const resolvedPath = path.resolve(process.cwd(), arg);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Video file not found: ${resolvedPath}`);
  }

  const stat = lstatSync(resolvedPath);
  if (stat.isDirectory()) {
    throw new Error(
      `Expected a media file, received a directory: ${resolvedPath}`,
    );
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported extension "${ext}". Use one of: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}`,
    );
  }

  return resolvedPath;
};

const main = async () => {
  const videoArg = process.argv[2];
  const outputArg = process.argv[3];
  if (!videoArg) {
    throw new Error(
      "Usage: bun src/cli/video2sub.ts <path-to-video> [output-json-path]",
    );
  }

  const videoPath = ensureInputFile(videoArg);
  const fileBaseName = path.basename(videoPath, path.extname(videoPath));

  const outDir = path.join(process.cwd(), "out");
  const tempDir = path.join(outDir, "temp");
  const tempAudioPath = path.join(tempDir, `${fileBaseName}.wav`);
  const outputPath = outputArg
    ? path.resolve(process.cwd(), outputArg)
    : path.join(outDir, `${fileBaseName}.json`);

  mkdirSync(tempDir, { recursive: true });
  mkdirSync(path.dirname(outputPath), { recursive: true });

  ensureWhisperInstallDirReady();

  console.log(`Installing whisper.cpp ${WHISPER_VERSION} in ${WHISPER_PATH}`);
  await installWhisperCpp({ to: WHISPER_PATH, version: WHISPER_VERSION });

  console.log(`Downloading Whisper model ${WHISPER_MODEL}`);
  await downloadWhisperModel({ folder: WHISPER_PATH, model: WHISPER_MODEL });

  console.log(`Extracting audio from ${videoPath}`);
  extractToTempAudioFile(videoPath, tempAudioPath);

  console.log(
    `Transcribing video with model=${WHISPER_MODEL} language=${WHISPER_LANG}`,
  );
  const whisperCppOutput = await transcribe({
    inputPath: tempAudioPath,
    model: WHISPER_MODEL,
    tokenLevelTimestamps: true,
    whisperPath: WHISPER_PATH,
    whisperCppVersion: WHISPER_VERSION,
    printOutput: false,
    translateToEnglish: false,
    language: WHISPER_LANG,
    splitOnWord: true,
  });

  const { captions } = toCaptions({ whisperCppOutput });
  writeFileSync(outputPath, JSON.stringify(captions, null, 2));

  rmSync(tempDir, { recursive: true, force: true });

  console.log(`Saved ${captions.length} captions to ${outputPath}`);
};

main().catch((err: unknown) => {
  const error = err instanceof Error ? err.message : String(err);
  console.error(error);
  process.exit(1);
});
