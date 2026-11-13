import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { requireAiAccess } from "./access";

function request(
  host = "localhost:3000",
  address = "127.0.0.1",
  headers: Record<string, unknown> = {}
) {
  return {
    headers: { host, ...headers },
    socket: { remoteAddress: address },
  } as unknown as Request;
}

describe("AI connection ownership boundary", () => {
  it.each([
    ["localhost:3000", "127.0.0.1"],
    ["127.0.0.1:3100", "::ffff:127.0.0.1"],
    ["[::1]:3000", "::1"],
  ])("allows a direct local request to %s", (host, address) => {
    expect(() => requireAiAccess(request(host, address))).not.toThrow();
  });
  it("allows same-origin browser requests and signed-in remote administrators", () => {
    expect(() =>
      requireAiAccess(
        request("localhost:3000", "127.0.0.1", {
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        })
      )
    ).not.toThrow();
    expect(() =>
      requireAiAccess(
        request("study.example", "192.0.2.10", {
          origin: "https://study.example",
        }),
        { role: "admin" }
      )
    ).not.toThrow();
  });
  it.each([
    request("localhost:3000", "192.168.1.20"),
    request("attacker.example", "127.0.0.1"),
    request("localhost.evil:3000"),
    request("localhost:3000", "127.0.0.1", { origin: "https://evil.example" }),
    request("localhost:3000", "127.0.0.1", { origin: "null" }),
    request("localhost:3000", "127.0.0.1", {
      origin: ["http://localhost:3000"],
    }),
    request("localhost:3000", "127.0.0.1", { "sec-fetch-site": "cross-site" }),
    request("localhost:3000", "127.0.0.1", { "sec-fetch-site": "same-site" }),
    request("localhost:3000", "192.0.2.10", {
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "localhost:3000",
    }),
    request("localhost:3000@evil.example"),
    request("localhost:3000/path"),
    request("localhost:3000,evil.example"),
  ])(
    "rejects visitors, cross-origin requests, proxy spoofing and rebinding",
    req => {
      expect(() => requireAiAccess(req)).toThrow();
    }
  );
  it("does not let administrator authentication bypass same-origin checks", () => {
    expect(() =>
      requireAiAccess(
        request("study.example", "192.0.2.10", {
          origin: "https://evil.example",
        }),
        { role: "admin" }
      )
    ).toThrow();
    expect(() =>
      requireAiAccess(request("study.example", "192.0.2.10"), { role: "user" })
    ).toThrow();
  });
});
