import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { requireAiAccess } from "./access";
import { getCachedOwnerSession } from "../owner-auth/service";

vi.mock("../owner-auth/service", async importOriginal => {
  const actual = await importOriginal<typeof import("../owner-auth/service")>();
  return { ...actual, getCachedOwnerSession: vi.fn(() => null) };
});

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

beforeEach(() => {
  for (const name of [
    "VERCEL",
    "STUDYOS_CLOUD_ACCESS",
    "VERCEL_URL",
    "VERCEL_BRANCH_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
    "STUDYOS_PUBLIC_HOSTS",
    "STUDYOS_OWNER_AUTH",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.mocked(getCachedOwnerSession).mockReturnValue(null);
});

afterEach(() => vi.unstubAllEnvs());

function protectedVercel(overrides: Record<string, string | undefined> = {}) {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("STUDYOS_CLOUD_ACCESS", "vercel-protected");
  vi.stubEnv("VERCEL_URL", "studyos-deployment.vercel.app");
  vi.stubEnv("VERCEL_BRANCH_URL", "studyos-git-main.vercel.app");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "studyos.vercel.app");
  for (const [name, value] of Object.entries(overrides))
    vi.stubEnv(name, value);
}

function verifiedOwner(overrides: Record<string, string | undefined> = {}) {
  protectedVercel(overrides);
  vi.stubEnv("STUDYOS_OWNER_AUTH", "enabled");
  vi.mocked(getCachedOwnerSession).mockReturnValue({
    id: "validated-session-fixture",
    username: "owner",
  });
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

describe("AI access requires the application owner on Vercel", () => {
  it.each([
    "studyos-deployment.vercel.app",
    "studyos-git-main.vercel.app",
    "studyos.vercel.app",
    "STUDYOS.VERCEL.APP",
    "studyos.vercel.app:443",
  ])(
    "rejects a legacy protected deployment hostname without owner authentication: %s",
    host => {
      protectedVercel();
      expect(() =>
        requireAiAccess(
          request(host, "192.0.2.10", {
            origin: `https://${host.toLowerCase().replace(/:443$/, "")}`,
            "sec-fetch-site": "same-origin",
          })
        )
      ).toThrow();
    }
  );

  it("rejects explicitly configured public hosts without owner authentication", () => {
    protectedVercel({ STUDYOS_PUBLIC_HOSTS: " study.example, other.example " });
    for (const host of ["study.example", "other.example"]) {
      expect(() => requireAiAccess(request(host, "192.0.2.10"))).toThrow();
    }
  });

  it("allows configured deployment hosts only after the owner session has been validated", () => {
    verifiedOwner();
    expect(() =>
      requireAiAccess(
        request("studyos.vercel.app", "192.0.2.10", {
          origin: "https://studyos.vercel.app",
          "sec-fetch-site": "same-origin",
        })
      )
    ).not.toThrow();
    vi.mocked(getCachedOwnerSession).mockReturnValue(null);
    expect(() =>
      requireAiAccess(request("studyos.vercel.app", "192.0.2.10"), {
        role: "admin",
      })
    ).toThrow();
  });

  it.each([
    { VERCEL: undefined },
    { VERCEL: "0" },
    { STUDYOS_CLOUD_ACCESS: undefined },
    { STUDYOS_CLOUD_ACCESS: "true" },
  ])("requires explicit cloud mode and the Vercel runtime: %j", config => {
    protectedVercel(config);
    expect(() =>
      requireAiAccess(request("studyos.vercel.app", "192.0.2.10"))
    ).toThrow();
  });

  it("fails closed when no protected hostname is configured", () => {
    verifiedOwner({
      VERCEL_URL: undefined,
      VERCEL_BRANCH_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
    });
    expect(() =>
      requireAiAccess(request("studyos.vercel.app", "192.0.2.10"))
    ).toThrow();
  });

  it.each([
    "*.example",
    "https://study.example",
    "study.example:443",
    "study.example/path",
    "study.example@evil.example",
    "study.example,",
    "127.0.0.1",
    "localhost",
    "private.localhost",
    "study.example.",
  ])("fails closed on invalid configured hostnames: %s", host => {
    verifiedOwner({ STUDYOS_PUBLIC_HOSTS: host });
    expect(() =>
      requireAiAccess(request("studyos.vercel.app", "192.0.2.10"))
    ).toThrow();
  });

  it.each([
    "evil.example",
    "studyos.vercel.app.evil.example",
    "studyos.vercel.app:80",
    "studyos.vercel.app:8443",
    "studyos.vercel.app.",
    "%73tudyos.vercel.app",
    "studyos.vercel.app@evil.example",
    "studyos.vercel.app/path",
  ])("rejects unprotected or disguised request hosts: %s", host => {
    verifiedOwner();
    const req = request(host, "192.0.2.10", {
      "x-forwarded-host": "studyos.vercel.app",
      "x-vercel-id": "spoofed",
      "x-vercel-protection-bypass": "spoofed",
    });
    expect(() => requireAiAccess(req)).toThrow();
    expect(() => requireAiAccess(req, { role: "admin" })).toThrow();
  });

  it.each([
    { origin: "https://evil.example" },
    { origin: "http://studyos.vercel.app" },
    { origin: "https://studyos.vercel.app:8443" },
    { origin: "null" },
    { origin: ["https://studyos.vercel.app"] },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ])("preserves browser request isolation: %j", headers => {
    verifiedOwner();
    expect(() =>
      requireAiAccess(request("studyos.vercel.app", "192.0.2.10", headers))
    ).toThrow();
  });

  it("does not grant remote access using deployment identity headers", () => {
    expect(() =>
      requireAiAccess(
        request("studyos.vercel.app", "192.0.2.10", {
          "x-vercel-id": "spoofed",
          "x-vercel-authenticated-user-email": "owner@example.com",
          "x-forwarded-for": "127.0.0.1",
        })
      )
    ).toThrow();
  });
});
