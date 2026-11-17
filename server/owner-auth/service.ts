import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { parse as parseCookies } from "cookie";
import type { Request, Response } from "express";
import { sealData, unsealData } from "iron-session";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mutateOwnerState, readOwnerState } from "./store";

const SESSION_SECONDS = 24 * 60 * 60;
const MAX_SESSIONS = 10;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_RATE_BUCKETS = 128;
const dummySalt = randomBytes(32);
const verifiedSessions = new WeakMap<
  Request,
  { cookie: string | undefined; session: OwnerSession | null }
>();

const usernameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);
const passwordSchema = (minimum: number) =>
  z
    .string()
    .max(512)
    .refine(value => {
      const length = Array.from(value).length;
      return length >= minimum && length <= 128;
    });
const base64 = (bytes: number) =>
  z.string().refine(value => {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === bytes && decoded.toString("base64") === value;
  });
const ownerSchema = z
  .object({
    username: usernameSchema,
    canonicalUsername: usernameSchema,
    salt: base64(32),
    passwordHash: base64(64),
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine(owner => owner.canonicalUsername === owner.username.toLowerCase());
const sessionSchema = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    owner: ownerSchema.nullable(),
    sessions: z.array(sessionSchema).max(MAX_SESSIONS),
    attempts: z
      .array(
        z
          .object({
            key: z.string().regex(/^(?:global|client:[a-f0-9]{64})$/),
            startedAt: z.number().int().nonnegative(),
            count: z.number().int().nonnegative().max(30),
          })
          .strict()
      )
      .max(MAX_RATE_BUCKETS),
  })
  .strict();

type OwnerState = z.infer<typeof stateSchema>;
export type OwnerSession = { id: string; username: string };
export type OwnerStatus = {
  enabled: boolean;
  authenticated: boolean;
  setupRequired: boolean;
  username?: string;
};
export type OwnerLoginResult = {
  status: OwnerStatus;
  sealedCookie: string;
};

const emptyState = (): OwnerState => ({
  version: 1,
  owner: null,
  sessions: [],
  attempts: [],
});

function unavailable(): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      "Owner authentication is unavailable. Check the server configuration.",
  });
}

export function authEnabled(): boolean {
  if (process.env.STUDYOS_OWNER_AUTH === "enabled") return true;
  if (
    process.env.VERCEL === "1" ||
    (process.env.STUDYOS_OWNER_AUTH &&
      process.env.STUDYOS_OWNER_AUTH !== "disabled")
  )
    unavailable();
  return false;
}

function sessionSecret() {
  const value = process.env.STUDYOS_OWNER_SESSION_SECRET;
  if (!value || value.length < 32 || Buffer.byteLength(value) < 32)
    unavailable();
  return value;
}

function loopback(value: string) {
  const address = value.toLowerCase();
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return (
    address === "::1" || (isIP(ipv4) === 4 && ipv4.split(".")[0] === "127")
  );
}

function publicHostname(value: string) {
  return (
    value.length <= 253 &&
    isIP(value) === 0 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      value
    ) &&
    !value.toLowerCase().endsWith(".localhost")
  );
}

function allowedHosts() {
  const hosts = new Set<string>();
  const values = [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    ...(process.env.STUDYOS_PUBLIC_HOSTS?.split(",") ?? []),
  ];
  for (const value of values) {
    if (value === undefined) continue;
    const host = value.trim().toLowerCase();
    if (!publicHostname(host)) unavailable();
    hosts.add(host);
  }
  return hosts;
}

function denied(): never {
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "This request is not allowed.",
  });
}

function localRequest(req: Request) {
  if (process.env.VERCEL === "1" || !loopback(req.socket?.remoteAddress ?? ""))
    return false;
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(
    req.headers.host ?? ""
  );
}

/** Trusted server configuration selects hosts; forwarded identity headers do not. */
export function validateOwnerRequest(req: Request, requireOrigin = false) {
  const rawHost = req.headers.host;
  if (typeof rawHost !== "string" || !rawHost || /[\s,/@?#\\%]/.test(rawHost))
    denied();
  const isLocal = localRequest(req);
  const protocol = isLocal && req.protocol !== "https" ? "http:" : "https:";
  let requestUrl: URL;
  try {
    requestUrl = new URL(`${protocol}//${rawHost}`);
  } catch {
    return denied();
  }
  if (!isLocal) {
    const hostname = /^([a-z0-9.-]+)(?::443)?$/i
      .exec(rawHost)?.[1]
      .toLowerCase();
    if (!hostname || !allowedHosts().has(hostname)) denied();
  }
  const origin = req.headers.origin;
  if (requireOrigin && origin === undefined) denied();
  if (origin !== undefined) {
    if (typeof origin !== "string") denied();
    try {
      const parsed = new URL(origin);
      if (parsed.origin !== origin || parsed.origin !== requestUrl.origin)
        denied();
    } catch {
      return denied();
    }
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") denied();
}

function requireEnabled(req: Request, mutation = false) {
  if (!authEnabled()) denied();
  sessionSecret();
  validateOwnerRequest(req, mutation);
}

function cookieName(req: Request) {
  return localRequest(req) && req.protocol !== "https"
    ? "studyos_owner"
    : "__Host-studyos_owner";
}

export function setOwnerCookie(
  req: Request,
  res: Response,
  sealedCookie: string
) {
  res.cookie(cookieName(req), sealedCookie, {
    httpOnly: true,
    secure: cookieName(req).startsWith("__Host-"),
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_SECONDS * 1000,
  });
}

export function clearOwnerCookie(req: Request, res: Response) {
  res.clearCookie(cookieName(req), {
    httpOnly: true,
    secure: cookieName(req).startsWith("__Host-"),
    sameSite: "strict",
    path: "/",
  });
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function getCachedOwnerSession(req: Request): OwnerSession | null {
  const cached = verifiedSessions.get(req);
  return cached && cached.cookie === req.headers.cookie ? cached.session : null;
}

export async function getOwnerSession(
  req: Request
): Promise<OwnerSession | null> {
  requireEnabled(
    req,
    !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET")
  );
  const cached = verifiedSessions.get(req);
  if (cached && cached.cookie === req.headers.cookie) return cached.session;
  const sealed = parseCookies(req.headers.cookie ?? "")[cookieName(req)];
  let id: string | undefined;
  if (sealed) {
    try {
      const payload = await unsealData<{ version?: unknown; id?: unknown }>(
        sealed,
        {
          password: sessionSecret(),
          ttl: SESSION_SECONDS,
        }
      );
      if (
        payload.version === 1 &&
        typeof payload.id === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(payload.id)
      )
        id = payload.id;
    } catch {
      // Invalid, expired, or forged cookies never grant owner access.
    }
  }
  if (!id) {
    verifiedSessions.set(req, { cookie: req.headers.cookie, session: null });
    return null;
  }
  const state = await readOwnerState(stateSchema, emptyState);
  const active = state.sessions.find(
    session => session.hash === digest(id!) && session.expiresAt > Date.now()
  );
  const owner =
    state.owner && active ? { id, username: state.owner.username } : null;
  verifiedSessions.set(req, { cookie: req.headers.cookie, session: owner });
  return owner;
}

export async function getOwnerStatus(req: Request): Promise<OwnerStatus> {
  if (!authEnabled())
    return { enabled: false, authenticated: false, setupRequired: false };
  requireEnabled(req);
  const session = await getOwnerSession(req);
  if (session)
    return {
      enabled: true,
      authenticated: true,
      setupRequired: false,
      username: session.username,
    };
  const state = await readOwnerState(stateSchema, emptyState);
  return { enabled: true, authenticated: false, setupRequired: !state.owner };
}

export class OwnerRateLimitError extends TRPCError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super({
      code: "TOO_MANY_REQUESTS",
      message: "Too many sign-in attempts. Please wait and try again.",
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function admitAttempt(req: Request) {
  const now = Date.now();
  // Vercel supplies this dedicated header at its ingress, overwriting external
  // IP forwarding values. It is used only for admission limits, never identity.
  // Local/self-hosted servers ignore forwarding headers entirely. Malformed or
  // multi-address values fall back to the actual socket; the global bucket
  // always spans all clients, including requests with no usable client address.
  const platformIp = req.headers["x-vercel-forwarded-for"];
  const clientAddress =
    process.env.VERCEL === "1" &&
    typeof platformIp === "string" &&
    isIP(platformIp)
      ? platformIp
      : (req.socket?.remoteAddress ?? "unknown");
  const client = `client:${digest(clientAddress)}`;
  return mutateOwnerState(stateSchema, emptyState, state => {
    const attempts = state.attempts
      .filter(item => item.startedAt + RATE_WINDOW_MS > now)
      .map(item => ({ ...item }));
    for (const [key, maximum] of [
      ["global", 30],
      [client, 5],
    ] as const) {
      let bucket = attempts.find(item => item.key === key);
      if (bucket && bucket.count >= maximum)
        throw new OwnerRateLimitError(
          Math.max(
            1,
            Math.ceil((bucket.startedAt + RATE_WINDOW_MS - now) / 1000)
          )
        );
      if (!bucket) {
        bucket = { key, startedAt: now, count: 0 };
        attempts.push(bucket);
      }
      bucket.count++;
    }
    const retained =
      attempts.length <= MAX_RATE_BUCKETS
        ? attempts
        : [
            attempts.find(item => item.key === "global")!,
            ...attempts
              .filter(item => item.key !== "global")
              .slice(-(MAX_RATE_BUCKETS - 1)),
          ];
    return {
      state: {
        ...state,
        attempts: retained,
        sessions: state.sessions.filter(session => session.expiresAt > now),
      },
      result: state.owner,
    };
  });
}

async function passwordHash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      }
    );
  });
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Check the sign-in fields and try again.",
    });
  return parsed.data;
}

function newSession() {
  const id = randomBytes(32).toString("base64url");
  const createdAt = Date.now();
  return {
    id,
    record: {
      hash: digest(id),
      createdAt,
      expiresAt: createdAt + SESSION_SECONDS * 1000,
    },
  };
}

async function loginResult(
  username: string,
  id: string
): Promise<OwnerLoginResult> {
  const sealedCookie = await sealData(
    { version: 1, id },
    { password: sessionSecret(), ttl: SESSION_SECONDS }
  );
  return {
    status: {
      enabled: true,
      authenticated: true,
      setupRequired: false,
      username,
    },
    sealedCookie,
  };
}

export async function setupOwner(
  req: Request,
  value: unknown
): Promise<OwnerLoginResult> {
  requireEnabled(req, true);
  const expectedKey = process.env.STUDYOS_OWNER_SETUP_KEY;
  if (
    process.env.STUDYOS_OWNER_SETUP_ENABLED !== "true" ||
    !expectedKey ||
    expectedKey.length < 32 ||
    Buffer.byteLength(expectedKey) < 32
  )
    denied();
  const body = input(
    z
      .object({
        setupKey: z.string().min(1).max(512),
        username: usernameSchema,
        password: passwordSchema(14),
      })
      .strict(),
    value
  );
  const existing = await admitAttempt(req);
  if (
    !timingSafeEqual(
      Buffer.from(digest(body.setupKey), "hex"),
      Buffer.from(digest(expectedKey), "hex")
    )
  )
    denied();
  if (existing)
    throw new TRPCError({
      code: "CONFLICT",
      message: "The owner account is already configured. Sign in instead.",
    });
  const salt = randomBytes(32);
  const hashed = await passwordHash(body.password, salt);
  const session = newSession();
  const owner = {
    username: body.username,
    canonicalUsername: body.username.toLowerCase(),
    salt: salt.toString("base64"),
    passwordHash: hashed.toString("base64"),
    createdAt: Date.now(),
  };
  await mutateOwnerState(stateSchema, emptyState, state => {
    if (state.owner)
      throw new TRPCError({
        code: "CONFLICT",
        message: "The owner account is already configured. Sign in instead.",
      });
    return {
      state: { ...state, owner, sessions: [session.record] },
      result: undefined,
    };
  });
  return loginResult(owner.username, session.id);
}

export async function loginOwner(
  req: Request,
  value: unknown
): Promise<OwnerLoginResult> {
  requireEnabled(req, true);
  const body = input(
    z
      .object({ username: usernameSchema, password: passwordSchema(1) })
      .strict(),
    value
  );
  const owner = await admitAttempt(req);
  // A wrong username still pays the same KDF work and returns the same error.
  const hash = await passwordHash(
    body.password,
    owner ? Buffer.from(owner.salt, "base64") : dummySalt
  );
  const validPassword =
    owner && timingSafeEqual(hash, Buffer.from(owner.passwordHash, "base64"));
  if (
    !owner ||
    owner.canonicalUsername !== body.username.toLowerCase() ||
    !validPassword
  )
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Username or password is incorrect.",
    });
  const session = newSession();
  await mutateOwnerState(stateSchema, emptyState, state => {
    if (
      !state.owner ||
      state.owner.passwordHash !== owner.passwordHash ||
      state.owner.canonicalUsername !== owner.canonicalUsername
    )
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Username or password is incorrect.",
      });
    return {
      state: {
        ...state,
        sessions: [
          ...state.sessions
            .filter(item => item.expiresAt > session.record.createdAt)
            .slice(-(MAX_SESSIONS - 1)),
          session.record,
        ],
      },
      result: undefined,
    };
  });
  return loginResult(owner.username, session.id);
}

export async function logoutOwner(req: Request): Promise<OwnerStatus> {
  requireEnabled(req, true);
  const session = await getOwnerSession(req);
  if (session) {
    await mutateOwnerState(stateSchema, emptyState, state => ({
      state: {
        ...state,
        sessions: state.sessions.filter(
          item => item.hash !== digest(session.id)
        ),
      },
      result: undefined,
    }));
  }
  verifiedSessions.set(req, { cookie: req.headers.cookie, session: null });
  const state = await readOwnerState(stateSchema, emptyState);
  return { enabled: true, authenticated: false, setupRequired: !state.owner };
}
