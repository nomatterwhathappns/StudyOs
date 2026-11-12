import { describe, expect, it } from "vitest";

const baseUrl = (process.env.STUDYOS_AI_ROUTER_URL ?? "").replace(/\/$/, "");
const token = process.env.STUDYOS_AI_ROUTER_TOKEN ?? "";
const model = process.env.STUDYOS_AI_ROUTER_MODEL ?? "Studyos";
const runLiveRouterCheck = process.env.RUN_PUBLIC_AI_ROUTER_SECRET_TEST === "true";

describe("public 9router configuration", () => {
  it.runIf(runLiveRouterCheck)("accepts the server-side StudyOS token and returns a non-empty completion", async () => {
    expect(baseUrl).toMatch(/^https:\/\//);
    expect(token.length).toBeGreaterThanOrEqual(32);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studyos-token": token,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply exactly with OK." }],
        max_tokens: 512,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(35_000),
    });

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
      error?: unknown;
    };

    expect(response.ok, JSON.stringify(payload)).toBe(true);
    expect(payload.choices?.[0]?.message?.content?.trim()).toBeTruthy();
  }, 45_000);
});
