import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAiConnection } from "../../shared/ai-connections";
import {
  discoverModels,
  invokeConnection,
  streamConnection,
  testConnection,
} from "./transport";

const servers: Server[] = [];
const messages = [
  { role: "system" as const, content: "You are a tutor." },
  { role: "user" as const, content: "Hello" },
  { role: "assistant" as const, content: "Hi" },
  { role: "user" as const, content: "Continue" },
];

function connection(
  overrides: Partial<ResolvedAiConnection> = {}
): ResolvedAiConnection {
  return {
    id: "7b929cc9-164a-4d2b-bac8-cdf45af7807b",
    name: "My service",
    protocol: "openai-chat",
    baseUrl: "https://provider.example/v1",
    model: "custom-model",
    authType: "bearer",
    authHeader: "x-api-key",
    apiKey: "super-secret-key",
    extraHeaders: {},
    stream: true,
    timeoutMs: 60000,
    maxOutputTokens: 4096,
    tokenParameter: "auto",
    jsonMode: "prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function completion(text = "Hello", finish = "stop") {
  return { choices: [{ message: { content: text }, finish_reason: finish }] };
}
function fetchResult(value: Response) {
  const fetchMock = vi.fn().mockResolvedValue(value);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function request(mock: ReturnType<typeof vi.fn>) {
  const [url, init] = mock.mock.calls[0] as [string, RequestInit];
  return {
    url,
    init,
    body: JSON.parse(String(init.body)),
    headers: new Headers(init.headers),
  };
}
function stream(
  text: string,
  sizes: number[] = [],
  contentType = "text/event-stream"
) {
  const encoded = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const size of sizes) {
          controller.enqueue(encoded.slice(offset, offset + size));
          offset += size;
        }
        if (offset < encoded.length) controller.enqueue(encoded.slice(offset));
        controller.close();
      },
    }),
    { headers: { "content-type": contentType } }
  );
}
async function localServer(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

describe("generic AI request formats", () => {
  it("preserves a version query, normalizes full endpoints and caps output tokens", async () => {
    const mock = fetchResult(json(completion("Ready", "length")));
    const result = await invokeConnection(
      connection({
        baseUrl:
          "https://provider.example/custom/chat/completions?api-version=2026-01",
        model: "gpt-5.2",
        maxOutputTokens: 1200,
      }),
      messages,
      { maxTokens: 2400, json: true }
    );
    expect(result).toEqual({
      text: "Ready",
      truncated: true,
      provider: "My service · gpt-5.2",
    });
    const sent = request(mock);
    expect(sent.url).toBe(
      "https://provider.example/custom/chat/completions?api-version=2026-01"
    );
    expect(sent.headers.get("authorization")).toBe("Bearer super-secret-key");
    expect(sent.body).toEqual({
      model: "gpt-5.2",
      messages,
      stream: false,
      max_completion_tokens: 1200,
    });
    expect(sent.init.redirect).toBe("error");
  });

  it("supports optional auth and explicit token parameter overrides", async () => {
    const mock = fetchResult(json(completion()));
    await invokeConnection(
      connection({
        authType: "none",
        extraHeaders: { "x-project": "learning" },
        tokenParameter: "none",
      }),
      messages,
      { maxTokens: 100 }
    );
    const sent = request(mock);
    expect(sent.headers.has("authorization")).toBe(false);
    expect(sent.headers.get("x-project")).toBe("learning");
    expect(sent.body).not.toHaveProperty("max_tokens");
    expect(sent.body).not.toHaveProperty("max_completion_tokens");
  });

  it("supports a custom authentication header and native JSON when requested", async () => {
    const mock = fetchResult(json(completion('{"answer":"yes"}')));
    await invokeConnection(
      connection({
        authType: "header",
        authHeader: "x-custom-token",
        jsonMode: "native",
        tokenParameter: "max_completion_tokens",
      }),
      messages,
      { maxTokens: 200, json: true }
    );
    const sent = request(mock);
    expect(sent.headers.get("x-custom-token")).toBe("super-secret-key");
    expect(sent.headers.has("authorization")).toBe(false);
    expect(sent.body.response_format).toEqual({ type: "json_object" });
    expect(sent.body.max_completion_tokens).toBe(200);
  });

  it("maps OpenAI Responses instructions, history and incomplete outputs", async () => {
    const mock = fetchResult(
      json({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "A response" }],
          },
        ],
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      })
    );
    await expect(
      invokeConnection(
        connection({
          protocol: "openai-responses",
          baseUrl: "https://provider.example/v1/responses",
          jsonMode: "native",
        }),
        messages,
        { maxTokens: 300, json: true }
      )
    ).resolves.toMatchObject({ text: "A response", truncated: true });
    const sent = request(mock);
    expect(sent.url).toBe("https://provider.example/v1/responses");
    expect(sent.body).toMatchObject({
      instructions: "You are a tutor.",
      input: messages.slice(1),
      max_output_tokens: 300,
      stream: false,
      text: { format: { type: "json_object" } },
    });
  });

  it("uses Responses message content when a gateway leaves output_text empty", async () => {
    fetchResult(
      json({
        output_text: "",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Visible output" }],
          },
        ],
        status: "completed",
      })
    );
    await expect(
      invokeConnection(connection({ protocol: "openai-responses" }), messages, {
        maxTokens: 300,
      })
    ).resolves.toMatchObject({ text: "Visible output", truncated: false });
  });

  it("maps Anthropic system/history and permits a version header override", async () => {
    const mock = fetchResult(
      json({
        content: [{ type: "text", text: "Anthropic output" }],
        stop_reason: "max_tokens",
      })
    );
    await expect(
      invokeConnection(
        connection({
          protocol: "anthropic",
          authType: "header",
          extraHeaders: { "Anthropic-Version": "2024-01-01" },
        }),
        messages,
        { maxTokens: 250, json: true }
      )
    ).resolves.toMatchObject({ text: "Anthropic output", truncated: true });
    const sent = request(mock);
    expect(sent.url).toBe("https://provider.example/v1/messages");
    expect(sent.headers.get("anthropic-version")).toBe("2024-01-01");
    expect(sent.headers.get("x-api-key")).toBe("super-secret-key");
    expect(sent.body).toEqual({
      model: "custom-model",
      system: "You are a tutor.",
      messages: messages.slice(1),
      stream: false,
      max_tokens: 250,
    });
  });

  it("maps Google roles, uses a header key and hides thought parts", async () => {
    const mock = fetchResult(
      json({
        candidates: [
          {
            content: {
              parts: [
                { text: "private reasoning", thought: true },
                { text: "Visible answer" },
              ],
            },
            finishReason: "MAX_TOKENS",
          },
        ],
      })
    );
    await expect(
      invokeConnection(
        connection({
          protocol: "google",
          baseUrl: "https://provider.example/v1beta/models/old:generateContent",
          model: "models/new-model",
          authType: "header",
          authHeader: "x-goog-api-key",
          jsonMode: "native",
        }),
        messages,
        { maxTokens: 400, json: true }
      )
    ).resolves.toMatchObject({ text: "Visible answer", truncated: true });
    const sent = request(mock);
    expect(sent.url).toBe(
      "https://provider.example/v1beta/models/new-model:generateContent"
    );
    expect(sent.url).not.toContain("super-secret");
    expect(sent.headers.get("x-goog-api-key")).toBe("super-secret-key");
    expect(sent.body.systemInstruction).toEqual({
      parts: [{ text: "You are a tutor." }],
    });
    expect(sent.body.contents[1]).toEqual({
      role: "model",
      parts: [{ text: "Hi" }],
    });
    expect(sent.body.generationConfig).toEqual({
      maxOutputTokens: 400,
      responseMimeType: "application/json",
    });
  });
});

describe("streaming adapters", () => {
  it("decodes fragmented UTF-8, CRLF and the final SSE event without a blank line", async () => {
    const frames =
      ': keepalive\r\nevent: message\r\ndata: {"choices":[{"delta":{"content":"Héllo 🌍"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"!"},"finish_reason":"length"}]}';
    fetchResult(stream(frames, Array(90).fill(1)));
    const tokens: string[] = [];
    await expect(
      streamConnection(connection(), messages, { maxTokens: 300 }, token =>
        tokens.push(token)
      )
    ).resolves.toMatchObject({ text: "Héllo 🌍!", truncated: true });
    expect(tokens.join("")).toBe("Héllo 🌍!");
  });

  it("does not duplicate Responses deltas when the completed event repeats the full answer", async () => {
    fetchResult(
      stream(
        'data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"output_text":"Hello world","status":"completed"}}\n\n'
      )
    );
    const tokens: string[] = [];
    await expect(
      streamConnection(
        connection({ protocol: "openai-responses" }),
        messages,
        { maxTokens: 300 },
        token => tokens.push(token)
      )
    ).resolves.toMatchObject({ text: "Hello world", truncated: false });
    expect(tokens).toEqual(["Hello", " world"]);
  });

  it("preserves an incomplete Responses event even if a gateway omits response.status", async () => {
    fetchResult(
      stream(
        'data: {"type":"response.output_text.delta","delta":"Partial"}\n\ndata: {"type":"response.incomplete","response":{"output_text":"Partial"}}\n\n'
      )
    );
    await expect(
      streamConnection(
        connection({ protocol: "openai-responses" }),
        messages,
        { maxTokens: 300 },
        () => undefined
      )
    ).resolves.toMatchObject({ text: "Partial", truncated: true });
  });

  it("extracts Anthropic text deltas and max-token completion signals", async () => {
    fetchResult(
      stream(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\ndata: {"type":"message_stop"}\n\n'
      )
    );
    await expect(
      streamConnection(
        connection({ protocol: "anthropic" }),
        messages,
        { maxTokens: 300 },
        () => undefined
      )
    ).resolves.toMatchObject({ text: "Hello", truncated: true });
  });

  it("extracts Google SSE parts and sets alt=sse without putting a key in the URL", async () => {
    const mock = fetchResult(
      stream(
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}]}\n\n'
      )
    );
    await expect(
      streamConnection(
        connection({
          protocol: "google",
          baseUrl: "https://provider.example/v1beta",
          authType: "header",
          authHeader: "x-goog-api-key",
        }),
        messages,
        { maxTokens: 300 },
        () => undefined
      )
    ).resolves.toMatchObject({ text: "Hello!", truncated: false });
    expect(request(mock).url).toBe(
      "https://provider.example/v1beta/models/custom-model:streamGenerateContent?alt=sse"
    );
  });

  it("accepts JSON from a gateway that ignores streaming and emits the text once", async () => {
    fetchResult(json(completion("Buffered")));
    const tokens: string[] = [];
    await streamConnection(connection(), messages, { maxTokens: 300 }, token =>
      tokens.push(token)
    );
    expect(tokens).toEqual(["Buffered"]);
  });

  it("requests nonstreaming output when the saved connection disables streaming", async () => {
    const mock = fetchResult(json(completion("Buffered")));
    await streamConnection(
      connection({ stream: false }),
      messages,
      { maxTokens: 300 },
      () => undefined
    );
    expect(request(mock).body.stream).toBe(false);
  });

  it("handles SSE with a missing content type using the same parser", async () => {
    fetchResult(
      stream(
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',
        [],
        "text/plain"
      )
    );
    await expect(
      streamConnection(
        connection(),
        messages,
        { maxTokens: 300 },
        () => undefined
      )
    ).resolves.toMatchObject({ text: "Hello" });
  });

  it("reports a premature stream end after preserving delivered partial tokens", async () => {
    fetchResult(
      stream('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n')
    );
    const tokens: string[] = [];
    await expect(
      streamConnection(connection(), messages, { maxTokens: 300 }, token =>
        tokens.push(token)
      )
    ).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: expect.stringContaining("ended before completion"),
    });
    expect(tokens).toEqual(["Partial"]);
  });

  it.each([
    [
      "openai-responses",
      'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
    ],
    [
      "anthropic",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n',
    ],
    [
      "google",
      'data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]}}]}\n\n',
    ],
  ] as const)(
    "does not report a disconnected %s stream as a complete answer",
    async (protocol, frames) => {
      fetchResult(stream(frames));
      const tokens: string[] = [];
      await expect(
        streamConnection(
          connection({ protocol }),
          messages,
          { maxTokens: 300 },
          token => tokens.push(token)
        )
      ).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: expect.stringContaining("ended before completion"),
      });
      expect(tokens).toEqual(["Partial"]);
    }
  );

  it("preserves a Google streamed output-limit signal", async () => {
    fetchResult(
      stream(
        'data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]},"finishReason":"MAX_TOKENS"}]}\n\n'
      )
    );
    await expect(
      streamConnection(
        connection({ protocol: "google" }),
        messages,
        { maxTokens: 300 },
        () => undefined
      )
    ).resolves.toMatchObject({ text: "Partial", truncated: true });
  });

  it("does not hide an SSE error or expose its provider message", async () => {
    fetchResult(
      stream(
        'event: error\ndata: {"error":{"type":"rate_limit_error","message":"secret super-secret-key"}}\n\n'
      )
    );
    await expect(
      streamConnection(
        connection(),
        messages,
        { maxTokens: 300 },
        () => undefined
      )
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.not.stringContaining("super-secret-key"),
    });
  });

  it.each([
    [
      'data: {"type":"response.failed","response":{"error":{"code":"invalid_api_key","message":"super-secret-key"}}}\n\n',
      "PRECONDITION_FAILED",
    ],
    [
      'event: error\ndata: {"error":{"type":"overloaded_error","message":"super-secret-key"}}\n\n',
      "SERVICE_UNAVAILABLE",
    ],
    [
      'data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"super-secret-key"}}\n\n',
      "TOO_MANY_REQUESTS",
    ],
  ])("sanitizes protocol-specific SSE errors", async (frames, code) => {
    fetchResult(stream(frames));
    await expect(
      streamConnection(
        connection(),
        messages,
        { maxTokens: 300 },
        () => undefined
      )
    ).rejects.toMatchObject({
      code,
      message: expect.not.stringContaining("super-secret-key"),
    });
  });
});

describe("safe failures and limits", () => {
  it.each([
    [400, "BAD_REQUEST"],
    [401, "PRECONDITION_FAILED"],
    [403, "PRECONDITION_FAILED"],
    [404, "PRECONDITION_FAILED"],
    [429, "TOO_MANY_REQUESTS"],
    [503, "SERVICE_UNAVAILABLE"],
    [504, "TIMEOUT"],
  ])(
    "maps HTTP %i without echoing a body or silently retrying",
    async (status, code) => {
      const mock = fetchResult(
        json({ error: { message: "super-secret-key" } }, status as number)
      );
      await expect(
        invokeConnection(connection(), messages, { maxTokens: 300 })
      ).rejects.toMatchObject({
        code,
        message: expect.not.stringContaining("super-secret-key"),
      });
      expect(mock).toHaveBeenCalledOnce();
    }
  );

  it("sanitizes network failures, including arbitrary provider diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("could not send super-secret-key"))
    );
    await expect(
      invokeConnection(connection(), messages, { maxTokens: 300 })
    ).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: expect.not.stringContaining("super-secret-key"),
    });
  });

  it("rejects credentials embedded in a URL before sending anything", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    await expect(
      invokeConnection(
        connection({ baseUrl: "https://provider.example/v1?key=secret" }),
        messages,
        { maxTokens: 300 }
      )
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("does not call the service if the caller has already cancelled", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    await expect(
      invokeConnection(connection(), messages, {
        maxTokens: 300,
        signal: AbortSignal.abort(),
      })
    ).rejects.toMatchObject({ code: "CLIENT_CLOSED_REQUEST" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects HTML endpoints, invalid JSON, empty output and oversized responses", async () => {
    for (const response of [
      new Response("<html>super-secret-key</html>", {
        headers: { "content-type": "text/html" },
      }),
      new Response("invalid", {
        headers: { "content-type": "application/json" },
      }),
      json(completion("")),
      new Response("x".repeat(2 * 1024 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
    ]) {
      fetchResult(response);
      await expect(
        invokeConnection(connection(), messages, { maxTokens: 300 })
      ).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: expect.not.stringContaining("super-secret-key"),
      });
    }
  });

  it("blocks a real HTTP redirect before credentials can reach the second URL", async () => {
    let redirectedHits = 0;
    const { baseUrl } = await localServer((req, res) => {
      if (req.url?.includes("/redirected")) {
        redirectedHits += 1;
        res.end(JSON.stringify(completion()));
      } else {
        res.writeHead(302, { location: "/redirected" });
        res.end();
      }
    });
    await expect(
      invokeConnection(connection({ baseUrl }), messages, { maxTokens: 300 })
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    expect(redirectedHits).toBe(0);
  });

  it("times out a real service and cancels a real stream when the caller aborts", async () => {
    const { baseUrl } = await localServer((req, res) => {
      if (req.headers.accept?.includes("text/event-stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n');
      }
    });
    await expect(
      invokeConnection(connection({ baseUrl }), messages, {
        maxTokens: 300,
        timeoutMs: 30,
      })
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    const abort = new AbortController();
    await expect(
      streamConnection(
        connection({ baseUrl }),
        messages,
        { maxTokens: 300, signal: abort.signal },
        () => abort.abort()
      )
    ).rejects.toMatchObject({ code: "CLIENT_CLOSED_REQUEST" });
  });

  it("uses the saved connection timeout when the caller supplies no override", async () => {
    const { baseUrl } = await localServer(() => undefined);
    await expect(
      invokeConnection(connection({ baseUrl, timeoutMs: 30 }), messages, {
        maxTokens: 300,
      })
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: expect.stringContaining("1 seconds"),
    });
  });
});

describe("model discovery and connection probes", () => {
  it("supports OpenAI-compatible lists and full endpoint base URLs", async () => {
    const mock = fetchResult(
      json({ data: [{ id: "one" }, { id: "one" }, { id: "two" }] })
    );
    await expect(
      discoverModels(
        connection({
          baseUrl: "https://provider.example/v1/chat/completions?api-version=1",
        })
      )
    ).resolves.toEqual([{ id: "one" }, { id: "two" }]);
    expect(mock.mock.calls[0][0]).toBe(
      "https://provider.example/v1/models?api-version=1"
    );
    expect(mock.mock.calls[0][1].method).toBe("GET");
  });

  it("paginates Google model lists and normalizes their IDs", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          models: [{ name: "models/one", displayName: "First" }],
          nextPageToken: "next",
        })
      )
      .mockResolvedValueOnce(json({ models: [{ name: "models/two" }] }));
    vi.stubGlobal("fetch", mock);
    await expect(
      discoverModels(
        connection({
          protocol: "google",
          baseUrl: "https://provider.example/v1beta/models/old:generateContent",
        })
      )
    ).resolves.toEqual([{ id: "one", name: "First" }, { id: "two" }]);
    expect(mock.mock.calls[1][0]).toBe(
      "https://provider.example/v1beta/models?pageToken=next"
    );
  });

  it("paginates Anthropic model lists and terminates repeated cursors", async () => {
    const mock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          json({
            data: [{ id: "one", display_name: "First" }],
            has_more: true,
            last_id: "same",
          })
        )
      );
    vi.stubGlobal("fetch", mock);
    await expect(
      discoverModels(connection({ protocol: "anthropic" }))
    ).resolves.toEqual([{ id: "one", name: "First" }]);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("offers manual model entry when discovery is unavailable", async () => {
    fetchResult(json({ unusual: [] }));
    await expect(discoverModels(connection())).rejects.toMatchObject({
      message: expect.stringContaining("manually"),
    });
  });

  it("tests the selected model without returning provider output or credentials", async () => {
    const mock = fetchResult(
      json(completion("The service repeated super-secret-key"))
    );
    const result = await testConnection(connection());
    expect(result).toMatchObject({
      ok: true,
      message: "Connected to My service · custom-model.",
      latencyMs: expect.any(Number),
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-key");
    expect(request(mock).body.messages).toEqual([
      { role: "user", content: "Reply briefly with OK." },
    ]);
    expect(request(mock).body.stream).toBe(false);
    expect(request(mock).body.max_tokens).toBe(1024);
  });

  it("keeps the connection probe within a lower configured output budget", async () => {
    const mock = fetchResult(json(completion("OK")));
    await testConnection(connection({ maxOutputTokens: 256 }));
    expect(request(mock).body.max_tokens).toBe(256);
  });
});
