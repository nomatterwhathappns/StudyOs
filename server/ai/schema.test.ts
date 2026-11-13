import { describe, expect, it } from "vitest";
import { aiConnectionInputSchema } from "@shared/ai-connections";

const connection = {
  name: "My API",
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "any-model",
};
describe("AI connection validation boundaries", () => {
  it.each([
    "https://user:secret@api.example/v1",
    "file:///etc/passwd",
    "ftp://api.example/v1",
    "https://api.example/v1#secret",
  ])("rejects credentials or unsupported URL %s", baseUrl => {
    expect(
      aiConnectionInputSchema.safeParse({ ...connection, baseUrl }).success
    ).toBe(false);
  });
  it.each([
    "api_key",
    "apiKey",
    "x-api-key",
    "key",
    "token",
    "access_token",
    "authorization",
    "auth",
    "client_secret",
    "signature",
  ])("keeps %s credentials out of the public URL metadata", key => {
    expect(
      aiConnectionInputSchema.safeParse({
        ...connection,
        baseUrl: `https://api.example/v1?${key}=secret-value`,
      }).success
    ).toBe(false);
  });
  it("accepts gateway version queries, local endpoints and auth-free servers", () => {
    expect(
      aiConnectionInputSchema.parse({
        ...connection,
        baseUrl:
          "https://api.example/custom/v1/chat/completions?api-version=2026-01",
        authType: "none",
      }).authType
    ).toBe("none");
    expect(aiConnectionInputSchema.parse(connection).baseUrl).toBe(
      connection.baseUrl
    );
  });
  it.each([
    { Host: "attacker.example" },
    { Cookie: "private" },
    { Authorization: "private" },
    { "x-extra": "private\r\nHost: injected" },
    { "x-a": "one", "X-A": "two" },
  ])(
    "rejects header injection, cookie forwarding and ambiguous names",
    extraHeaders => {
      expect(
        aiConnectionInputSchema.safeParse({ ...connection, extraHeaders })
          .success
      ).toBe(false);
    }
  );
  it("rejects conflicting secret replacement and deletion", () => {
    expect(
      aiConnectionInputSchema.safeParse({
        ...connection,
        apiKey: "replacement",
        clearApiKey: true,
      }).success
    ).toBe(false);
    expect(
      aiConnectionInputSchema.safeParse({
        ...connection,
        extraHeaders: { "x-team": "replacement" },
        clearHeaders: true,
      }).success
    ).toBe(false);
  });
});
