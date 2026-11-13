import { trpc } from "@/lib/trpc";
import type { StudyCitation } from "@/lib/study-types";
import { useStudyStore } from "@/store/useStudyStore";
import type { QuizGenerationSettings } from "@/components/studyos/QuizGeneratorDialog";
import React, { createContext, useContext, useMemo, useRef, useState } from "react";

type SourceTaskKind = "explain" | "key-term" | "vocabulary" | "quiz" | "chat-translation";
type SourceTaskStatus = "pending" | "review" | "error";
export type KeyTermDraft = { term: string; definition: string; context: string; example: string };
export type ChatTranslationLanguage = "english" | "indonesian";
export type ChatTranslationCache = Record<ChatTranslationLanguage, Record<string, string>>;

export type SourceTask = {
  id: string;
  kind: SourceTaskKind;
  label: string;
  status: SourceTaskStatus;
  sessionId: string;
  selection?: string;
  draft?: KeyTermDraft;
  error?: string;
};

type SourceRequest = {
  sessionId: string;
  sessionName: string;
  materials: string;
  responseStyle: "Fast" | "Balanced" | "Deep";
  model: "active";
  selection: string;
};

type QuizRequest = Omit<SourceRequest, "selection"> & { quiz: QuizGenerationSettings };
type ChatTranslationRequest = { sessionId: string; sessionName: string; model: "active"; target: ChatTranslationLanguage; messages: Array<{ id: string; content: string }> };
type ChatTranslationJob = Pick<ChatTranslationRequest, "target" | "messages">;

type SourceAiActivityValue = {
  tasks: SourceTask[];
  startKeyTerm: (request: SourceRequest) => void;
  startVocabulary: (request: SourceRequest) => void;
  startExplain: (request: SourceRequest) => void;
  startQuiz: (request: QuizRequest) => void;
  startChatTranslation: (request: ChatTranslationRequest) => void;
  cancelTask: (taskId: string) => void;
  cancelChatTranslation: (sessionId: string) => void;
  discardTask: (taskId: string) => void;
  saveKeyTerm: (taskId: string, draft: KeyTermDraft) => void;
  chatTranslationsFor: (sessionId: string) => ChatTranslationCache;
  chatTranslationProgressFor: (sessionId: string) => { target: ChatTranslationLanguage; messageIds: string[] } | null;
  chatTranslationTarget: (sessionId: string) => ChatTranslationLanguage | null;
  chatTranslationError: (sessionId: string) => string | null;
  clearChatTranslationErrors: (sessionId: string) => void;
  isPending: (sessionId: string, kind: SourceTaskKind) => boolean;
};

const SourceAiActivityContext = createContext<SourceAiActivityValue | null>(null);

function taskId(kind: SourceTaskKind) {
  return `source-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sourceCitations(sessionId: string, citations: Array<{ title: string; ordinal: number }>): StudyCitation[] {
  const session = useStudyStore.getState().sessions.find((entry) => entry.id === sessionId);
  return citations.map((citation) => ({ ...citation, materialId: session?.materials.find((material) => material.title === citation.title)?.id }));
}

export function SourceAiActivityProvider({ children }: { children: React.ReactNode }) {
  const addVocabulary = useStudyStore((state) => state.addVocabulary);
  const addMessage = useStudyStore((state) => state.addMessage);
  const addQuiz = useStudyStore((state) => state.addQuiz);
  const [tasks, setTasks] = useState<SourceTask[]>([]);
  const runs = useRef<Record<string, number>>({});
  const explain = trpc.study.explain.useMutation();
  const draftKeyTerm = trpc.study.draftKeyTerm.useMutation();
  const draftVocabulary = trpc.study.draftVocabulary.useMutation();
  const quiz = trpc.study.quiz.useMutation();
  const translateChat = trpc.study.translateChat.useMutation();
  const [chatTranslations, setChatTranslations] = useState<Record<string, ChatTranslationCache>>({});
  const [chatTranslationTargets, setChatTranslationTargets] = useState<Record<string, ChatTranslationLanguage>>({});
  const [chatTranslationJobs, setChatTranslationJobs] = useState<Record<string, ChatTranslationJob>>({});

  const begin = (kind: SourceTaskKind, request: Pick<SourceRequest, "sessionId" | "sessionName"> & { selection?: string }) => {
    const id = taskId(kind);
    const label = kind === "key-term" ? "Save Terms" : kind === "vocabulary" ? "Save Vocab" : kind === "quiz" ? "Generate Quiz" : kind === "chat-translation" ? "Translate Chat" : "Explain";
    const run = 1;
    runs.current[id] = run;
    setTasks((current) => [...current.filter((task) => !(task.sessionId === request.sessionId && task.kind === kind && task.status === "pending")), { id, kind, label, status: "pending", sessionId: request.sessionId, selection: request.selection }]);
    return { id, run, label };
  };

  const finish = (id: string, run: number, updater: (task: SourceTask) => SourceTask | null) => {
    if (runs.current[id] !== run) return;
    setTasks((current) => current.flatMap((task) => task.id === id ? (updater(task) ? [updater(task) as SourceTask] : []) : [task]));
  };

  const startKeyTerm = (request: SourceRequest) => {
    const { id, run } = begin("key-term", request);
    draftKeyTerm.mutate({ sessionName: request.sessionName, materials: request.materials, translate: false, responseStyle: request.responseStyle, model: request.model, selection: request.selection }, {
      onSuccess: (draft) => finish(id, run, (task) => ({ ...task, status: "review", draft })),
      onError: (reason) => finish(id, run, (task) => ({ ...task, status: "error", error: reason.message })),
    });
  };

  const startVocabulary = (request: SourceRequest) => {
    const { id, run } = begin("vocabulary", request);
    draftVocabulary.mutate({ sessionName: request.sessionName, materials: request.materials, translate: false, responseStyle: request.responseStyle, model: request.model, selection: request.selection }, {
      onSuccess: (draft) => { if (runs.current[id] !== run) return; addVocabulary(request.sessionId, draft.term, draft.meaning, { sourceExcerpt: request.selection }); finish(id, run, () => null); },
      onError: (reason) => finish(id, run, (task) => ({ ...task, status: "error", error: reason.message })),
    });
  };

  const startExplain = (request: SourceRequest) => {
    const { id, run } = begin("explain", request);
    addMessage(request.sessionId, { role: "user", content: `Explain: ${request.selection}` });
    explain.mutate({ sessionName: request.sessionName, materials: request.materials, translate: false, responseStyle: request.responseStyle, model: request.model, selection: request.selection }, {
      onSuccess: ({ text, citations, truncated, provider }) => { if (runs.current[id] !== run) return; addMessage(request.sessionId, { role: "assistant", content: text, citations: sourceCitations(request.sessionId, citations), truncated, ...(provider ? { provider } : {}) }); finish(id, run, () => null); },
      onError: (reason) => finish(id, run, (task) => ({ ...task, status: "error", error: reason.message })),
    });
  };

  const startQuiz = (request: QuizRequest) => {
    const { id, run } = begin("quiz", request);
    quiz.mutate({ sessionName: request.sessionName, materials: request.materials, translate: false, responseStyle: request.responseStyle, model: request.model, quiz: request.quiz }, {
      onSuccess: ({ questions }) => { if (runs.current[id] !== run) return; addQuiz(request.sessionId, questions); finish(id, run, () => null); },
      onError: (reason) => finish(id, run, (task) => ({ ...task, status: "error", error: reason.message })),
    });
  };

  const runChatTranslationBatch = (id: string, run: number, request: ChatTranslationRequest, offset: number) => {
    const batch = request.messages.slice(offset, offset + 6);
    if (!batch.length) { setChatTranslationJobs((current) => { const next = { ...current }; delete next[request.sessionId]; return next; }); finish(id, run, () => null); return; }
    translateChat.mutate({ model: request.model, target: request.target, messages: batch }, {
      onSuccess: ({ translations }) => {
        if (runs.current[id] !== run) return;
        setChatTranslations((current) => ({
          ...current,
          [request.sessionId]: {
            english: { ...(current[request.sessionId]?.english ?? {}), ...Object.fromEntries(translations.english.map((item) => [item.id, item.content])) },
            indonesian: { ...(current[request.sessionId]?.indonesian ?? {}), ...Object.fromEntries(translations.indonesian.map((item) => [item.id, item.content])) },
          },
        }));
        window.dispatchEvent(new CustomEvent("studyos:chat-translation-result", { detail: { sessionId: request.sessionId, translations } }));
        if (offset + batch.length < request.messages.length) { runChatTranslationBatch(id, run, request, offset + batch.length); return; }
        setChatTranslationJobs((current) => { const next = { ...current }; delete next[request.sessionId]; return next; });
        finish(id, run, () => null);
      },
      onError: (reason) => { if (runs.current[id] !== run) return; setChatTranslationJobs((current) => { const next = { ...current }; delete next[request.sessionId]; return next; }); finish(id, run, (task) => ({ ...task, status: "error", error: reason.message })); },
    });
  };

  const startChatTranslation = (request: ChatTranslationRequest) => {
    if (tasks.some((task) => task.sessionId === request.sessionId && task.kind === "chat-translation" && task.status === "pending")) return;
    const { id, run } = begin("chat-translation", request);
    setChatTranslationTargets((current) => ({ ...current, [request.sessionId]: request.target }));
    setChatTranslationJobs((current) => ({ ...current, [request.sessionId]: { target: request.target, messages: request.messages } }));
    runChatTranslationBatch(id, run, request, 0);
  };

  const cancelTask = (id: string) => {
    const task = tasks.find((entry) => entry.id === id);
    if (!task) return;
    runs.current[id] = (runs.current[id] ?? 0) + 1;
    if (task.kind === "explain") explain.reset();
    if (task.kind === "key-term") draftKeyTerm.reset();
    if (task.kind === "vocabulary") draftVocabulary.reset();
    if (task.kind === "quiz") quiz.reset();
    if (task.kind === "chat-translation") {
      translateChat.reset();
      setChatTranslationJobs((current) => { const next = { ...current }; delete next[task.sessionId]; return next; });
      setChatTranslationTargets((current) => { const next = { ...current }; delete next[task.sessionId]; return next; });
      window.dispatchEvent(new CustomEvent("studyos:chat-translate", { detail: { active: false } }));
    }
    setTasks((current) => current.filter((entry) => entry.id !== id));
  };

  const cancelChatTranslation = (sessionId: string) => {
    tasks.filter((task) => task.sessionId === sessionId && task.kind === "chat-translation").forEach((task) => { runs.current[task.id] = (runs.current[task.id] ?? 0) + 1; });
    translateChat.reset();
    setChatTranslationJobs((current) => { const next = { ...current }; delete next[sessionId]; return next; });
    setTasks((current) => current.filter((task) => !(task.sessionId === sessionId && task.kind === "chat-translation")));
    setChatTranslationTargets((current) => { const next = { ...current }; delete next[sessionId]; return next; });
    window.dispatchEvent(new CustomEvent("studyos:chat-translate", { detail: { active: false } }));
  };

  const discardTask = (id: string) => setTasks((current) => current.filter((task) => task.id !== id));
  const saveKeyTerm = (id: string, draft: KeyTermDraft) => {
    const task = tasks.find((entry) => entry.id === id && entry.kind === "key-term" && entry.status === "review");
    if (!task) return;
    addVocabulary(task.sessionId, draft.term, draft.definition, { context: draft.context, example: draft.example, sourceExcerpt: task.selection });
    discardTask(id);
  };

  const value = useMemo<SourceAiActivityValue>(() => ({
    tasks, startKeyTerm, startVocabulary, startExplain, startQuiz, startChatTranslation, cancelTask, cancelChatTranslation, discardTask, saveKeyTerm,
    chatTranslationsFor: (sessionId) => chatTranslations[sessionId] ?? { english: {}, indonesian: {} },
    chatTranslationProgressFor: (sessionId) => { const job = chatTranslationJobs[sessionId]; return job ? { target: job.target, messageIds: job.messages.map((message) => message.id) } : null; },
    chatTranslationTarget: (sessionId) => chatTranslationTargets[sessionId] ?? null,
    chatTranslationError: (sessionId) => tasks.find((task) => task.sessionId === sessionId && task.kind === "chat-translation" && task.status === "error")?.error ?? null,
    clearChatTranslationErrors: (sessionId) => setTasks((current) => current.filter((task) => !(task.sessionId === sessionId && task.kind === "chat-translation" && task.status === "error"))),
    isPending: (sessionId, kind) => tasks.some((task) => task.sessionId === sessionId && task.kind === kind && task.status === "pending"),
  }), [tasks, chatTranslations, chatTranslationTargets, chatTranslationJobs]);

  return <SourceAiActivityContext.Provider value={value}>{children}</SourceAiActivityContext.Provider>;
}

export function useSourceAiActivity() {
  const value = useContext(SourceAiActivityContext);
  if (!value) throw new Error("useSourceAiActivity must be used inside SourceAiActivityProvider");
  return value;
}

export function useOptionalSourceAiActivity() {
  return useContext(SourceAiActivityContext);
}
