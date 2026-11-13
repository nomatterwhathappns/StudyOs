import express from "express";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ResolvedAiConnection } from "@shared/ai-connections";

const { getActiveConnection, streamConnection } = vi.hoisted(() => ({
  getActiveConnection: vi.fn(),
  streamConnection: vi.fn(),
}));
vi.mock("./ai/connection-store", () => ({ getActiveConnection }));
vi.mock("./ai/transport", () => ({
  streamConnection,
  invokeConnection: vi.fn(),
  testConnection: vi.fn(),
  discoverModels: vi.fn(),
}));
import {
  normalizeStreamPayload,
  registerStudyChatStream,
  streamErrorMessage,
} from "./studyChatStream";

const connection: ResolvedAiConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "My server",
  protocol: "openai-chat",
  baseUrl: "http://localhost:9000/v1",
  model: "custom-model",
  authType: "none",
  authHeader: "x-api-key",
  extraHeaders: {},
  stream: true,
  timeoutMs: 90000,
  maxOutputTokens: 8192,
  tokenParameter: "auto",
  jsonMode: "prompt",
  createdAt: "2026-11-13T00:00:00.000Z",
  updatedAt: "2026-11-13T00:00:00.000Z",
};
const input = {
  sessionName: "Cloud",
  materials: "[Source: Notes · part 1]\nA source.",
  translate: false,
  responseStyle: "Balanced",
  model: "active",
  history: [{ role: "user", content: "Explain." }],
};
let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerStudyChatStream(app);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server port");
  url = `http://127.0.0.1:${address.port}/api/study/chat-stream`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  getActiveConnection.mockReset().mockResolvedValue(connection);
  streamConnection
    .mockReset()
    .mockImplementation(async (_connection, _messages, _options, emit) => {
      emit("A grounded answer.");
      return {
        text: "A grounded answer. [Source: Notes · part 1]",
        truncated: false,
        provider: "My server · custom-model",
      };
    });
});
async function post(
  body: unknown = input,
  headers: Record<string, string> = {}
) {
  return new Promise<string>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => {
          text += chunk;
        });
        response.on("end", () => resolve(text));
        response.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("configured-connection chat streaming", () => {
  it("normalizes oversized materials and history while preserving Continue", () => {
    const normalized = normalizeStreamPayload({
      ...input,
      continueAnswer: true,
      materials: "x".repeat(18000),
      history: [
        { role: "assistant", content: "  " },
        { role: "user", content: " Explain " },
        { role: "assistant", content: 44 },
      ],
    }) as typeof input & { continueAnswer: boolean };
    expect(normalized.materials).toHaveLength(10000);
    expect(normalized.history).toEqual([{ role: "user", content: "Explain" }]);
    expect(normalized.continueAnswer).toBe(true);
  });
  it("streams the selected connection, citations and actual provider", async () => {
    const output = await post();
    expect(output).toContain(
      'event: meta\ndata: {"provider":"My server · custom-model"'
    );
    expect(output).toContain(
      'event: token\ndata: {"token":"A grounded answer."}'
    );
    expect(output).toContain('"text":"A grounded answer."');
    expect(output).toContain('"citations":[{"title":"Notes","ordinal":1}]');
    expect(output).toContain('"truncated":false');
    expect(getActiveConnection).toHaveBeenCalledTimes(1);
    expect(streamConnection.mock.calls[0][0]).toBe(connection);
    expect(streamConnection.mock.calls[0][2]).toMatchObject({
      maxTokens: 2400,
      timeoutMs: 90000,
    });
  });
  it("preserves truncation and supplies continuation instructions without changing connection", async () => {
    streamConnection.mockResolvedValueOnce({
      text: "Partial",
      truncated: true,
      provider: "My server · custom-model",
    });
    const output = await post({ ...input, continueAnswer: true });
    expect(output).toContain('"truncated":true');
    expect(streamConnection.mock.calls[0][1].at(-1).content).toContain(
      "Continue the immediately preceding answer"
    );
    expect(getActiveConnection).toHaveBeenCalledTimes(1);
  });
  it("does not read credentials for invalid or stale client-selected models", async () => {
    expect(await post({ ...input, model: "old-provider" })).toContain(
      "event: error"
    );
    expect(getActiveConnection).not.toHaveBeenCalled();
    expect(streamConnection).not.toHaveBeenCalled();
  });
  it("rejects a rebinding Host and cross-site browser before reading credentials", async () => {
    expect(await post(input, { host: "attacker.example" })).toContain(
      "event: error"
    );
    expect(await post(input, { origin: "https://attacker.example" })).toContain(
      "event: error"
    );
    expect(getActiveConnection).not.toHaveBeenCalled();
  });
  it("preserves actionable connection and quota errors without fallback calls", async () => {
    getActiveConnection.mockRejectedValueOnce(
      new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Choose an active AI connection in Profile.",
      })
    );
    expect(await post()).toContain(
      "Choose an active AI connection in Profile."
    );
    expect(streamConnection).not.toHaveBeenCalled();
    streamConnection.mockRejectedValueOnce(
      new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "AI service rate limit (429).",
      })
    );
    expect(await post()).toContain("AI service rate limit (429).");
    expect(streamConnection).toHaveBeenCalledTimes(1);
  });
  it("aborts the upstream request when the client disconnects", async () => {
    let aborted: (() => void) | undefined;
    const observed = new Promise<void>(resolve => {
      aborted = resolve;
    });
    streamConnection.mockImplementationOnce(
      async (_connection, _messages, options, emit) => {
        emit("Starting");
        await new Promise<void>(resolve =>
          options.signal.addEventListener(
            "abort",
            () => {
              aborted?.();
              resolve();
            },
            { once: true }
          )
        );
        throw new TRPCError({
          code: "CLIENT_CLOSED_REQUEST",
          message: "Cancelled",
        });
      }
    );
    const controller = new AbortController();
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await observed;
    expect(streamConnection.mock.calls[0][2].signal.aborted).toBe(true);
  });
  it("sanitizes unknown failures while retaining validation and safe typed errors", () => {
    expect(streamErrorMessage(new Error("private-token-value"))).not.toContain(
      "private-token-value"
    );
    const parsed = z.string().min(1).safeParse("");
    if (parsed.success) throw new Error("Expected validation failure");
    expect(streamErrorMessage(parsed.error)).toMatch(/Konteks chat/);
    expect(
      streamErrorMessage(
        new TRPCError({
          code: "TIMEOUT",
          message: "Configured timeout exceeded.",
        })
      )
    ).toBe("Configured timeout exceeded.");
  });
});
