import { Telegraf } from "telegraf";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SessionState, PipelineResult } from "./types";

// Simple in-memory sessions (MVP). For production, move to Redis/DB.
const sessions: SessionState = {};

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN not set");
}

// Disable webhook reply optimization to avoid Telegraf redactToken mutating readonly errors
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 60000 });
bot.telegram.webhookReply = false;

bot.catch((err, ctx) => {
  console.error("Bot error", err);
  if (ctx?.reply) {
    return ctx.reply("Hubo un error procesando tu mensaje. Intenta de nuevo.");
  }
});

const askConfig = async (ctx: any) => {
  await ctx.reply(
    "¿Cuántos minutos de intro quieres saltar? (ej: 0, 1, 2)",
  );
  await ctx.reply(
    "¿Cuántos clips quieres generar? (ej: 3)",
  );
  await ctx.reply(
    "Duración de los clips: 30, 45, 60 o 'auto'",
  );
};

const parseNumber = (text: string) => {
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : null;
};

const runPipeline = (
  url: string,
  skipMinutes: number,
  count: number,
  duration: "30" | "45" | "60" | "auto",
): Promise<PipelineResult> => {
  return new Promise((resolve, reject) => {
    const args = ["run", "short-url", url, "--count", String(count)];
    if (skipMinutes > 0) {
      args.push("--skip-start-seconds", String(skipMinutes * 60));
    }
    if (duration !== "auto") {
      args.push("--target-seconds", duration);
    }

    const proc = spawn("bun", args, {
      cwd: path.join(process.cwd()),
      env: process.env,
      stdio: "inherit",
    });

    proc.on("error", (err) => reject(err));
    proc.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`Pipeline exited with code ${code}`));

      const outputDir = path.join(process.cwd(), "output");
      // Metadata files per short-url flow
      const metadataPath = path.join(outputDir, "clips_metadata.json");
      if (!existsSync(metadataPath)) {
        return reject(new Error("No se encontró clips_metadata.json"));
      }

      const clips: string[] = [];
      for (let i = 1; i <= count; i++) {
        const base = String(i).padStart(2, "0");
        const finalClip = path.join(outputDir, `clip_${base}-final.mp4`);
        const rawClip = path.join(outputDir, `clip_${base}.mp4`);
        const captionedClip = path.join(process.cwd(), "out", `clip_${base}-captioned.mp4`);
        if (existsSync(finalClip)) {
          clips.push(finalClip);
        } else if (existsSync(captionedClip)) {
          clips.push(captionedClip);
        } else if (existsSync(rawClip)) {
          clips.push(rawClip);
        }
      }

      resolve({ clips, metadataPath });
    });
  });
};

bot.start((ctx) => ctx.reply("Envíame un link de YouTube para generar clips."));

const processRequest = async (chatId: number, session: any, ctx: any) => {
  try {
    const result = await runPipeline(
      session.url!,
      session.skipIntroMinutes ?? 0,
      session.count ?? 1,
      session.duration,
    );
    sessions[chatId] = { processing: false };

    if (!ctx?.telegram) return;
    await ctx.telegram.sendMessage(chatId, "Clips listos. Enviando metadata y enlaces locales.");

    let parsedMeta: { clips: any[] } | null = null;
    if (existsSync(result.metadataPath)) {
      const metaRaw = readFileSync(result.metadataPath, "utf8");
      try {
        parsedMeta = JSON.parse(metaRaw) as { clips: any[] };
      } catch (err) {
        console.warn("No se pudo parsear metadata JSON, enviando archivo.", err);
        await ctx.telegram.sendDocument(chatId, {
          source: result.metadataPath,
          filename: path.basename(result.metadataPath),
        });
      }
    }

    // Send each clip as video, then metadata text
    for (let idx = 0; idx < result.clips.length; idx++) {
      const clipPath = result.clips[idx];
      const clipMeta = parsedMeta?.clips?.find((c) => c.clipNumber === idx + 1) ?? null;
      await ctx.telegram.sendVideo(chatId, {
        source: clipPath,
        filename: path.basename(clipPath),
      }, {
        supports_streaming: true,
      });

      const title = clipMeta?.title ?? "";
      const description = clipMeta?.description ?? "";
      const hashtags = Array.isArray(clipMeta?.hashtags)
        ? clipMeta!.hashtags.join(" ")
        : "";
      const text = `🎬 Clip ${idx + 1}\n📝 Título: ${title}\n💬 Descripción: ${description}\n#️⃣ Hashtags: ${hashtags}`;
      await ctx.telegram.sendMessage(chatId, text.trim());
    }
  } catch (error) {
    sessions[chatId] = { processing: false };
    console.error(error);
    if (ctx?.telegram) {
      await ctx.telegram.sendMessage(chatId, `Error: ${(error as Error).message}`);
    }
  }
};

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text: string = ctx.message.text.trim();

  // If awaiting config answers
  const session = sessions[chatId] ?? {};

  // If we already have a URL but missing parameters, parse answers
  if (session.url && !session.processing) {
    if (session.skipIntroMinutes === undefined) {
      const n = parseNumber(text);
      if (n === null) return ctx.reply("Valor inválido. Indica minutos de intro a saltar.");
      session.skipIntroMinutes = n;
      sessions[chatId] = session;
      return ctx.reply("¿Cuántos clips quieres generar? (ej: 3)");
    }
    if (session.count === undefined) {
      const n = parseNumber(text);
      if (n === null || n < 1 || n > 100) {
        return ctx.reply("Valor inválido. Indica un número entre 1 y 100.");
      }
      session.count = n;
      sessions[chatId] = session;
      return ctx.reply("Duración: 30, 45, 60 o 'auto'");
    }
    if (session.duration === undefined) {
      const val = text.toLowerCase();
      if (!["30", "45", "60", "auto"].includes(val)) {
        return ctx.reply("Elige 30, 45, 60 o 'auto'.");
      }
      session.duration = val as "30" | "45" | "60" | "auto";
      sessions[chatId] = session;

      // Launch pipeline asynchronously to avoid Telegraf 90s timeout
      ctx.reply("Procesando... esto puede tardar unos minutos.");
      session.processing = true;
      sessions[chatId] = session;
      setImmediate(() => processRequest(chatId, session, ctx));
      return;
    }
  }

  // New URL entry
  if (text.startsWith("http")) {
    sessions[chatId] = { url: text };
    await ctx.reply("Recibí el link. Vamos a configurar:");
    return askConfig(ctx);
  }

  return ctx.reply("Envíame un link de YouTube para comenzar.");
});

bot.launch().then(() => console.log("Bot iniciado"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
