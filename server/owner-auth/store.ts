import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { storageMode } from "../ai/blob-store";

const BLOB_PATH = "studyos/owner-auth-v1.json";
const STATE_FILE = "owner-auth.json";
const KEY_FILE = "owner-auth.key";
const LOCK_FILE = "owner-auth.lock";
const MAX_BYTES = 512 * 1024;
const CONTEXT = Buffer.from("studyos:owner-auth:v1");
const queues = new Map<string, Promise<void>>();
const envelopeSchema = z
  .object({
    version: z.literal(1),
    iv: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
  })
  .strict();

function unavailable(): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      "Owner authentication storage is unavailable. Check the private store and its encryption key. Saved credentials have not been reset.",
  });
}

function conflict(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: "Owner authentication was updated by another request. Try again.",
  });
}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function base64(value: string, length?: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    (length !== undefined && bytes.length !== length)
  )
    unavailable();
  return bytes;
}

function ownerKey(master: Buffer): Buffer {
  return Buffer.from(
    hkdfSync("sha256", master, CONTEXT, "owner-auth-encryption", 32)
  );
}

function cloudKey(): Buffer {
  // storageMode validates the same unchanged master key and Blob credentials
  // used by AI storage. HKDF and GCM AAD isolate this record cryptographically.
  return ownerKey(base64(process.env.STUDYOS_AI_MASTER_KEY ?? "", 32));
}

function validate<State>(schema: z.ZodType<State>, value: unknown): State {
  const parsed = schema.safeParse(value);
  if (!parsed.success) unavailable();
  return parsed.data;
}

function encode<State>(schema: z.ZodType<State>, state: State, key: Buffer) {
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(CONTEXT);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(validate(schema, state)), "utf8"),
      cipher.final(),
    ]);
    const serialized = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    if (Buffer.byteLength(serialized) > MAX_BYTES) unavailable();
    return serialized;
  } catch {
    unavailable();
  }
}

function decode<State>(
  schema: z.ZodType<State>,
  serialized: string,
  key: Buffer
): State {
  try {
    if (Buffer.byteLength(serialized) > MAX_BYTES) unavailable();
    const envelope = envelopeSchema.parse(JSON.parse(serialized));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      base64(envelope.iv, 12)
    );
    decipher.setAAD(CONTEXT);
    decipher.setAuthTag(base64(envelope.tag, 16));
    const plaintext = Buffer.concat([
      decipher.update(base64(envelope.ciphertext)),
      decipher.final(),
    ]);
    return validate(schema, JSON.parse(plaintext.toString("utf8")));
  } catch {
    unavailable();
  }
}

async function blobSnapshot<State>(
  schema: z.ZodType<State>,
  empty: () => State,
  key: Buffer,
  signal: AbortSignal
) {
  try {
    const response = await get(BLOB_PATH, {
      access: "private",
      useCache: false,
      abortSignal: signal,
    });
    if (!response)
      return {
        state: validate(schema, empty()),
        etag: undefined,
        serialized: undefined,
      };
    if (
      response.statusCode !== 200 ||
      response.blob.size > MAX_BYTES ||
      !response.blob.etag
    )
      unavailable();
    const reader = response.stream.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          unavailable();
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      reader.releaseLock();
    }
    const serialized = Buffer.concat(chunks).toString("utf8");
    return {
      state: decode(schema, serialized, key),
      etag: response.blob.etag,
      serialized,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    unavailable();
  }
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
      unavailable();
    if ((info.mode & 0o777) !== 0o700) await fs.chmod(directory, 0o700);
    return true;
  } catch (error) {
    if (!create && errorCode(error) === "ENOENT") return false;
    if (error instanceof TRPCError) throw error;
    unavailable();
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
    unavailable();
  if ((info.mode & 0o777) !== 0o600) await fs.chmod(filename, 0o600);
  return info;
}

async function localKey(directory: string, create: boolean): Promise<Buffer> {
  const filename = path.join(directory, KEY_FILE);
  try {
    await privateFile(filename);
    const master = await fs.readFile(filename);
    if (master.length !== 32) unavailable();
    return ownerKey(master);
  } catch (error) {
    if (errorCode(error) !== "ENOENT" || !create) unavailable();
  }
  // This runs only while holding the owner lock. Never replace a missing key
  // for an existing encrypted record, even if its contents cannot be read.
  try {
    await fs.lstat(path.join(directory, STATE_FILE));
    unavailable();
  } catch (error) {
    if (errorCode(error) !== "ENOENT") unavailable();
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const master = randomBytes(32);
  try {
    handle = await fs.open(filename, "wx", 0o600);
    await handle.writeFile(master);
    await handle.sync();
    return ownerKey(master);
  } catch {
    if (handle) await fs.unlink(filename).catch(() => undefined);
    return unavailable();
  } finally {
    await handle?.close();
  }
}

async function localRead<State>(
  directory: string,
  schema: z.ZodType<State>,
  empty: () => State
): Promise<State> {
  try {
    if (!(await privateDirectory(directory, false)))
      return validate(schema, empty());
    const filename = path.join(directory, STATE_FILE);
    let info;
    try {
      info = await privateFile(filename);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return validate(schema, empty());
      throw error;
    }
    if (info.size > MAX_BYTES) unavailable();
    const serialized = await fs.readFile(filename, "utf8");
    return decode(schema, serialized, await localKey(directory, false));
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    unavailable();
  }
}

async function writeLock<Result>(
  directory: string,
  operation: () => Promise<Result>
): Promise<Result> {
  await privateDirectory(directory, true);
  const filename = path.join(directory, LOCK_FILE);
  const deadline = Date.now() + 3_000;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  while (true) {
    try {
      handle = await fs.open(filename, "wx", 0o600);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") unavailable();
      try {
        await privateFile(filename);
      } catch (lockError) {
        if (errorCode(lockError) === "ENOENT") continue;
        unavailable();
      }
      if (Date.now() >= deadline) conflict();
      await new Promise<void>(resolve => setTimeout(resolve, 40));
    }
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
    );
    return await operation();
  } finally {
    try {
      await handle.close();
    } finally {
      await fs.unlink(filename);
    }
  }
}

function queued<Result>(
  operation: (directory: string) => Promise<Result>
): Promise<Result> {
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

export async function readOwnerState<State>(
  schema: z.ZodType<State>,
  empty: () => State
): Promise<State> {
  if (storageMode() === "vercel-blob")
    return (
      await blobSnapshot(schema, empty, cloudKey(), AbortSignal.timeout(30_000))
    ).state;
  return queued(directory => localRead(directory, schema, empty));
}

/** The synchronous callback may run again after a conflict; keep it free of side effects. */
export async function mutateOwnerState<State, Result>(
  schema: z.ZodType<State>,
  empty: () => State,
  operation: (state: State) => { state: State; result: Result }
): Promise<Result> {
  if (storageMode() === "vercel-blob") {
    const signal = AbortSignal.timeout(30_000);
    const key = cloudKey();
    let current = await blobSnapshot(schema, empty, key, signal);
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = operation(current.state);
      const serialized = encode(schema, next.state, key);
      try {
        await put(BLOB_PATH, serialized, {
          access: "private",
          addRandomSuffix: false,
          contentType: "application/json",
          ...(current.etag
            ? { allowOverwrite: true, ifMatch: current.etag }
            : { allowOverwrite: false }),
          abortSignal: signal,
        });
        return next.result;
      } catch (error) {
        if (!current.etag || error instanceof BlobPreconditionFailedError) {
          const latest = await blobSnapshot(schema, empty, key, signal);
          if (latest.serialized === serialized) return next.result;
          if (latest.etag) {
            current = latest;
            continue;
          }
        }
        unavailable();
      }
    }
    conflict();
  }
  return queued(directory =>
    writeLock(directory, async () => {
      const next = operation(await localRead(directory, schema, empty));
      const serialized = encode(
        schema,
        next.state,
        await localKey(directory, true)
      );
      const temporary = path.join(directory, `.owner-auth-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, path.join(directory, STATE_FILE));
        return next.result;
      } finally {
        await fs.unlink(temporary).catch(() => undefined);
      }
    })
  ).catch(error => {
    if (error instanceof TRPCError) throw error;
    unavailable();
  });
}
