import { once } from "node:events";
import { createServer, type Server } from "node:http";
import express from "express";
import { TRPCError } from "@trpc/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { registerOwnerAuthRoutes } from "./routes";
import { OwnerRateLimitError } from "./service";

const operations = vi.hoisted(() => ({
  getOwnerStatus: vi.fn(),
  setupOwner: vi.fn(),
  loginOwner: vi.fn(),
  logoutOwner: vi.fn(),
}));

vi.mock("./service", async importOriginal => {
  const actual = await importOriginal<typeof import("./service")>();
  return { ...actual, ...operations };
});

const signedIn = {
  enabled: true,
  authenticated: true,
  setupRequired: false,
  username: "Study.Owner",
};
const signedOut = {
  enabled: true,
  authenticated: false,
  setupRequired: false,
};
const sealedCookie = "sealed-session-only-for-the-http-cookie";

describe("owner authentication HTTP routes", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    registerOwnerAuthRoutes(app);
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.stubEnv("VERCEL", undefined);
    for (const operation of Object.values(operations)) operation.mockReset();
    operations.getOwnerStatus.mockResolvedValue(signedOut);
    operations.setupOwner.mockResolvedValue({ status: signedIn, sealedCookie });
    operations.loginOwner.mockResolvedValue({ status: signedIn, sealedCookie });
    operations.logoutOwner.mockResolvedValue(signedOut);
  });

  afterEach(() => vi.unstubAllEnvs());

  function post(path: string, body: unknown = {}) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify(body),
    });
  }

  it("returns only public session state and prevents browser/proxy caching", async () => {
    operations.getOwnerStatus.mockResolvedValue({
      ...signedOut,
      setupRequired: true,
    });
    const response = await fetch(`${baseUrl}/api/owner/session`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({
      ...signedOut,
      setupRequired: true,
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(operations.getOwnerStatus).toHaveBeenCalledOnce();
  });

  it("rejects malformed JSON without echoing its private content", async () => {
    const response = await fetch(`${baseUrl}/api/owner/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: '{"password":"malformed-private-password",',
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("malformed-private-password");
    expect(operations.loginOwner).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects oversized login bodies before invoking authentication", async () => {
    const response = await post("/api/owner/login", {
      username: "Study.Owner",
      password: `oversized-private-password-${"x".repeat(20 * 1024)}`,
    });
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("oversized-private-password");
    expect(operations.loginOwner).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    ["setup", operations.setupOwner],
    ["login", operations.loginOwner],
  ])(
    "sets the %s session in an HttpOnly cookie without echoing it",
    async (path, operation) => {
      const input = {
        username: "Study.Owner",
        password: "private password with spaces",
        ...(path === "setup" ? { setupKey: "private-setup-key" } : {}),
      };
      const response = await post(`/api/owner/${path}`, input);
      const body = await response.json();
      const cookie = response.headers.get("set-cookie");

      expect(response.status).toBe(200);
      expect(body).toEqual(signedIn);
      expect(JSON.stringify(body)).not.toContain(sealedCookie);
      expect(JSON.stringify(body)).not.toContain(input.password);
      expect(JSON.stringify(body)).not.toContain("private-setup-key");
      expect(cookie).toContain(`studyos_owner=${sealedCookie}`);
      expect(cookie).toContain("Max-Age=86400");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain("Secure");
      expect(cookie).not.toContain("Domain=");
      expect(operation).toHaveBeenCalledOnce();
      expect(operation.mock.calls[0][1]).toEqual(input);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  );

  it("uses a Secure host-only production cookie behind Vercel's proxy", async () => {
    vi.stubEnv("VERCEL", "1");
    const response = await post("/api/owner/login", {
      username: "Study.Owner",
      password: "private password with spaces",
    });
    const cookie = response.headers.get("set-cookie");

    expect(response.status).toBe(200);
    expect(cookie).toContain(`__Host-studyos_owner=${sealedCookie}`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
  });

  it("revokes the session before clearing its cookie", async () => {
    const response = await post("/api/owner/logout");
    const cookie = response.headers.get("set-cookie");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(signedOut);
    expect(operations.logoutOwner).toHaveBeenCalledOnce();
    expect(cookie).toContain("studyos_owner=;");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it.each([
    ["BAD_REQUEST", 400],
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
    ["CONFLICT", 409],
    ["TOO_MANY_REQUESTS", 429],
  ] as const)(
    "handles asynchronous %s rejections as safe HTTP %i responses",
    async (code, status) => {
      operations.loginOwner.mockRejectedValue(
        new TRPCError({ code, message: "Safe authentication error" })
      );
      const response = await post("/api/owner/login", {});

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: "Safe authentication error",
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  );

  it("returns Retry-After for the durable admission limiter", async () => {
    operations.loginOwner.mockRejectedValue(new OwnerRateLimitError(47));
    const response = await post("/api/owner/login", {});

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("47");
    expect(await response.json()).toEqual({
      error: expect.any(String),
    });
  });

  it.each([
    new Error("password=private-value; setupKey=private-bootstrap-token"),
    new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Private Blob token and password details must remain private",
    }),
  ])(
    "hides unexpected and storage errors without issuing a session",
    async error => {
      operations.setupOwner.mockRejectedValue(error);
      const response = await post("/api/owner/setup", {});
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toEqual({
        error: "Owner authentication is unavailable. Please try again later.",
      });
      expect(JSON.stringify(body)).not.toContain("private");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  );

  it("does not clear the cookie when durable logout revocation fails", async () => {
    operations.logoutOwner.mockRejectedValue(new Error("Blob offline"));
    const response = await post("/api/owner/logout");

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: "Owner authentication is unavailable. Please try again later.",
    });
  });

  it("catches session-status failures without leaking authentication configuration", async () => {
    operations.getOwnerStatus.mockRejectedValue(
      new Error("missing private secret")
    );
    const response = await fetch(`${baseUrl}/api/owner/session`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Owner authentication is unavailable. Please try again later.",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
