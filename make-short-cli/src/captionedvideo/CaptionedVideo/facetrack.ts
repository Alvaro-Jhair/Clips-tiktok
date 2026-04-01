import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

export type CropBox = { x: number; y: number; w: number; h: number };

type FaceBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
};

type FaceSample = {
  t: number;
  faces: FaceBox[];
};

type FaceDetectionFile = {
  width: number;
  height: number;
  durationSec: number;
  samples: FaceSample[];
};

type FaceDetectionStats = {
  samples: number;
  samplesWithFaces: number;
  totalFaces: number;
  avgFacesPerSample: number;
  maxFacesInSample: number;
};

type FaceTrackPoint = {
  t: number;
  cx: number;
  score: number;
  trackId: number | null;
  faceLeft: number | null;
  faceRight: number | null;
  reason:
    | "speaker"
    | "stability"
    | "multi-balance"
    | "occlusion-hold"
    | "panel-selection";
};

type SubtitleCaption = {
  text: string;
  startMs: number;
  endMs: number;
  index?: number;
};

type TrackedFace = {
  cx: number;
  width: number;
  cy: number;
  height: number;
  confidence: number;
  trackId: number;
};

type TrackedSample = {
  t: number;
  faces: TrackedFace[];
};

type ActiveSpeakerCropResult = {
  filter: string;
  mode:
    | "single-face"
    | "two-face"
    | "multi-face"
    | "wide-fallback"
    | "static-center";
  confidence: number;
};

export type FramingKeyframe = {
  t: number;
  x: number;
  reason:
    | "speaker"
    | "stability"
    | "multi-balance"
    | "occlusion-hold"
    | "panel-selection";
  trackId: number | null;
};

export type LayoutType = "stage" | "dual" | "panel";

export type PanelRegion = {
  trackId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  samples: number;
};

type ShotSegment = {
  start: number;
  end: number;
  x: number; // crop left
  trackId: number | null;
  reason: FaceTrackPoint["reason"];
  score: number;
  type: "hold" | "move";
  fromX?: number;
  toX?: number;
};

type SubjectLog = {
  trackId: number | null;
  side: "left" | "right" | "center";
};

type StageAnchors = {
  leftTrackId: number;
  centerTrackId: number;
  rightTrackId: number;
  leftCenterCx: number;
  centerCx: number;
  centerRightCx: number;
};

type DualAnchors = {
  leftTrackId: number;
  rightTrackId: number;
  leftCx: number;
  rightCx: number;
  dualCx: number;
};

type DebugCounters = {
  switchesAccepted: number;
  switchesRejected: number;
  jitterSuppressed: number;
  keyframesMerged: number;
  turnCandidates: number;
  turnAccepted: number;
  turnSuppressed: number;
  captionWindows: number;
};

export type FramingPlan = {
  mode:
    | "single-face"
    | "two-face"
    | "multi-face"
    | "wide-fallback"
    | "static-center";
  gridMode?: "grid_full" | "grid_pan" | "grid_panel_highlight" | null;
  confidence: number;
  cropWidth: number;
  keyframes: FramingKeyframe[];
  dominantTrack: number | null;
  fallback: boolean;
  filter: string;
  layoutType: LayoutType;
  layoutColumns?: number;
  layoutRows?: number;
  shots?: ShotSegment[];
  stageAnchors?: StageAnchors | null;
  dualAnchors?: DualAnchors | null;
};

type FaceProfile = "single" | "dual" | "multi";

const TRACK_INTERVAL_SEC = 0.5;
const MIN_TRACK_SAMPLES = 6;
const MAX_TRACK_SAMPLES = 80;
const SAFE_HEADROOM_TOP = 0.18;
const SAFE_HEADROOM_BOTTOM = 0.26;
const MAX_PER_SECOND_SHIFT_PX = 420;
const TRACK_MATCH_THRESHOLD_RATIO = 0.18;
const MIN_STABLE_TRACK_RATIO = 0.22;
const FACE_SAFE_PAD_RATIO = 0.08;

const clamp = (value: number, min: number, max: number) => {
  return Math.max(min, Math.min(max, value));
};

const round3 = (value: number) => {
  return Number(value.toFixed(3));
};

const runQuiet = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    throw new Error(`Command failed: ${command} ${args.join(" ")} ${stderr}`);
  }
  return result;
};

export const getVideoDimensions = (
  videoPath: string,
): { width: number; height: number } | null => {
  const res = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=s=,:p=0",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0 || !res.stdout) return null;
  const parts = res.stdout.trim().split(",");
  if (parts.length < 2) return null;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
};

const getVideoDurationSec = (videoPath: string): number | null => {
  const res = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0 || !res.stdout) return null;
  const parsed = Number(res.stdout.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const readSubtitleCaptions = (subtitlePath?: string): SubtitleCaption[] => {
  if (!subtitlePath) return [];
  try {
    const parsed = JSON.parse(readFileSync(subtitlePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => typeof entry === "object" && entry !== null)
      .map((entry, idx) => {
        const record = entry as Record<string, unknown>;
        return {
          text: typeof record.text === "string" ? record.text.trim() : "",
          startMs: typeof record.startMs === "number" ? record.startMs : 0,
          endMs: typeof record.endMs === "number" ? record.endMs : 0,
          index: idx,
        } satisfies SubtitleCaption;
      })
      .filter((caption) => caption.text.length > 0 && caption.endMs > caption.startMs)
      .sort((a, b) => a.startMs - b.startMs)
      .map((cap, idx) => ({ ...cap, index: idx }));
  } catch {
    return [];
  }
};

const getCaptionIndexAt = (captions: SubtitleCaption[], tSec: number) => {
  const tMs = tSec * 1000;
  for (let index = 0; index < captions.length; index++) {
    const caption = captions[index];
    if (tMs >= caption.startMs && tMs <= caption.endMs) {
      return index;
    }
  }
  return -1;
};

const getFirstFaceCenter = (samples: TrackedSample[], fallback: number) => {
  for (const sample of samples) {
    if (sample.faces.length === 0) continue;
    const best = [...sample.faces].sort(
      (a, b) => b.confidence * b.width - a.confidence * a.width,
    )[0];
    if (best) {
      return best.cx;
    }
  }
  return fallback;
};

const buildPiecewiseXExpr = (
  times: number[],
  xValues: number[],
  fallbackX: number,
) => {
  if (times.length === 0 || xValues.length === 0) {
    return `${Math.round(fallbackX)}`;
  }
  if (times.length === 1) {
    return `${Math.round(xValues[0] ?? fallbackX)}`;
  }

  let expr = `${Math.round(xValues[xValues.length - 1] ?? fallbackX)}`;
  for (let index = times.length - 2; index >= 0; index--) {
    const t0 = times[index];
    const t1 = times[index + 1];
    const x0 = xValues[index] ?? fallbackX;
    const x1 = xValues[index + 1] ?? fallbackX;
    const safeDen = Math.max(0.001, t1 - t0);
    const segmentExpr = `${x0.toFixed(2)}+(${(x1 - x0).toFixed(2)})*((t-${t0.toFixed(3)})/${safeDen.toFixed(3)})`;
    expr = `if(lt(t,${t1.toFixed(3)}),${segmentExpr},${expr})`;
  }
  expr = `if(lte(t,${times[0].toFixed(3)}),${xValues[0].toFixed(2)},${expr})`;
  return expr;
};

const buildShotTimeline = (
  times: number[],
  xs: number[],
  trackIds: Array<number | null>,
  cropWidth: number,
  frameWidth: number,
): ShotSegment[] => {
  if (times.length === 0 || xs.length !== times.length) return [];

  const MIN_HOLD = 0.9; // seconds
  const TRANSITION = 0.3; // seconds
  const MAX_JUMP = cropWidth * 0.25;
  const center = frameWidth / 2;

  const shots: ShotSegment[] = [];
  let shotStart = times[0];
  let shotX = xs[0];
  let shotTrack = trackIds[0] ?? null;

  const pushHold = (start: number, end: number, x: number, trackId: number | null) => {
    if (end <= start) return;
    shots.push({ start, end, x, trackId, reason: "stability", score: 1, type: "hold" });
  };

  for (let i = 1; i < times.length; i++) {
    const dt = times[i] - times[i - 1];
    const dx = Math.abs(xs[i] - xs[i - 1]);
    const trackChanged = trackIds[i] !== shotTrack && trackIds[i] !== null;
    const duration = times[i] - shotStart;
    const needsCut = trackChanged || dx > MAX_JUMP;

    if (needsCut && duration >= MIN_HOLD) {
      // finish current hold
      const holdEnd = Math.max(shotStart, times[i] - TRANSITION);
      pushHold(shotStart, holdEnd, shotX, shotTrack);
      // add move
      shots.push({
        type: "move",
        start: holdEnd,
        end: times[i],
        fromX: shotX,
        toX: xs[i],
        x: xs[i],
        trackId: trackIds[i] ?? shotTrack,
        reason: trackChanged ? "speaker" : "stability",
        score: 1,
      });
      // start new hold
      shotStart = times[i];
      shotX = xs[i];
      shotTrack = trackIds[i] ?? shotTrack;
    } else if (needsCut) {
      // not enough hold; just update target
      shotX = xs[i];
      shotTrack = trackIds[i] ?? shotTrack;
    }
  }

  pushHold(shotStart, times[times.length - 1] + TRANSITION, shotX, shotTrack);
  return shots;
};

const visionSwiftScript = `
import Foundation
import Vision
import CoreGraphics

func jsonString<T: Encodable>(_ value: T) throws -> String {
  let encoder = JSONEncoder()
  let data = try encoder.encode(value)
  return String(decoding: data, as: UTF8.self)
}

struct Face: Encodable {
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  let confidence: Double
}

struct Sample: Encodable {
  let t: Double
  let faces: [Face]
}

struct Output: Encodable {
  let width: Int
  let height: Int
  let durationSec: Double
  let samples: [Sample]
}

let args = CommandLine.arguments
if args.count < 7 {
  fputs("Usage: swift face.swift <frames-dir> <times-json> <width> <height> <duration> <output-json>\\n", stderr)
  exit(2)
}

let framesDir = args[1]
let timesPath = args[2]
let width = Int(args[3]) ?? 0
let height = Int(args[4]) ?? 0
let durationSec = Double(args[5]) ?? 0
let outputPath = args[6]

let timesData = try Data(contentsOf: URL(fileURLWithPath: timesPath))
let times = try JSONDecoder().decode([Double].self, from: timesData)

var samples: [Sample] = []

for index in 0..<times.count {
  let fileName = String(format: "frame-%04d.jpg", index)
  let framePath = (framesDir as NSString).appendingPathComponent(fileName)
  let frameURL = URL(fileURLWithPath: framePath)
  let imageData = try Data(contentsOf: frameURL)
  guard let cgImageSource = CGImageSourceCreateWithData(imageData as CFData, nil),
        let cgImage = CGImageSourceCreateImageAtIndex(cgImageSource, 0, nil) else {
    continue
  }

  let request = VNDetectFaceRectanglesRequest()
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])
  let observations = (request.results as? [VNFaceObservation]) ?? []
  let mapped = observations.map { obs -> Face in
    let bb = obs.boundingBox
    return Face(
      x: Double(bb.origin.x),
      y: Double(bb.origin.y),
      w: Double(bb.size.width),
      h: Double(bb.size.height),
      confidence: Double(obs.confidence)
    )
  }
  samples.append(Sample(t: times[index], faces: mapped))
}

let output = Output(width: width, height: height, durationSec: durationSec, samples: samples)
let out = try jsonString(output)
try out.write(toFile: outputPath, atomically: true, encoding: .utf8)
`;

const extractTrackingFrames = (
  videoPath: string,
  framesDir: string,
  sampleTimes: number[],
) => {
  console.log(`[facetrack] frameExtractionStarted dir=${framesDir} samples=${sampleTimes.length}`);
  if (sampleTimes.length === 0) return;
  const selectExpr = sampleTimes
    .map((time) => `between(t\\,${Math.max(0, time - 0.05).toFixed(3)}\\,${(time + 0.05).toFixed(3)})`)
    .join("+");

  runQuiet("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-i",
    videoPath,
    "-vf",
    `select='${selectExpr}',scale=960:-2`,
    "-vsync",
    "vfr",
    "-start_number",
    "0",
    path.join(framesDir, "frame-%04d.jpg"),
  ]);

  const files = readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort();
  const framesCount = files.length;
  const sampleFiles = files.slice(0, 3).join(", ");
  console.log(
    `[facetrack] frameExtractionCompleted dir=${framesDir} framesCount=${framesCount} files=${sampleFiles}`,
  );
  if (framesCount === 0) {
    throw new Error(`[facetrack] Frame extraction failed: no frames generated in ${framesDir}`);
  }
};

const detectFacesWithVision = (
  videoPath: string,
  width: number,
  height: number,
  durationSec: number,
): FaceDetectionFile | null => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "face-track-"));
  const framesDir = path.join(tempRoot, "frames");
  const scriptPath = path.join(tempRoot, "detect.swift");
  const timesPath = path.join(tempRoot, "times.json");
  const outputPath = path.join(tempRoot, "faces.json");

  try {
    runQuiet("mkdir", ["-p", framesDir]);
    const sampleCount = clamp(
      Math.round(durationSec / TRACK_INTERVAL_SEC),
      MIN_TRACK_SAMPLES,
      MAX_TRACK_SAMPLES,
    );
    const sampleTimes = Array.from({ length: sampleCount }, (_, index) => {
      return round3(((index + 0.5) / sampleCount) * durationSec);
    });
    writeFileSync(timesPath, JSON.stringify(sampleTimes));
    writeFileSync(scriptPath, visionSwiftScript);

    extractTrackingFrames(videoPath, framesDir, sampleTimes);

    const files = readdirSync(framesDir)
      .filter((f) => /^frame-\d+\.jpg$/.test(f))
      .sort((a, b) => {
        const na = Number(a.replace(/[^0-9]/g, ""));
        const nb = Number(b.replace(/[^0-9]/g, ""));
        return na - nb;
      });
    if (files.length === 0) {
      console.warn(`[facetrack] no frames found after extraction in ${framesDir}`);
      return null;
    }

    const swift = spawnSync(
      "swift",
      [
        scriptPath,
        framesDir,
        timesPath,
        `${width}`,
        `${height}`,
        `${durationSec}`,
        outputPath,
      ],
      { encoding: "utf8" },
    );

    if (swift.status !== 0) {
      const stderr = (swift.stderr ?? "").toString().trim();
      console.warn(`[facetrack] vision swift failed status=${swift.status} stderr=${stderr}`);
      return null;
    }

    const parsed = JSON.parse(readFileSync(outputPath, "utf8")) as FaceDetectionFile;
    if (!parsed || !Array.isArray(parsed.samples)) return null;
    return parsed;
  } catch (error) {
    console.warn(`[facetrack] detectFacesWithVision error ${(error as Error).message}`);
    return null;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
};

const summarizeDetections = (detection: FaceDetectionFile): FaceDetectionStats => {
  const samples = detection.samples.length;
  let samplesWithFaces = 0;
  let totalFaces = 0;
  let maxFacesInSample = 0;
  for (const sample of detection.samples) {
    const count = sample.faces.length;
    if (count > 0) samplesWithFaces += 1;
    totalFaces += count;
    if (count > maxFacesInSample) maxFacesInSample = count;
  }
  const avgFacesPerSample = samples > 0 ? totalFaces / samples : 0;
  return { samples, samplesWithFaces, totalFaces, avgFacesPerSample, maxFacesInSample };
};

const chooseTrackedFaceCenters = (
  samples: FaceSample[],
  frameWidth: number,
): FaceTrackPoint[] => {
  const track: FaceTrackPoint[] = [];
  let prevCx = frameWidth / 2;
  let prevSize = 0;

  for (const sample of samples) {
    const faceCandidates = sample.faces.map((face) => {
      const cx = (face.x + face.w / 2) * frameWidth;
      const area = face.w * face.h;
      const continuity = 1 - Math.min(1, Math.abs(cx - prevCx) / (frameWidth * 0.5));
      const sizeScore = Math.min(1, area * 12);
      const continuityBoost = prevSize > 0 ? 0.65 * continuity : 0.3;
      const score = face.confidence * 0.55 + sizeScore * 0.2 + continuityBoost;
      return { cx, score, area };
    });

    if (faceCandidates.length === 0) {
      track.push({ t: sample.t, cx: prevCx, score: 0 });
      continue;
    }

    faceCandidates.sort((a, b) => b.score - a.score);
    const best = faceCandidates[0];
    prevCx = best.cx;
    prevSize = best.area;
    track.push({ t: sample.t, cx: best.cx, score: best.score });
  }

  return track;
};

const analyzeFaceProfile = (samples: FaceSample[]): FaceProfile => {
  const counts = samples
    .map((sample) => sample.faces.length)
    .filter((count) => count > 0);
  if (counts.length === 0) return "single";

  const avg = counts.reduce((acc, count) => acc + count, 0) / counts.length;
  const withTwoOrMore = counts.filter((count) => count >= 2).length / counts.length;
  const withThreeOrMore = counts.filter((count) => count >= 3).length / counts.length;

  if (avg >= 2.6 || withThreeOrMore > 0.25) {
    return "multi";
  }
  if (avg >= 1.6 || withTwoOrMore > 0.45) {
    return "dual";
  }
  return "single";
};

const buildTrackedSamples = (
  samples: FaceSample[],
  frameWidth: number,
  frameHeight: number,
): { trackedSamples: TrackedSample[]; stableTrackIds: Set<number>; trackPoints: Map<number, number> } => {
  type MutableTrack = {
    id: number;
    lastCx: number;
    points: number;
  };

  const tracks: MutableTrack[] = [];
  let nextTrackId = 1;
  const trackedSamples: TrackedSample[] = [];

  for (const sample of samples) {
    const usedTrackIds = new Set<number>();
    const faces = sample.faces
      .map((face) => ({
        cx: (face.x + face.w / 2) * frameWidth,
        width: Math.max(1, face.w * frameWidth),
        cy: (face.y + face.h / 2) * frameHeight,
        height: Math.max(1, face.h * frameHeight),
        confidence: face.confidence,
      }))
      .sort((a, b) => b.confidence * b.width - a.confidence * a.width)
      .map((face) => {
        let bestTrack: MutableTrack | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const track of tracks) {
          if (usedTrackIds.has(track.id)) continue;
          const dist = Math.abs(track.lastCx - face.cx);
          const threshold = Math.max(40, frameWidth * TRACK_MATCH_THRESHOLD_RATIO);
          if (dist <= threshold && dist < bestDist) {
            bestDist = dist;
            bestTrack = track;
          }
        }

        if (!bestTrack) {
          bestTrack = { id: nextTrackId++, lastCx: face.cx, points: 0 };
          tracks.push(bestTrack);
        }

        bestTrack.lastCx = face.cx;
        bestTrack.points += 1;
        usedTrackIds.add(bestTrack.id);

        return {
          cx: face.cx,
          width: face.width,
          cy: face.cy,
          height: face.height,
          confidence: face.confidence,
          trackId: bestTrack.id,
        } satisfies TrackedFace;
      });

    trackedSamples.push({ t: sample.t, faces });
  }

  const minPoints = Math.max(2, Math.round(samples.length * MIN_STABLE_TRACK_RATIO));
  const stableTrackIds = new Set(
    tracks.filter((track) => track.points >= minPoints).map((track) => track.id),
  );
  const trackPoints = new Map(tracks.map((t) => [t.id, t.points]));
  return { trackedSamples, stableTrackIds, trackPoints };
};

const getFaceBoundsCenter = (sample: FaceSample, frameWidth: number) => {
  if (sample.faces.length === 0) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const face of sample.faces) {
    const left = face.x * frameWidth;
    const right = (face.x + face.w) * frameWidth;
    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return null;
  }
  return {
    center: (minX + maxX) / 2,
    spread: Math.max(0, maxX - minX),
  };
};

const detectLayoutType = (
  samples: TrackedSample[],
  frameWidth: number,
  frameHeight: number,
): {
  layout: LayoutType;
  columns: number;
  rows: number;
  panelRegions: PanelRegion[];
  stageAnchors: StageAnchors | null;
  dualAnchors: DualAnchors | null;
  isGridMulti: boolean;
} => {
  let columns = 1;
  let rows = 1;
  let layout: LayoutType = "stage";
  const panelRegions: PanelRegion[] = [];
  let stageAnchors: StageAnchors | null = null;
  let dualAnchors: DualAnchors | null = null;
  let isGridMulti = false;

  const positionsByTrack = new Map<number, { minX: number; maxX: number; minY: number; maxY: number; count: number }>();

  for (const sample of samples) {
    for (const face of sample.faces) {
      const current = positionsByTrack.get(face.trackId) ?? {
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
        count: 0,
      };
      const left = face.cx - face.width / 2;
      const right = face.cx + face.width / 2;
      const top = face.cy - face.height / 2;
      const bottom = face.cy + face.height / 2;
      current.minX = Math.min(current.minX, left);
      current.maxX = Math.max(current.maxX, right);
      current.minY = Math.min(current.minY, top);
      current.maxY = Math.max(current.maxY, bottom);
      current.count += 1;
      positionsByTrack.set(face.trackId, current);
    }
  }

  const tracks = Array.from(positionsByTrack.entries()).map(([trackId, pos]) => ({
    trackId,
    minX: pos.minX,
    maxX: pos.maxX,
    minY: pos.minY,
    maxY: pos.maxY,
    count: pos.count,
    cx: (pos.minX + pos.maxX) / 2,
    cy: (pos.minY + pos.maxY) / 2,
    w: Math.max(1, pos.maxX - pos.minX),
    h: Math.max(1, pos.maxY - pos.minY),
  }));

  if (tracks.length >= 3) {
    const xs = tracks.map((t) => t.cx / frameWidth);
    const ys = tracks.map((t) => t.cy / frameHeight);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    if (spreadX > 0.45 && spreadY < 0.25) {
      layout = "panel";
      columns = tracks.length >= 4 ? 2 : 3;
      rows = Math.ceil(tracks.length / columns);
    } else if (spreadX > 0.35 && tracks.length >= 2) {
      layout = "dual";
      columns = 2;
      rows = 1;
    }
  } else if (tracks.length === 2) {
    const spreadX = Math.abs(tracks[0].cx - tracks[1].cx) / frameWidth;
    const spreadY = Math.abs(tracks[0].cy - tracks[1].cy) / frameHeight;
    if (spreadX > 0.25 && spreadY < 0.35) {
      layout = "dual";
      columns = 2;
      rows = 1;
    }
  }

  if (layout === "panel") {
    // Assign panels based on rough grid from positions
    const sorted = [...tracks].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    const cellWidth = frameWidth / columns;
    const cellHeight = frameHeight / rows;
    for (const track of sorted) {
      const col = clamp(Math.floor(track.cx / cellWidth), 0, columns - 1);
      const row = clamp(Math.floor(track.cy / cellHeight), 0, rows - 1);
      const x = col * cellWidth;
      const y = row * cellHeight;
      panelRegions.push({
        trackId: track.trackId,
        x,
        y,
        w: cellWidth,
        h: cellHeight,
        cx: x + cellWidth / 2,
        cy: y + cellHeight / 2,
        samples: track.count,
      });
    }
  }

  // Derive 3-person stage anchors when exactly 3 stable tracks span left/center/right
  if (layout === "stage") {
    const stableTracks = tracks.filter((t) => t.count >= Math.max(2, samples.length * 0.15));
    if (stableTracks.length === 3) {
      const sorted = [...stableTracks].sort((a, b) => a.cx - b.cx);
      const [left, center, right] = sorted;
      const spread = right.cx - left.cx;
      if (spread > frameWidth * 0.35) {
        stageAnchors = {
          leftTrackId: left.trackId,
          centerTrackId: center.trackId,
          rightTrackId: right.trackId,
          leftCenterCx: (left.cx + center.cx) / 2,
          centerCx: center.cx,
          centerRightCx: (center.cx + right.cx) / 2,
        };
        layout = "panel"; // treat as multi-face to avoid single-face lock
      }
    }
  }

  // Mark grid-like multi layout: many tracks spread in grid pattern
  if (layout === "panel" && panelRegions.length >= 4) {
    isGridMulti = true;
  }

  // Derive dual anchors for two stable tracks spanning left/right
  if (!stageAnchors && layout === "dual" && tracks.length === 2) {
    const sorted = [...tracks].sort((a, b) => a.cx - b.cx);
    const [left, right] = sorted;
    const spread = right.cx - left.cx;
    if (spread > frameWidth * 0.18) {
      dualAnchors = {
        leftTrackId: left.trackId,
        rightTrackId: right.trackId,
        leftCx: left.cx,
        rightCx: right.cx,
        dualCx: (left.cx + right.cx) / 2,
      };
    }
  }

  return { layout, columns, rows, panelRegions, stageAnchors, dualAnchors, isGridMulti };
};

const smoothCenters = (
  points: FaceTrackPoint[],
  cropWidth: number,
  frameWidth: number,
): number[] => {
  const maxX = Math.max(0, frameWidth - cropWidth);
  const safeLeft = cropWidth * 0.2;
  const safeRight = cropWidth * 0.8;
  const jitterDeadband = cropWidth * 0.015;

  const xTargets = points.map((point) => {
    let x = point.cx - cropWidth / 2;
    x = clamp(x, 0, maxX);
    const faceWithinWindow = point.cx - x;
    if (faceWithinWindow < safeLeft) {
      x = clamp(point.cx - safeLeft, 0, maxX);
    } else if (faceWithinWindow > safeRight) {
      x = clamp(point.cx - safeRight, 0, maxX);
    }
    return x;
  });

  const smooth: number[] = [];
  let prev = xTargets[0] ?? maxX / 2;

  for (let index = 0; index < xTargets.length; index++) {
    const t = points[index]?.t ?? index * TRACK_INTERVAL_SEC;
    const prevT = points[index - 1]?.t ?? Math.max(0, t - TRACK_INTERVAL_SEC);
    const dt = Math.max(0.001, t - prevT);
    const maxStep = MAX_PER_SECOND_SHIFT_PX * dt;
    let target = xTargets[index] ?? prev;
    if (Math.abs(target - prev) < jitterDeadband) {
      target = prev;
    }
    const boundedTarget =
      target > prev + maxStep
        ? prev + maxStep
        : target < prev - maxStep
          ? prev - maxStep
          : target;
    const confidence = clamp(points[index]?.score ?? 0, 0, 1);
    const alpha = clamp(0.12 + confidence * 0.3, 0.12, 0.5);
    prev = prev + (boundedTarget - prev) * alpha;
    let nextX = clamp(prev, 0, maxX);

    const faceLeft = points[index]?.faceLeft;
    const faceRight = points[index]?.faceRight;
    if (faceLeft !== null && faceRight !== null) {
      const pad = cropWidth * FACE_SAFE_PAD_RATIO;
      const minAllowedX = clamp(faceRight + pad - cropWidth, 0, maxX);
      const maxAllowedX = clamp(faceLeft - pad, 0, maxX);
      if (minAllowedX <= maxAllowedX) {
        nextX = clamp(nextX, minAllowedX, maxAllowedX);
      } else {
        nextX = clamp((minAllowedX + maxAllowedX) / 2, 0, maxX);
      }
    }

    smooth.push(nextX);
    prev = nextX;
  }

  return smooth;
};

const mergeNearbyKeyframes = (
  times: number[],
  xs: number[],
  trackIds: Array<number | null>,
  reasons: FaceTrackPoint["reason"][],
  cropWidth: number,
  debug: DebugCounters,
) => {
  if (times.length === 0) return { times, xs, trackIds, reasons };

  const mergedTimes: number[] = [times[0]];
  const mergedXs: number[] = [xs[0]];
  const mergedTracks: Array<number | null> = [trackIds[0] ?? null];
  const mergedReasons: FaceTrackPoint["reason"][] = [reasons[0] ?? "stability"];
  const deadband = cropWidth * 0.02;

  for (let i = 1; i < times.length; i++) {
    const lastIndex = mergedXs.length - 1;
    const dx = Math.abs(xs[i] - mergedXs[lastIndex]);
    const dt = times[i] - mergedTimes[lastIndex];
    const trackChanged = trackIds[i] !== mergedTracks[lastIndex];
    if (!trackChanged && dx < deadband && dt < 1.4) {
      debug.keyframesMerged += 1;
      continue;
    }
    mergedTimes.push(times[i]);
    mergedXs.push(xs[i]);
    mergedTracks.push(trackIds[i] ?? null);
    mergedReasons.push(reasons[i] ?? "stability");
  }

  return { times: mergedTimes, xs: mergedXs, trackIds: mergedTracks, reasons: mergedReasons };
};

const buildSpeakerAwareCenters = (
  trackedSamples: TrackedSample[],
  stableTrackIds: Set<number>,
  trackPoints: Map<number, number>,
  frameWidth: number,
  frameHeight: number,
  profile: FaceProfile,
  subtitles: SubtitleCaption[],
  layout: LayoutType,
  panelRegions: PanelRegion[],
  stageAnchors: StageAnchors | null,
  dualAnchors: DualAnchors | null,
  isGridMulti: boolean,
  subjectLogs: SubjectLog[],
  cropWidth: number,
  debug: DebugCounters,
): FaceTrackPoint[] => {
  type CaptionWindowLog = {
    index: number;
    start: number;
    end: number;
    selectedTrack: number | null;
    candidates: Record<string, number>;
    switchesAccepted: number;
    switchesRejected: number;
    rejections: string[];
  };

  const points: FaceTrackPoint[] = [];
  let prevCx = getFirstFaceCenter(trackedSamples, frameWidth / 2);
  let prevTrackId: number | null = null;
  let prevCaptionIndex = -1;
  let lastSwitchT = -10;
  let hadAnyVisibleFace = false;
  const panelByTrack = new Map(panelRegions.map((p) => [p.trackId, p]));
  const dominantTrack = (() => {
    let best: { id: number; points: number } | null = null;
    for (const [id, pts] of trackPoints.entries()) {
      if (!best || pts > best.points) {
        best = { id, points: pts };
      }
    }
    return best?.id ?? null;
  })();
  const centerX = frameWidth / 2;
  let lastChosenTrack: number | null = null;
  let lastSubjectSwitchT = -10;
  const MIN_SWITCH_HOLD = 0.9; // seconds (more responsive to turns)
  const JITTER_THRESHOLD_RATIO = 0.03;
  const SWITCH_SCORE_BONUS = 0.35;
  const MAX_STABILITY_SPAN = 4.0; // seconds before forcing reevaluation
  let forcedReevalAnchorT = 0;
  let lastTurnCaptionIndex = -1;
  const MAX_HOLD_FOR_DUAL = 5.0; // seconds hard cap for dual conversations
  const MIN_TURN_HOLD = 0.6; // minimal hold after a turn before next switch
  const TURN_SWITCH_WINDOW = 1.2; // seconds after caption start to favor a switch
  const TURN_MIN_SWITCH_HOLD = 0.25; // allow faster switch right after a turn
  const TURN_ALT_BOOST = 0.25; // bonus to alternate track inside turn window
  const MAX_CAPTION_DUAL_HOLD = 3.0; // cap hold in dual conversations while captions active
  const SINGLE_DOMINANCE_RATIO = 1.25; // dominance needed to stay single-side when both visible
  const SINGLE_HOLD_CAP_DUAL = 3.5; // cap for single-side hold in dual when both visible
  let currentCaptionLog: CaptionWindowLog | null = null;
  let lastComposition: "left_single" | "right_single" | "dual_two_shot" | null = null;
  let lastCompositionT = 0;

  const flushCaptionLog = (endTime: number) => {
    if (!currentCaptionLog) return;
    const candidateSummary = Object.entries(currentCaptionLog.candidates)
      .sort((a, b) => b[1] - a[1])
      .map(([track, score]) => `${track}:${score.toFixed(2)}`)
      .join("|") || "none";
    const rejectionSummary = currentCaptionLog.rejections.length
      ? currentCaptionLog.rejections.join(",")
      : "none";
    console.log(
      `[facetrack] caption window idx=${currentCaptionLog.index} start=${currentCaptionLog.start.toFixed(2)} end=${endTime.toFixed(2)} selected=${currentCaptionLog.selectedTrack ?? "none"} candidates=${candidateSummary} switchesAccepted=${currentCaptionLog.switchesAccepted} switchesRejected=${currentCaptionLog.switchesRejected} rejections=${rejectionSummary}`,
    );
    currentCaptionLog = null;
  };

  for (const sample of trackedSamples) {
    const visibleFaces = sample.faces.filter((face) => {
      return stableTrackIds.size === 0 || stableTrackIds.has(face.trackId);
    });
    const captionIndex = getCaptionIndexAt(subtitles, sample.t);
    const speakingNow = captionIndex >= 0;
    const captionChanged = speakingNow && captionIndex !== prevCaptionIndex;
    const captionStartT = speakingNow ? subtitles[captionIndex].startMs / 1000 : null;
    const withinTurnWindow =
      captionStartT !== null ? sample.t - captionStartT <= TURN_SWITCH_WINDOW : false;
    if (captionChanged && prevCaptionIndex >= 0) {
      const prevCaption = subtitles[prevCaptionIndex];
      flushCaptionLog(Math.min(sample.t, prevCaption.endMs / 1000));
    }
    if (speakingNow && (!currentCaptionLog || currentCaptionLog.index !== captionIndex)) {
      const cap = subtitles[captionIndex];
      currentCaptionLog = {
        index: captionIndex,
        start: cap.startMs / 1000,
        end: cap.endMs / 1000,
        selectedTrack: prevTrackId,
        candidates: {},
        switchesAccepted: 0,
        switchesRejected: 0,
        rejections: [],
      };
      debug.captionWindows += 1;
    }
    if (captionChanged) {
      debug.turnCandidates += 1;
      lastTurnCaptionIndex = captionIndex;
    }

    if (visibleFaces.length === 0) {
      const fallbackCx = hadAnyVisibleFace ? prevCx : getFirstFaceCenter(trackedSamples, prevCx);
      points.push({
        t: sample.t,
        cx: fallbackCx,
        score: 0.18,
        trackId: prevTrackId,
        faceLeft: null,
        faceRight: null,
        reason: "occlusion-hold",
      });
      prevCx = fallbackCx;
      prevCaptionIndex = captionIndex;
      continue;
    }

    hadAnyVisibleFace = true;

    let chosen: TrackedFace | null = null;
    let candidateScore = 0;
    const chooseStableDominant = () => {
      if (dominantTrack !== null) {
        const found = visibleFaces.find((f) => f.trackId === dominantTrack);
        if (found) return found;
      }
      return [...visibleFaces].sort((a, b) => b.confidence * b.width - a.confidence * a.width)[0] ?? null;
    };

    const scoredFaces = visibleFaces.map((face) => {
      const sizeScore = clamp(face.width / (frameWidth * 0.4), 0, 1);
      const continuity = 1 - Math.min(1, Math.abs(face.cx - prevCx) / (frameWidth * 0.65));
      const trackKeepBase = prevTrackId !== null && face.trackId === prevTrackId ? 0.12 : 0;
      const trackKeep = speakingNow && withinTurnWindow ? trackKeepBase * 0.35 : trackKeepBase;
      const turnAlt = speakingNow && withinTurnWindow && lastChosenTrack !== null && face.trackId !== lastChosenTrack ? TURN_ALT_BOOST : 0;
      return {
        face,
        score: face.confidence * 0.5 + sizeScore * 0.3 + continuity * 0.2 + trackKeep + turnAlt,
      };
    });
    scoredFaces.sort((a, b) => b.score - a.score);
    const bestOverall = scoredFaces[0] ?? null;
    const bestDifferent = scoredFaces.find((s) => s.face.trackId !== lastChosenTrack) ?? null;

    if (speakingNow) {
      const sameTrackVisible =
        prevTrackId !== null
          ? visibleFaces.find((face) => face.trackId === prevTrackId) ?? null
          : null;

      if (sameTrackVisible && !captionChanged) {
        chosen = sameTrackVisible;
        candidateScore = scoredFaces.find((s) => s.face.trackId === sameTrackVisible.trackId)?.score ?? 0;
      } else if (captionChanged && bestDifferent) {
        const turnBonus = SWITCH_SCORE_BONUS + TURN_ALT_BOOST;
        candidateScore = bestDifferent.score + turnBonus;
        chosen = bestDifferent.face;
      } else if (bestOverall) {
        const turnBonus =
          prevTrackId !== null &&
          bestOverall.face.trackId !== prevTrackId &&
          (captionChanged || withinTurnWindow) &&
          sample.t - lastSwitchT > 0.5
            ? SWITCH_SCORE_BONUS
            : 0;
        candidateScore = bestOverall.score + turnBonus;
        chosen = bestOverall.face;
      }
    } else if (prevTrackId !== null) {
      const prevFace = visibleFaces.find((face) => face.trackId === prevTrackId) ?? null;
      if (prevFace) {
        chosen = prevFace;
        candidateScore = scoredFaces.find((s) => s.face.trackId === prevFace.trackId)?.score ?? 0;
      }
    }

    // If still no chosen, pick best overall
    if (!chosen && bestOverall) {
      chosen = bestOverall.face;
      candidateScore = bestOverall.score;
    }

    if (!chosen) {
      if (profile === "single") {
        chosen = chooseStableDominant();
      } else {
        const stable = chooseStableDominant();
        if (stable) {
          chosen = stable;
        } else {
          // As a last resort pick the largest/confident face, but never geometric center
          const fallback = [...visibleFaces]
            .map((f) => ({ face: f, score: f.confidence * f.width }))
            .sort((a, b) => b.score - a.score)[0];
          chosen = fallback?.face ?? null;
          candidateScore = fallback?.score ?? 0;
        }
      }
    }

    const nextCx = chosen?.cx ?? prevCx;
    if (prevTrackId !== null && chosen && chosen.trackId !== prevTrackId && speakingNow) {
      lastSwitchT = sample.t;
    }

    const panel = chosen ? panelByTrack.get(chosen.trackId) ?? null : null;
    const nextFaceLeft = chosen ? chosen.cx - chosen.width / 2 : null;
    const nextFaceRight = chosen ? chosen.cx + chosen.width / 2 : null;
    const faceBasedCx = nextCx;
    let finalCx = faceBasedCx;
    let finalLeft = nextFaceLeft;
    let finalRight = nextFaceRight;
    let reason: FaceTrackPoint["reason"] = speakingNow ? "speaker" : "stability";

    // Avoid empty-center multi-balance: prefer dominant or prior track if center is empty
    if (!chosen && dominantTrack !== null) {
      const dom = visibleFaces.find((f) => f.trackId === dominantTrack);
      if (dom) {
        finalCx = dom.cx;
        finalLeft = dom.cx - dom.width / 2;
        finalRight = dom.cx + dom.width / 2;
        reason = "stability";
      }
    }

    const multipleTracksVisible = visibleFaces.length > 1;

    // Stage anchor framing for 3-person stage: choose anchors based on speaker side
    if (stageAnchors && speakingNow) {
      const isLeft = chosen?.trackId === stageAnchors.leftTrackId;
      const isRight = chosen?.trackId === stageAnchors.rightTrackId;
      const isCenter = chosen?.trackId === stageAnchors.centerTrackId;
      if (isLeft) {
        finalCx = stageAnchors.leftCenterCx;
        reason = "speaker";
      } else if (isRight) {
        finalCx = stageAnchors.centerRightCx;
        reason = "speaker";
      } else if (isCenter) {
        finalCx = stageAnchors.centerCx;
        reason = "speaker";
      }
    }

    // Dual-stage framing: decide between left_single, right_single, dual_two_shot
    if (dualAnchors && speakingNow) {
      const isLeft = chosen?.trackId === dualAnchors.leftTrackId;
      const isRight = chosen?.trackId === dualAnchors.rightTrackId;
      const leftVisible = visibleFaces.some((f) => f.trackId === dualAnchors.leftTrackId);
      const rightVisible = visibleFaces.some((f) => f.trackId === dualAnchors.rightTrackId);
      const bothVisible = leftVisible && rightVisible;

      // Heuristics: if both visible and no strong dominance, prefer dual shot
      let composition: "left_single" | "right_single" | "dual_two_shot" = "dual_two_shot";

      // dominance by score ratio when both visible
      if (bothVisible) {
        const leftScore = scoredFaces.find((s) => s.face.trackId === dualAnchors.leftTrackId)?.score ?? 0;
        const rightScore = scoredFaces.find((s) => s.face.trackId === dualAnchors.rightTrackId)?.score ?? 0;
        if (leftScore > 0 && leftScore / Math.max(0.001, rightScore) >= SINGLE_DOMINANCE_RATIO) {
          composition = "left_single";
        } else if (rightScore > 0 && rightScore / Math.max(0.001, leftScore) >= SINGLE_DOMINANCE_RATIO) {
          composition = "right_single";
        }
      }

      // If clear speaker dominance to one side, choose that single shot
      if (isLeft && !isRight) {
        composition = "left_single";
      } else if (isRight && !isLeft) {
        composition = "right_single";
      } else if (bothVisible) {
        composition = "dual_two_shot";
      }

      if (composition === "left_single") {
        finalCx = dualAnchors.leftCx;
        reason = "speaker";
      } else if (composition === "right_single") {
        finalCx = dualAnchors.rightCx;
        reason = "speaker";
      } else {
        finalCx = dualAnchors.dualCx;
        reason = "multi-balance";
      }

      lastComposition = composition;
      lastCompositionT = sample.t;
    }

    if (panel && !(speakingNow && multipleTracksVisible && withinTurnWindow)) {
      if (isGridMulti && multipleTracksVisible) {
        // For grid: prefer keeping full grid or mild pan, avoid tight panel lock
        const gridPad = cropWidth * 0.05;
        finalCx = clamp(panel.cx, gridPad, frameWidth - gridPad);
        reason = "multi-balance";
      } else {
        finalCx = panel.cx;
        finalLeft = panel.x;
        finalRight = panel.x + panel.w;
        reason = "panel-selection";
      }
    }

    // Jitter suppression / hold: ignore tiny shifts while same subject
    const jitterThreshold = cropWidth * JITTER_THRESHOLD_RATIO;
    if (lastChosenTrack !== null && chosen?.trackId === lastChosenTrack) {
      if (Math.abs(finalCx - prevCx) < jitterThreshold) {
        finalCx = prevCx;
        if (finalLeft !== null && finalRight !== null) {
          const width = finalRight - finalLeft;
          finalLeft = prevCx - width / 2;
          finalRight = prevCx + width / 2;
        }
        debug.jitterSuppressed += 1;
      }
    }

    // Allow speaker switch after a minimum hold; otherwise suppress
    const subjectChanged = chosen?.trackId !== null && chosen?.trackId !== lastChosenTrack;
    const timeSinceLastSwitch = sample.t - lastSubjectSwitchT;
    const stabilitySpan = sample.t - forcedReevalAnchorT;
    const forcedReeval = stabilitySpan >= MAX_STABILITY_SPAN;
    const exceededHold = profile === "dual" && stabilitySpan >= MAX_HOLD_FOR_DUAL;
    const captionHoldExceeded =
      profile === "dual" && speakingNow && stabilitySpan >= MAX_CAPTION_DUAL_HOLD;
    const effectiveMinSwitchHold = withinTurnWindow ? TURN_MIN_SWITCH_HOLD : MIN_SWITCH_HOLD;

    const turnWindowForceSwitch = subjectChanged && speakingNow && withinTurnWindow;

    // Dual composition hold cap: if in dual_two_shot recently, allow earlier moves
    const dualCompositionHoldExceeded =
      profile === "dual" &&
      lastComposition === "dual_two_shot" &&
      sample.t - lastCompositionT >= SINGLE_HOLD_CAP_DUAL;

    if (
      subjectChanged &&
      timeSinceLastSwitch < effectiveMinSwitchHold &&
      chosen?.trackId !== prevTrackId &&
      !forcedReeval &&
      !exceededHold &&
      !captionHoldExceeded &&
      !turnWindowForceSwitch &&
      !dualCompositionHoldExceeded
    ) {
      // reject this switch, keep previous framing
      finalCx = prevCx;
      debug.switchesRejected += 1;
      debug.turnSuppressed += captionChanged ? 1 : 0;
      reason = "stability";
      if (currentCaptionLog) {
        currentCaptionLog.switchesRejected += 1;
        const rejReason = `reject candidate=${chosen?.trackId ?? "none"} hold=${timeSinceLastSwitch.toFixed(2)} minHold=${effectiveMinSwitchHold.toFixed(2)} forced=${forcedReeval || exceededHold || captionHoldExceeded || dualCompositionHoldExceeded} turnWindow=${withinTurnWindow}`;
        currentCaptionLog.rejections.push(rejReason);
      }
      console.log(
        `[facetrack] switch decision t=${sample.t.toFixed(2)} prevTrack=${lastChosenTrack ?? "none"} candidate=${chosen?.trackId ?? "none"} candidateScore=${candidateScore.toFixed(3)} stabilityHold=${timeSinceLastSwitch.toFixed(2)} forced=${forcedReeval} accepted=false switchesRejected=${debug.switchesRejected}`,
      );
    } else if (
      subjectChanged ||
      forcedReeval ||
      exceededHold ||
      captionHoldExceeded ||
      turnWindowForceSwitch ||
      dualCompositionHoldExceeded ||
      timeSinceLastSwitch >= MIN_TURN_HOLD
    ) {
      const accept = true;
      debug.switchesAccepted += 1;
      debug.turnAccepted += captionChanged ? 1 : 0;
      lastSubjectSwitchT = sample.t;
      lastChosenTrack = chosen?.trackId ?? lastChosenTrack;
      forcedReevalAnchorT = sample.t;
      reason = speakingNow ? "speaker" : "stability";
      console.log(
        `[facetrack] switch decision t=${sample.t.toFixed(2)} prevTrack=${lastChosenTrack ?? "none"} candidate=${chosen?.trackId ?? "none"} candidateScore=${candidateScore.toFixed(3)} stabilityHold=${timeSinceLastSwitch.toFixed(2)} forced=${forcedReeval || exceededHold} accepted=true switchesAccepted=${debug.switchesAccepted}`,
      );
      if (currentCaptionLog) {
        currentCaptionLog.switchesAccepted += 1;
      }
    }
    if (!subjectChanged && chosen?.trackId !== null) {
      lastChosenTrack = chosen.trackId;
    }

    if (currentCaptionLog) {
      const candidateTrackId = chosen?.trackId ?? prevTrackId ?? null;
      if (candidateTrackId !== null) {
        const key = String(candidateTrackId);
        const prev = currentCaptionLog.candidates[key] ?? 0;
        currentCaptionLog.candidates[key] = Math.max(prev, candidateScore);
      }
      currentCaptionLog.selectedTrack = lastChosenTrack ?? prevTrackId ?? currentCaptionLog.selectedTrack;
    }

    const side: SubjectLog["side"] = finalCx < centerX ? "left" : finalCx > centerX ? "right" : "center";
    subjectLogs.push({ trackId: chosen?.trackId ?? prevTrackId ?? null, side });

    console.log(
      `[facetrack] select t=${sample.t.toFixed(2)} currentTrack=${lastChosenTrack ?? "none"} candidateTrack=${chosen?.trackId ?? "none"} candidateScore=${candidateScore.toFixed(3)} side=${side} reason=${reason} jitterSuppressed=${debug.jitterSuppressed}`,
    );

    points.push({
      t: sample.t,
      cx: finalCx,
      score: clamp((chosen?.confidence ?? 0.2) + 0.25, 0.2, 0.95),
      trackId: chosen?.trackId ?? prevTrackId,
      faceLeft: finalLeft,
      faceRight: finalRight,
      reason,
    });
    prevCx = finalCx;
    prevTrackId = chosen?.trackId ?? prevTrackId;
    prevCaptionIndex = captionIndex;
  }

  if (currentCaptionLog) {
    flushCaptionLog(currentCaptionLog.end);
  }

  return points;
};

const computeCropDimensions = (
  frameWidth: number,
  frameHeight: number,
  targetWidth: number,
  targetHeight: number,
) => {
  const aspect = targetWidth / targetHeight;
  const cropWidth = Math.min(frameWidth, Math.round(frameHeight * aspect));
  const cropHeight = Math.min(frameHeight, Math.round(cropWidth / aspect));
  return { cropWidth, cropHeight };
};

const getFaceTrackingCrop = (
  videoPath: string,
  targetWidth: number,
  targetHeight: number,
  subtitlePath?: string,
): { result: ActiveSpeakerCropResult; plan: FramingPlan } | null => {
  const dims = getVideoDimensions(videoPath);
  const durationSec = getVideoDurationSec(videoPath);
  if (!dims || !durationSec) return null;

  const detection = detectFacesWithVision(
    videoPath,
    dims.width,
    dims.height,
    durationSec,
  );
  if (!detection || detection.samples.length < 3) {
    console.warn(
      `[facetrack] detection missing or too few samples (samples=${detection?.samples.length ?? 0}) -> static fallback`,
    );
    return null;
  }

  const detectionStats = summarizeDetections(detection);
  console.log(
    `[facetrack] detection stats samples=${detectionStats.samples} withFaces=${detectionStats.samplesWithFaces} totalFaces=${detectionStats.totalFaces} avgFaces=${detectionStats.avgFacesPerSample.toFixed(2)} maxFaces=${detectionStats.maxFacesInSample}`,
  );

  const profile = analyzeFaceProfile(detection.samples);
  const subtitles = readSubtitleCaptions(subtitlePath);
  const { trackedSamples, stableTrackIds, trackPoints } = buildTrackedSamples(
    detection.samples,
    dims.width,
    dims.height,
  );

  console.log(
    `[facetrack] trackedSamples=${trackedSamples.length} stableTracks=${stableTrackIds.size}`,
  );

  const { layout, columns, rows, panelRegions, stageAnchors, dualAnchors, isGridMulti } = detectLayoutType(
    trackedSamples,
    dims.width,
    dims.height,
  );

  console.log(
    `[facetrack] layout detection layout=${layout} cols=${columns} rows=${rows} panelCount=${panelRegions.length} isGridMulti=${isGridMulti}`,
  );

  const { cropWidth, cropHeight } = computeCropDimensions(
    dims.width,
    dims.height,
    targetWidth,
    targetHeight,
  );

  if (cropWidth >= dims.width) {
    const fallbackResult = {
      filter: `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}`,
      mode: "wide-fallback",
      confidence: 0.25,
    } satisfies ActiveSpeakerCropResult;
    return {
      result: fallbackResult,
      plan: {
        mode: fallbackResult.mode,
        confidence: fallbackResult.confidence,
        cropWidth,
        keyframes: [],
        dominantTrack: null,
        fallback: true,
        filter: fallbackResult.filter,
        layoutType: layout,
        layoutColumns: columns,
        layoutRows: rows,
      },
    };
  }

  const subjectLogs: SubjectLog[] = [];
  const debug: DebugCounters = {
    switchesAccepted: 0,
    switchesRejected: 0,
    jitterSuppressed: 0,
    keyframesMerged: 0,
    turnCandidates: 0,
    turnAccepted: 0,
    turnSuppressed: 0,
    captionWindows: 0,
  };
  const tracked = buildSpeakerAwareCenters(
    trackedSamples,
    stableTrackIds,
    trackPoints,
    dims.width,
    dims.height,
    profile,
    subtitles,
    layout,
    panelRegions,
    stageAnchors,
    dualAnchors,
    isGridMulti,
    subjectLogs,
    cropWidth,
    debug,
  );
  if (tracked.length === 0) {
    console.warn("[facetrack] no tracked points -> static fallback");
    return null;
  }
  const smoothX = smoothCenters(tracked, cropWidth, dims.width);
  const times = tracked.map((point) => point.t);
  const trackIds = tracked.map((p) => p.trackId);
  const reasons = tracked.map((p) => p.reason);

  const merged = mergeNearbyKeyframes(times, smoothX, trackIds, reasons, cropWidth, debug);
  const xExpr = buildPiecewiseXExpr(merged.times, merged.xs, (dims.width - cropWidth) / 2);

  const yCenter = dims.height / 2;
  const yTopSafe = yCenter - cropHeight * (0.5 - SAFE_HEADROOM_TOP);
  const yBottomSafe = yCenter + cropHeight * (0.5 - SAFE_HEADROOM_BOTTOM);
  const y = clamp(
    yTopSafe + (yBottomSafe - yTopSafe) * 0.5 - cropHeight / 2,
    0,
    Math.max(0, dims.height - cropHeight),
  );

  const filter = `crop=${cropWidth}:${cropHeight}:x='${xExpr}':y=${Math.round(y)},scale=${targetWidth}:${targetHeight}`;
  const confidentSamples = tracked.filter((point) => point.score > 0.4).length;
  const confidence = clamp(confidentSamples / tracked.length, 0.2, 0.95);

  const keyframes: FramingKeyframe[] = merged.times.map((t, index) => ({
    t,
    x: merged.xs[index] ?? 0,
    reason: merged.reasons[index] ?? "stability",
    trackId: merged.trackIds[index] ?? null,
  }));

  const shots = buildShotTimeline(merged.times, merged.xs, merged.trackIds, cropWidth, dims.width);
  const holdSegmentsCount = shots.filter((s) => s.type === "hold").length;
  const moveSegmentsCount = shots.filter((s) => s.type === "move").length;
  const uniqueTrackIdsInShots = Array.from(new Set(shots.map((s) => s.trackId ?? null)));
  const uniqueTrackIdsInKeyframes = Array.from(new Set(keyframes.map((k) => k.trackId ?? null)));
  const panelSelectionCount = tracked.filter((p) => p.reason === "panel-selection").length;
  const speakerSelectionCount = tracked.filter((p) => p.reason === "speaker").length;

  const holdDurations = shots
    .filter((s) => s.type === "hold")
    .map((s) => Math.max(0, s.end - s.start));
  const averageHoldDuration = holdDurations.length
    ? holdDurations.reduce((a, b) => a + b, 0) / holdDurations.length
    : 0;
  const longestHoldDuration = holdDurations.length ? Math.max(...holdDurations) : 0;

  const avgVisibleFaces =
    trackedSamples.length > 0
      ? trackedSamples.reduce((acc, sample) => acc + sample.faces.length, 0) /
        trackedSamples.length
      : 0;
  const chosenTrackCounts = tracked.reduce<Record<string, number>>((acc, point) => {
    const key = point.trackId === null ? "none" : String(point.trackId);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const dominantTrackEntry = Object.entries(chosenTrackCounts).sort((a, b) => b[1] - a[1])[0];
  const distinctTracksUsed = Object.keys(chosenTrackCounts).length;
  const reasonCounts = tracked.reduce<Record<string, number>>((acc, point) => {
    acc[point.reason] = (acc[point.reason] ?? 0) + 1;
    return acc;
  }, {});
  const totalTrackedPoints = tracked.length || 1;
  const primaryDominanceRatio = dominantTrackEntry ? dominantTrackEntry[1] / totalTrackedPoints : 0;
  const firstCropX = smoothX[0] ?? (dims.width - cropWidth) / 2;
  const lastCropX = smoothX[smoothX.length - 1] ?? firstCropX;
  const shotHoldsCount = shots.filter((s) => s.type === "hold").length;
  const shotMovesCount = shots.filter((s) => s.type === "move").length;
  const subjectLeft = subjectLogs.filter((s) => s.side === "left").length;
  const subjectRight = subjectLogs.filter((s) => s.side === "right").length;
  const subjectCenter = subjectLogs.filter((s) => s.side === "center").length;

  // Grid-specific mode selection (compute before logging)
  let gridMode: FramingPlan["gridMode"] = null;
  if (layout === "panel" && isGridMulti) {
    const activeFaces = trackedSamples.reduce((acc, s) => acc + s.faces.length, 0) / Math.max(1, trackedSamples.length);
    const strongDominance = primaryDominanceRatio > 0.7;
    if (activeFaces >= 3.5 && !strongDominance) {
      gridMode = "grid_full";
    } else if (!strongDominance) {
      gridMode = "grid_pan";
    } else {
      gridMode = "grid_panel_highlight";
    }
  }
  console.log(
    `[facetrack] facesAvg=${avgVisibleFaces.toFixed(2)} profile=${profile} layout=${layout} cols=${columns} rows=${rows} panels=${panelRegions.length} isGridMulti=${isGridMulti} dominantTrack=${dominantTrackEntry ? dominantTrackEntry[0] : "none"} trackFrames=${dominantTrackEntry ? dominantTrackEntry[1] : 0} reasons=${Object.entries(reasonCounts)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(",")} cropW=${cropWidth} cropH=${cropHeight} x0=${Math.round(firstCropX)} x1=${Math.round(lastCropX)} shotsHold=${shotHoldsCount} shotsMove=${shotMovesCount} subjectsL=${subjectLeft} subjectsR=${subjectRight} subjectsC=${subjectCenter} switchesAccepted=${debug.switchesAccepted} switchesRejected=${debug.switchesRejected} jitterSuppressed=${debug.jitterSuppressed} keyframesMerged=${debug.keyframesMerged} holdSegmentsCount=${holdSegmentsCount} moveSegmentsCount=${moveSegmentsCount} totalDistinctTracksUsed=${distinctTracksUsed} avgHold=${averageHoldDuration.toFixed(2)} longestHold=${longestHoldDuration.toFixed(2)} turnCandidates=${debug.turnCandidates} turnAccepted=${debug.turnAccepted} turnSuppressed=${debug.turnSuppressed}`,
  );

  console.log(
    `[facetrack] summary tracksInShots=${uniqueTrackIdsInShots.join("|")} tracksInKeyframes=${uniqueTrackIdsInKeyframes.join("|")} switchesAccepted=${debug.switchesAccepted} switchesRejected=${debug.switchesRejected} moveSegments=${moveSegmentsCount} holdSegments=${holdSegmentsCount} totalDistinctTracksUsed=${distinctTracksUsed} avgHold=${averageHoldDuration.toFixed(2)} longestHold=${longestHoldDuration.toFixed(2)} turnCandidates=${debug.turnCandidates} turnAccepted=${debug.turnAccepted} turnSuppressed=${debug.turnSuppressed} gridMode=${gridMode ?? "none"} isGridMulti=${isGridMulti}`,
  );

  console.log(
    `[facetrack] clipSummary uniqueTracksKeyframes=${uniqueTrackIdsInKeyframes.join("|")} uniqueTracksShots=${uniqueTrackIdsInShots.join("|")} longestHold=${longestHoldDuration.toFixed(2)} switchesAccepted=${debug.switchesAccepted} switchesRejected=${debug.switchesRejected} primaryDominanceRatio=${primaryDominanceRatio.toFixed(2)} panelSelectionCount=${panelSelectionCount} speakerSelectionCount=${speakerSelectionCount}`,
  );

  const mode =
    layout === "panel"
      ? "multi-face"
      : profile === "single"
        ? "single-face"
        : profile === "dual"
          ? "two-face"
          : "multi-face";


  const dominantTrack =
    dominantTrackEntry && dominantTrackEntry[0] !== "none"
      ? Number(dominantTrackEntry[0])
      : null;

  const result = {
    filter,
    mode,
    confidence,
  } satisfies ActiveSpeakerCropResult;

  const plan: FramingPlan = {
    mode,
    gridMode,
    confidence,
    cropWidth,
    keyframes,
    dominantTrack: Number.isFinite(dominantTrack ?? Number.NaN) ? dominantTrack : null,
    fallback: false,
    filter,
    layoutType: layout,
    layoutColumns: columns,
    layoutRows: rows,
    shots,
    stageAnchors,
    dualAnchors,
  };

  console.log(
    `[facetrack] framing plan mode=${mode} layout=${layout} keyframes=${keyframes.length} dominantTrack=${dominantTrack ?? "none"} confidence=${confidence.toFixed(2)} filter=${filter} holdSegments=${holdSegmentsCount} moveSegments=${moveSegmentsCount} gridMode=${gridMode ?? "none"} isGridMulti=${isGridMulti} panelCount=${panelRegions.length}`,
  );

  return { result, plan };
};

const staticCenterPlan = (
  targetWidth: number,
  targetHeight: number,
  layout: LayoutType,
  columns?: number,
  rows?: number,
): { result: ActiveSpeakerCropResult; plan: FramingPlan } => {
  const result = {
    filter: `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}`,
    mode: "static-center",
    confidence: 0,
  } satisfies ActiveSpeakerCropResult;

  return {
    result,
    plan: {
      mode: result.mode,
      confidence: result.confidence,
      cropWidth: targetWidth,
      keyframes: [],
      dominantTrack: null,
      fallback: true,
      filter: result.filter,
      layoutType: layout,
      layoutColumns: columns,
      layoutRows: rows,
    },
  };
};

export const analyzeFramingPlan = (
  videoPath: string,
  targetWidth: number,
  targetHeight: number,
  subtitlePath?: string,
): FramingPlan => {
  const tracked = getFaceTrackingCrop(videoPath, targetWidth, targetHeight, subtitlePath);
  if (tracked) {
    return tracked.plan;
  }
  return staticCenterPlan(targetWidth, targetHeight, "stage").plan;
};

export const framingPlanToFilter = (plan: FramingPlan): string => {
  return plan.filter;
};

export const detectBestCrop = (
  videoPath: string,
  targetAspect: number,
): CropBox | null => {
  const dims = getVideoDimensions(videoPath);
  if (!dims) return null;
  const { width, height } = dims;
  const cropW = Math.min(width, Math.round(height * targetAspect));
  const cropX = Math.max(0, Math.round((width - cropW) / 2));
  return { x: cropX, y: 0, w: cropW, h: height };
};

export const detectActiveSpeakerCrop = (
  videoPath: string,
  targetWidth: number,
  targetHeight: number,
  subtitlePath?: string,
): ActiveSpeakerCropResult => {
  const tracked = getFaceTrackingCrop(videoPath, targetWidth, targetHeight, subtitlePath);
  if (tracked) {
    return tracked.result;
  }
  return staticCenterPlan(targetWidth, targetHeight, "stage").result;
};
