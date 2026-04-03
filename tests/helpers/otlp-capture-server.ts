import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { OTLP_PATH } from "../../src/_core/constants.js";

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  contentType: string | undefined;
  rawBody: string;
  parsedPayload: unknown;
}

export interface OtlpCaptureServer {
  port: number;
  baseUrl: string;
  requests: CapturedRequest[];
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
  waitForRequests(count: number, timeoutMs?: number): Promise<CapturedRequest[]>;
  lastPayload(): unknown | undefined;
}

const OTLP_LOGS_PATH = `${OTLP_PATH}/v1/logs`;

export function createOtlpCaptureServer(): OtlpCaptureServer {
  let server: Server;
  let port = 0;
  const requests: CapturedRequest[] = [];
  let requestResolvers: Array<() => void> = [];

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));

    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf-8");
      let parsedPayload: unknown = null;

      try {
        parsedPayload = JSON.parse(rawBody);
      } catch {
        parsedPayload = null;
      }

      const captured: CapturedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        contentType: req.headers["content-type"],
        rawBody,
        parsedPayload,
      };

      requests.push(captured);

      for (const resolve of requestResolvers) {
        resolve();
      }
      requestResolvers = [];

      if (req.url === OTLP_LOGS_PATH && req.method === "POST") {
        const response = JSON.stringify({
          id: `capture-${Date.now()}`,
          resourceType: "logs",
          processedEvents: 1,
          created: new Date().toISOString(),
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(response);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });
  }

  return {
    get port() {
      return port;
    },
    get baseUrl() {
      return `http://127.0.0.1:${port}`;
    },
    requests,

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createServer(handleRequest);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            port = addr.port;
          }
          resolve();
        });
        server.on("error", reject);
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },

    reset(): void {
      requests.length = 0;
      requestResolvers = [];
    },

    waitForRequests(count: number, timeoutMs = 5000): Promise<CapturedRequest[]> {
      if (requests.length >= count) {
        return Promise.resolve(requests.slice(0, count));
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Timeout waiting for ${count} requests, received ${requests.length} after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);

        const check = () => {
          if (requests.length >= count) {
            clearTimeout(timer);
            resolve(requests.slice(0, count));
          } else {
            requestResolvers.push(check);
          }
        };

        requestResolvers.push(check);
      });
    },

    lastPayload(): unknown | undefined {
      if (requests.length === 0) return undefined;
      return requests[requests.length - 1].parsedPayload;
    },
  };
}
