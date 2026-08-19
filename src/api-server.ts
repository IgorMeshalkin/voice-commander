import { createServer, type Server, type ServerResponse } from "node:http";
import type { DatabaseService } from "./database.js";

const API_HOST = "0.0.0.0";
const API_PORT = 18_081;
const PAGE_SIZE = 10;

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export class ApiServer {
  private server: Server | null = null;

  constructor(private readonly database: DatabaseService) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handleRequest(request.url, request.method, response);
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
    requestUrl: string | undefined,
    method: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(requestUrl ?? "/", `http://${API_HOST}:${API_PORT}`);
      if (method !== "GET" || url.pathname !== "/audio-files") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const page = Number(url.searchParams.get("page") ?? "1");
      const sort = url.searchParams.get("sort") ?? "desc";
      if (!Number.isInteger(page) || page < 1) {
        sendJson(response, 400, { error: "page must be a positive integer" });
        return;
      }
      if (sort !== "asc" && sort !== "desc") {
        sendJson(response, 400, { error: "sort must be asc or desc" });
        return;
      }

      const result = await this.database.listAudioFiles(page, PAGE_SIZE, sort);
      sendJson(response, 200, {
        items: result.items,
        pagination: {
          page,
          pageSize: PAGE_SIZE,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / PAGE_SIZE),
        },
        sort: { field: "savedAt", direction: sort },
      });
    } catch (error: unknown) {
      console.error("Ошибка HTTP API:", error instanceof Error ? error.message : error);
      sendJson(response, 500, { error: "Internal server error" });
    }
  }
}
