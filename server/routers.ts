import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { decodeAvatarImage } from "./avatarUpload";
import { decodeAndExtractDocument } from "./documentImport";
import { storagePut } from "./storage";
import { searchSources } from "./sourceSearch";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import type { ResolvedAiConnection } from "@shared/ai-connections";
import { requireAiAccess } from "./ai/access";
import { getActiveConnection } from "./ai/connection-store";
import { aiConnectionsRouter } from "./ai/connections-router";
import { invokeConnection } from "./ai/transport";
import { isLocalStudyMode } from "./runtimeMode";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(6000),
});

const chatTranslationItemSchema = z.object({
  id: z.string().min(1).max(160),
  content: z.string().min(1).max(6000),
});

const responseStyleSchema = z.enum(["Fast", "Balanced", "Deep", "Concise", "Detailed"]).default("Balanced");
type ResponseStyle = z.infer<typeof responseStyleSchema>;
type ResponseMode = "Fast" | "Balanced" | "Deep";

const studyModelSchema = z.literal("active");
export type StudyModel = z.infer<typeof studyModelSchema>;

const aiInputSchema = z.object({
  sessionName: z.string().min(1).max(100),
  materials: z.string().max(10000),
  translate: z.boolean().default(false),
  responseStyle: responseStyleSchema,
  model: studyModelSchema.default("active"),
  aiName: z.string().max(80).optional(),
});

const quizSettingsSchema = z.object({
  difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
  questionCount: z.union([z.literal(3), z.literal(5)]).default(5),
  optionCount: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(4),
}).default({ difficulty: "medium", questionCount: 5, optionCount: 4 });

const keyTermDraftSchema = z.object({
  term: z.string().min(1).max(600),
  definition: z.string().min(1).max(1200),
  context: z.string().max(1200),
  example: z.string().max(1200),
});

const vocabularyDraftSchema = z.object({
  term: z.string().min(1).max(600),
  meaning: z.string().min(1).max(600),
});

export function sourceContext(materials: string) {
  return materials.trim()
    ? `Study materials for this session:\n---\n${materials.trim().slice(0, 10000)}\n---`
    : "No source material has been added yet. Be helpful, transparent, and invite the learner to add a source when context would improve the answer.";
}

export function responseMode(responseStyle: ResponseStyle): ResponseMode {
  if (responseStyle === "Fast" || responseStyle === "Concise") return "Fast";
  if (responseStyle === "Deep" || responseStyle === "Detailed") return "Deep";
  return "Balanced";
}

export function responseTokenBudget(task: "chat" | "continue" | "explain" | "quiz" | "keyTerm", responseStyle: ResponseStyle) {
  const mode = responseMode(responseStyle);
  const budgets = {
    Fast: { chat: 900, continue: 900, explain: 750, quiz: 1_500, keyTerm: 550 },
    Balanced: { chat: 2_400, continue: 2_400, explain: 1_600, quiz: 2_000, keyTerm: 700 },
    Deep: { chat: 4_200, continue: 4_200, explain: 2_800, quiz: 2_700, keyTerm: 950 },
  } as const;
  return budgets[mode][task];
}


export function aiCompanionName(value?: string) {
  const normalized = (value ?? "").replace(/[^a-zA-Z0-9 .'-]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  return normalized || "StudyOS";
}

export function systemPrompt(sessionName: string, materials: string, translate: boolean, responseStyle: ResponseStyle, aiName?: string) {
  const mode = responseMode(responseStyle);
  const companionName = aiCompanionName(aiName);
  return [
    `You are ${companionName}, a knowledgeable, grounded, and genuinely helpful study companion inside the StudyOS app. When the learner asks who you are or refers to you by name, identify yourself as ${companionName}; do not claim your name is StudyOS unless ${companionName} is StudyOS.`,
    `The learner is working in the session: ${sessionName}.`,
    sourceContext(materials),
    "Sound natural and human: answer the learner directly, use smooth conversational sentences, and explain ideas like a patient friend who knows the subject well. Avoid robotic headings, canned praise, excessive exclamation points, and fake certainty. Match the learner's language and level of formality while staying respectful.",
    "When source material is available, ground every source-based paragraph in it. Put the exact chunk tag such as [Source: title · part 2] at the end of each grounded paragraph. StudyOS renders those tags as clean citation controls, so use only tags that appear in the supplied material. Never invent a source or claim that it appeared in the material.",
    mode === "Fast" ? "Answer in at most two short paragraphs or four short bullets. Give the direct answer or definition first, then only the essential context. Do not add service catalogs, comparison tables, implementation details, or a follow-up question unless the learner explicitly asks. Aim for 80–140 words when the question is open-ended." : mode === "Deep" ? "Provide a structured and thorough explanation with helpful context, while staying focused on the learning goal." : "Give a clear, well-balanced answer with enough context to support learning without unnecessary detail.",
    "Always finish your current sentence and provide a natural stopping point. Do not end in the middle of a sentence.",
    translate ? "Always respond in natural Bahasa Indonesia regardless of the question language. Keep technical terms in English when that is clearer." : "Respond in the language used by the learner unless they ask for another language.",
  ].join("\n\n");
}

export type StudyCitation = { title: string; ordinal: number };
type StudyAIResult = { text: string; citations: StudyCitation[]; truncated: boolean; provider: string };
type StudyJsonSchema = { name: string; schema: Record<string, unknown> };
const sourceTagPattern = /\[Source:\s*([^\]\n]+?)\s*[·-]\s*part\s*(\d+)\s*\]/gi;

export function extractStudyCitations(content: string): StudyCitation[] {
  const citations: StudyCitation[] = [];
  const seen = new Set<string>();
  for (const match of Array.from(content.matchAll(sourceTagPattern))) {
    const title = match[1]?.trim();
    const ordinal = Number(match[2]);
    const key = `${title}\u0000${ordinal}`;
    if (title && Number.isInteger(ordinal) && ordinal > 0 && !seen.has(key)) {
      citations.push({ title, ordinal });
      seen.add(key);
    }
  }
  return citations;
}

export function formatStudyResponse(content: string) {
  return {
    text: content.replace(sourceTagPattern, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    citations: extractStudyCitations(content),
  };
}

function parseJsonObject(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const candidate = fenced ?? (start >= 0 && end >= start ? trimmed.slice(start, end + 1) : "");
  if (!candidate) throw new SyntaxError("No JSON object found");
  return JSON.parse(candidate);
}

export function parseChatTranslations(content: string, messageIds: string[]) {
  const parsed = z.object({ translations: z.array(chatTranslationItemSchema) }).safeParse(parseJsonObject(content));
  if (!parsed.success) throw new TRPCError({ code: "BAD_GATEWAY", message: "StudyOS could not translate this chat yet. Please try again." });
  return completeChatTranslations(parsed.data.translations, messageIds);
}

function completeChatTranslations(items: z.infer<typeof chatTranslationItemSchema>[], messageIds: string[]) {
  const translations = new Map(items.map((item) => [item.id, item.content.trim()]));
  const missing = messageIds.filter((id) => !translations.get(id));
  if (missing.length) throw new TRPCError({ code: "BAD_GATEWAY", message: "StudyOS could not translate every chat message. Please try again." });
  return messageIds.map((id) => ({ id, content: translations.get(id)! }));
}

export function parseChatTranslationCache(content: string, messageIds: string[]) {
  const parsed = z.object({
    english: z.array(chatTranslationItemSchema),
    indonesian: z.array(chatTranslationItemSchema),
  }).safeParse(parseJsonObject(content));
  if (!parsed.success) throw new TRPCError({ code: "BAD_GATEWAY", message: "StudyOS could not translate this chat yet. Please try again." });
  return {
    english: completeChatTranslations(parsed.data.english, messageIds),
    indonesian: completeChatTranslations(parsed.data.indonesian, messageIds),
  };
}

type ChatTranslationCache = ReturnType<typeof parseChatTranslationCache>;
const TRANSLATION_BATCH_CHARACTER_LIMIT = 5_000;

function translationBatches(messages: z.infer<typeof chatTranslationItemSchema>[]) {
  const batches: z.infer<typeof chatTranslationItemSchema>[][] = [];
  let current: z.infer<typeof chatTranslationItemSchema>[] = [];
  let characters = 0;
  for (const message of messages) {
    const messageCharacters = message.content.length;
    if (current.length && characters + messageCharacters > TRANSLATION_BATCH_CHARACTER_LIMIT) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(message);
    characters += messageCharacters;
  }
  if (current.length) batches.push(current);
  return batches;
}

function mergeTranslationCaches(caches: ChatTranslationCache[]): ChatTranslationCache {
  return {
    english: caches.flatMap((cache) => cache.english),
    indonesian: caches.flatMap((cache) => cache.indonesian),
  };
}

function normalizeTranslationText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?()[\]{}"'`*_~—–-]/g, "").trim();
}

function sourceClearlyNeedsTranslation(value: string, target: "english" | "indonesian") {
  const text = value.toLowerCase();
  const indonesianSignals = text.match(/\b(?:aku|saya|kamu|yang|dan|atau|untuk|dengan|dari|ini|itu|apa|bagaimana|belajar|adalah|sebagai|pada|tidak|bisa|sudah|akan|menyimpan|lewat|banyak|sangat|dalam)\b/g)?.length ?? 0;
  const englishSignals = text.match(/\b(?:the|and|or|for|with|from|this|that|what|how|learn|is|are|can|will|not|about|into|over)\b/g)?.length ?? 0;
  return target === "english" ? indonesianSignals >= 2 && indonesianSignals > englishSignals : englishSignals >= 2 && englishSignals > indonesianSignals;
}

function copiedOppositeLanguageSource(originals: z.infer<typeof chatTranslationItemSchema>[], translations: z.infer<typeof chatTranslationItemSchema>[], target: "english" | "indonesian") {
  const translatedById = new Map(translations.map((item) => [item.id, item.content]));
  return originals.some((original) => {
    const translation = translatedById.get(original.id);
    if (!translation) return false;
    return sourceClearlyNeedsTranslation(original.content, target) && normalizeTranslationText(original.content) === normalizeTranslationText(translation);
  });
}

function normalizedDraftLabel(value: string) {
  return value.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

function parseLabelledKeyTermDraft(content: string) {
  const labels: Record<string, "term" | "definition" | "context" | "example"> = {
    "term": "term", "key term": "term", "istilah": "term",
    "definition": "definition", "definisi": "definition",
    "context": "context", "konteks": "context",
    "example": "example", "contoh": "example",
  };
  const draft: Partial<Record<"term" | "definition" | "context" | "example", string>> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?(?:\*{0,2})?([^:：]+?)(?:\*{0,2})?\s*[:：]\s*(.+?)\s*$/);
    if (!match) continue;
    const field = labels[normalizedDraftLabel(match[1] ?? "")];
    if (field && !draft[field]) draft[field] = (match[2] ?? "").replace(/^\*{0,2}|\*{0,2}$/g, "").trim();
  }
  return draft;
}

function compactKeyTermText(value: string, maxLength: number, finishSentence = false) {
  const clean = value.replace(/\s+/g, " ").trim();
  const sentenceEnd = finishSentence ? clean.search(/[.!?](?:\s|$)/) : -1;
  const concise = sentenceEnd >= 0 ? clean.slice(0, sentenceEnd + 1) : clean;
  return concise.length <= maxLength ? concise : `${concise.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function compactKeyTermDraft(draft: z.infer<typeof keyTermDraftSchema>) {
  return {
    term: compactKeyTermText(draft.term, 80),
    definition: compactKeyTermText(draft.definition, 180, true),
    context: compactKeyTermText(draft.context, 150, true),
    example: compactKeyTermText(draft.example, 150, true),
  };
}

export function parseKeyTermDraft(content: string) {
  try {
    const parsed = keyTermDraftSchema.safeParse(parseJsonObject(content));
    if (parsed.success) return compactKeyTermDraft(parsed.data);
  } catch {
    // A few providers still wrap valid card fields in Markdown despite JSON mode.
  }
  const fallback = keyTermDraftSchema.safeParse(parseLabelledKeyTermDraft(content));
  if (fallback.success) return compactKeyTermDraft(fallback.data);
  throw new TRPCError({ code: "BAD_GATEWAY", message: "StudyOS AI returned an invalid Key Term draft. Please try again." });
}

function parseVocabularyDraft(content: string) {
  try {
    const parsed = vocabularyDraftSchema.safeParse(parseJsonObject(content));
    if (parsed.success) return { term: compactKeyTermText(parsed.data.term, 80), meaning: compactKeyTermText(parsed.data.meaning, 180, true) };
  } catch {
    // Some local providers return labelled text despite the requested JSON shape.
  }
  const draft: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?(?:\*{0,2})?([^:：]+?)(?:\*{0,2})?\s*[:：]\s*(.+?)\s*$/);
    if (!match) continue;
    const label = normalizedDraftLabel(match[1] ?? "");
    if (["term", "word", "istilah", "kata"].includes(label)) draft.term ??= match[2] ?? "";
    if (["meaning", "translation", "arti", "terjemahan"].includes(label)) draft.meaning ??= match[2] ?? "";
  }
  const fallback = vocabularyDraftSchema.safeParse(draft);
  if (fallback.success) return { term: compactKeyTermText(fallback.data.term, 80), meaning: compactKeyTermText(fallback.data.meaning, 180, true) };
  throw new TRPCError({ code: "BAD_GATEWAY", message: "StudyOS AI returned an invalid vocabulary translation. Please try again." });
}

function isEmptyVocabularyResponse(error: unknown) {
  return error instanceof TRPCError && error.code === "BAD_GATEWAY" && /(?:empty (?:AI )?(?:response|output)|no visible text|respons kosong)/i.test(error.message);
}

const rawQuizQuestionSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(4),
  correct: z.unknown().optional(),
  correctIndex: z.unknown().optional(),
  correct_index: z.unknown().optional(),
  correctAnswer: z.unknown().optional(),
  answer: z.unknown().optional(),
  explanation: z.string().min(1),
});

function normalizeQuizCorrectIndex(value: unknown, options: string[]) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < options.length) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (/^[A-D]$/i.test(text) && text.toUpperCase().charCodeAt(0) - 65 < options.length) return text.toUpperCase().charCodeAt(0) - 65;
    if (/^[0-3]$/.test(text) && Number(text) < options.length) return Number(text);
    const optionIndex = options.findIndex((option) => option.trim().toLowerCase() === text.toLowerCase());
    if (optionIndex >= 0) return optionIndex;
  }
  throw new TRPCError({ code: "BAD_GATEWAY", message: "StudyOS AI returned an invalid quiz answer key. Please try again." });
}

export function parseQuizQuestions(content: string, settings: z.infer<typeof quizSettingsSchema> = { difficulty: "medium", questionCount: 5, optionCount: 4 }) {
  const parsed = parseJsonObject(content) as { questions?: unknown };
  const questions = z.array(rawQuizQuestionSchema.refine((question) => question.options.length === settings.optionCount, { message: "Unexpected option count" })).length(settings.questionCount).parse(parsed.questions);
  return questions.map(({ correct, correctIndex, correct_index, correctAnswer, answer, ...question }) => ({
    ...question,
    correct: normalizeQuizCorrectIndex(correct ?? correctIndex ?? correct_index ?? correctAnswer ?? answer, question.options),
  }));
}

type StudyMessage = { role: "system" | "user" | "assistant"; content: string };

// Access is checked before the store decrypts a managed key. One immutable
// connection snapshot is reused by all batches and bounded repair attempts.
const aiProcedure = publicProcedure.use(async ({ ctx, next }) => {
  requireAiAccess(ctx.req, ctx.user);
  const aiConnection = await getActiveConnection();
  return next({ ctx: { ...ctx, aiConnection } });
});

export async function invokeStudyAI(_model: StudyModel, messages: StudyMessage[], maxTokens: number, _responseStyle: ResponseStyle, json: boolean | StudyJsonSchema, connection: ResolvedAiConnection, timeoutMs = connection.timeoutMs) {
  const result = await invokeConnection(connection, messages, { maxTokens, json: Boolean(json), timeoutMs });
  if (json) return { ...result, citations: [] } satisfies StudyAIResult;
  return { ...formatStudyResponse(result.text), truncated: result.truncated, provider: result.provider } satisfies StudyAIResult;
}

function invokeStudyAIForConnection(connection: ResolvedAiConnection, model: StudyModel, messages: StudyMessage[], maxTokens: number, responseStyle: ResponseStyle, json: boolean | StudyJsonSchema = false, timeoutMs?: number) {
  return invokeStudyAI(model, messages, maxTokens, responseStyle, json, connection, timeoutMs);
}

function isPrivateAddress(address: string) {
  if (isIP(address) === 6) return address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:");
  const octets = address.split(".").map(Number);
  return address === "0.0.0.0" || octets[0] === 10 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 || octets[0] >= 224;
}

async function validateSourceUrl(rawUrl: string) {
  const url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hostname === "localhost" || url.hostname.endsWith(".local")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Use a public HTTP or HTTPS URL." });
  }
  const records = await lookup(url.hostname, { all: true });
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Private network URLs cannot be used as sources." });
  }
  return url;
}

async function readLimitedText(response: Response) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 750_000) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "This source is too large. Choose a page under 750 KB." });
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 750_000) { await reader.cancel(); throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "This source is too large. Choose a page under 750 KB." }); }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => { merged.set(chunk, offset); offset += chunk.byteLength; });
  return new TextDecoder().decode(merged);
}

export const appRouter = router({
  system: systemRouter,
  aiConnections: aiConnectionsRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  study: router({
    uploadAvatar: publicProcedure
      .input(z.object({ imageDataUrl: z.string().min(32).max(2_100_000) }))
      .mutation(async ({ input }) => {
        try {
          const image = decodeAvatarImage(input.imageDataUrl);
          if (isLocalStudyMode()) {
            return { url: input.imageDataUrl };
          }
          const { url } = await storagePut(`studyos/avatars/profile.${image.extension}`, image.bytes, image.contentType);
          return { url };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS avatar upload]", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "StudyOS could not upload that profile image. Please try again." });
        }
      }),
    uploadDocument: publicProcedure
      .input(z.object({
        name: z.string().min(1).max(180),
        mimeType: z.enum(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/markdown", "text/csv"]),
        dataUrl: z.string().min(32).max(7_100_000),
      }))
      .mutation(async ({ input }) => {
        try {
          const document = await decodeAndExtractDocument(input);
          const safeName = input.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `study-material.${document.extension}`;
          if (isLocalStudyMode()) {
            return { title: input.name, url: "", content: document.content, format: document.format };
          }
          const { url } = await storagePut(`studyos/materials/${Date.now()}-${safeName}`, document.bytes, document.contentType);
          return { title: input.name, url, content: document.content, format: document.format };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS document upload]", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "StudyOS could not import that document. Please try again." });
        }
      }),
    fetchSource: publicProcedure
      .input(z.object({ url: z.string().min(3).max(2048) }))
      .mutation(async ({ input }) => {
        try {
          const url = await validateSourceUrl(input.url);
          const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "User-Agent": "StudyOS Source Reader/1.0" } });
          if (response.status >= 300 && response.status < 400) throw new TRPCError({ code: "BAD_REQUEST", message: "Redirecting URLs are not supported. Please paste the final public URL." });
          if (!response.ok) throw new TRPCError({ code: "BAD_REQUEST", message: "StudyOS could not fetch this source." });
          const html = await readLimitedText(response);
          if (!html.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "No readable text was returned by this source." });
          return { url: url.toString(), title: url.hostname.replace(/^www\./, ""), html };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS source fetch]", error);
          throw new TRPCError({ code: "BAD_REQUEST", message: "StudyOS could not read this URL. Try a different public page or upload a text file." });
        }
      }),
    searchSources: publicProcedure
      .input(z.object({ query: z.string().trim().min(2).max(180), scope: z.enum(["web", "academic"]) }))
      .mutation(async ({ input }) => {
        try {
          return { results: await searchSources(input.scope, input.query) };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS source search]", { scope: input.scope, error: error instanceof Error ? error.name : "unknown" });
          throw new TRPCError({ code: "BAD_GATEWAY", message: "Search belum tersedia saat ini. Coba lagi beberapa saat lagi." });
        }
      }),
    chat: aiProcedure
      .input(aiInputSchema.extend({ history: z.array(chatMessageSchema).max(30) }))
      .mutation(async ({ input, ctx }) => {
        try {
          const result = await invokeStudyAIForConnection(ctx.aiConnection, input.model, [
            { role: "system", content: systemPrompt(input.sessionName, input.materials, input.translate, input.responseStyle, input.aiName) },
            ...input.history.map((message) => ({ role: message.role, content: message.content })),
          ], responseTokenBudget("chat", input.responseStyle), input.responseStyle);
          return result;
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS AI chat]", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "StudyOS AI is temporarily unavailable. Please try again." });
        }
      }),
    translateChat: aiProcedure
      .input(z.object({
        messages: z.array(chatTranslationItemSchema).min(1).max(6),
        model: studyModelSchema.default("active"),
        target: z.enum(["english", "indonesian"]),
      }))
      .mutation(async ({ input, ctx }) => {
        try {
          const translationSystemPrompt = [
            "You are a precise bilingual translator for a personal study chat.",
            `Translate every supplied message into ${input.target === "english" ? "natural English" : "natural Bahasa Indonesia"}. The opposite language will use the original chat text, so do not generate it.`,
            "Preserve Markdown, code blocks, URLs, names, numerical values, technical terms when clearer in English, and the learner's original tone. Do not explain, summarize, answer questions, or add commentary.",
            "Return JSON only in exactly this shape: {\"translations\":[{\"id\":\"original id\",\"content\":\"translation\"}]}. Return every supplied id exactly once.",
          ].join("\n\n");
          const translationSchema: StudyJsonSchema = {
            name: "chat_translations",
            schema: {
              type: "object",
              properties: {
                translations: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "string" }, content: { type: "string" } },
                    required: ["id", "content"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["translations"],
              additionalProperties: false,
            },
          };
          const translateBatch = async (batch: z.infer<typeof chatTranslationItemSchema>[]): Promise<ChatTranslationCache> => {
            const characterCount = batch.reduce((total, message) => total + message.content.length, 0);
            const outputBudget = Math.min(1_600, Math.max(450, Math.ceil(characterCount * 0.8) + 220));
            const requestTranslation = async (system: string) => {
              const result = await invokeStudyAIForConnection(ctx.aiConnection, input.model, [
                { role: "system", content: system },
                { role: "user", content: JSON.stringify({ messages: batch }) },
              ], outputBudget, "Balanced", translationSchema, ctx.aiConnection.timeoutMs);
              if (result.truncated) throw new TRPCError({ code: "BAD_GATEWAY", message: "Translation JSON was truncated." });
              return parseChatTranslations(result.text, batch.map((message) => message.id));
            };
            let translated = await requestTranslation(translationSystemPrompt);
            if (copiedOppositeLanguageSource(batch, translated, input.target)) {
              translated = await requestTranslation([
                "The previous answer was rejected because it copied a message in the wrong language instead of translating it.",
                `Translate every supplied message into ${input.target === "english" ? "natural English" : "natural Bahasa Indonesia"}. Do not leave a message unchanged when it clearly uses the opposite language.`,
                "Return JSON only in exactly this shape: {\"translations\":[{\"id\":\"original id\",\"content\":\"translation\"}]}. Return every supplied id exactly once. Do not add any explanation.",
              ].join("\n\n"));
              if (copiedOppositeLanguageSource(batch, translated, input.target)) {
                throw new TRPCError({ code: "BAD_GATEWAY", message: "The AI service repeated the original text instead of translating it. Try again or choose a different model." });
              }
            }
            const originals = batch.map((message) => ({ id: message.id, content: message.content }));
            return input.target === "english"
              ? { english: translated, indonesian: originals }
              : { english: originals, indonesian: translated };
          };
          const caches: ChatTranslationCache[] = [];
          for (const batch of translationBatches(input.messages)) caches.push(await translateBatch(batch));
          return { translations: mergeTranslationCaches(caches) };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS Chat translation]", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "StudyOS could not translate this chat yet. Please try again." });
        }
      }),
    continue: aiProcedure
      .input(aiInputSchema.extend({ history: z.array(chatMessageSchema).min(1).max(31) }))
      .mutation(async ({ input, ctx }) => {
        try {
          const result = await invokeStudyAIForConnection(ctx.aiConnection, input.model, [
            { role: "system", content: systemPrompt(input.sessionName, input.materials, input.translate, input.responseStyle, input.aiName) },
            ...input.history.map((message) => ({ role: message.role, content: message.content })),
            { role: "user", content: "Continue the immediately preceding answer exactly where it stopped. Do not repeat its opening or recap it; finish the remaining explanation naturally and cite any source-based paragraphs." },
          ], responseTokenBudget("continue", input.responseStyle), input.responseStyle);
          return result;
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS AI continuation]", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "StudyOS AI could not continue that answer. Please try again." });
        }
      }),
    explain: aiProcedure
      .input(aiInputSchema.extend({ selection: z.string().min(1).max(3000) }))
      .mutation(async ({ input, ctx }) => {
        try {
          const result = await invokeStudyAIForConnection(ctx.aiConnection, input.model, [
            { role: "system", content: systemPrompt(input.sessionName, input.materials, input.translate, input.responseStyle) },
            { role: "user", content: `Explain this selected text in a clear learning-focused way. Include a concise definition, why it matters, and one simple example when appropriate:\n\n${input.selection}` },
          ], responseTokenBudget("explain", input.responseStyle), input.responseStyle, false, ctx.aiConnection.timeoutMs);
          return result;
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS AI explain]", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "StudyOS AI could not explain that selection. Please try again." });
        }
      }),
    draftKeyTerm: aiProcedure
      .input(aiInputSchema.extend({ selection: z.string().min(1).max(2000) }))
      .mutation(async ({ input, ctx }) => {
        try {
          const result = await invokeStudyAIForConnection(ctx.aiConnection, input.model, [
            { role: "system", content: [
              "You create concise, accurate Key Term flashcards for a personal study app.",
              sourceContext(input.materials),
              "Return one JSON object only with these string fields: term, definition, context, example. Make term the shortest standard name or acronym (maximum 80 characters). Make definition one plain-language sentence of at most 180 characters; a phrase-style definition is ideal, such as 'platform komputasi awan (cloud computing)'. Context and example are optional: return an empty string when they do not add essential learning value; otherwise keep each to one short sentence of at most 150 characters.",
              "Do not invent facts beyond the selected text and supplied material. Use the learner's language unless they requested Indonesian, in which case use natural Bahasa Indonesia.",
            ].join("\n\n") },
            { role: "user", content: `Selected text:\n${input.selection}` },
          ], responseTokenBudget("keyTerm", input.responseStyle), input.responseStyle, {
            name: "key_term_draft",
            schema: {
              type: "object",
              properties: {
                term: { type: "string" },
                definition: { type: "string" },
                context: { type: "string" },
                example: { type: "string" },
              },
              required: ["term", "definition", "context", "example"],
              additionalProperties: false,
            },
          }, ctx.aiConnection.timeoutMs);
          return parseKeyTermDraft(result.text);
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS AI Key Term draft]", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "StudyOS AI could not prepare that Key Term. Please try again." });
        }
      }),
    draftVocabulary: aiProcedure
      .input(aiInputSchema.extend({ selection: z.string().min(1).max(240) }))
      .mutation(async ({ input, ctx }) => {
        try {
          const messages: Array<{ role: "system" | "user"; content: string }> = [
            { role: "system", content: [
              "You create minimal vocabulary cards for a personal study app.",
              "Return one JSON object only with string fields: term, meaning.",
              "Keep term as the exact selected foreign word or short phrase (maximum 80 characters).",
              "Meaning must be only a short, natural Bahasa Indonesia translation (maximum 180 characters). Do not add a definition, context, example, label, punctuation explanation, or extra commentary.",
            ].join("\n\n") },
            { role: "user", content: `Selected vocabulary:\n${input.selection}` },
          ];
          let result;
          try {
            result = await invokeStudyAIForConnection(ctx.aiConnection, input.model, messages, 250, input.responseStyle, false, ctx.aiConnection.timeoutMs);
          } catch (error) {
            if (!isEmptyVocabularyResponse(error)) throw error;
            // Retry a malformed empty response once on the same connection.
            result = await invokeStudyAIForConnection(ctx.aiConnection, input.model, [
              { role: "system", content: "Translate the selected foreign word or short phrase into Bahasa Indonesia. Reply with only valid JSON: {\"term\":\"selected word\",\"meaning\":\"short Indonesian translation\"}. No explanation." },
              { role: "user", content: input.selection },
            ], 500, input.responseStyle, false, ctx.aiConnection.timeoutMs);
          }
          return parseVocabularyDraft(result.text);
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS AI vocabulary draft]", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "StudyOS AI could not translate that vocabulary. Please try again." });
        }
      }),
    quiz: aiProcedure
      .input(aiInputSchema.extend({ quiz: quizSettingsSchema }))
      .mutation(async ({ input, ctx }) => {
        if (!input.materials.trim()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Add at least one source before generating a quiz." });
        }
        try {
          const difficulty = input.quiz.difficulty === "easy" ? "Easy: recall clear facts and definitions." : input.quiz.difficulty === "hard" ? "Hard: test application, comparison, and reasoning from the material." : "Medium: test understanding and simple application from the material.";
          const quizTimeoutMs = ctx.aiConnection.timeoutMs;
          const result = await invokeStudyAIForConnection(ctx.aiConnection, input.model, [
            { role: "system", content: `You create high-quality learning quizzes. Generate exactly ${input.quiz.questionCount} distinct multiple-choice questions based only on the supplied study material. Each question must have exactly ${input.quiz.optionCount} plausible options, one correct option, and a concise one-sentence explanation. ${difficulty} Keep every field short enough for all questions to fit. Return JSON only in this exact shape: {\"questions\":[{\"question\":\"...\",\"options\":[\"...\"],\"correct\":0,\"explanation\":\"...\"}]}. The correct field must be a zero-based number from 0 to ${input.quiz.optionCount - 1}; do not use correctIndex, answer, letters, or option text. No Markdown or commentary.` },
            { role: "user", content: `${sourceContext(input.materials)}\n\nGenerate the quiz for the session \"${input.sessionName}\".` },
          ], responseTokenBudget("quiz", input.responseStyle), input.responseStyle, true, quizTimeoutMs);
          try {
            return { questions: parseQuizQuestions(result.text, input.quiz) };
          } catch (parseError) {
            const repaired = await invokeStudyAIForConnection(ctx.aiConnection, input.model, [
              { role: "system", content: `Reformat the supplied Quiz candidate into valid JSON only. Return exactly ${input.quiz.questionCount} questions with exactly ${input.quiz.optionCount} short options each. Use this shape: {\"questions\":[{\"question\":\"...\",\"options\":[\"...\"],\"correct\":0,\"explanation\":\"...\"}]}. correct must be a number 0 to ${input.quiz.optionCount - 1}. Do not add Markdown or commentary.` },
              { role: "user", content: `Quiz candidate to repair:\n${result.text.slice(0, 12_000)}` },
            ], responseTokenBudget("quiz", input.responseStyle), input.responseStyle, true, quizTimeoutMs);
            try {
              return { questions: parseQuizQuestions(repaired.text, input.quiz) };
            } catch {
              throw parseError;
            }
          }
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("[StudyOS AI quiz]", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "StudyOS AI could not generate a valid quiz. Please try again." });
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
