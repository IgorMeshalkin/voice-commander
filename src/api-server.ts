import { createReadStream } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";
import { calculateTaskStatus, type CreateTaskEntity, type DatabaseService } from "./database.js";

const API_HOST = "0.0.0.0";
const API_PORT = 18_081;
const PAGE_SIZE = 20;
const AUDIO_DIR = process.env.VOICE_RECORDINGS_DIR ?? "/recordings";
const TRANSCRIPTIONS_DIR = process.env.VOICE_TRANSCRIPTIONS_DIR ?? "/transcriptions";
const REVIEWS_DIR = process.env.VOICE_REVIEWS_DIR ?? "/reviews";

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65_536) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isIsoDate(value: string | null): boolean {
  if (value === null) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export class ApiServer {
  private server: Server | null = null;

  constructor(private readonly database: DatabaseService) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(API_PORT, API_HOST, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
    console.log(`HTTP API готов на порту ${API_PORT}`);
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${API_HOST}:${API_PORT}`);
      if (request.method === "POST" && url.pathname === "/tasks") {
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch {
          sendJson(response, 400, { error: "Request body must be valid JSON" });
          return;
        }
        const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
        const title = typeof input.title === "string" ? input.title.trim() : "";
        const description = typeof input.description === "string" ? input.description.trim() : "";
        const audioFileId = typeof input.audioFileId === "string" ? input.audioFileId : "";
        const links = Array.isArray(input.links)
          ? [...new Set(input.links.filter((link): link is string => typeof link === "string").map((link) => link.trim()).filter(Boolean))]
          : [];
        const parseOptionalDate = (value: unknown): Date | null | undefined => {
          if (value === null || value === "" || value === undefined) return null;
          if (typeof value !== "string") return undefined;
          const date = new Date(value);
          return Number.isNaN(date.valueOf()) ? undefined : date;
        };
        const scheduledAt = parseOptionalDate(input.scheduledAt);
        const deadlineAt = parseOptionalDate(input.deadlineAt);
        const estimateDays = input.estimateDays === undefined ? 0 : Number(input.estimateDays);
        if (!title || title.length > 160 || !description || description.length > 4000) {
          sendJson(response, 400, { error: "title and description are required" });
          return;
        }
        if (!/^[0-9a-f-]{36}$/i.test(audioFileId) || !(await this.database.getAudioFile(audioFileId))) {
          sendJson(response, 400, { error: "audioFileId must reference an existing audio file" });
          return;
        }
        if (links.length > 20 || links.some((link) => link.length > 2000) || scheduledAt === undefined || deadlineAt === undefined
          || !Number.isInteger(estimateDays) || estimateDays < 0 || estimateDays > 15) {
          sendJson(response, 400, { error: "Invalid task fields" });
          return;
        }
        const entity: CreateTaskEntity = { title, description, links, audioFileId, scheduledAt, deadlineAt, estimateDays };
        const task = await this.database.createTask(entity);
        sendJson(response, 201, { ...task, status: calculateTaskStatus(task) });
        return;
      }
      const taskMatch = url.pathname.match(/^\/tasks\/([0-9a-f-]{36})$/i);
      if (request.method === "PATCH" && taskMatch) {
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch {
          sendJson(response, 400, { error: "Request body must be valid JSON" });
          return;
        }
        const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
        let task;
        if (typeof input.isCompleted === "boolean" && !("title" in input)) {
          task = await this.database.updateTaskCompleted(taskMatch[1], input.isCompleted);
        } else {
          const title = typeof input.title === "string" ? input.title.trim() : "";
          const description = typeof input.description === "string" ? input.description.trim() : "";
          const links = Array.isArray(input.links)
            ? [...new Set(input.links.filter((link): link is string => typeof link === "string").map((link) => link.trim()).filter(Boolean))]
            : [];
          const parseDate = (value: unknown): Date | null | undefined => {
            if (value === null || value === "" || value === undefined) return null;
            if (typeof value !== "string") return undefined;
            const date = new Date(value);
            return Number.isNaN(date.valueOf()) ? undefined : date;
          };
          const scheduledAt = parseDate(input.scheduledAt);
          const deadlineAt = parseDate(input.deadlineAt);
          const estimateDays = Number(input.estimateDays);
          if (!title || title.length > 160 || !description || description.length > 4000
            || links.length > 20 || links.some((link) => link.length > 2000)
            || scheduledAt === undefined || deadlineAt === undefined
            || !Number.isInteger(estimateDays) || estimateDays < 0 || estimateDays > 15) {
            sendJson(response, 400, { error: "Invalid task fields" });
            return;
          }
          task = await this.database.updateTask(taskMatch[1], { title, description, links, scheduledAt, deadlineAt, estimateDays });
        }
        if (!task) {
          sendJson(response, 404, { error: "Task not found" });
          return;
        }
        sendJson(response, 200, { ...task, status: calculateTaskStatus(task) });
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/audio-files") {
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch {
          sendJson(response, 400, { error: "Request body must be valid JSON" });
          return;
        }
        const ids = typeof body === "object" && body !== null && "ids" in body && Array.isArray(body.ids)
          ? [...new Set(body.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))]
          : [];
        if (!ids.length || ids.length > 100) {
          sendJson(response, 400, { error: "ids must contain 1 to 100 UUIDs" });
          return;
        }
        const files = await this.database.getAudioFilesByIds(ids);
        const removeIfPresent = async (path: string): Promise<void> => {
          try { await unlink(path); } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        };
        for (const file of files) {
          if (basename(file.filename) !== file.filename) continue;
          const stem = basename(file.filename, extname(file.filename));
          await Promise.all([
            removeIfPresent(join(AUDIO_DIR, file.filename)),
            removeIfPresent(join(TRANSCRIPTIONS_DIR, `${stem}.txt`)),
            removeIfPresent(join(REVIEWS_DIR, `${stem}.md`)),
          ]);
        }
        const deleted = await this.database.deleteAudioFiles(files.map((file) => file.id));
        sendJson(response, 200, { deleted });
        return;
      }
      const audioFileMatch = url.pathname.match(/^\/audio-files\/([0-9a-f-]{36})$/i);
      if (request.method === "PATCH" && audioFileMatch) {
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch {
          sendJson(response, 400, { error: "Request body must be valid JSON" });
          return;
        }
        const alias = typeof body === "object" && body !== null && "alias" in body && typeof body.alias === "string"
          ? body.alias.trim()
          : "";
        if (!alias || alias.length > 160) {
          sendJson(response, 400, { error: "alias must contain 1 to 160 characters" });
          return;
        }
        const updated = await this.database.updateAudioFileAlias(audioFileMatch[1], alias);
        if (!updated) {
          sendJson(response, 404, { error: "Audio file not found" });
          return;
        }
        sendJson(response, 200, { id: audioFileMatch[1], alias });
        return;
      }
      if (request.method !== "GET") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      if (url.pathname === "/tasks/nearest-status") {
        const task = await this.database.getNearestActiveTask();
        sendJson(response, 200, task
          ? { taskId: task.id, status: calculateTaskStatus(task) }
          : { taskId: null, status: null });
        return;
      }

      if (audioFileMatch) {
        const file = await this.database.getAudioFile(audioFileMatch[1]);
        if (!file) {
          sendJson(response, 404, { error: "Audio file not found" });
          return;
        }
        sendJson(response, 200, file);
        return;
      }

      if (url.pathname === "/tasks") {
        const page = Number(url.searchParams.get("page") ?? "1");
        const sort = url.searchParams.get("sort") ?? "asc";
        const dateFrom = url.searchParams.get("dateFrom");
        const dateTo = url.searchParams.get("dateTo");
        const search = url.searchParams.get("search")?.trim() || null;
        const state = url.searchParams.get("state") ?? "all";
        if (!Number.isInteger(page) || page < 1 || (sort !== "asc" && sort !== "desc")) {
          sendJson(response, 400, { error: "Invalid pagination or sort" });
          return;
        }
        if (!isIsoDate(dateFrom) || !isIsoDate(dateTo) || (dateFrom && dateTo && dateFrom > dateTo)) {
          sendJson(response, 400, { error: "Invalid date range" });
          return;
        }
        if (search && search.length > 200) {
          sendJson(response, 400, { error: "search must not exceed 200 characters" });
          return;
        }
        if (state !== "all" && state !== "in_progress" && state !== "done" && state !== "dead") {
          sendJson(response, 400, { error: "state must be all, in_progress, done or dead" });
          return;
        }
        const result = await this.database.listTasks(page, PAGE_SIZE, sort, dateFrom, dateTo, search, state);
        sendJson(response, 200, {
          items: result.items.map((task) => ({ ...task, status: calculateTaskStatus(task) })),
          pagination: {
            page,
            pageSize: PAGE_SIZE,
            totalItems: result.totalItems,
            totalPages: Math.ceil(result.totalItems / PAGE_SIZE),
          },
          sort: { field: "scheduledAt", direction: sort },
          filters: { dateFrom, dateTo, search, state },
        });
        return;
      }

      const resourceMatch = url.pathname.match(
        /^\/audio-files\/([0-9a-f-]{36})\/(audio|transcription|review)$/i,
      );
      if (resourceMatch) {
        const [, id, resource] = resourceMatch;
        await this.sendAudioFileResource(id, resource, request, response);
        return;
      }

      if (url.pathname !== "/audio-files") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const page = Number(url.searchParams.get("page") ?? "1");
      const sort = url.searchParams.get("sort") ?? "desc";
      const dateFrom = url.searchParams.get("dateFrom");
      const dateTo = url.searchParams.get("dateTo");
      const search = url.searchParams.get("search")?.trim() || null;
      if (!Number.isInteger(page) || page < 1) {
        sendJson(response, 400, { error: "page must be a positive integer" });
        return;
      }
      if (sort !== "asc" && sort !== "desc") {
        sendJson(response, 400, { error: "sort must be asc or desc" });
        return;
      }
      if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
        sendJson(response, 400, { error: "dateFrom and dateTo must use YYYY-MM-DD" });
        return;
      }
      if (dateFrom && dateTo && dateFrom > dateTo) {
        sendJson(response, 400, { error: "dateFrom must not be later than dateTo" });
        return;
      }
      if (search && search.length > 200) {
        sendJson(response, 400, { error: "search must not exceed 200 characters" });
        return;
      }

      const result = await this.database.listAudioFiles(page, PAGE_SIZE, sort, dateFrom, dateTo, search);
      sendJson(response, 200, {
        items: result.items,
        pagination: {
          page,
          pageSize: PAGE_SIZE,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / PAGE_SIZE),
          totalSizeBytes: result.totalSizeBytes,
        },
        sort: { field: "savedAt", direction: sort },
        filters: { dateFrom, dateTo, search },
      });
    } catch (error: unknown) {
      console.error("Ошибка HTTP API:", error instanceof Error ? error.message : error);
      sendJson(response, 500, { error: "Internal server error" });
    }
  }

  private async sendAudioFileResource(
    id: string,
    resource: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const file = await this.database.getAudioFile(id);
    if (!file || basename(file.filename) !== file.filename) {
      sendJson(response, 404, { error: "Audio file not found" });
      return;
    }
    const stem = basename(file.filename, extname(file.filename));
    if (resource === "audio") {
      await this.streamAudio(join(AUDIO_DIR, file.filename), request, response);
      return;
    }
    if (!file.isReviewed) {
      sendJson(response, 409, { error: "AI review is not ready" });
      return;
    }
    try {
      const markdown = await readFile(join(REVIEWS_DIR, `${stem}.md`), "utf8");
      const sections = this.splitReview(markdown);
      sendJson(response, 200, {
        content: resource === "transcription" ? sections.transcription : sections.review,
        proposals: resource === "review" ? sections.proposals : undefined,
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(response, 404, { error: "Reviewed text file not found" });
        return;
      }
      throw error;
    }
  }

  private splitReview(markdown: string): {
    transcription: string;
    review: string;
    proposals: Array<{ title: string; description: string; links: string[]; scheduledAt: string | null; deadlineAt: string | null }>;
  } {
    const lines = markdown.split(/\r?\n/);
    const transcriptionIndex = lines.findIndex((line) => line.trim() === "# Транскрипция");
    const reviewIndex = lines.findIndex((line) => line.trim() === "# Review");
    const proposalsIndex = lines.findIndex((line) =>
      line.trim() === "# Предложения по созданию задач" ||
      line.trim() === "# Предложения по созданию заданий"
    );
    if (transcriptionIndex < 0 || reviewIndex <= transcriptionIndex) {
      throw new Error("Invalid reviewed Markdown structure");
    }
    const proposalSource = proposalsIndex > reviewIndex ? lines.slice(proposalsIndex + 1).join("\n") : "";
    const field = (block: string, label: string): string =>
      block.match(new RegExp(`^${label}:[ \\t]*([^\\r\\n]*)$`, "mi"))?.[1]?.trim() ?? "";
    const proposals = proposalSource.split(/^### Задача\s*$/gmi).slice(1).flatMap((block) => {
      const title = field(block, "Название");
      const description = field(block, "Описание");
      if (!title || !description) return [];
      const parseDate = (value: string): string | null => value && !Number.isNaN(new Date(value).valueOf()) ? value : null;
      return [{
        title,
        description,
        links: field(block, "Ссылки").split(",").map((link) => link.trim()).filter(Boolean),
        scheduledAt: parseDate(field(block, "Желательное время выполнения")),
        deadlineAt: parseDate(field(block, "Жёсткий дедлайн")),
      }];
    });
    return {
      transcription: lines.slice(transcriptionIndex, reviewIndex).join("\n").trim(),
      review: lines.slice(reviewIndex, proposalsIndex > reviewIndex ? proposalsIndex : undefined).join("\n").trim(),
      proposals,
    };
  }

  private async streamAudio(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const info = await stat(path);
      const range = request.headers.range;
      if (!range) {
        response.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": info.size,
          "Accept-Ranges": "bytes",
        });
        createReadStream(path).pipe(response);
        return;
      }
      const match = range.match(/^bytes=(\d+)-(\d*)$/);
      if (!match) {
        response.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end();
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      if (start > end || start >= info.size) {
        response.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end();
        return;
      }
      response.writeHead(206, {
        "Content-Type": "audio/wav",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Accept-Ranges": "bytes",
      });
      createReadStream(path, { start, end }).pipe(response);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(response, 404, { error: "Audio file not found" });
        return;
      }
      throw error;
    }
  }
}
