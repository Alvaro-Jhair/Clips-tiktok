import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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

type TranscriptChunk = {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
};

type ShortSegment = {
  startChunkId: number;
  endChunkId: number;
};

type ShortSelection = {
  segments: ShortSegment[];
  viralityScore: number;
  hook: string;
  reason: string;
  sponsorLikelihood?: number;
  audienceAppealScore?: number;
};

type EvaluatedSegment = ShortSegment & {
  startMs: number;
  endMs: number;
  durationSec: number;
};

type EvaluatedSelection = ShortSelection & {
  iteration: number;
  startMs: number;
  endMs: number;
  totalDurationSec: number;
  segmentsWithTime: EvaluatedSegment[];
  normalizedScore: number;
  promoPenalty: number;
  sponsorLikelihood: number;
  audienceAppealScore: number;
};

const DEFAULT_MIN_SECONDS = 18;
const DEFAULT_TARGET_SECONDS = 30; // hint, not a hard cap
const DEFAULT_MAX_SECONDS = 55;
const LEGACY_IDEAL_MIN = 22;
const LEGACY_IDEAL_MAX = 40;
const DEFAULT_MAX_ITERATIONS = 3;
const MAX_ITERATIONS = 10;
const DEFAULT_OPENAI_BASE_URL = "http://localhost:3000";
const DEFAULT_OPENAI_MODEL = "gpt-5-mini";

const SYSTEM_PROMPT = `Eres un editor de shorts experto para TikTok/YouTube Shorts/IG Reels, especializado en podcasts, entrevistas y comedia (ej: Hablando Huevadas, Zaca TV, Habla Good, No Somos TV, clips tipo Jay Wheeler/Mundo Rueditas).

Objetivo: seleccionar momentos virales (no resumir) que funcionen solos.

Filtro anti-publicidad estricto:
- Penaliza y evita segmentos de publicidad/sponsor/autopromoción/CTA.
- Señales a evitar: "este video llega gracias a", "patrocinado por", "usa mi código", "descuento", "link en la descripción", "suscríbete", "síguenos", "auspicia", "publicidad", "promoción".
- Si el momento parece comercial aunque tenga estructura, debe bajar fuerte el score.
- Evita inicio/final cuando sea intro, promo, despedida o cierre comercial.

Duración flexible:
- Usa los límites proporcionados: mínimo {{MIN_SECONDS}}s, ideal alrededor de {{TARGET_SECONDS}}s, máximo {{MAX_SECONDS}}s.
- Ajusta la duración al momento completo (gancho + contexto breve + remate), no recortes abrupto.

Hard constraints:
- Puedes elegir uno o varios segmentos.
- Usa startChunkId y endChunkId (inclusive).
- Orden cronológico, sin solaparse.
- Duración total entre {{MIN_SECONDS}}s y {{MAX_SECONDS}}s. Apunta al ideal (~{{TARGET_SECONDS}}s) si el remate cabe ahí; si el remate necesita más, permite hasta {{MAX_SECONDS}}s.

Qué priorizar (en orden):
1) Gancho inmediato en 1-2s: frase inesperada, pregunta incómoda, risa inicial, silencio tenso.
2) Contexto mínimo: solo lo justo para entender la situación.
3) Remate claro: risa, reacción, frase fuerte, giro, incomodidad.

Busca:
- Humor claro o reacción humana genuina.
- Frases que cambian el ambiente.
- Tensión o incomodidad breve.
- Momentos que el público general comparte/repite.

Evita:
- Conversación plana o sin payoff.
- Chistes que requieren mucho contexto externo.
- Clips que empiezan sin contexto suficiente.
- Clips que terminan abruptos.
- Relleno lento.

Normas de selección:
- Si hay varias personas, mantener coherencia (misma mini-escena) y no saltar sin transición.
- Prefiere inicios que ya traen emoción; si hay setup, que sea muy corto.
- No pases el máximo de {{MAX_SECONDS}}s; si un gran momento excede, recorta para conservar gancho y remate.

Calificación:
- viralityScore realista 0-100.
- sponsorLikelihood: 0-100 (alto = parece sponsor/publicidad/CTA).
- audienceAppealScore: 0-100 (qué tanto entretiene al público general: humor/tensión/sorpresa/momento memorable).
- Prefiere 1-3 segmentos; máximo 4.

Salida:
- Solo JSON válido según el esquema.
- Sin markdown ni texto extra.`;

const isFiniteNumber = (value: unknown): value is number => {
  return typeof value === "number" && Number.isFinite(value);
};

const usage = () => {
  return "Usage: bun src/cli/create-short.ts <subtitle-json-file> [--min-seconds <number>] [--target-seconds <number>] [--max-seconds <number>] [--skip-start-seconds <number>] [--model <name>] [--max-iterations <1-10>] [--exclude-chunks <ranges>] [--exclude-time-ranges <ranges>] [--tag <suffix>]";
};

const parseRanges = (raw: string): Array<{ start: number; end: number }> => {
  const cleaned = raw.trim();
  if (!cleaned) {
    throw new Error("--exclude-chunks must not be empty.");
  }

  const parts = cleaned.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("--exclude-chunks must include at least one range.");
  }

  return parts.map((part) => {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw new Error(
        `Invalid range "${part}". Use numbers or ranges like 5-10,12-15.`,
      );
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (end < start) {
      throw new Error(`Invalid range "${part}". end must be >= start.`);
    }
    return { start, end };
  });
};

const parseTimeRanges = (raw: string): Array<{ startSec: number; endSec: number }> => {
  const cleaned = raw.trim();
  if (!cleaned) {
    throw new Error("--exclude-time-ranges must not be empty.");
  }

  const parts = cleaned.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("--exclude-time-ranges must include at least one range.");
  }

  return parts.map((part) => {
    const match = part.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    if (!match) {
      throw new Error(
        `Invalid time range "${part}". Use format like 120-180,245.5-301.2.`,
      );
    }
    const startSec = Number(match[1]);
    const endSec = Number(match[2]);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0) {
      throw new Error(`Invalid time range "${part}". Start/end must be valid numbers >= 0.`);
    }
    if (endSec <= startSec) {
      throw new Error(`Invalid time range "${part}". end must be > start.`);
    }
    return { startSec, endSec };
  });
};

const parseTag = (raw: string) => {
  const value = raw.trim();
  if (!value) {
    throw new Error("--tag must be a non-empty string.");
  }
  if (!/^[a-zA-Z0-9_-]{1,20}$/.test(value)) {
    throw new Error(
      "--tag must be alphanumeric/underscore/dash and up to 20 chars.",
    );
  }
  return value;
};

const parseArgs = (args: string[]) => {
  let filenameArg: string | null = null;
  let minSeconds = DEFAULT_MIN_SECONDS;
  let targetSeconds = DEFAULT_TARGET_SECONDS;
  let maxSeconds = DEFAULT_MAX_SECONDS;
  let skipStartSeconds = 0;
  let modelArg: string | null = null;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let excludeRanges: Array<{ start: number; end: number }> = [];
  let excludeTimeRanges: Array<{ startSec: number; endSec: number }> = [];
  let tagArg: string | null = null;

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

    if (arg.startsWith("--max-seconds=")) {
      const rawValue = arg.slice("--max-seconds=".length);
      const parsed = Number(rawValue);
      if (!rawValue || !Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--max-seconds must be a positive number.");
      }
      maxSeconds = parsed;
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

    if (arg === "--exclude-chunks") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --exclude-chunks.");
      }

      excludeRanges = parseRanges(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--exclude-chunks=")) {
      const value = arg.slice("--exclude-chunks=".length);
      excludeRanges = parseRanges(value);
      continue;
    }

    if (arg === "--exclude-time-ranges") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --exclude-time-ranges.");
      }

      excludeTimeRanges = parseTimeRanges(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--exclude-time-ranges=")) {
      const value = arg.slice("--exclude-time-ranges=".length);
      excludeTimeRanges = parseTimeRanges(value);
      continue;
    }

    if (arg === "--tag") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --tag.");
      }

      tagArg = parseTag(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--tag=")) {
      const value = arg.slice("--tag=".length);
      tagArg = parseTag(value);
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (filenameArg) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    filenameArg = arg;
  }

  if (!filenameArg) {
    throw new Error(usage());
  }

  if (!(minSeconds > 0 && targetSeconds > 0 && maxSeconds > 0)) {
    throw new Error("Durations must be positive.");
  }
  if (minSeconds > targetSeconds) {
    throw new Error("--min-seconds must be <= --target-seconds.");
  }
  if (targetSeconds > maxSeconds) {
    throw new Error("--target-seconds must be <= --max-seconds.");
  }

  return {
    filenameArg,
    minSeconds,
    targetSeconds,
    maxSeconds,
    skipStartSeconds,
    modelArg,
    maxIterations,
    excludeRanges,
    excludeTimeRanges,
    tagArg,
  };
};

const resolveSubtitleJson = (filenameArg: string) => {
  const subtitlePath = path.resolve(process.cwd(), filenameArg);

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

  const captions = parsed.map((entry, index) => {
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

  if (captions.length === 0) {
    throw new Error(`Subtitle JSON has no captions: ${subtitleJsonPath}`);
  }

  return captions;
};

const normalizeToken = (text: string) => {
  return text.replace(/\s+/g, " ").trim();
};

const normalizeForMatch = (text: string) => {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
};

const PROMO_PHRASES = [
  "este video llega gracias a",
  "patrocinado por",
  "usa mi codigo",
  "descuento",
  "link en la descripcion",
  "suscribete",
  "siguenos",
  "auspicia",
  "publicidad",
  "promocion",
];

const CTA_HINTS = [
  "dale like",
  "comparte",
  "activa la campanita",
  "canal",
  "sígueme",
  "sigueme",
  "síganos",
  "siganos",
];

const getWordCount = (text: string) => {
  return text
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0).length;
};

const buildTranscriptChunks = (
  captions: SubtitleCaption[],
): TranscriptChunk[] => {
  const chunks: TranscriptChunk[] = [];

  let currentTextParts: string[] = [];
  let currentStartMs = 0;
  let currentEndMs = 0;
  let currentWordCount = 0;
  let hasOpenChunk = false;

  const closeChunk = () => {
    if (!hasOpenChunk) {
      return;
    }

    const text = currentTextParts.join(" ").replace(/\s+/g, " ").trim();
    if (text.length > 0) {
      chunks.push({
        id: chunks.length,
        startMs: currentStartMs,
        endMs: currentEndMs,
        text,
      });
    }

    currentTextParts = [];
    currentWordCount = 0;
    hasOpenChunk = false;
  };

  for (let index = 0; index < captions.length; index++) {
    const caption = captions[index];
    const token = normalizeToken(caption.text);
    if (token.length === 0) {
      continue;
    }

    if (!hasOpenChunk) {
      currentStartMs = caption.startMs;
      currentEndMs = caption.endMs;
      currentTextParts = [token];
      currentWordCount = getWordCount(token);
      hasOpenChunk = true;
    } else {
      currentTextParts.push(token);
      currentEndMs = caption.endMs;
      currentWordCount += getWordCount(token);
    }

    const nextCaption = captions[index + 1] ?? null;
    const gapToNext = nextCaption
      ? nextCaption.startMs - caption.endMs
      : Infinity;
    const chunkDuration = currentEndMs - currentStartMs;
    const punctuationBoundary = /[.!?]$/.test(token);
    const gapBoundary = gapToNext > 650;
    const maxDurationBoundary = chunkDuration >= 4200;
    const maxWordsBoundary = currentWordCount >= 18;

    if (
      !nextCaption ||
      punctuationBoundary ||
      gapBoundary ||
      maxDurationBoundary ||
      maxWordsBoundary
    ) {
      closeChunk();
    }
  }

  closeChunk();

  if (chunks.length === 0) {
    throw new Error(
      "Could not build transcript chunks from the subtitle file.",
    );
  }

  return chunks;
};

const formatChunksForPrompt = (chunks: TranscriptChunk[]) => {
  return chunks
    .map((chunk) => {
      return `#${chunk.id} [${chunk.startMs}-${chunk.endMs}] ${chunk.text}`;
    })
    .join("\n");
};

const buildJsonSchemaResponseFormat = () => {
  return {
    type: "json_schema",
    json_schema: {
      name: "viral_short_selection",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["segments", "viralityScore", "hook", "reason"],
        properties: {
          segments: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["startChunkId", "endChunkId"],
              properties: {
                startChunkId: { type: "integer" },
                endChunkId: { type: "integer" },
              },
            },
          },
          viralityScore: { type: "number", minimum: 0, maximum: 100 },
          sponsorLikelihood: { type: "number", minimum: 0, maximum: 100 },
          audienceAppealScore: { type: "number", minimum: 0, maximum: 100 },
          hook: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
  };
};

const extractApiErrorMessage = (raw: string) => {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string };
      message?: string;
    };
    if (parsed.error?.message) {
      return parsed.error.message;
    }
    if (parsed.message) {
      return parsed.message;
    }
  } catch {
    // noop
  }

  return raw;
};

const extractContentFromChatCompletion = (payload: unknown): string => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("Invalid OpenAI response format.");
  }

  const root = payload as Record<string, unknown>;
  if (!Array.isArray(root.choices) || root.choices.length === 0) {
    throw new Error("OpenAI response does not include choices.");
  }

  const firstChoice = root.choices[0];
  if (
    typeof firstChoice !== "object" ||
    firstChoice === null ||
    Array.isArray(firstChoice)
  ) {
    throw new Error("OpenAI response choice is invalid.");
  }

  const choice = firstChoice as Record<string, unknown>;
  const message = choice.message;
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    throw new Error("OpenAI response choice has no message.");
  }

  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (typeof part !== "object" || part === null || Array.isArray(part)) {
          return "";
        }

        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") {
          return record.text;
        }

        return "";
      })
      .filter((part) => part.length > 0);

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  throw new Error("OpenAI response has no readable message content.");
};

const stripCodeFence = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (!match) {
    return trimmed;
  }
  return match[1].trim();
};

const parseSelection = (rawContent: string): ShortSelection => {
  const json = stripCodeFence(rawContent);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Model response is not valid JSON: ${rawContent}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Model response must be a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  const segmentsRaw = record.segments;
  const startChunkId = record.startChunkId;
  const endChunkId = record.endChunkId;
  const viralityScore = record.viralityScore;
  const sponsorLikelihood = record.sponsorLikelihood;
  const audienceAppealScore = record.audienceAppealScore;
  const hook = record.hook;
  const reason = record.reason;

  const rawSegments: unknown[] = Array.isArray(segmentsRaw)
    ? segmentsRaw
    : Number.isInteger(startChunkId) && Number.isInteger(endChunkId)
      ? [{ startChunkId, endChunkId }]
      : [];

  if (rawSegments.length === 0) {
    throw new Error(
      "segments must be a non-empty array (or include legacy startChunkId/endChunkId).",
    );
  }

  const segments = rawSegments.map((segment, index) => {
    if (
      typeof segment !== "object" ||
      segment === null ||
      Array.isArray(segment)
    ) {
      throw new Error(`segments[${index}] must be an object.`);
    }

    const segmentRecord = segment as Record<string, unknown>;
    const segmentStart = segmentRecord.startChunkId;
    const segmentEnd = segmentRecord.endChunkId;

    if (!Number.isInteger(segmentStart)) {
      throw new Error(`segments[${index}].startChunkId must be an integer.`);
    }
    if (!Number.isInteger(segmentEnd)) {
      throw new Error(`segments[${index}].endChunkId must be an integer.`);
    }

    return {
      startChunkId: Number(segmentStart),
      endChunkId: Number(segmentEnd),
    };
  });

  if (!isFiniteNumber(viralityScore)) {
    throw new Error("viralityScore must be a finite number.");
  }
  if (sponsorLikelihood !== undefined && !isFiniteNumber(sponsorLikelihood)) {
    throw new Error("sponsorLikelihood must be a finite number when provided.");
  }
  if (audienceAppealScore !== undefined && !isFiniteNumber(audienceAppealScore)) {
    throw new Error("audienceAppealScore must be a finite number when provided.");
  }
  if (typeof hook !== "string" || hook.trim().length === 0) {
    throw new Error("hook must be a non-empty string.");
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error("reason must be a non-empty string.");
  }
  return {
    segments,
    viralityScore,
    sponsorLikelihood: isFiniteNumber(sponsorLikelihood)
      ? Math.max(0, Math.min(100, sponsorLikelihood))
      : undefined,
    audienceAppealScore: isFiniteNumber(audienceAppealScore)
      ? Math.max(0, Math.min(100, audienceAppealScore))
      : undefined,
    hook: hook.trim(),
    reason: reason.trim(),
  };
};

const countPhraseHits = (text: string, phrases: string[]) => {
  let hits = 0;
  for (const phrase of phrases) {
    if (text.includes(phrase)) {
      hits += 1;
    }
  }
  return hits;
};

const estimatePromoPenalty = (
  selectedTranscript: string,
  startMs: number,
  endMs: number,
  totalTimelineMs: number,
) => {
  const normalized = normalizeForMatch(selectedTranscript);
  const promoHits = countPhraseHits(normalized, PROMO_PHRASES);
  const ctaHits = countPhraseHits(normalized, CTA_HINTS);
  const textPromoScore = Math.min(100, promoHits * 22 + ctaHits * 10);

  const edgeWindowMs = Math.min(90_000, Math.max(15_000, totalTimelineMs * 0.14));
  const nearStart = startMs <= edgeWindowMs;
  const nearEnd = endMs >= Math.max(0, totalTimelineMs - edgeWindowMs);
  const edgeFactor = nearStart || nearEnd ? 1 : 0;
  const edgePromoPenalty = edgeFactor * (promoHits > 0 || ctaHits > 0 ? 28 : 0);

  const sponsorLikelihood = Math.min(
    100,
    textPromoScore + edgeFactor * (promoHits > 0 ? 22 : 8),
  );
  const promoPenalty = Math.min(100, textPromoScore + edgePromoPenalty);

  return {
    promoPenalty,
    sponsorLikelihood,
  };
};

const APPEAL_HINTS = [
  "jaj",
  "risa",
  "no puede ser",
  "increible",
  "que fuerte",
  "escucha",
  "mira",
  "bro",
  "wtf",
  "verg",
  "plot twist",
  "inesperad",
  "tenso",
  "silencio",
  "me muero",
];

const estimateAudienceAppealFromText = (text: string) => {
  const normalized = normalizeForMatch(text);
  const hits = countPhraseHits(normalized, APPEAL_HINTS);
  const questionBangs = (normalized.match(/[!?]/g) ?? []).length;
  const density = Math.min(1, normalized.length / 500);
  const base = hits * 10 + questionBangs * 1.2 + density * 18;
  return Math.max(5, Math.min(90, base));
};

const buildHeuristicSelection = (
  chunks: TranscriptChunk[],
  minSeconds: number,
  targetSeconds: number,
  maxSeconds: number,
  skipStartSeconds: number,
  excludeRanges: Array<{ start: number; end: number }>,
  excludeTimeRanges: Array<{ startSec: number; endSec: number }>,
): ShortSelection => {
  const totalMs = chunks[chunks.length - 1]?.endMs ?? 0;
  let bestCandidate:
    | {
        startChunkId: number;
        endChunkId: number;
        score: number;
        virality: number;
        sponsorLikelihood: number;
        appeal: number;
      }
    | null = null;

  for (let start = 0; start < chunks.length; start++) {
    let end = start;
    while (end < chunks.length) {
      const startMs = chunks[start].startMs;
      const endMs = chunks[end].endMs;
      const durationSec = (endMs - startMs) / 1000;
      if (startMs < skipStartSeconds * 1000) {
        end += 1;
        continue;
      }
      if (durationSec > maxSeconds) break;

      if (durationSec >= minSeconds) {
        const overlapsExcluded = excludeRanges.some((range) => {
          return start <= range.end && end >= range.start;
        });
        if (overlapsExcluded) {
          end += 1;
          continue;
        }

        const overlapsExcludedTime = excludeTimeRanges.some((range) => {
          const rangeStartMs = range.startSec * 1000;
          const rangeEndMs = range.endSec * 1000;
          return startMs < rangeEndMs && endMs > rangeStartMs;
        });
        if (overlapsExcludedTime) {
          end += 1;
          continue;
        }

        const transcript = chunks
          .slice(start, end + 1)
          .map((chunk) => chunk.text)
          .join(" ");
        const promo = estimatePromoPenalty(transcript, startMs, endMs, totalMs);
        const appeal = estimateAudienceAppealFromText(transcript);
        const durationDistance = Math.abs(durationSec - targetSeconds);
        const durationFit = Math.max(0, 14 - durationDistance * 0.7);
        const virality = Math.max(0, Math.min(100, appeal + durationFit - promo.promoPenalty * 0.35));
        const score = virality - promo.promoPenalty * 0.55 - promo.sponsorLikelihood * 0.45;

        if (!bestCandidate || score > bestCandidate.score) {
          bestCandidate = {
            startChunkId: start,
            endChunkId: end,
            score,
            virality,
            sponsorLikelihood: promo.sponsorLikelihood,
            appeal,
          };
        }
      }

      end += 1;
    }
  }

  if (!bestCandidate) {
    const defaultEnd = Math.min(chunks.length - 1, 2);
    return {
      segments: [{ startChunkId: 0, endChunkId: defaultEnd }],
      viralityScore: 25,
      sponsorLikelihood: 35,
      audienceAppealScore: 25,
      hook: "Selección heurística de respaldo",
      reason: "Fallback local por fallo del modelo o respuesta inválida.",
    };
  }

  return {
    segments: [
      {
        startChunkId: bestCandidate.startChunkId,
        endChunkId: bestCandidate.endChunkId,
      },
    ],
    viralityScore: Math.max(0, Math.min(100, bestCandidate.virality)),
    sponsorLikelihood: Math.max(0, Math.min(100, bestCandidate.sponsorLikelihood)),
    audienceAppealScore: Math.max(0, Math.min(100, bestCandidate.appeal)),
    hook: "Momento elegido por criterio anti-promo",
    reason: "Fallback heurístico priorizando appeal y penalizando sponsor/CTA.",
  };
};

const evaluateSelection = (
  selection: ShortSelection,
  chunks: TranscriptChunk[],
  minSeconds: number,
  targetSeconds: number,
  maxSeconds: number,
  skipStartSeconds: number,
  excludeTimeRanges: Array<{ startSec: number; endSec: number }>,
  iteration: number,
): EvaluatedSelection => {
  if (selection.segments.length === 0) {
    throw new Error("At least one segment is required.");
  }

  if (selection.segments.length > 4) {
    throw new Error("A maximum of 4 segments is allowed.");
  }

  const segmentsWithTime: EvaluatedSegment[] = [];
  let previousEndChunkId = -1;
  let totalDurationMs = 0;

  for (let index = 0; index < selection.segments.length; index++) {
    const segment = selection.segments[index];
    if (segment.startChunkId < 0 || segment.startChunkId >= chunks.length) {
      throw new Error(
        `segments[${index}].startChunkId ${segment.startChunkId} is out of bounds for ${chunks.length} chunks.`,
      );
    }

    if (segment.endChunkId < 0 || segment.endChunkId >= chunks.length) {
      throw new Error(
        `segments[${index}].endChunkId ${segment.endChunkId} is out of bounds for ${chunks.length} chunks.`,
      );
    }

    if (segment.endChunkId < segment.startChunkId) {
      throw new Error(`segments[${index}] has endChunkId < startChunkId.`);
    }

    if (segment.startChunkId <= previousEndChunkId) {
      throw new Error(
        "Segments must be in chronological order and must not overlap.",
      );
    }

    const startMs = chunks[segment.startChunkId].startMs;
    const endMs = chunks[segment.endChunkId].endMs;
    if (endMs <= startMs) {
      throw new Error(`segments[${index}] has invalid timestamps.`);
    }

    const durationMs = endMs - startMs;
    totalDurationMs += durationMs;
    previousEndChunkId = segment.endChunkId;

    segmentsWithTime.push({
      ...segment,
      startMs,
      endMs,
      durationSec: durationMs / 1000,
    });
  }

  const totalDurationSec = totalDurationMs / 1000;
  if (totalDurationSec < minSeconds || totalDurationSec > maxSeconds) {
    throw new Error(
      `Selected combined duration ${totalDurationSec.toFixed(2)}s is out of allowed range ${minSeconds}-${maxSeconds}s.`,
    );
  }

  const boundedViralityScore = Math.max(0, Math.min(100, selection.viralityScore));
  const inferredAppeal = Math.max(
    0,
    Math.min(
      100,
      typeof selection.audienceAppealScore === "number"
        ? selection.audienceAppealScore
        : boundedViralityScore,
    ),
  );
  const idealCenter = targetSeconds;
  const span = Math.max(5, targetSeconds * 0.4);
  const distance = Math.abs(totalDurationSec - idealCenter);
  const durationBonus = Math.max(0, 8 - Math.min(8, (distance / span) * 8));
  const firstSegment = segmentsWithTime[0];
  const lastSegment = segmentsWithTime[segmentsWithTime.length - 1];

  if (firstSegment.startMs < skipStartSeconds * 1000) {
    throw new Error(
      `Selected segment starts at ${(firstSegment.startMs / 1000).toFixed(2)}s, before --skip-start-seconds=${skipStartSeconds}s.`,
    );
  }

  const overlapsExcludedTime = excludeTimeRanges.some((range) => {
    const rangeStartMs = range.startSec * 1000;
    const rangeEndMs = range.endSec * 1000;
    return firstSegment.startMs < rangeEndMs && lastSegment.endMs > rangeStartMs;
  });
  if (overlapsExcludedTime) {
    throw new Error("Selection overlaps excluded timeline ranges.");
  }

  const selectedTranscript = segmentsWithTime
    .map((segment) => {
      return chunks
        .slice(segment.startChunkId, segment.endChunkId + 1)
        .map((chunk) => chunk.text)
        .join(" ");
    })
    .join(" ")
    .trim();
  const timelineMs = chunks[chunks.length - 1]?.endMs ?? lastSegment.endMs;
  const promoEstimation = estimatePromoPenalty(
    selectedTranscript,
    firstSegment.startMs,
    lastSegment.endMs,
    timelineMs,
  );
  const sponsorLikelihood = Math.max(
    promoEstimation.sponsorLikelihood,
    Math.max(0, Math.min(100, selection.sponsorLikelihood ?? 0)),
  );
  const promoPenalty = Math.max(promoEstimation.promoPenalty, sponsorLikelihood * 0.7);

  const segmentCountPenalty = Math.max(0, (segmentsWithTime.length - 2) * 3);
  const similarityPenalty = excludeTimeRanges.reduce((acc, range) => {
    const centerMs = (firstSegment.startMs + lastSegment.endMs) / 2;
    const rangeCenterMs = ((range.startSec + range.endSec) / 2) * 1000;
    const deltaSec = Math.abs(centerMs - rangeCenterMs) / 1000;
    if (deltaSec >= 40) return acc;
    return acc + Math.max(0, 14 - deltaSec * 0.35);
  }, 0);
  const promoHardPenalty = promoPenalty * 0.62 + sponsorLikelihood * 0.38;
  const qualityBase = boundedViralityScore * 0.28 + inferredAppeal * 0.72;
  const normalizedScore = Math.max(
    0,
    Math.min(
      100,
      qualityBase + durationBonus - segmentCountPenalty - similarityPenalty - promoHardPenalty,
    ),
  );

  return {
    ...selection,
    iteration,
    startMs: firstSegment.startMs,
    endMs: lastSegment.endMs,
    totalDurationSec,
    segmentsWithTime,
    normalizedScore,
    promoPenalty,
    sponsorLikelihood,
    audienceAppealScore: inferredAppeal,
  };
};

const formatSelectionSegments = (segments: ShortSegment[]) => {
  return segments
    .map((segment) => `${segment.startChunkId}-${segment.endChunkId}`)
    .join(", ");
};

const buildUserPrompt = (
  chunksPrompt: string,
  minSeconds: number,
  targetSeconds: number,
  maxSeconds: number,
  skipStartSeconds: number,
  best: EvaluatedSelection | null,
  feedback: string,
  excludeRanges: Array<{ start: number; end: number }>,
  excludeTimeRanges: Array<{ startSec: number; endSec: number }>,
) => {
  const bestSnapshot = best
    ? `Current best: segments [${formatSelectionSegments(best.segments)}], combinedDuration ${best.totalDurationSec.toFixed(2)}s, normalizedScore ${best.normalizedScore.toFixed(2)}, viralityScore ${best.viralityScore.toFixed(2)}, hook "${best.hook}"`
    : "Current best: none yet.";

  const excludeNote =
    excludeRanges.length === 0
      ? "No excluded chunks."
      : `Do NOT use any chunk ids inside these ranges (inclusive): ${excludeRanges
          .map((range) => `${range.start}-${range.end}`)
          .join(", ")}. If unavoidable, pick different segments.`;

  const skipStartNote =
    skipStartSeconds > 0
      ? `Hard constraint: do not use any content before ${skipStartSeconds}s from the video start.`
      : "No skip-start restriction.";

  const excludeTimeNote =
    excludeTimeRanges.length === 0
      ? "No excluded timeline ranges."
      : `Do NOT use timeline ranges (seconds, inclusive overlap forbidden): ${excludeTimeRanges
          .map((range) => `${range.startSec.toFixed(3)}-${range.endSec.toFixed(3)}`)
          .join(", ")}.`;

  return [
    `duration_bounds: min=${minSeconds}s target≈${targetSeconds}s max=${maxSeconds}s (ajusta al momento completo, evita cortes abruptos)`,
    "Hard anti-promo: evita sponsor/publicidad/autopromoción/CTA. Penaliza muy fuerte frases como: este video llega gracias a, patrocinado por, usa mi código, descuento, link en la descripción, suscríbete, síguenos, auspicia, publicidad, promoción.",
    "Si el segmento suena a comercial aunque esté bien armado, NO lo selecciones.",
    "Evita inicio/final del video cuando sean intro, despedida o cierre promocional.",
    skipStartNote,
    excludeTimeNote,
    bestSnapshot,
    excludeNote,
    `Feedback from previous attempt: ${feedback}`,
    "Return only JSON that matches the schema.",
    "Transcript chunks:",
    chunksPrompt,
  ].join("\n\n");
};

const createCompletion = async (
  endpoint: string,
  apiKey: string | null,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  useJsonSchema: boolean,
) => {
  const requestBody: Record<string, unknown> = {
    model,
    temperature: 0.2,
    max_completion_tokens: 500,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };

  if (useJsonSchema) {
    requestBody.response_format = buildJsonSchemaResponseFormat();
  } else {
    requestBody.response_format = {
      type: "json_object",
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenAI API request failed (${response.status}): ${extractApiErrorMessage(rawBody)}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Error(`OpenAI API returned non-JSON response: ${rawBody}`);
  }

  return extractContentFromChatCompletion(payload);
};

const requestSelectionFromOpenAi = async (
  endpoint: string,
  apiKey: string | null,
  model: string,
  systemPrompt: string,
  userPrompt: string,
) => {
  try {
    return await createCompletion(
      endpoint,
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      true,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const schemaLikelyUnsupported =
      message.includes("json_schema") ||
      message.includes("response_format") ||
      message.includes("Unsupported value");

    if (!schemaLikelyUnsupported) {
      throw error;
    }

    return createCompletion(
      endpoint,
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      false,
    );
  }
};

const formatSecondsForFileName = (seconds: number) => {
  const rounded = Number(seconds.toFixed(3));
  if (Number.isInteger(rounded)) {
    return `${rounded}`;
  }

  return `${rounded}`.replace(".", "_");
};

const ensureOpenAiEndpoint = (modelArg: string | null) => {
  const baseUrlRaw = process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(baseUrlRaw);
  } catch {
    throw new Error(`Invalid OPENAI_BASE_URL: ${baseUrlRaw}`);
  }

  const model =
    modelArg ??
    process.env.OPENAI_SHORT_MODEL ??
    process.env.OPENAI_MODEL ??
    DEFAULT_OPENAI_MODEL;
  const apiKey = process.env.OPENAI_API_KEY ?? null;
  if (parsed.hostname === "api.openai.com" && !apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required when OPENAI_BASE_URL points to api.openai.com.",
    );
  }

  const endpoint = new URL("/v1/chat/completions", parsed).toString();
  return { endpoint, apiKey, model, baseUrlRaw };
};

const main = async () => {
  const {
    filenameArg,
    minSeconds,
    targetSeconds,
    maxSeconds,
    skipStartSeconds,
    modelArg,
    maxIterations,
    excludeRanges,
    excludeTimeRanges,
    tagArg,
  } = parseArgs(process.argv.slice(2));
  const subtitlePath = resolveSubtitleJson(filenameArg);
  const captions = validateSubtitleJson(subtitlePath);
  const chunks = buildTranscriptChunks(captions);
  const chunksPrompt = formatChunksForPrompt(chunks);

  const { endpoint, apiKey, model, baseUrlRaw } = ensureOpenAiEndpoint(modelArg);

  let bestSelection: EvaluatedSelection | null = null;
  let feedback = "No previous attempts yet.";
  let roundsWithoutImprovement = 0;
  let lastAttemptError = "";

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const userPrompt = buildUserPrompt(
        chunksPrompt,
        minSeconds,
        targetSeconds,
        maxSeconds,
        skipStartSeconds,
        bestSelection,
        feedback,
        excludeRanges,
        excludeTimeRanges,
      );

    try {
      const rawContent = await requestSelectionFromOpenAi(
        endpoint,
        apiKey,
        model,
        SYSTEM_PROMPT,
        userPrompt,
      );
      const parsedSelection = parseSelection(rawContent);
      const evaluated = evaluateSelection(
        parsedSelection,
        chunks,
        minSeconds,
        targetSeconds,
        maxSeconds,
        skipStartSeconds,
        excludeTimeRanges,
        iteration,
      );

      const overlapsExcluded = excludeRanges.some((range) => {
        return evaluated.segments.some((segment) => {
          return (
            segment.startChunkId <= range.end && segment.endChunkId >= range.start
          );
        });
      });

      if (overlapsExcluded) {
        throw new Error(
          "Selection uses excluded chunk ids. Pick different segments.",
        );
      }

      if (
        !bestSelection ||
        evaluated.normalizedScore > bestSelection.normalizedScore
      ) {
        bestSelection = evaluated;
        roundsWithoutImprovement = 0;
        feedback = `Accepted. Improve this benchmark: normalizedScore=${evaluated.normalizedScore.toFixed(2)}, segments=[${formatSelectionSegments(evaluated.segments)}], combinedDuration=${evaluated.totalDurationSec.toFixed(2)}s, hook=${evaluated.hook}`;
      } else {
        roundsWithoutImprovement += 1;
        feedback = `Rejected. Candidate score ${evaluated.normalizedScore.toFixed(2)} was not better than best ${bestSelection.normalizedScore.toFixed(2)}.`;
      }
    } catch (error) {
      roundsWithoutImprovement += 1;
      const message = error instanceof Error ? error.message : String(error);
      lastAttemptError = message;
      feedback = `Invalid attempt. Fix all issues and return valid JSON. Error: ${message}`;
    }

    if (iteration >= 3 && roundsWithoutImprovement >= 3 && bestSelection) {
      break;
    }
  }

  if (!bestSelection) {
    const fallbackSelection = buildHeuristicSelection(
      chunks,
      minSeconds,
      targetSeconds,
      maxSeconds,
      skipStartSeconds,
      excludeRanges,
      excludeTimeRanges,
    );
    bestSelection = evaluateSelection(
      fallbackSelection,
      chunks,
      minSeconds,
      targetSeconds,
      maxSeconds,
      skipStartSeconds,
      excludeTimeRanges,
      maxIterations + 1,
    );
    console.warn(
      `Model fallback activated. Reason: ${lastAttemptError || `Could not produce a valid short after ${maxIterations} iterations. Check OpenAI connectivity and model compatibility at ${baseUrlRaw}.`}`,
    );
  }

  const selectedCaptions = captions.filter((caption) => {
    return bestSelection.segmentsWithTime.some((segment) => {
      return caption.endMs > segment.startMs && caption.startMs < segment.endMs;
    });
  });

  if (selectedCaptions.length === 0) {
    throw new Error("The selected short has no captions after filtering.");
  }

  const inputBaseName = path.basename(subtitlePath, ".json");
  const secondsLabel = formatSecondsForFileName(targetSeconds);
  const tagLabel = tagArg ? `_${tagArg}` : "";
  const publicDir = path.join(process.cwd(), "public");
  const outDir = path.join(process.cwd(), "out");
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(
    publicDir,
    `${inputBaseName}_${secondsLabel}${tagLabel}s.json`,
  );
  const selectionMetadataPath = path.join(
    outDir,
    `${inputBaseName}_${secondsLabel}${tagLabel}s.selection.json`,
  );

  writeFileSync(outputPath, JSON.stringify(selectedCaptions, null, 2));
  writeFileSync(
    selectionMetadataPath,
    JSON.stringify(
      {
        subtitlePath,
        targetSeconds,
        model,
        maxIterations,
        segments: bestSelection.segmentsWithTime,
        viralityScore: bestSelection.viralityScore,
        normalizedScore: bestSelection.normalizedScore,
        promoPenalty: bestSelection.promoPenalty,
        sponsorLikelihood: bestSelection.sponsorLikelihood,
        audienceAppealScore: bestSelection.audienceAppealScore,
        hook: bestSelection.hook,
        reason: bestSelection.reason,
      },
      null,
      2,
    ),
  );

  console.log(`Input subtitle JSON: ${subtitlePath}`);
  console.log(`LLM chunks analyzed: ${chunks.length}`);
  console.log(`Model: ${model}`);
  console.log(`Max iterations: ${maxIterations}`);
  console.log(
    `Target short duration (bounds): min=${minSeconds}s target≈${targetSeconds}s max=${maxSeconds}s`,
  );
  if (skipStartSeconds > 0) {
    console.log(`Skip start seconds: ${skipStartSeconds}s`);
  }
  if (excludeTimeRanges.length > 0) {
    console.log(
      `Excluded timeline ranges: ${excludeTimeRanges
        .map((range) => `${range.startSec.toFixed(3)}-${range.endSec.toFixed(3)}`)
        .join(", ")}`,
    );
  }
  console.log(
    `Selected segments: ${formatSelectionSegments(bestSelection.segments)}`,
  );
  console.log(
    `Selected timeline span: ${bestSelection.startMs}ms - ${bestSelection.endMs}ms`,
  );
  console.log(
    `Combined selected duration: ${bestSelection.totalDurationSec.toFixed(2)}s`,
  );
  console.log(`Selected hook: ${bestSelection.hook}`);
  console.log(`Selection reason: ${bestSelection.reason}`);
  console.log(`Promo penalty: ${bestSelection.promoPenalty.toFixed(2)}`);
  console.log(`Sponsor likelihood: ${bestSelection.sponsorLikelihood.toFixed(2)}`);
  console.log(`Audience appeal: ${bestSelection.audienceAppealScore.toFixed(2)}`);
  console.log(`Selection score: ${bestSelection.normalizedScore.toFixed(2)}`);
  console.log(`Output captions: ${selectedCaptions.length}`);
  console.log(`Saved short subtitle JSON: ${outputPath}`);
  console.log(`Saved short selection metadata: ${selectionMetadataPath}`);
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error(usage());
  process.exit(1);
});
