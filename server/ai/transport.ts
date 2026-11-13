import { TRPCError } from "@trpc/server";
import type { ResolvedAiConnection } from "../../shared/ai-connections";

export type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
export type AiRequestOptions = {
  maxTokens: number;
  json?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};
export type AiResult = { text: string; truncated: boolean; provider: string };

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 1000;

function provider(connection: ResolvedAiConnection) {
  return `${connection.name} · ${connection.model}`;
}

function serviceError(status: number): TRPCError {
  if (status === 401 || status === 403)
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `The AI service rejected authentication (${status}). Check the connection's key and authentication type in Profile.`,
    });
  if (status === 429)
    return new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message:
        "The AI service is limiting requests (429). Wait before trying again or check the service's quota.",
    });
  if (status === 408 || status === 504)
    return new TRPCError({
      code: "TIMEOUT",
      message: `The AI service timed out (${status}). Try again or adjust the connection timeout.`,
    });
  if (status === 404 || status === 405)
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `The AI endpoint was not found or does not support this operation (${status}). Check the base URL, API format and model.`,
    });
  if (status >= 500)
    return new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: `The AI service is unavailable (${status}). Try again later.`,
    });
  return new TRPCError({
    code: "BAD_REQUEST",
    message: `The AI service rejected the request (${status}). Check the model, API format and advanced connection settings.`,
  });
}

function payloadError(payload: unknown): TRPCError {
  const envelope = record(payload);
  const error =
    record(envelope?.error) ?? record(record(envelope?.response)?.error);
  const status = Number(error?.status_code ?? error?.code);
  if ([400, 401, 403, 404, 405, 408, 429, 500, 503, 504, 529].includes(status))
    return serviceError(status === 529 ? 503 : status);
  const type = [error?.type, error?.code, error?.status]
    .filter(value => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (type.includes("rate_limit") || type.includes("quota"))
    return serviceError(429);
  if (type.includes("authentication") || type.includes("invalid_api_key"))
    return serviceError(401);
  if (type.includes("overloaded") || type.includes("unavailable"))
    return serviceError(503);
  return new TRPCError({
    code: "BAD_GATEWAY",
    message:
      "The AI service reported an error while generating the response. Check the connection and model in Profile.",
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textParts(value: unknown, excludeThoughts = false): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(part => {
      const item = record(part);
      return item &&
        (!excludeThoughts || item.thought !== true) &&
        typeof item.text === "string"
        ? item.text
        : "";
    })
    .join("");
}

function lengthLimited(reason: unknown) {
  return (
    typeof reason === "string" &&
    ["length", "max_tokens", "max_output_tokens"].includes(reason.toLowerCase())
  );
}

function endpoint(
  connection: ResolvedAiConnection,
  operation: "generate" | "models",
  streaming = false
) {
  let url: URL;
  try {
    url = new URL(connection.baseUrl);
  } catch {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The AI connection has an invalid base URL. Edit it in Profile.",
    });
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Use an HTTP(S) API URL without embedded credentials or a fragment.",
    });
  if (
    Array.from(url.searchParams.keys()).some(key =>
      /^(?:key|api[_-]?key|token|access_token|secret|password)$/i.test(key)
    )
  )
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Put API credentials in the connection's key or header fields, not its URL.",
    });
  let prefix = url.pathname.replace(/\/+$/, "");
  prefix = prefix.replace(/\/(?:chat\/completions|responses|messages)$/, "");
  if (connection.protocol === "google") {
    prefix = prefix
      .replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/, "")
      .replace(/\/models$/, "");
    url.pathname =
      operation === "models"
        ? `${prefix}/models`
        : `${prefix}/models/${encodeURIComponent(connection.model.replace(/^models\//, ""))}:${streaming ? "streamGenerateContent" : "generateContent"}`;
    url.searchParams.delete("alt");
    if (streaming && operation === "generate")
      url.searchParams.set("alt", "sse");
  } else {
    prefix = prefix.replace(/\/models$/, "");
    const suffix =
      operation === "models"
        ? "models"
        : connection.protocol === "openai-chat"
          ? "chat/completions"
          : connection.protocol === "openai-responses"
            ? "responses"
            : "messages";
    url.pathname = `${prefix}/${suffix}`;
  }
  return url;
}

function requestHeaders(connection: ResolvedAiConnection, streaming = false) {
  const headers = new Headers(connection.extraHeaders);
  headers.set("content-type", "application/json");
  headers.set(
    "accept",
    streaming ? "text/event-stream, application/json" : "application/json"
  );
  if (connection.protocol === "anthropic" && !headers.has("anthropic-version"))
    headers.set("anthropic-version", "2023-06-01");
  if (connection.authType !== "none" && connection.apiKey) {
    if (connection.authType === "bearer")
      headers.set("authorization", `Bearer ${connection.apiKey}`);
    else headers.set(connection.authHeader, connection.apiKey);
  }
  return headers;
}

function requestBody(
  connection: ResolvedAiConnection,
  messages: AiMessage[],
  options: AiRequestOptions,
  streaming: boolean
) {
  if (!messages.length)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "At least one message is required for an AI request.",
    });
  const limit = Math.min(
    connection.maxOutputTokens,
    Math.max(1, Math.floor(options.maxTokens))
  );
  if (!Number.isFinite(limit))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The output token limit is invalid.",
    });
  const system = messages
    .filter(message => message.role === "system")
    .map(message => message.content)
    .join("\n\n");
  const history = messages.filter(message => message.role !== "system");
  const nativeJson = options.json === true && connection.jsonMode === "native";
  if (connection.protocol === "openai-chat") {
    const tokenParameter =
      connection.tokenParameter === "auto"
        ? /^(?:gpt-5|o[134])(?:[.\-]|$)/i.test(connection.model)
          ? "max_completion_tokens"
          : "max_tokens"
        : connection.tokenParameter;
    return {
      model: connection.model,
      messages,
      stream: streaming,
      ...(tokenParameter === "none" ? {} : { [tokenParameter]: limit }),
      ...(nativeJson ? { response_format: { type: "json_object" } } : {}),
    };
  }
  if (connection.protocol === "openai-responses")
    return {
      model: connection.model,
      ...(system ? { instructions: system } : {}),
      input: history.map(message => ({
        role: message.role,
        content: message.content,
      })),
      stream: streaming,
      max_output_tokens: limit,
      ...(nativeJson ? { text: { format: { type: "json_object" } } } : {}),
    };
  if (connection.protocol === "anthropic")
    return {
      model: connection.model,
      ...(system ? { system } : {}),
      messages: history.map(message => ({
        role: message.role,
        content: message.content,
      })),
      stream: streaming,
      max_tokens: limit,
    };
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: history.map(message => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
    generationConfig: {
      maxOutputTokens: limit,
      ...(nativeJson ? { responseMimeType: "application/json" } : {}),
    },
  };
}

async function withSignal<T>(
  connection: ResolvedAiConnection,
  options: { signal?: AbortSignal; timeoutMs?: number },
  action: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeout = Math.max(
    1,
    Math.min(options.timeoutMs ?? connection.timeoutMs, connection.timeoutMs)
  );
  const timer = AbortSignal.timeout(timeout);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timer])
    : timer;
  try {
    signal.throwIfAborted();
    return await action(signal);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    const name = record(error)?.name;
    const reasonName = record(signal.reason)?.name;
    if (name === "TimeoutError" || reasonName === "TimeoutError")
      throw new TRPCError({
        code: "TIMEOUT",
        message: `The AI service did not finish within ${Math.ceil(timeout / 1000)} seconds. Adjust the connection timeout in Profile if needed.`,
      });
    if (signal.aborted || name === "AbortError")
      throw new TRPCError({
        code: "CLIENT_CLOSED_REQUEST",
        message: "The AI request was cancelled.",
      });
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message:
        "StudyOS could not reach the AI service. Check its URL, TLS configuration and whether the service is running. Redirects are not followed.",
    });
  }
}

async function checkedFetch(url: URL, init: RequestInit) {
  const response = await fetch(url.toString(), { ...init, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw serviceError(response.status);
  }
  return response;
}

async function readBounded(
  response: Response,
  consume?: (chunk: string) => boolean | void
) {
  if (!response.body)
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "The AI service returned an empty response.",
    });
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    await response.body.cancel();
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message:
        "The AI response is too large. Reduce the connection's output token limit.",
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message:
            "The AI response is too large. Reduce the connection's output token limit.",
        });
      const chunk = decoder.decode(value, { stream: true });
      if (consume) {
        if (consume(chunk) === false) break;
      } else text += chunk;
    }
    const tail = decoder.decode();
    if (tail) {
      if (consume) consume(tail);
      else text += tail;
    }
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message:
        "The AI service returned invalid JSON. Check the base URL and API format.",
    });
  }
}

function extractJson(
  connection: ResolvedAiConnection,
  value: unknown
): { text: string; truncated: boolean } {
  const payload = record(value);
  if (!payload || payload.error || payload.status === "failed")
    throw payloadError(value);
  if (connection.protocol === "openai-chat") {
    const choice = record(
      Array.isArray(payload.choices) ? payload.choices[0] : undefined
    );
    const message = record(choice?.message);
    return {
      text:
        textParts(message?.content) ||
        (typeof choice?.text === "string" ? choice.text : ""),
      truncated: lengthLimited(choice?.finish_reason),
    };
  }
  if (connection.protocol === "openai-responses") {
    const output = Array.isArray(payload.output)
      ? payload.output.map(item => textParts(record(item)?.content)).join("")
      : "";
    const reason = record(payload.incomplete_details)?.reason;
    return {
      text:
        typeof payload.output_text === "string" && payload.output_text
          ? payload.output_text
          : output,
      truncated:
        lengthLimited(reason) || (payload.status === "incomplete" && !reason),
    };
  }
  if (connection.protocol === "anthropic")
    return {
      text: textParts(payload.content),
      truncated: lengthLimited(payload.stop_reason),
    };
  const candidate = record(
    Array.isArray(payload.candidates) ? payload.candidates[0] : undefined
  );
  return {
    text: textParts(record(candidate?.content)?.parts, true),
    truncated: lengthLimited(candidate?.finishReason),
  };
}

type Frame = { event: string; data: string };

function sseParser(onFrame: (frame: Frame) => boolean | void) {
  let pending = "";
  let data: string[] = [];
  let event = "";
  let stopped = false;
  function dispatch() {
    if (data.length && onFrame({ event, data: data.join("\n") }) === false)
      stopped = true;
    data = [];
    event = "";
  }
  function line(value: string) {
    if (!value) return dispatch();
    if (value.startsWith(":")) return;
    const separator = value.indexOf(":");
    const field = separator < 0 ? value : value.slice(0, separator);
    const content =
      separator < 0 ? "" : value.slice(separator + 1).replace(/^ /, "");
    if (field === "data") data.push(content);
    else if (field === "event") event = content;
  }
  return {
    push(chunk: string) {
      if (stopped) return false;
      pending += chunk;
      while (!stopped) {
        const match = /\r\n|\n|\r(?!$)/.exec(pending);
        if (!match) break;
        line(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
      }
      return !stopped;
    },
    finish() {
      if (!stopped) {
        if (pending) line(pending.replace(/\r$/, ""));
        dispatch();
      }
    },
  };
}

function streamAccumulator(
  connection: ResolvedAiConnection,
  onToken: (token: string) => void
) {
  let text = "";
  let truncated = false;
  let completed = false;
  function append(token: string) {
    if (token) {
      text += token;
      onToken(token);
    }
  }
  return {
    frame({ event, data }: Frame) {
      if (data.trim() === "[DONE]") {
        completed = true;
        return false;
      }
      if (event === "ping" || !data.trim()) return;
      const payload = record(parseJson(data));
      if (
        !payload ||
        payload.error ||
        event === "error" ||
        payload.type === "error" ||
        payload.type === "response.failed"
      )
        throw payloadError(payload);
      if (connection.protocol === "openai-chat") {
        const choice = record(
          Array.isArray(payload.choices) ? payload.choices[0] : undefined
        );
        append(textParts(record(choice?.delta)?.content));
        if (!text && choice?.message)
          append(textParts(record(choice.message)?.content));
        if (!text && typeof choice?.text === "string") append(choice.text);
        truncated ||= lengthLimited(choice?.finish_reason);
        completed ||= typeof choice?.finish_reason === "string";
      } else if (connection.protocol === "openai-responses") {
        const type = payload.type ?? event;
        if (
          type === "response.output_text.delta" &&
          typeof payload.delta === "string"
        )
          append(payload.delta);
        if (
          type === "response.output_text.done" &&
          !text &&
          typeof payload.text === "string"
        )
          append(payload.text);
        if (type === "response.completed" || type === "response.incomplete") {
          const complete = extractJson(connection, payload.response);
          if (!text) append(complete.text);
          else if (complete.text.startsWith(text))
            append(complete.text.slice(text.length));
          const incompleteReason = record(
            record(payload.response)?.incomplete_details
          )?.reason;
          truncated ||=
            complete.truncated ||
            (type === "response.incomplete" && !incompleteReason);
          completed = true;
          return false;
        }
      } else if (connection.protocol === "anthropic") {
        if (payload.type === "content_block_start")
          append(textParts([payload.content_block]));
        if (
          payload.type === "content_block_delta" &&
          record(payload.delta)?.type === "text_delta"
        )
          append(textParts([payload.delta]));
        if (payload.type === "message_delta") {
          truncated ||= lengthLimited(record(payload.delta)?.stop_reason);
          completed ||= typeof record(payload.delta)?.stop_reason === "string";
        }
        if (payload.type === "message_stop") {
          completed = true;
          return false;
        }
      } else {
        const partial = extractJson(connection, payload);
        append(partial.text);
        truncated ||= partial.truncated;
        const candidate = record(
          Array.isArray(payload.candidates) ? payload.candidates[0] : undefined
        );
        completed ||= typeof candidate?.finishReason === "string";
      }
    },
    result() {
      if (text && !completed)
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message:
            "The AI stream ended before completion. The partial answer can be continued or retried.",
        });
      return { text, truncated };
    },
  };
}

async function readGeneration(
  response: Response,
  connection: ResolvedAiConnection,
  onToken: (token: string) => void
) {
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType === "text/event-stream") {
    const accumulator = streamAccumulator(connection, onToken);
    const parser = sseParser(frame => accumulator.frame(frame));
    await readBounded(response, chunk => parser.push(chunk));
    parser.finish();
    return accumulator.result();
  }
  if (
    contentType &&
    contentType !== "application/json" &&
    !contentType.endsWith("+json") &&
    contentType !== "text/plain"
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message:
        "The endpoint did not return JSON or an SSE stream. Check the base URL and API format.",
    });
  }
  const text = await readBounded(response);
  // Some gateways omit the SSE content type. Their bounded response still works,
  // although live token delivery requires the standard text/event-stream header.
  if (/^\s*(?:data:|event:|:)/.test(text)) {
    const accumulator = streamAccumulator(connection, onToken);
    const parser = sseParser(frame => accumulator.frame(frame));
    parser.push(text);
    parser.finish();
    return accumulator.result();
  }
  const result = extractJson(connection, parseJson(text));
  if (result.text) onToken(result.text);
  return result;
}

async function generate(
  connection: ResolvedAiConnection,
  messages: AiMessage[],
  options: AiRequestOptions,
  streaming: boolean,
  onToken: (token: string) => void
): Promise<AiResult> {
  return withSignal(connection, options, async signal => {
    const response = await checkedFetch(
      endpoint(connection, "generate", streaming),
      {
        method: "POST",
        headers: requestHeaders(connection, streaming),
        body: JSON.stringify(
          requestBody(connection, messages, options, streaming)
        ),
        signal,
      }
    );
    const result = await readGeneration(response, connection, onToken);
    if (!result.text.trim())
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message:
          "The AI service returned no visible text. Check model support and the output token limit in Profile.",
      });
    return { ...result, provider: provider(connection) };
  });
}

export async function invokeConnection(
  connection: ResolvedAiConnection,
  messages: AiMessage[],
  options: AiRequestOptions
): Promise<AiResult> {
  return generate(connection, messages, options, false, () => undefined);
}

export async function streamConnection(
  connection: ResolvedAiConnection,
  messages: AiMessage[],
  options: AiRequestOptions,
  onToken: (token: string) => void
): Promise<AiResult> {
  return generate(connection, messages, options, connection.stream, onToken);
}

export async function discoverModels(
  connection: ResolvedAiConnection,
  callerSignal?: AbortSignal
): Promise<Array<{ id: string; name?: string }>> {
  return withSignal(
    connection,
    { signal: callerSignal, timeoutMs: Math.min(connection.timeoutMs, 15000) },
    async signal => {
      const url = endpoint(connection, "models");
      const models = new Map<string, { id: string; name?: string }>();
      const cursors = new Set<string>();
      for (let page = 0; page < 5 && models.size < MAX_MODELS; page += 1) {
        const response = await checkedFetch(url, {
          method: "GET",
          headers: requestHeaders(connection),
          signal,
        });
        const payload = record(parseJson(await readBounded(response)));
        if (payload?.error) throw payloadError(payload);
        const entries = Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.models)
            ? payload.models
            : undefined;
        if (!entries)
          throw new TRPCError({
            code: "BAD_GATEWAY",
            message:
              "This endpoint does not provide a supported model list. Enter the model ID manually in Profile.",
          });
        for (const entry of entries) {
          const item = record(entry);
          const rawId =
            typeof entry === "string"
              ? entry
              : typeof item?.id === "string"
                ? item.id
                : typeof item?.name === "string"
                  ? item.name
                  : "";
          const id = (
            connection.protocol === "google"
              ? rawId.replace(/^models\//, "")
              : rawId
          ).trim();
          if (!id || id.length > 200 || /[\r\n\0]/.test(id)) continue;
          const name =
            typeof item?.displayName === "string"
              ? item.displayName
              : typeof item?.display_name === "string"
                ? item.display_name
                : undefined;
          models.set(id, { id, ...(name ? { name } : {}) });
          if (models.size >= MAX_MODELS) break;
        }
        const cursor =
          connection.protocol === "google" &&
          typeof payload?.nextPageToken === "string"
            ? payload.nextPageToken
            : connection.protocol === "anthropic" &&
                payload?.has_more === true &&
                typeof payload.last_id === "string"
              ? payload.last_id
              : undefined;
        if (!cursor || cursors.has(cursor)) break;
        cursors.add(cursor);
        url.searchParams.set(
          connection.protocol === "google" ? "pageToken" : "after_id",
          cursor
        );
      }
      if (!models.size)
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message:
            "The service returned no usable model IDs. Enter a model ID manually in Profile.",
        });
      return Array.from(models.values());
    }
  );
}

export async function testConnection(
  connection: ResolvedAiConnection
): Promise<{ ok: true; message: string; latencyMs: number }> {
  const start = performance.now();
  // Reasoning models can spend the initial tokens internally before producing
  // visible text. A tiny probe budget would incorrectly report them as broken.
  await invokeConnection(
    connection,
    [{ role: "user", content: "Reply briefly with OK." }],
    { maxTokens: 1024, timeoutMs: Math.min(connection.timeoutMs, 15000) }
  );
  return {
    ok: true,
    message: `Connected to ${provider(connection)}.`,
    latencyMs: Math.round(performance.now() - start),
  };
}
