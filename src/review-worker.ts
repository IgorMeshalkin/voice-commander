import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { access, chmod, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { DatabaseService, type AudioFileForReview } from "./database.js";

const TRANSCRIPTIONS_DIR =
  process.env.VOICE_TRANSCRIPTIONS_DIR ??
  join(process.env.HOME ?? ".", "voice-commander", "transcriptions");
const REVIEWS_DIR =
  process.env.VOICE_REVIEWS_DIR ?? join(process.env.HOME ?? ".", "voice-commander", "reviews");
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const REVIEW_HOOK_SOCKET =
  process.env.REVIEW_HOOK_SOCKET ?? join(TRANSCRIPTIONS_DIR, ".review-worker.sock");

let running = true;
let codexProcess: ChildProcess | null = null;
const queue: AudioFileForReview[] = [];
const queuedIds = new Set<string>();
let wakeQueue: (() => void) | null = null;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function reviewPaths(filename: string): {
  transcriptionPath: string;
  reviewPath: string;
  temporaryReviewPath: string;
} {
  const stem = basename(filename, extname(filename));
  return {
    transcriptionPath: join(TRANSCRIPTIONS_DIR, `${stem}.txt`),
    reviewPath: join(REVIEWS_DIR, `${stem}.md`),
    temporaryReviewPath: join(REVIEWS_DIR, `.${stem}-${process.pid}.md`),
  };
}

function extractAlias(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const reviewHeading = lines.findIndex((line) => line.trim() === "# Review");
  if (reviewHeading < 0) throw new Error("В ревью отсутствует раздел # Review");
  const firstLine = lines.slice(reviewHeading + 1).find((line) => line.trim().length > 0)?.trim();
  const match = firstLine?.match(/^Alias:\s*(.+)$/);
  const alias = match?.[1].trim();
  if (!alias || alias.length > 160) {
    throw new Error("Первая строка раздела Review не содержит корректный Alias");
  }
  return alias;
}

async function runCodexReview(file: AudioFileForReview): Promise<string> {
  const { transcriptionPath, reviewPath, temporaryReviewPath } = reviewPaths(file.filename);
  if (await exists(reviewPath)) return extractAlias(await readFile(reviewPath, "utf8"));
  if (!(await exists(transcriptionPath))) {
    throw new Error(`Файл транскрипции не найден: ${transcriptionPath}`);
  }

  await unlink(temporaryReviewPath).catch(() => undefined);
  const prompt = [
    "Используй $audio-text-review.",
    `Обработай транскрипцию из файла: ${transcriptionPath}`,
    "Верни только итоговый Markdown. Первая непустая строка после # Review обязана иметь вид Alias: <осмысленное название>.",
    "После # Review добавь третий раздел верхнего уровня: # Предложения по созданию задач.",
    "Извлеки только реальные действия, которые пользователь должен выполнить в связи с записью. Не придумывай задачи или сроки.",
    "Для каждой найденной задачи используй строго такой формат:",
    "### Задача",
    "Название: <краткое название>",
    "Описание: <что именно нужно сделать>",
    "Ссылки: <ссылки через запятую или пусто>",
    "Желательное время выполнения: <ISO 8601 с часовым поясом или пусто>",
    "Жёсткий дедлайн: <ISO 8601 с часовым поясом или пусто>",
    "Если ни одной обоснованной задачи нет, оставь раздел без подразделов ### Задача.",
  ].join("\n");

  console.log(`Ревью началось: ${file.filename}`);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    codexProcess = spawn(
      "nice",
      [
        "-n",
        "15",
        CODEX_BIN,
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "-C",
        TRANSCRIPTIONS_DIR,
        "-o",
        temporaryReviewPath,
        prompt,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    codexProcess.stderr?.setEncoding("utf8");
    codexProcess.stderr?.on("data", (message: string) => {
      if (message.trim()) console.error("codex-review:", message.trim());
    });
    codexProcess.once("error", reject);
    codexProcess.once("exit", resolve);
  }).finally(() => {
    codexProcess = null;
  });

  if (exitCode !== 0) {
    await unlink(temporaryReviewPath).catch(() => undefined);
    throw new Error(`codex exec завершился с кодом ${exitCode ?? "unknown"}`);
  }
  const output = await stat(temporaryReviewPath);
  if (output.size === 0) {
    await unlink(temporaryReviewPath).catch(() => undefined);
    throw new Error("codex exec вернул пустое ревью");
  }
  const alias = extractAlias(await readFile(temporaryReviewPath, "utf8"));
  await rename(temporaryReviewPath, reviewPath);
  console.log(`Ревью сохранено: ${reviewPath}`);
  return alias;
}

async function processFile(database: DatabaseService, file: AudioFileForReview): Promise<void> {
  if (!(await database.markAudioFileReviewStarted(file.id))) return;
  try {
    const alias = await runCodexReview(file);
    await database.markAudioFileReviewed(file.id, alias);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await database.markAudioFileReviewFailed(file.id, message);
    console.error(`Не удалось создать ревью ${file.filename}:`, message);
  }
}

async function main(): Promise<void> {
  const database = new DatabaseService();
  await database.initialize();
  await mkdir(REVIEWS_DIR, { recursive: true });
  await unlink(REVIEW_HOOK_SOCKET).catch(() => undefined);

  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/review") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 4096) request.destroy();
    });
    request.on("end", () => {
      try {
        const event = JSON.parse(body) as Partial<AudioFileForReview>;
        if (
          typeof event.id !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(event.id) ||
          typeof event.filename !== "string" ||
          basename(event.filename) !== event.filename
        ) {
          throw new Error("invalid event");
        }
        if (!queuedIds.has(event.id)) {
          queuedIds.add(event.id);
          queue.push({ id: event.id, filename: event.filename });
          wakeQueue?.();
          wakeQueue = null;
        }
        response.writeHead(202).end();
      } catch {
        response.writeHead(400).end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(REVIEW_HOOK_SOCKET, resolve);
  });
  await chmod(REVIEW_HOOK_SOCKET, 0o600);
  console.log(`Фоновый worker ревью слушает hook: ${REVIEW_HOOK_SOCKET}`);

  try {
    while (running) {
      const file = queue.shift();
      if (!file) {
        await new Promise<void>((resolve) => {
          wakeQueue = resolve;
        });
        continue;
      }
      await processFile(database, file);
      queuedIds.delete(file.id);
    }
  } finally {
    server.close();
    await unlink(REVIEW_HOOK_SOCKET).catch(() => undefined);
    await database.close();
  }
}

const shutdown = (): void => {
  running = false;
  codexProcess?.kill("SIGTERM");
  wakeQueue?.();
  wakeQueue = null;
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

main().catch((error: unknown) => {
  console.error("Фоновый worker ревью остановлен:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
