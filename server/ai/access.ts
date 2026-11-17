import { TRPCError } from "@trpc/server";
import type { Request } from "express";
import { isIP } from "node:net";
import {
  authEnabled,
  getCachedOwnerSession,
  validateOwnerRequest,
} from "../owner-auth/service";

function isLoopback(value: string) {
  const address = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (address === "::1") return true;
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return isIP(ipv4) === 4 && ipv4.split(".")[0] === "127";
}

function isPublicHostname(value: string) {
  return (
    value.length <= 253 &&
    isIP(value) === 0 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      value
    ) &&
    !value.toLowerCase().endsWith(".localhost")
  );
}

function protectedVercelHosts(): Set<string> | null {
  const configured = [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    ...(process.env.STUDYOS_PUBLIC_HOSTS?.split(",") ?? []),
  ];
  const hosts = new Set<string>();
  for (const configuredHost of configured) {
    if (configuredHost === undefined) continue;
    const host = configuredHost.trim().toLowerCase();
    if (!isPublicHostname(host)) return null;
    hosts.add(host);
  }
  return hosts.size ? hosts : null;
}

/** Connection credentials belong to this server's owner, not arbitrary visitors. */
export function requireAiAccess(
  req: Request,
  user?: { role: string } | null
): void {
  const deny = () => {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "AI connections are restricted to this app's authorized owner.",
    });
  };
  if (authEnabled()) {
    validateOwnerRequest(
      req,
      !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET")
    );
    if (!getCachedOwnerSession(req)) return deny();
    return;
  }
  const rawHost = req.headers?.host;
  if (typeof rawHost !== "string" || !rawHost || /[\s,/@?#\\]/.test(rawHost))
    return deny();
  let host: URL;
  try {
    host = new URL(`http://${rawHost}`);
  } catch {
    return deny();
  }
  const protectedVercel =
    process.env.VERCEL === "1" &&
    process.env.STUDYOS_CLOUD_ACCESS === "vercel-protected";
  const origin = req.headers?.origin;
  if (origin !== undefined) {
    if (typeof origin !== "string") return deny();
    try {
      const parsed = new URL(origin);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.origin !== origin ||
        (protectedVercel && parsed.protocol !== "https:") ||
        parsed.host.toLowerCase() !==
          new URL(`${parsed.protocol}//${rawHost}`).host.toLowerCase()
      )
        return deny();
    } catch {
      return deny();
    }
  }
  const site = req.headers?.["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return deny();
  if (protectedVercel) {
    // Vercel Authentication must protect ALL deployment and production URLs.
    // The platform is the authentication perimeter; visitor headers grant no
    // identity. Every authorized deployment viewer shares the owner's store.
    const hosts = protectedVercelHosts();
    const hostname = /^([a-z0-9.-]+)(?::443)?$/i
      .exec(rawHost)?.[1]
      .toLowerCase();
    if (!hosts || !hostname || !hosts.has(hostname)) return deny();
    return;
  }
  if (user?.role === "admin") return;
  if (!isLoopback(req.socket?.remoteAddress ?? "")) return deny();
  if (host.hostname.toLowerCase() !== "localhost" && !isLoopback(host.hostname))
    return deny();
}
