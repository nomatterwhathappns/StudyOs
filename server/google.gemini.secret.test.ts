import { describe, expect, it, vi } from "vitest";
import { invokeGoogleGemini, toGoogleResponseSchema } from "./googleGemini";

const runLiveGeminiCheck = process.env.RUN_GOOGLE_GEMINI_SECRET_TEST === "true";

describe("Google Gemini API key", () => {
  it.runIf(runLiveGeminiCheck)("can access the Gemini model catalog", async () => {
    const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    expect(key, "GOOGLE_GENERATIVE_AI_API_KEY must be configured").toBeTruthy();

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key!)}`, {
      signal: AbortSignal.timeout(10_000),
    });

    expect(response.ok, `Google Gemini model catalog request failed with ${response.status}`).toBe(true);
    const payload = await response.json() as { models?: unknown[] };
    expect(payload.models).toBeInstanceOf(Array);
  });

  it("formats a server-side Gemini response without exposing the key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "ready" }] } }] }),
    } as Response);
    try {
      await expect(invokeGoogleGemini({ messages: [{ role: "user", content: "Reply with exactly: ready" }], maxTokens: 64, apiKey: "test-server-key" })).resolves.toEqual({ text: "ready", truncated: false });
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("passes an optional JSON schema to Gemini for structured drafts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }),
    } as Response);
    try {
      await invokeGoogleGemini({ messages: [{ role: "user", content: "Draft a card" }], maxTokens: 64, apiKey: "test-server-key", json: true, jsonSchema: { type: "object", properties: { term: { type: "string" } }, additionalProperties: false } });
      const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(request.generationConfig).toMatchObject({ responseMimeType: "application/json", responseSchema: { type: "object" } });
      expect(request.generationConfig.responseSchema).not.toHaveProperty("additionalProperties");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("retries a temporary Gemini 503 and returns the recovered response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "service unavailable" } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "recovered" }] } }] }) } as Response);
    try {
      await expect(invokeGoogleGemini({ messages: [{ role: "user", content: "Retry once" }], maxTokens: 16, apiKey: "test-server-key" })).resolves.toEqual({ text: "recovered", truncated: false });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reports Gemini 503 clearly after bounded retries", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 503, text: async () => "service unavailable" } as Response);
    try {
      await expect(invokeGoogleGemini({ messages: [{ role: "user", content: "Still unavailable" }], maxTokens: 16, apiKey: "test-server-key" })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: "Google Gemini sedang tidak tersedia (503). Key kamu sudah tersambung; coba lagi beberapa saat lagi.",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("explains a daily Gemini quota limit without presenting it as a short retry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({
        error: {
          message: "Quota exceeded. Please retry in 53.3s.",
          details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }],
        },
      }),
    } as Response);
    try {
      await expect(invokeGoogleGemini({ messages: [{ role: "user", content: "Hello" }], maxTokens: 32, apiKey: "test-key" })).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: "Kuota harian Gemini untuk personal key ini sudah mencapai batas 20 request. Tunggu reset kuota Google atau gunakan project/key lain yang masih memiliki kuota.",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("removes unsupported additionalProperties from nested Google response schemas", () => {
    expect(toGoogleResponseSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { question: { type: "string" } },
          },
        },
      },
    })).toEqual({
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: { type: "object", properties: { question: { type: "string" } } },
        },
      },
    });
  });

  it("reports a clear configuration error when the key is unavailable", async () => {
    const originalKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    try {
      await expect(invokeGoogleGemini({ messages: [{ role: "user", content: "Hello" }], maxTokens: 16 })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    } finally {
      if (originalKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalKey;
    }
  });
});
