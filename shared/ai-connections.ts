import { z } from "zod";

export const aiProtocolSchema = z.enum([
  "openai-chat",
  "openai-responses",
  "anthropic",
  "google",
]);
export type AiProtocol = z.infer<typeof aiProtocolSchema>;
export const AI_PROTOCOL_LABELS: Record<AiProtocol, string> = {
  "openai-chat": "OpenAI-compatible Chat Completions",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
  google: "Google Generative Language",
};

const forbiddenHeaders = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "cookie",
  "set-cookie",
  "origin",
  "referer",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
  "authorization",
]);
const headerName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "Use a valid HTTP header name.");
const secret = z
  .string()
  .trim()
  .max(8192)
  .refine(
    value => !/[\r\n\0]/.test(value),
    "Keys must not contain line breaks."
  );
const baseUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      const parsed = new URL(value);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Use an HTTP(S) URL without embedded credentials or fragments.",
        });
      }
      if (
        Array.from(parsed.searchParams.keys()).some(key =>
          /^(?:key|(?:x[-_])?api[_-]?key|token|access_token|secret|client_secret|password|auth|authorization|credential|signature|sig)$/i.test(
            key
          )
        )
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Put credentials in the API key or custom headers, not the URL.",
        });
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Enter a complete API URL, including http:// or https://.",
      });
    }
  });

export const aiConnectionInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(80),
    protocol: aiProtocolSchema.default("openai-chat"),
    baseUrl,
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(value => !/[\r\n\0]/.test(value), "Use a single model ID."),
    authType: z.enum(["bearer", "header", "none"]).default("bearer"),
    authHeader: headerName.default("x-api-key"),
    apiKey: secret.optional(),
    clearApiKey: z.boolean().optional(),
    extraHeaders: z
      .record(
        headerName,
        z
          .string()
          .max(4096)
          .refine(
            value => !/[\r\n\0]/.test(value),
            "Header values must not contain line breaks."
          )
      )
      .refine(
        value => Object.keys(value).length <= 20,
        "Use at most 20 custom headers."
      )
      .optional(),
    clearHeaders: z.boolean().optional(),
    stream: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).max(180000).default(60000),
    maxOutputTokens: z.number().int().min(64).max(32768).default(4096),
    tokenParameter: z
      .enum(["auto", "max_tokens", "max_completion_tokens", "none"])
      .default("auto"),
    jsonMode: z.enum(["prompt", "native"]).default("prompt"),
  })
  .superRefine((value, ctx) => {
    const names = Object.keys(value.extraHeaders ?? {}).map(key =>
      key.toLowerCase()
    );
    if (
      names.some(name => forbiddenHeaders.has(name)) ||
      new Set(names).size !== names.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["extraHeaders"],
        message:
          "Custom headers must be unique and must not override HTTP routing, cookies or Authorization.",
      });
    }
    if (
      value.authType === "header" &&
      (forbiddenHeaders.has(value.authHeader.toLowerCase()) ||
        names.includes(value.authHeader.toLowerCase()))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["authHeader"],
        message:
          "Choose a dedicated authentication header that is not also a custom header.",
      });
    }
    if (value.clearApiKey && value.apiKey) {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "Choose either a replacement key or Remove saved key.",
      });
    }
    if (
      value.clearHeaders &&
      value.extraHeaders &&
      Object.keys(value.extraHeaders).length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["extraHeaders"],
        message: "Choose either replacement headers or Remove saved headers.",
      });
    }
  });

export type AiConnectionInput = z.infer<typeof aiConnectionInputSchema>;
export type AiConnectionDraft = z.input<typeof aiConnectionInputSchema>;
export type ResolvedAiConnection = Omit<
  AiConnectionInput,
  "id" | "clearApiKey" | "clearHeaders" | "extraHeaders"
> & {
  id: string;
  extraHeaders: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};
export type PublicAiConnection = Omit<
  ResolvedAiConnection,
  "apiKey" | "extraHeaders"
> & {
  hasApiKey: boolean;
  keySuffix: string | null;
  headerNames: string[];
};
export type AiConnectionsState = {
  connections: PublicAiConnection[];
  activeId: string | null;
};
