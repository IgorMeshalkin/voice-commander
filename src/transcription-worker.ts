import { access, readdir, rename, unlink } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, extname, join } from "node:path";
import { DatabaseService } from "./database.js";

const AUDIO_DIR = process.env.VOICE_RECORDINGS_DIR ?? "/recordings";
const TRANSCRIPTIONS_DIR = process.env.VOICE_TRANSCRIPTIONS_DIR ?? "/transcriptions";
const WHISPER_CLI_PATH =
  process.env.WHISPER_CLI_PATH ?? "/app/vendor/whisper.cpp/build/bin/whisper-cli";
const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ??
  "/app/vendor/whisper.cpp/models/ggml-small-q5_1.bin";
const SCAN_INTERVAL_MS = 10_000;

let running = true;
let recognitionProcess: ChildProcess | null = null;
const synchronizedFiles = new Set<string>();

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function transcribe(filename: string, database: DatabaseService): Promise<void> {
  const stem = basename(filename, extname(filename));
  const audioPath = join(AUDIO_DIR, filename);
  const finalOutputPath = join(TRANSCRIPTIONS_DIR, `${stem}.txt`);
  if (await exists(finalOutputPath)) {
    await database.markAudioFileTranscribed(filename);
    return;
  }

  const temporaryOutputBase = join(TRANSCRIPTIONS_DIR, `.${stem}-${process.pid}`);
  const temporaryOutputPath = `${temporaryOutputBase}.txt`;
  console.log(`Фоновое распознавание началось: ${filename}`);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    recognitionProcess = spawn(
      "nice",
      [
        "-n",
        "15",
        WHISPER_CLI_PATH,
        "--model",
        WHISPER_MODEL_PATH,
        "--file",
        audioPath,
        "--language",
        "ru",
        "--threads",
        "1",
        "--processors",
        "1",
        "--beam-size",
        "1",
        "--best-of",
        "1",
        "--no-fallback",
        "--no-gpu",
        "--no-timestamps",
        "--output-txt",
        "--output-file",
        temporaryOutputBase,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    recognitionProcess.stderr?.setEncoding("utf8");
    recognitionProcess.stderr?.on("data", (message: string) => {
      if (message.trim()) console.error("whisper-worker:", message.trim());
    });
    recognitionProcess.once("error", reject);
    recognitionProcess.once("exit", resolve);
  }).finally(() => {
    recognitionProcess = null;
  });

  if (exitCode !== 0) {
    await unlink(temporaryOutputPath).catch(() => undefined);
    throw new Error(`whisper-cli завершился с кодом ${exitCode ?? "unknown"}`);
  }

  await rename(temporaryOutputPath, finalOutputPath);
  await database.markAudioFileTranscribed(filename);
  console.log(`Транскрипция сохранена: ${finalOutputPath}`);
}

async function processPendingFiles(database: DatabaseService): Promise<void> {
  const filenames = (await readdir(AUDIO_DIR))
    .filter((filename) => filename.toLowerCase().endsWith(".wav"))
    .sort();

  for (const filename of filenames) {
    if (!running) return;
    if (synchronizedFiles.has(filename)) continue;
    try {
      await transcribe(filename, database);
      synchronizedFiles.add(filename);
    } catch (error: unknown) {
      console.error(
        `Не удалось распознать ${filename}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

async function main(): Promise<void> {
  const database = new DatabaseService();
  console.log("Фоновый worker транскрипций запущен");
  try {
    while (running) {
      await processPendingFiles(database);
      if (!running) break;
      await new Promise((resolve) => setTimeout(resolve, SCAN_INTERVAL_MS));
    }
  } finally {
    await database.close();
  }
}

const shutdown = (): void => {
  running = false;
  recognitionProcess?.kill("SIGTERM");
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

main().catch((error: unknown) => {
  console.error("Фоновый worker остановлен:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
