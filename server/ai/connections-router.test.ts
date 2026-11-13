import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConnectionDraft } from "@shared/ai-connections";
import type { TrpcContext } from "../_core/context";
import { aiConnectionsRouter } from "./connections-router";
import { getActiveConnection, listConnections } from "./connection-store";
import { discoverModels, testConnection } from "./transport";

vi.mock("./transport", () => ({
  testConnection: vi
    .fn()
    .mockResolvedValue({ ok: true, message: "Connected", latencyMs: 12 }),
  discoverModels: vi
    .fn()
    .mockResolvedValue([{ id: "first-model", name: "First" }]),
}));

let directory: string;
const draft = (
  changes: Partial<AiConnectionDraft> = {}
): AiConnectionDraft => ({
  name: "My gateway",
  protocol: "openai-chat",
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "test-model",
  apiKey: "router-api-secret-1234",
  extraHeaders: { "x-gateway-token": "router-header-secret" },
  ...changes,
});
function context(
  remoteAddress = "127.0.0.1",
  host = "localhost:3000",
  role?: "admin" | "user"
): TrpcContext {
  return {
    req: {
      headers: {
        host,
        origin: `http://${host}`,
        "sec-fetch-site": "same-origin",
      },
      socket: { remoteAddress },
      protocol: "http",
    } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    user: role ? ({ role } as TrpcContext["user"]) : null,
  };
}

beforeEach(async () => {
  const root = path.resolve("tmp/ai-rework");
  await fs.mkdir(root, { recursive: true });
  directory = await fs.mkdtemp(path.join(root, "router-"));
  vi.stubEnv("STUDYOS_DATA_DIR", directory);
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("AI connections API", () => {
  it("guards every operation before reading credentials or calling a provider", async () => {
    const caller = aiConnectionsRouter.createCaller(
      context("198.51.100.10", "example.com")
    );
    const id = "12f024cd-d1b4-4a74-884d-04e283d746b4";
    for (const operation of [
      () => caller.list(),
      () => caller.save(draft()),
      () => caller.remove({ id }),
      () => caller.activate({ id }),
      () => caller.test({ draft: draft() }),
      () => caller.models({ draft: draft() }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(testConnection).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("allows a signed-in administrator and returns safe connection DTOs only", async () => {
    const caller = aiConnectionsRouter.createCaller(
      context("198.51.100.10", "example.com", "admin")
    );
    const saved = await caller.save(draft());
    expect(saved).toMatchObject({
      hasApiKey: true,
      keySuffix: "1234",
      headerNames: ["x-gateway-token"],
    });
    expect(JSON.stringify(saved)).not.toContain("router-api-secret");
    expect(JSON.stringify(saved)).not.toContain("router-header-secret");
    expect(await caller.list()).toEqual({
      connections: [saved],
      activeId: null,
    });
    expect(await caller.activate({ id: saved.id })).toEqual({
      activeId: saved.id,
    });
    expect((await getActiveConnection()).id).toBe(saved.id);
    expect(await caller.remove({ id: saved.id })).toEqual({ activeId: null });
  });

  it("tests an unsaved draft using stored secret fields without saving its edits", async () => {
    const caller = aiConnectionsRouter.createCaller(context());
    const saved = await caller.save(draft());
    expect(
      await caller.test({
        id: saved.id,
        draft: draft({
          id: saved.id,
          name: "Not saved",
          apiKey: undefined,
          extraHeaders: undefined,
        }),
      })
    ).toEqual({ ok: true, message: "Connected", latencyMs: 12 });
    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Not saved",
        apiKey: "router-api-secret-1234",
        extraHeaders: { "x-gateway-token": "router-header-secret" },
      })
    );
    expect((await caller.list()).connections[0].name).toBe("My gateway");
    expect((await caller.list()).activeId).toBeNull();
  });

  it("discovers models from unsaved or saved settings and does not persist new drafts", async () => {
    const caller = aiConnectionsRouter.createCaller(context());
    await expect(
      caller.models({ draft: draft({ model: "model-list" }) })
    ).resolves.toEqual({ models: [{ id: "first-model", name: "First" }] });
    expect(discoverModels).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "router-api-secret-1234",
      })
    );
    expect(await listConnections()).toEqual({
      connections: [],
      activeId: null,
    });
    const saved = await caller.save(draft());
    await caller.models({ id: saved.id });
    expect(discoverModels).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: saved.id,
        apiKey: "router-api-secret-1234",
      })
    );
  });

  it("rejects invalid or ambiguous draft credentials before invoking transport", async () => {
    const caller = aiConnectionsRouter.createCaller(context());
    await expect(caller.test({})).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller.test({ draft: draft({ apiKey: "new-key", clearApiKey: true }) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.models({
        draft: draft({ extraHeaders: { Authorization: "secret" } }),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(testConnection).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });
});
