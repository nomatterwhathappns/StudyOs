import type { Express, Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createContext } from "./_core/context";
import { requireAiAccess } from "./ai/access";
import { getActiveConnection } from "./ai/connection-store";
import { streamConnection } from "./ai/transport";
import {
  formatStudyResponse,
  responseMode,
  responseTokenBudget,
  systemPrompt,
} from "./routers";

const streamInput = z.object({
  sessionName: z.string().min(1).max(120),
  materials: z.string().max(10_000),
  translate: z.boolean(),
  responseStyle: z.enum(["Fast", "Balanced", "Deep", "Concise", "Detailed"]),
  model: z.literal("active"),
  aiName: z.string().max(80).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(6_000),
      })
    )
    .min(1)
    .max(30),
  continueAnswer: z.boolean().optional(),
});

type StreamMessage = { role: "system" | "user" | "assistant"; content: string };

export function normalizeStreamPayload(body: unknown) {
  const candidate =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawHistory = Array.isArray(candidate.history) ? candidate.history : [];
  const history = rawHistory
    .filter((item): item is { role: unknown; content: unknown } =>
      Boolean(item && typeof item === "object")
    )
    .map(item => ({
      role: item.role,
      content:
        typeof item.content === "string"
          ? item.content.trim().slice(0, 6_000)
          : "",
    }))
    .filter(item => item.content.length > 0)
    .slice(-30);
  return {
    ...candidate,
    materials:
      typeof candidate.materials === "string"
        ? candidate.materials.trim().slice(0, 10_000)
        : candidate.materials,
    history,
  };
}

export function streamErrorMessage(reason: unknown) {
  if (reason instanceof TRPCError) return reason.message;
  if (reason instanceof z.ZodError)
    return "Konteks chat terlalu besar atau belum lengkap. StudyOS sudah merapikan data chat—silakan kirim ulang pesanmu.";
  return "Respons AI belum bisa diproses. Coba kirim ulang atau periksa AI Settings.";
}

function event(res: Response, name: string, payload: unknown) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  const flush = (res as Response & { flush?: () => void }).flush;
  flush?.call(res);
}

export function registerStudyChatStream(app: Express) {
  app.post("/api/study/chat-stream", async (req: Request, res: Response) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.once("aborted", cancel);
    res.once("close", cancel);
    if (req.aborted || res.destroyed) controller.abort();

    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();

    try {
      const input = streamInput.parse(normalizeStreamPayload(req.body));
      const { user } = await createContext({ req, res });
      requireAiAccess(req, user);
      // Settings changes do not switch an already running request's connection.
      const connection = await getActiveConnection();
      if (controller.signal.aborted) return;
      const messages: StreamMessage[] = [
        {
          role: "system",
          content: systemPrompt(
            input.sessionName,
            input.materials,
            input.translate,
            input.responseStyle,
            input.aiName
          ),
        },
        ...input.history,
        ...(input.continueAnswer
          ? [
              {
                role: "user" as const,
                content:
                  "Continue the immediately preceding answer exactly where it stopped. Do not repeat its opening or recap it; finish the remaining explanation naturally.",
              },
            ]
          : []),
      ];
      const provider = `${connection.name} · ${connection.model}`;
      event(res, "meta", {
        provider,
        model: connection.model,
        connectionId: connection.id,
      });
      const result = await streamConnection(
        connection,
        messages,
        {
          maxTokens: responseTokenBudget(
            input.continueAnswer ? "continue" : "chat",
            input.responseStyle
          ),
          timeoutMs: connection.timeoutMs,
          signal: controller.signal,
        },
        token => {
          if (
            !controller.signal.aborted &&
            !res.destroyed &&
            !res.writableEnded
          )
            event(res, "token", { token });
        }
      );
      if (controller.signal.aborted || res.destroyed) return;
      event(res, "done", {
        ...formatStudyResponse(result.text),
        truncated: result.truncated,
        provider: result.provider,
        mode: responseMode(input.responseStyle),
      });
    } catch (reason) {
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded)
        event(res, "error", { message: streamErrorMessage(reason) });
    } finally {
      req.off("aborted", cancel);
      res.off("close", cancel);
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  });
}
