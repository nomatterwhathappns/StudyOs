import type { Request } from "express";
import { createHash } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  authEnabled,
  getCachedOwnerSession,
  getOwnerSession,
  getOwnerStatus,
  loginOwner,
  logoutOwner,
  setupOwner,
  validateOwnerRequest,
} from "./service";

const backing = vi.hoisted(() => ({
  state: undefined as any,
  tail: Promise.resolve() as Promise<unknown>,
  read: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("./store", () => ({
  readOwnerState: backing.read,
  mutateOwnerState: backing.mutate,
}));

const password = "  owner password with spaces 🔑  ";
const setupKey = "a-strong-test-only-bootstrap-key-0123456789";
let fixture: any;
let validCookie: string;

function environment() {
  for (const name of [
    "VERCEL",
    "VERCEL_URL",
    "VERCEL_BRANCH_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
    "STUDYOS_PUBLIC_HOSTS",
  ])
    vi.stubEnv(name, undefined);
  vi.stubEnv("STUDYOS_OWNER_AUTH", "enabled");
  vi.stubEnv(
    "STUDYOS_OWNER_SESSION_SECRET",
    "test-session-secret-with-at-least-32-characters"
  );
  vi.stubEnv("STUDYOS_OWNER_SETUP_ENABLED", "true");
  vi.stubEnv("STUDYOS_OWNER_SETUP_KEY", setupKey);
}

function request(
  options: {
    cookie?: string;
    host?: string;
    origin?: string | null;
    site?: string;
    address?: string;
    method?: string;
  } = {}
) {
  return {
    method: options.method ?? "POST",
    protocol: "http",
    headers: {
      host: options.host ?? "localhost:3000",
      ...(options.origin === null
        ? {}
        : { origin: options.origin ?? "http://localhost:3000" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.site ? { "sec-fetch-site": options.site } : {}),
    },
    socket: { remoteAddress: options.address ?? "127.0.0.1" },
  } as unknown as Request;
}

beforeAll(async () => {
  environment();
  backing.read.mockImplementation(async (schema, empty) =>
    schema.parse(structuredClone(backing.state ?? empty()))
  );
  backing.mutate.mockImplementation((schema, empty, operation) => {
    const result = backing.tail.then(() => {
      const current = schema.parse(structuredClone(backing.state ?? empty()));
      const next = operation(current);
      backing.state = schema.parse(structuredClone(next.state));
      return next.result;
    });
    backing.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  });
  const setup = await setupOwner(request(), {
    setupKey,
    username: "Owner.One",
    password,
  });
  validCookie = `studyos_owner=${setup.sealedCookie}`;
  fixture = structuredClone(backing.state);
  fixture.attempts = [];
});

beforeEach(() => {
  environment();
  backing.state = structuredClone(fixture);
  backing.tail = Promise.resolve();
  backing.read.mockClear();
  backing.mutate.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("owner account bootstrap and login", () => {
  it("stores a salted hash and only hashed session IDs, never the supplied password", () => {
    expect(JSON.stringify(fixture)).not.toContain(password);
    expect(fixture.owner.salt).toHaveLength(44);
    expect(fixture.owner.passwordHash).toHaveLength(88);
    expect(fixture.sessions[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.sessions[0]).not.toHaveProperty("id");
  });

  it("requires the setup flag and private bootstrap key before creating an owner", async () => {
    backing.state = undefined;
    vi.stubEnv("STUDYOS_OWNER_SETUP_ENABLED", "false");
    await expect(
      setupOwner(request(), { setupKey, username: "new-owner", password })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(backing.state).toBeUndefined();
    vi.stubEnv("STUDYOS_OWNER_SETUP_ENABLED", "true");
    await expect(
      setupOwner(request(), {
        setupKey: "wrong-key",
        username: "new-owner",
        password,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(backing.state.owner).toBeNull();
    expect(backing.state.sessions).toEqual([]);
    expect(
      backing.state.attempts.find((item: any) => item.key === "global").count
    ).toBe(1);
  });

  it("never overwrites an owner even with the correct setup key", async () => {
    await expect(
      setupOwner(request(), { setupKey, username: "new-owner", password })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(backing.state.owner).toEqual(fixture.owner);
  });

  it("allows exactly one owner when two setup requests race", async () => {
    backing.state = undefined;
    const results = await Promise.allSettled([
      setupOwner(request(), { setupKey, username: "first-owner", password }),
      setupOwner(request(), { setupKey, username: "second-owner", password }),
    ]);
    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results
        .filter(result => result.status === "rejected")
        .map(result => result.reason.code)
    ).toEqual(["CONFLICT"]);
    const winner = results.find(result => result.status === "fulfilled")!;
    expect(backing.state.owner.username).toBe(winner.value.status.username);
    expect(backing.state.sessions).toHaveLength(1);
  });

  it("authenticates case-insensitive usernames while preserving password spaces", async () => {
    const result = await loginOwner(request(), {
      username: "OWNER.ONE",
      password,
    });
    expect(result.status).toEqual({
      enabled: true,
      authenticated: true,
      setupRequired: false,
      username: "Owner.One",
    });
    expect(JSON.stringify(result.status)).not.toContain(result.sealedCookie);
    expect(
      await getOwnerSession(
        request({ cookie: `studyos_owner=${result.sealedCookie}` })
      )
    ).toMatchObject({ username: "Owner.One" });
    await expect(
      loginOwner(request(), {
        username: "OWNER.ONE",
        password: password.trim(),
      })
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Username or password is incorrect.",
    });
  });

  it("returns the same failure for a wrong username and a wrong password", async () => {
    const wrongUsername = loginOwner(request(), {
      username: "another-owner",
      password,
    });
    await expect(wrongUsername).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Username or password is incorrect.",
    });
    await expect(
      loginOwner(request(), {
        username: "Owner.One",
        password: "wrong password",
      })
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Username or password is incorrect.",
    });
  });

  it("rejects short setup passwords without silently truncating or trimming", async () => {
    backing.state = undefined;
    await expect(
      setupOwner(request(), {
        setupKey,
        username: "new-owner",
        password: "short",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      setupOwner(request(), {
        setupKey,
        username: "new-owner",
        password: "🔑".repeat(129),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(backing.state).toBeUndefined();
  });

  it("reserves distributed attempt slots before concurrent password checks", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        loginOwner(request(), { username: "Owner.One", password: "incorrect" })
      )
    );
    const errors = results.map(result =>
      result.status === "rejected" ? result.reason.code : "success"
    );
    expect(errors.filter(code => code === "UNAUTHORIZED")).toHaveLength(5);
    expect(errors.filter(code => code === "TOO_MANY_REQUESTS")).toHaveLength(1);
    expect(
      backing.state.attempts.find((item: any) => item.key.startsWith("client:"))
        .count
    ).toBe(5);
  }, 15_000);

  it("does not let spoofed forwarding headers bypass the client bucket", async () => {
    // Reuse the actually admitted socket-derived key instead of any forwarding header.
    await expect(
      loginOwner(request(), { username: "Owner.One", password: "incorrect" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const bucket = backing.state.attempts.find((item: any) =>
      item.key.startsWith("client:")
    );
    bucket.count = 5;
    const req = request();
    req.headers["x-forwarded-for"] = "203.0.113.100";
    req.headers["x-vercel-forwarded-for"] = "203.0.113.101";
    await expect(
      loginOwner(req, { username: "Owner.One", password })
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("uses Vercel's valid platform client IP independently of the shared socket", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "studyos.vercel.app");
    const socket = "192.0.2.10";
    const platformIp = "203.0.113.101";
    backing.state.attempts = [
      {
        key: `client:${createHash("sha256").update(socket).digest("hex")}`,
        startedAt: Date.now(),
        count: 5,
      },
    ];
    const req = request({
      host: "studyos.vercel.app",
      origin: "https://studyos.vercel.app",
      address: socket,
    });
    req.headers["x-vercel-forwarded-for"] = platformIp;
    expect(
      (await loginOwner(req, { username: "Owner.One", password })).status
        .authenticated
    ).toBe(true);
    expect(backing.state.attempts).toContainEqual(
      expect.objectContaining({
        key: `client:${createHash("sha256").update(platformIp).digest("hex")}`,
        count: 1,
      })
    );
  });

  it.each(["203.0.113.101, 198.51.100.1", "invalid-client", ["203.0.113.101"]])(
    "falls back to the socket for malformed platform IP headers: %j",
    async header => {
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "studyos.vercel.app");
      const socket = "192.0.2.10";
      backing.state.attempts = [
        {
          key: `client:${createHash("sha256").update(socket).digest("hex")}`,
          startedAt: Date.now(),
          count: 5,
        },
      ];
      const req = request({
        host: "studyos.vercel.app",
        origin: "https://studyos.vercel.app",
        address: socket,
      });
      req.headers["x-vercel-forwarded-for"] = header;
      await expect(
        loginOwner(req, { username: "Owner.One", password })
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    }
  );

  it("limits all clients through the shared global bucket", async () => {
    backing.state.attempts = [
      { key: "global", startedAt: Date.now(), count: 30 },
    ];
    await expect(
      loginOwner(request({ address: "127.0.0.2" }), {
        username: "Owner.One",
        password,
      })
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(backing.state.attempts).toHaveLength(1);
  });

  it("bounds concurrent sessions and evicts the oldest when signing in", async () => {
    const now = Date.now();
    backing.state.sessions = Array.from({ length: 10 }, (_, index) => ({
      hash: String(index).padStart(64, "0"),
      createdAt: now - 100 + index,
      expiresAt: now + 10_000,
    }));
    const result = await loginOwner(request(), {
      username: "Owner.One",
      password,
    });
    expect(backing.state.sessions).toHaveLength(10);
    expect(
      backing.state.sessions.some(
        (session: any) => session.hash === "0".repeat(64)
      )
    ).toBe(false);
    expect(
      await getOwnerSession(
        request({ cookie: `studyos_owner=${result.sealedCookie}` })
      )
    ).not.toBeNull();
  });
});

describe("owner sessions and request boundary", () => {
  it("publishes no owner identity until a sealed and stored session is verified", async () => {
    expect(await getOwnerStatus(request({ method: "GET" }))).toEqual({
      enabled: true,
      authenticated: false,
      setupRequired: false,
    });
    backing.state = undefined;
    expect(await getOwnerStatus(request({ method: "GET" }))).toEqual({
      enabled: true,
      authenticated: false,
      setupRequired: true,
    });
  });

  it("only caches verified sessions and binds the cache to the cookie header", async () => {
    const req = request({ cookie: validCookie });
    expect(getCachedOwnerSession(req)).toBeNull();
    expect(await getOwnerSession(req)).toMatchObject({ username: "Owner.One" });
    expect(getCachedOwnerSession(req)).toMatchObject({ username: "Owner.One" });
    await getOwnerSession(req);
    expect(backing.read).toHaveBeenCalledTimes(1);
    req.headers.cookie = "studyos_owner=forged";
    expect(getCachedOwnerSession(req)).toBeNull();
    expect(await getOwnerSession(req)).toBeNull();
  });

  it("rechecks request origin before reusing a verified session cache", async () => {
    const req = request({ cookie: validCookie });
    await getOwnerSession(req);
    req.headers.origin = "https://evil.example";
    await expect(getOwnerSession(req)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("revokes a logout session durably for a different request", async () => {
    expect(
      await getOwnerSession(request({ cookie: validCookie }))
    ).not.toBeNull();
    expect(await logoutOwner(request({ cookie: validCookie }))).toMatchObject({
      authenticated: false,
    });
    expect(await getOwnerSession(request({ cookie: validCookie }))).toBeNull();
  });

  it("rejects expired sessions even when their cookie was previously valid", async () => {
    backing.state.sessions[0].expiresAt = Date.now() - 1;
    expect(await getOwnerSession(request({ cookie: validCookie }))).toBeNull();
  });

  it("fails closed when durable session storage is unavailable", async () => {
    backing.read.mockRejectedValueOnce(new Error("private-storage-error"));
    await expect(
      getOwnerSession(request({ cookie: validCookie }))
    ).rejects.toThrow("private-storage-error");
  });

  it.each([
    { origin: null },
    { origin: "https://evil.example" },
    { site: "same-site" },
    { site: "cross-site" },
    { host: "localhost:3000@evil.example" },
    { host: "localhost.evil:3000" },
    { address: "192.0.2.10" },
  ])("denies invalid owner request boundaries: %j", async options => {
    await expect(
      loginOwner(request(options), { username: "Owner.One", password })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(backing.mutate).not.toHaveBeenCalled();
  });

  it("uses trusted public host config with HTTPS default ports, not proxy identity headers", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "studyos.vercel.app");
    const req = request({
      host: "studyos.vercel.app:443",
      origin: "https://studyos.vercel.app",
      address: "192.0.2.10",
    });
    expect(() => validateOwnerRequest(req, true)).not.toThrow();
    req.headers.host = "attacker.example";
    req.headers["x-forwarded-host"] = "studyos.vercel.app";
    req.headers["x-vercel-authenticated-user-email"] = "owner@example.com";
    expect(() => validateOwnerRequest(req, true)).toThrow();
  });

  it("does not expose local fallback for an unconfigured Vercel deployment", () => {
    vi.stubEnv("STUDYOS_OWNER_AUTH", undefined);
    expect(authEnabled()).toBe(false);
    vi.stubEnv("VERCEL", "1");
    expect(() => authEnabled()).toThrow();
  });

  it("requires session encryption configuration before accepting a valid cookie", async () => {
    vi.stubEnv("STUDYOS_OWNER_SESSION_SECRET", undefined);
    await expect(
      getOwnerSession(request({ cookie: validCookie }))
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(backing.read).not.toHaveBeenCalled();
  });
});
