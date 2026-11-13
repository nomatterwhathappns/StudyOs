import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConnectionDraft } from "@shared/ai-connections";
import {
  activateConnection,
  deleteConnection,
  getActiveConnection,
  getConnection,
  listConnections,
  resolveDraftConnection,
  saveConnection,
} from "./connection-store";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let directory: string;
const draft = (
  changes: Partial<AiConnectionDraft> = {}
): AiConnectionDraft => ({
  name: "Local gateway",
  baseUrl: "http://127.0.0.1:20128/v1",
  model: "my-model",
  apiKey: "saved-api-secret-9876",
  extraHeaders: { "x-gateway-token": "saved-header-secret" },
  ...changes,
});
const file = (name: string) => path.join(directory, name);

beforeEach(async () => {
  const root = path.resolve("tmp/ai-rework");
  await fs.mkdir(root, { recursive: true });
  directory = await fs.mkdtemp(path.join(root, "store-"));
  vi.stubEnv("STUDYOS_DATA_DIR", directory);
  vi.mocked(fs.rename).mockClear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("AI connection persistence", () => {
  it("lists an uninitialized store without creating any files or choosing a connection", async () => {
    vi.stubEnv("STUDYOS_DATA_DIR", file("not-created"));
    await expect(listConnections()).resolves.toEqual({
      connections: [],
      activeId: null,
    });
    await expect(fs.stat(file("not-created"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(getActiveConnection()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("encrypts credentials, returns safe metadata, and protects the key and store permissions", async () => {
    const saved = await saveConnection(draft());
    expect(saved).toMatchObject({
      name: "Local gateway",
      hasApiKey: true,
      keySuffix: "9876",
      headerNames: ["x-gateway-token"],
    });
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved).not.toHaveProperty("extraHeaders");
    const serialized = await fs.readFile(file("connections.json"), "utf8");
    expect(serialized).not.toContain("saved-api-secret");
    expect(serialized).not.toContain("saved-header-secret");
    expect((await fs.readFile(file("master.key"))).length).toBe(32);
    if (process.platform !== "win32") {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(file("master.key"))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(file("connections.json"))).mode & 0o777).toBe(
        0o600
      );
    }
    expect(await listConnections()).toEqual({
      connections: [saved],
      activeId: null,
    });
    await activateConnection(saved.id);
    await expect(getActiveConnection()).resolves.toMatchObject({
      id: saved.id,
      apiKey: "saved-api-secret-9876",
      extraHeaders: { "x-gateway-token": "saved-header-secret" },
    });
  });

  it("preserves omitted or blank keys and omitted headers, while explicit clear flags remove only the requested secrets", async () => {
    const saved = await saveConnection(draft());
    const original = await getConnection(saved.id);
    await saveConnection(
      draft({
        id: saved.id,
        name: "Renamed",
        apiKey: undefined,
        extraHeaders: undefined,
      })
    );
    expect(await getConnection(saved.id)).toMatchObject({
      apiKey: original.apiKey,
      extraHeaders: original.extraHeaders,
      createdAt: original.createdAt,
      name: "Renamed",
    });
    await saveConnection(
      draft({ id: saved.id, apiKey: "", extraHeaders: undefined })
    );
    expect((await getConnection(saved.id)).apiKey).toBe(original.apiKey);
    await saveConnection(
      draft({
        id: saved.id,
        apiKey: undefined,
        extraHeaders: undefined,
        clearApiKey: true,
      })
    );
    expect(await getConnection(saved.id)).toMatchObject({
      extraHeaders: original.extraHeaders,
    });
    expect((await getConnection(saved.id)).apiKey).toBeUndefined();
    await saveConnection(
      draft({
        id: saved.id,
        apiKey: "replacement-secret",
        extraHeaders: undefined,
        clearHeaders: true,
      })
    );
    expect(await getConnection(saved.id)).toMatchObject({
      apiKey: "replacement-secret",
      extraHeaders: {},
    });
  });

  it("never returns the whole value of short saved keys as a suffix", async () => {
    const saved = await saveConnection(draft({ apiKey: "tiny" }));
    expect(saved).toMatchObject({ hasApiKey: true, keySuffix: null });
    expect(JSON.stringify(await listConnections())).not.toContain("tiny");
    expect((await getConnection(saved.id)).apiKey).toBe("tiny");
  });

  it("does not silently switch active connections when the selected connection is removed", async () => {
    const first = await saveConnection(draft());
    const second = await saveConnection(draft({ name: "Second" }));
    await activateConnection(first.id);
    await deleteConnection(second.id);
    expect((await listConnections()).activeId).toBe(first.id);
    const third = await saveConnection(draft({ name: "Third" }));
    await deleteConnection(first.id);
    expect(await listConnections()).toMatchObject({
      connections: [{ id: third.id }],
      activeId: null,
    });
    await expect(getActiveConnection()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await expect(activateConnection(randomUUID())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await deleteConnection(third.id);
    expect(await listConnections()).toEqual({
      connections: [],
      activeId: null,
    });
  });

  it("merges draft edits with stored secrets without persisting the draft or activating it", async () => {
    const saved = await saveConnection(draft());
    const resolved = await resolveDraftConnection({
      id: saved.id,
      draft: draft({
        id: saved.id,
        name: "Unsaved",
        apiKey: undefined,
        extraHeaders: undefined,
      }),
    });
    expect(resolved).toMatchObject({
      name: "Unsaved",
      apiKey: "saved-api-secret-9876",
      extraHeaders: { "x-gateway-token": "saved-header-secret" },
    });
    expect((await getConnection(saved.id)).name).toBe("Local gateway");
    await resolveDraftConnection({ draft: draft({ name: "New unsaved" }) });
    expect((await listConnections()).connections).toHaveLength(1);
    await expect(
      resolveDraftConnection({
        id: randomUUID(),
        draft: draft({ id: saved.id }),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(resolveDraftConnection({})).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("revalidates preserved custom headers when authentication settings change", async () => {
    const saved = await saveConnection(draft());
    await expect(
      saveConnection(
        draft({
          id: saved.id,
          authType: "header",
          authHeader: "x-gateway-token",
          apiKey: undefined,
          extraHeaders: undefined,
        })
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await getConnection(saved.id)).authType).toBe("bearer");
  });

  it("serializes concurrent creations and enforces the 20-connection limit without lost updates", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 21 }, (_, index) =>
        saveConnection(draft({ name: `Connection ${index}` }))
      )
    );
    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(20);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(
      1
    );
    const state = await listConnections();
    expect(state.connections).toHaveLength(20);
    expect(
      new Set(state.connections.map(connection => connection.id)).size
    ).toBe(20);
    expect(state.activeId).toBeNull();
  });

  it.each(["{broken JSON", JSON.stringify({ version: 99 })])(
    "reports corrupt state without resetting it: %s",
    async broken => {
      await saveConnection(draft());
      await fs.writeFile(file("connections.json"), broken);
      await expect(listConnections()).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
      await expect(saveConnection(draft())).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
      expect(await fs.readFile(file("connections.json"), "utf8")).toBe(broken);
    }
  );

  it("never generates a replacement master key when saved connections already exist", async () => {
    await saveConnection(draft());
    const before = await fs.readFile(file("connections.json"), "utf8");
    await fs.unlink(file("master.key"));
    await expect(listConnections()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    await expect(saveConnection(draft())).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    await expect(fs.stat(file("master.key"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(file("connections.json"), "utf8")).toBe(before);
  });

  it("rejects an incorrect encryption key without changing the saved store", async () => {
    await saveConnection(draft());
    const before = await fs.readFile(file("connections.json"), "utf8");
    await fs.writeFile(file("master.key"), randomBytes(32));
    await expect(listConnections()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(await fs.readFile(file("connections.json"), "utf8")).toBe(before);
  });

  it("keeps the previous state after a failed atomic replacement and recovers the write queue", async () => {
    const saved = await saveConnection(draft());
    await activateConnection(saved.id);
    const before = await fs.readFile(file("connections.json"), "utf8");
    vi.mocked(fs.rename).mockRejectedValueOnce(
      new Error("disk failure containing saved-api-secret-9876")
    );
    await expect(
      saveConnection(draft({ id: saved.id, name: "Failed" }))
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.not.stringContaining("saved-api-secret"),
    });
    expect(await fs.readFile(file("connections.json"), "utf8")).toBe(before);
    expect((await getActiveConnection()).name).toBe("Local gateway");
    await saveConnection(draft({ id: saved.id, name: "Recovered" }));
    expect((await getActiveConnection()).name).toBe("Recovered");
    expect(await fs.readdir(directory)).toEqual(
      expect.arrayContaining(["connections.json", "master.key"])
    );
    expect(
      (await fs.readdir(directory)).some(
        name => name.endsWith(".tmp") || name === "store.lock"
      )
    ).toBe(false);
  });

  it("waits for another process's write lock before reading and mutating the state", async () => {
    await fs.writeFile(file("store.lock"), "another writer", { mode: 0o600 });
    const writing = saveConnection(draft());
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(await fs.readdir(directory)).not.toContain("connections.json");
    await fs.unlink(file("store.lock"));
    await expect(writing).resolves.toMatchObject({ name: "Local gateway" });
  });

  it("keeps updates made by independent store instances and reloads the saved active connection", async () => {
    vi.resetModules();
    const secondStore = await import("./connection-store");
    const [first, second] = await Promise.all([
      saveConnection(draft({ name: "First instance" })),
      secondStore.saveConnection(draft({ name: "Second instance" })),
    ]);
    await secondStore.activateConnection(second.id);
    vi.resetModules();
    const restartedStore = await import("./connection-store");
    const state = await restartedStore.listConnections();
    expect(new Set(state.connections.map(connection => connection.id))).toEqual(
      new Set([first.id, second.id])
    );
    expect((await restartedStore.getActiveConnection()).id).toBe(second.id);
  });

  it("reports a busy store without deleting another writer's lock", async () => {
    await fs.writeFile(file("store.lock"), "other process", { mode: 0o600 });
    await expect(saveConnection(draft())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await fs.readFile(file("store.lock"), "utf8")).toBe("other process");
    expect(await fs.readdir(directory)).toEqual(["store.lock"]);
  }, 5000);

  it.skipIf(process.platform === "win32")(
    "refuses symlinked data directories and keys",
    async () => {
      const actual = file("actual");
      const linked = file("linked");
      await fs.mkdir(actual);
      await fs.symlink(actual, linked, "dir");
      vi.stubEnv("STUDYOS_DATA_DIR", linked);
      await expect(saveConnection(draft())).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
      expect(await fs.readdir(actual)).toEqual([]);
      vi.stubEnv("STUDYOS_DATA_DIR", directory);
      await saveConnection(draft());
      const other = file("other.key");
      await fs.rename(file("master.key"), other);
      await fs.symlink(other, file("master.key"));
      await expect(listConnections()).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
    }
  );

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked store without replacing the target",
    async () => {
      await saveConnection(draft());
      const backup = file("saved-connections.json");
      await fs.rename(file("connections.json"), backup);
      const original = await fs.readFile(backup, "utf8");
      await fs.symlink(backup, file("connections.json"));
      await expect(listConnections()).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
      await expect(
        saveConnection(draft({ name: "Should not save" }))
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(await fs.readFile(backup, "utf8")).toBe(original);
    }
  );
});
