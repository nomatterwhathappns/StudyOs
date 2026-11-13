import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  aiConnectionInputSchema,
  type AiConnectionDraft,
  type AiConnectionInput,
  type AiConnectionsState,
  type PublicAiConnection,
  type ResolvedAiConnection,
} from "@shared/ai-connections";

const MAX_CONNECTIONS = 20;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const STORE_FILE = "connections.json";
const KEY_FILE = "master.key";
const LOCK_FILE = "store.lock";
const CONTEXT = Buffer.from("studyos:ai-connections:v1");
const queues = new Map<string, Promise<void>>();
type StoredState = {
  version: 1;
  connections: ResolvedAiConnection[];
  activeId: string | null;
};

const envelopeSchema = z
  .object({
    version: z.literal(1),
    iv: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    connections: z.array(z.unknown()).max(MAX_CONNECTIONS),
    activeId: z.string().uuid().nullable(),
  })
  .strict();
const metadataSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const storedKeys = [
  "id",
  "name",
  "protocol",
  "baseUrl",
  "model",
  "authType",
  "authHeader",
  "extraHeaders",
  "stream",
  "timeoutMs",
  "maxOutputTokens",
  "tokenParameter",
  "jsonMode",
  "createdAt",
  "updatedAt",
];
const allowedStoredKeys = new Set([...storedKeys, "apiKey"]);

function code(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function corruptStore(): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      "Saved AI connections or their encryption key are damaged or unavailable. Restore the original data and key; the saved connections have not been reset.",
  });
}

function storageError(operation: "read" | "write"): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `AI connection storage could not be ${operation === "read" ? "read" : "written"}. Check the server data directory and its permissions, then try again.`,
  });
}

function queued<T>(operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = path.resolve(
    process.env.STUDYOS_DATA_DIR || path.join(process.cwd(), ".studyos")
  );
  const result = (queues.get(directory) ?? Promise.resolve()).then(() =>
    operation(directory)
  );
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  queues.set(directory, tail);
  void tail.then(() => {
    if (queues.get(directory) === tail) queues.delete(directory);
  });
  return result;
}

async function privateDirectory(directory: string, create: boolean) {
  try {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      storageError(create ? "write" : "read");
    if ((info.mode & 0o777) !== 0o700) await fs.chmod(directory, 0o700);
    return true;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (!create && code(error) === "ENOENT") return false;
    storageError(create ? "write" : "read");
  }
}

async function privateFile(filename: string) {
  const info = await fs.lstat(filename);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (process.getuid && info.uid !== process.getuid())
  )
    storageError("read");
  if ((info.mode & 0o777) !== 0o600) await fs.chmod(filename, 0o600);
  return info;
}

async function withWriteLock<T>(
  directory: string,
  operation: () => Promise<T>
): Promise<T> {
  await privateDirectory(directory, true);
  const filename = path.join(directory, LOCK_FILE);
  const deadline = Date.now() + 3_000;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  while (true) {
    try {
      handle = await fs.open(filename, "wx", 0o600);
      break;
    } catch (error) {
      if (code(error) !== "EEXIST") storageError("write");
      try {
        await privateFile(filename);
      } catch (lockError) {
        if (code(lockError) === "ENOENT") continue;
        if (lockError instanceof TRPCError) throw lockError;
        storageError("write");
      }
      if (Date.now() >= deadline)
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "AI connection storage is busy. Wait for the other server operation to finish. If a server stopped unexpectedly, verify it is no longer running before removing store.lock from the data directory.",
        });
      await new Promise<void>(resolve => setTimeout(resolve, 40));
    }
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
    );
    return await operation();
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    return storageError("write");
  } finally {
    let releaseError: unknown;
    try {
      await handle.close();
    } catch (error) {
      releaseError = error;
    }
    try {
      await fs.unlink(filename);
    } catch (error) {
      if (code(error) !== "ENOENT") releaseError = error;
    }
    if (releaseError) storageError("write");
  }
}

async function readKey(
  directory: string,
  allowMissing = false
): Promise<Buffer | undefined> {
  let key: Buffer;
  try {
    const filename = path.join(directory, KEY_FILE);
    await privateFile(filename);
    key = await fs.readFile(filename);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (code(error) === "ENOENT") {
      if (allowMissing) return undefined;
      corruptStore();
    }
    storageError("read");
  }
  if (key.length !== 32) corruptStore();
  return key;
}

function decodeBase64(value: string, length?: number) {
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    (length !== undefined && bytes.length !== length)
  )
    corruptStore();
  return bytes;
}

function validateState(value: unknown): StoredState {
  const state = stateSchema.safeParse(value);
  if (!state.success) corruptStore();
  const connections = state.data.connections.map(
    (candidate): ResolvedAiConnection => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      )
        corruptStore();
      const record = candidate as Record<string, unknown>;
      if (
        storedKeys.some(key => !Object.hasOwn(record, key)) ||
        Object.keys(record).some(key => !allowedStoredKeys.has(key))
      )
        corruptStore();
      const metadata = metadataSchema.safeParse(record);
      const input = aiConnectionInputSchema.safeParse(record);
      if (!metadata.success || !input.success) corruptStore();
      const {
        clearApiKey: _clearApiKey,
        clearHeaders: _clearHeaders,
        ...connection
      } = input.data;
      return {
        ...connection,
        ...metadata.data,
        extraHeaders: input.data.extraHeaders ?? {},
      };
    }
  );
  const ids = new Set(connections.map(connection => connection.id));
  if (
    ids.size !== connections.length ||
    (state.data.activeId !== null && !ids.has(state.data.activeId))
  )
    corruptStore();
  return { version: 1, connections, activeId: state.data.activeId };
}

async function readState(directory: string): Promise<StoredState> {
  if (!(await privateDirectory(directory, false)))
    return { version: 1, connections: [], activeId: null };
  let serialized: string;
  try {
    const filename = path.join(directory, STORE_FILE);
    const info = await privateFile(filename);
    if (!info.isFile() || info.size > MAX_STORE_BYTES) corruptStore();
    serialized = await fs.readFile(filename, "utf8");
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (code(error) === "ENOENT") {
      await readKey(directory, true);
      return { version: 1, connections: [], activeId: null };
    }
    storageError("read");
  }
  const key = await readKey(directory);
  try {
    const envelope = envelopeSchema.parse(JSON.parse(serialized));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key!,
      decodeBase64(envelope.iv, 12)
    );
    decipher.setAAD(CONTEXT);
    decipher.setAuthTag(decodeBase64(envelope.tag, 16));
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64(envelope.ciphertext)),
      decipher.final(),
    ]);
    return validateState(JSON.parse(plaintext.toString("utf8")));
  } catch {
    corruptStore();
  }
}

async function writeState(directory: string, state: StoredState) {
  const temporary = path.join(directory, `.connections-${randomUUID()}.tmp`);
  try {
    let key = await readKey(directory, true);
    if (!key) {
      try {
        await fs.lstat(path.join(directory, STORE_FILE));
        corruptStore();
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        if (code(error) !== "ENOENT") throw error;
      }
      try {
        const keyHandle = await fs.open(
          path.join(directory, KEY_FILE),
          "wx",
          0o600
        );
        try {
          await keyHandle.writeFile(randomBytes(32));
          await keyHandle.sync();
        } catch (error) {
          // This key is newly created and no encrypted store exists yet. A
          // partial key must not poison a retry of the first save.
          await fs
            .unlink(path.join(directory, KEY_FILE))
            .catch(() => undefined);
          throw error;
        } finally {
          await keyHandle.close();
        }
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
      key = await readKey(directory);
    }
    await fs.chmod(path.join(directory, KEY_FILE), 0o600);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key!, iv);
    cipher.setAAD(CONTEXT);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state), "utf8"),
      cipher.final(),
    ]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(envelope, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path.join(directory, STORE_FILE));
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    storageError("write");
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function publicConnection(
  connection: ResolvedAiConnection
): PublicAiConnection {
  const { apiKey, extraHeaders, ...safe } = connection;
  return {
    ...safe,
    hasApiKey: Boolean(apiKey),
    keySuffix: apiKey && apiKey.length > 4 ? apiKey.slice(-4) : null,
    headerNames: Object.keys(extraHeaders),
  };
}

function parseInput(draft: AiConnectionDraft): AiConnectionInput {
  const result = aiConnectionInputSchema.safeParse(draft);
  if (!result.success)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Check the AI connection settings and try again.",
    });
  return result.data;
}

function requireConnection(state: StoredState, id: string) {
  const connection = state.connections.find(item => item.id === id);
  if (!connection)
    throw new TRPCError({
      code: "NOT_FOUND",
      message:
        "This AI connection no longer exists. Refresh the connection list and try again.",
    });
  return connection;
}

function mergeConnection(
  input: AiConnectionInput,
  existing?: ResolvedAiConnection
): ResolvedAiConnection {
  const { clearApiKey, clearHeaders, apiKey, extraHeaders, id, ...settings } =
    input;
  const timestamp = new Date().toISOString();
  const merged = {
    ...settings,
    id: existing?.id ?? id ?? randomUUID(),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    apiKey: clearApiKey
      ? undefined
      : apiKey === undefined || apiKey === ""
        ? existing?.apiKey
        : apiKey,
    extraHeaders: clearHeaders
      ? {}
      : (extraHeaders ?? existing?.extraHeaders ?? {}),
  };
  // Revalidate with preserved headers: changing the authentication header can
  // otherwise collide with an existing custom header that the browser cannot see.
  const validated = aiConnectionInputSchema.safeParse(merged);
  if (!validated.success)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The authentication settings conflict with the saved custom headers. Replace or remove those headers and try again.",
    });
  return merged;
}

export function listConnections(): Promise<AiConnectionsState> {
  return queued(async directory => {
    const state = await readState(directory);
    return {
      connections: state.connections.map(publicConnection),
      activeId: state.activeId,
    };
  });
}

export function saveConnection(
  draft: AiConnectionDraft
): Promise<PublicAiConnection> {
  const input = parseInput(draft);
  return queued(directory =>
    withWriteLock(directory, async () => {
      const state = await readState(directory);
      const existing = input.id
        ? requireConnection(state, input.id)
        : undefined;
      if (!existing && state.connections.length >= MAX_CONNECTIONS)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "You can save at most 20 AI connections. Remove one before adding another.",
        });
      const connection = mergeConnection(input, existing);
      const next = existing
        ? state.connections.map(item =>
            item.id === existing.id ? connection : item
          )
        : [...state.connections, connection];
      await writeState(directory, { ...state, connections: next });
      return publicConnection(connection);
    })
  );
}

export function deleteConnection(
  id: string
): Promise<{ activeId: string | null }> {
  return queued(directory =>
    withWriteLock(directory, async () => {
      const state = await readState(directory);
      requireConnection(state, id);
      const activeId = state.activeId === id ? null : state.activeId;
      await writeState(directory, {
        ...state,
        activeId,
        connections: state.connections.filter(item => item.id !== id),
      });
      return { activeId };
    })
  );
}

export function activateConnection(id: string): Promise<{ activeId: string }> {
  return queued(directory =>
    withWriteLock(directory, async () => {
      const state = await readState(directory);
      requireConnection(state, id);
      await writeState(directory, { ...state, activeId: id });
      return { activeId: id };
    })
  );
}

export function getConnection(id: string): Promise<ResolvedAiConnection> {
  return queued(async directory =>
    requireConnection(await readState(directory), id)
  );
}

export function getActiveConnection(): Promise<ResolvedAiConnection> {
  return queued(async directory => {
    const state = await readState(directory);
    if (!state.activeId)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Choose an AI connection in AI settings before sending a request.",
      });
    return requireConnection(state, state.activeId);
  });
}

export function resolveDraftConnection(input: {
  id?: string;
  draft?: AiConnectionDraft;
}): Promise<ResolvedAiConnection> {
  return queued(async directory => {
    if (input.id && input.draft?.id && input.id !== input.draft.id)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "The connection IDs do not match.",
      });
    const id = input.id ?? input.draft?.id;
    const existing = id
      ? requireConnection(await readState(directory), id)
      : undefined;
    if (input.draft)
      return mergeConnection(
        parseInput({ ...input.draft, ...(id ? { id } : {}) }),
        existing
      );
    if (existing) return existing;
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Choose a saved connection or provide connection settings first.",
    });
  });
}
