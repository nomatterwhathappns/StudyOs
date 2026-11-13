import { TRPCError } from "@trpc/server";
import type { Request } from "express";
import { isIP } from "node:net";

function isLoopback(value: string) {
  const address = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (address === "::1") return true;
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return isIP(ipv4) === 4 && ipv4.split(".")[0] === "127";
}

/** Connection credentials belong to this server's owner, not arbitrary visitors. */
export function requireAiAccess(
  req: Request,
  user?: { role: string } | null
): void {
  const deny = () => {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "AI connections are available from localhost on this server, or to its signed-in administrator.",
    });
  };
  const rawHost = req.headers?.host;
  if (typeof rawHost !== "string" || !rawHost || /[\s,/@?#\\]/.test(rawHost))
    return deny();
  let host: URL;
  try {
    host = new URL(`http://${rawHost}`);
  } catch {
    return deny();
  }
  const origin = req.headers?.origin;
  if (origin !== undefined) {
    if (typeof origin !== "string") return deny();
    try {
      const parsed = new URL(origin);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.origin !== origin ||
        parsed.host.toLowerCase() !== host.host.toLowerCase()
      )
        return deny();
    } catch {
      return deny();
    }
  }
  const site = req.headers?.["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none")
    return deny();
  if (user?.role === "admin") return;
  if (!isLoopback(req.socket?.remoteAddress ?? "")) return deny();
  if (host.hostname.toLowerCase() !== "localhost" && !isLoopback(host.hostname))
    return deny();
}
