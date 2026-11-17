import { createServer, request as nativeRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../_core/app";
import { createContext, type TrpcContext } from "../_core/context";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appRouter } from "../routers";
import { requireAiAccess } from "../ai/access";
import { getOwnerSession } from "./service";
import { invokeConnection, streamConnection } from "../ai/transport";
import { storagePut } from "../storage";
import { registerOAuthRoutes } from "../_core/oauth";
import { sdk } from "../_core/sdk";

vi.mock("../ai/transport", () => ({
  invokeConnection: vi.fn().mockResolvedValue({
    text: "Owner answer",
    truncated: false,
    provider: "Fixture provider",
  }),
  streamConnection: vi.fn(async (_connection, _messages, _options, onToken) => {
    onToken("Owner answer");
    return {
      text: "Owner answer",
      truncated: false,
      provider: "Fixture provider",
    };
  }),
  testConnection: vi
    .fn()
    .mockResolvedValue({ ok: true, message: "Connected", latencyMs: 1 }),
  discoverModels: vi.fn().mockResolvedValue([{ id: "fixture-model" }]),
}));
vi.mock("../storage", () => ({
  storagePut: vi
    .fn()
    .mockResolvedValue({ url: "/manus-storage/owner-avatar.png" }),
}));
vi.mock("../_core/oauth", () => ({ registerOAuthRoutes: vi.fn() }));
vi.mock("../_core/sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));
vi.mock("../_core/storageProxy", () => ({
  registerStorageProxy: (app: Express) =>
    app.get("/manus-storage/*", (_req, res) => res.json({ ownerFile: true })),
}));

let directory: string;
let server: Server;
let base: string;
const setupKey = "integration-only-setup-key-00000000000000000000";
const account = {
  username: "fixture-owner",
  password: "Integration-owner-password-ONLY",
};
const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString("base64")}`;
const probeRouter = router({
  protected: protectedProcedure.query(({ ctx }) => ({
    username: ctx.owner?.username,
    user: ctx.user,
  })),
  admin: adminProcedure.query(({ ctx }) => ({
    username: ctx.owner?.username,
    user: ctx.user,
  })),
});

beforeEach(async () => {
  const root = path.resolve("tmp/owner-auth-integration");
  await fs.mkdir(root, { recursive: true });
  directory = await fs.mkdtemp(path.join(root, "case-"));
  vi.stubEnv("VERCEL", undefined);
  vi.stubEnv("STUDYOS_OWNER_AUTH", "enabled");
  vi.stubEnv(
    "STUDYOS_OWNER_SESSION_SECRET",
    "integration-only-session-secret-0000000000000000"
  );
  vi.stubEnv("STUDYOS_OWNER_SETUP_ENABLED", "true");
  vi.stubEnv("STUDYOS_OWNER_SETUP_KEY", setupKey);
  vi.stubEnv("STUDYOS_DATA_DIR", directory);
  vi.stubEnv("STUDYOS_AI_STORAGE", "local");
  vi.stubEnv("STUDYOS_LOCAL_MODE", "true");
  vi.stubEnv("STUDYOS_PUBLIC_HOSTS", undefined);
  vi.clearAllMocks();
  server = createServer(await createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

function request(
  url: string,
  options: {
    method?: string;
    json?: unknown;
    body?: string;
    cookie?: string;
    headers?: Record<string, string>;
  } = {}
) {
  const method =
    options.method ??
    (options.json !== undefined || options.body !== undefined ? "POST" : "GET");
  if (options.headers?.host) {
    // fetch implementations can normalize Host to the connection URL. A real
    // HTTP request lets the cloud-host boundary be tested over the local socket.
    return new Promise<Response>((resolve, reject) => {
      const outgoing = nativeRequest(
        `${base}${url}`,
        {
          method,
          headers: {
            "content-type": "application/json",
            ...(method !== "GET" && method !== "HEAD" ? { origin: base } : {}),
            ...(options.cookie ? { cookie: options.cookie } : {}),
            ...options.headers,
          },
        },
        incoming => {
          const chunks: Buffer[] = [];
          incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
          incoming.on("error", reject);
          incoming.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              for (const item of Array.isArray(value)
                ? value
                : value === undefined
                  ? []
                  : [value])
                headers.append(name, item);
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: incoming.statusCode,
                headers,
              })
            );
          });
        }
      );
      outgoing.on("error", reject);
      outgoing.end(
        options.json !== undefined ? JSON.stringify(options.json) : options.body
      );
    });
  }
  return fetch(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(method !== "GET" && method !== "HEAD" ? { origin: base } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    ...(options.json !== undefined
      ? { body: JSON.stringify(options.json) }
      : options.body !== undefined
        ? { body: options.body }
        : {}),
    redirect: "manual",
  });
}

async function setup() {
  const response = await request("/api/owner/setup", {
    json: { ...account, setupKey },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    authenticated: true,
    username: account.username,
  });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toMatch(/^studyos_owner=/);
  return cookie!;
}

async function mutation(name: string, input: unknown, cookie: string) {
  const response = await request(`/api/trpc/${name}`, {
    cookie,
    json: { json: input },
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.result.data.json;
}

function callerContext(cookie?: string): TrpcContext {
  return {
    req: {
      method: "GET",
      protocol: "http",
      headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) },
      socket: { remoteAddress: "127.0.0.1" },
    } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: { id: 99, role: "admin" } as NonNullable<TrpcContext["user"]>,
    owner: { id: "invented-owner", username: "invented-owner" },
  };
}

describe("owner authentication across the running API", () => {
  it("keeps only authentication endpoints public and rejects every business tRPC procedure", async () => {
    const status = await request("/api/owner/session");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      enabled: true,
      authenticated: false,
      setupRequired: true,
    });
    for (const [name, procedure] of Object.entries(appRouter._def.procedures)) {
      const method = procedure._def.type === "query" ? "GET" : "POST";
      const response = await request(`/api/trpc/${name}`, {
        method,
        ...(method === "POST" ? { json: { json: {} } } : {}),
      });
      expect(response.status, name).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "OWNER_AUTH_REQUIRED",
      });
    }
    expect(invokeConnection).not.toHaveBeenCalled();
    expect(streamConnection).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("rejects forged cookies and legacy identity claims before reading a malformed upload or starting SSE", async () => {
    const headers = {
      authorization: "Bearer forged-legacy-admin",
      "x-vercel-protection-bypass": "invented",
      "x-forwarded-user": "admin",
    };
    for (const url of [
      "/api/trpc/study.uploadDocument",
      "/api/trpc/study.uploadAvatar",
      "/api/study/chat-stream",
    ]) {
      const response = await request(url, {
        cookie: "studyos_owner=forged; app_session_id=legacy-forged",
        headers,
        body: "{broken-json",
      });
      expect(response.status, url).toBe(401);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
    }
    expect((await request("/manus-storage/private-source")).status).toBe(401);
    expect(storagePut).not.toHaveBeenCalled();
    expect(streamConnection).not.toHaveBeenCalled();
  });

  it("does not let a manufactured context owner or legacy admin bypass direct tRPC callers", async () => {
    const context = callerContext();
    const caller = appRouter.createCaller(context);
    await expect(caller.system.health({ timestamp: 1 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.aiConnections.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.study.uploadAvatar({ imageDataUrl: png })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      probeRouter.createCaller(context).admin()
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(() => requireAiAccess(context.req, context.user)).toThrow();
  });

  it("allows the real owner to manage connections, import profile and study data, and stream an answer without MySQL", async () => {
    const cookie = await setup();
    const listed = await request("/api/trpc/aiConnections.list", { cookie });
    expect(listed.status).toBe(200);
    expect((await listed.json()).result.data.json).toEqual({
      connections: [],
      activeId: null,
    });
    expect(
      await mutation("study.uploadAvatar", { imageDataUrl: png }, cookie)
    ).toEqual({ url: png });
    const text = "A private owner study source.";
    expect(
      await mutation(
        "study.uploadDocument",
        {
          name: "owner.txt",
          mimeType: "text/plain",
          dataUrl: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
        },
        cookie
      )
    ).toMatchObject({ content: text, url: "", format: "TXT" });
    const saved = await mutation(
      "aiConnections.save",
      {
        name: "Fixture provider",
        baseUrl: "http://127.0.0.1:65000/v1",
        model: "fixture-model",
        apiKey: "integration-fixture-not-a-real-provider-key",
      },
      cookie
    );
    await mutation("aiConnections.activate", { id: saved.id }, cookie);
    const response = await request("/api/study/chat-stream", {
      cookie,
      json: {
        sessionName: "Owner session",
        materials: text,
        translate: false,
        responseStyle: "Fast",
        model: "active",
        history: [{ role: "user", content: "Explain this source" }],
      },
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain("event: token");
    expect(stream).toContain("Owner answer");
    expect(stream).toContain("event: done");
    expect(streamConnection).toHaveBeenCalledOnce();
    expect(sdk.authenticateRequest).not.toHaveBeenCalled();
    const ctx = callerContext(cookie);
    expect(await createContext({ req: ctx.req, res: ctx.res })).toMatchObject({
      user: null,
      owner: { username: account.username },
    });
    expect(await probeRouter.createCaller(ctx).protected()).toEqual({
      username: account.username,
      user: null,
    });
    expect(await probeRouter.createCaller(ctx).admin()).toEqual({
      username: account.username,
      user: null,
    });
  });

  it("removes legacy OAuth entirely and protects cloud file routes when cloud study mode is selected", async () => {
    vi.stubEnv("STUDYOS_LOCAL_MODE", "false");
    const other = createServer(await createApp());
    await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
    const previous = base;
    base = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      expect((await request("/manus-storage/private-source")).status).toBe(401);
      const cookie = await setup();
      const fileResponse = await request("/manus-storage/private-source", {
        cookie,
      });
      expect(fileResponse.status).toBe(200);
      expect(await fileResponse.json()).toEqual({ ownerFile: true });
      expect(
        (
          await request("/api/oauth/callback?code=forged&state=forged", {
            cookie,
          })
        ).status
      ).toBe(404);
      expect(registerOAuthRoutes).not.toHaveBeenCalled();
      expect(sdk.authenticateRequest).not.toHaveBeenCalled();
      expect(
        await mutation("study.uploadAvatar", { imageDataUrl: png }, cookie)
      ).toEqual({ url: "/manus-storage/owner-avatar.png" });
      expect(storagePut).toHaveBeenCalledOnce();
    } finally {
      base = previous;
      other.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        other.close(error => (error ? reject(error) : resolve()))
      );
    }
  });

  it("ignores the former Vercel platform bypass and fails closed when owner mode is missing", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("STUDYOS_CLOUD_ACCESS", "vercel-protected");
    vi.stubEnv("VERCEL_URL", "owner.example.com");
    vi.stubEnv("VERCEL_BRANCH_URL", undefined);
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", undefined);
    const headers = {
      host: "owner.example.com",
      origin: "https://owner.example.com",
    };
    expect(
      (await request("/api/trpc/aiConnections.list", { headers })).status
    ).toBe(401);
    expect(
      (await request("/api/study/chat-stream", { headers, json: {} })).status
    ).toBe(401);
    expect(
      (await request("/manus-storage/private-source", { headers })).status
    ).toBe(401);
    vi.stubEnv("STUDYOS_OWNER_AUTH", undefined);
    expect(
      (await request("/api/trpc/aiConnections.list", { headers })).status
    ).toBe(503);
    expect((await request("/api/owner/session", { headers })).status).toBe(503);
  });

  it("uses the small safe authentication parser and requires a matching origin on authenticated mutations", async () => {
    const malformed = await request("/api/owner/login", {
      body: "{broken-json",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toContain("application/json");
    const oversized = await request("/api/owner/login", {
      json: { password: "x".repeat(9 * 1024) },
    });
    expect(oversized.status).toBe(413);
    const cookie = await setup();
    const crossOrigin = await request("/api/trpc/study.uploadAvatar", {
      cookie,
      headers: { origin: "https://attacker.example" },
      json: { json: { imageDataUrl: png } },
    });
    expect(crossOrigin.status).toBe(403);
    expect(storagePut).not.toHaveBeenCalled();
    const direct = callerContext(cookie);
    await getOwnerSession(direct.req);
    direct.req.headers.origin = "https://attacker.example";
    expect(() => requireAiAccess(direct.req, { role: "admin" })).toThrow();
  });

  it("revokes an already issued cookie for all subsequent business requests on logout", async () => {
    const cookie = await setup();
    expect(
      (await request("/api/trpc/aiConnections.list", { cookie })).status
    ).toBe(200);
    const logout = await request("/api/owner/logout", { cookie, json: {} });
    expect(logout.status).toBe(200);
    expect(
      (await request("/api/trpc/aiConnections.list", { cookie })).status
    ).toBe(401);
    expect(
      (await request("/api/study/chat-stream", { cookie, json: {} })).status
    ).toBe(401);
  });
});
