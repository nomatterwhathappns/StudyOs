import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { NoteEditor } from "@/components/studyos/NoteEditor";
import { defaultQuizGenerationSettings, QuizGeneratorDialog, type QuizGenerationSettings } from "@/components/studyos/QuizGeneratorDialog";
import { ThemeShuffleButton } from "@/components/studyos/ThemeSettings";
import { useOptionalSourceAiActivity, useSourceAiActivity } from "@/contexts/SourceAiActivityContext";
import { useWatchTimer } from "@/contexts/WatchTimerContext";
import { buildAdaptiveMaterialContext, buildMaterialChunks, materialChunkDomId } from "@/lib/material-context";
import { trpc } from "@/lib/trpc";
import type { Quiz, StudyCitation, StudySession, VocabItem, VocabReviewRating } from "@/lib/study-types";
import { compactKeyTermText, isVocabularyDue, plainText, scoreQuiz, vocabularyDueAt } from "@/lib/study-utils";
import { useStudyStore } from "@/store/useStudyStore";
import { BookOpenText, ChevronRight, Clock3, Compass, ExternalLink, FileText, FolderOpen, FolderPlus, Languages, Loader2, MessageCircleQuestion, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pause, Pin, Play, Plus, RotateCcw, Search, Send, Sparkles, Trash2, Upload, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { useLocation } from "wouter";

type KeyTermDraft = {
  term: string;
  definition: string;
  context: string;
  example: string;
};

type ChatTranslationCache = Record<"english" | "indonesian", Record<string, string>>;

const emptyChatTranslationCache = (): ChatTranslationCache => ({ english: {}, indonesian: {} });

type ChatTranslationLanguage = "english" | "indonesian";
type ChatTranslationProgress = { target: ChatTranslationLanguage; messageIds: string[] };

function normalizeChatMarkdown(content: string) {
  let insideCodeBlock = false;
  return content.replace(/[\u00A0\u2007\u202F\u2060\uFEFF]/g, " ").split(/(\r?\n)/).map((line) => {
    if (line.trimStart().startsWith("```")) { insideCodeBlock = !insideCodeBlock; return line; }
    if (insideCodeBlock) return line;
    return line.replace(/^(\s*)\*{3,}\s*(.+?)\s*\*{3,}\s*$/, "$1**$2**");
  }).join("");
}

function ChatMarkdown({ content }: { content: string }) {
  return <div className="study-chat-markdown"><Streamdown controls={{ table: false, code: false }} components={{ table: ({ node: _node, children, ...props }) => <div className="study-chat-table-scroll"><table {...props}>{children}</table></div> }}>{normalizeChatMarkdown(content)}</Streamdown></div>;
}

function inferOriginalChatLanguage(messages: StudySession["chatHistory"]): ChatTranslationLanguage {
  const text = messages.map((message) => message.content).join(" ").toLowerCase();
  const indonesianMatches = text.match(/\b(?:aku|saya|kamu|kalian|yang|dan|atau|untuk|dengan|dari|ini|itu|apa|bagaimana|belajar|terima|gak|nggak)\b/g)?.length ?? 0;
  const englishMatches = text.match(/\b(?:the|and|or|for|with|from|this|that|what|how|learn|please|thank|is|are)\b/g)?.length ?? 0;
  return englishMatches > indonesianMatches ? "english" : "indonesian";
}

function nextChatTranslationTarget(messages: StudySession["chatHistory"], translateChat: boolean, visibleTarget: ChatTranslationLanguage): ChatTranslationLanguage {
  if (translateChat) return visibleTarget === "english" ? "indonesian" : "english";
  return inferOriginalChatLanguage(messages) === "english" ? "indonesian" : "english";
}

export function WorkspaceProfileButton({ profile, onOpenProfile }: { profile: { name: string; avatar?: string }; onOpenProfile: () => void }) {
  return <button type="button" onClick={onOpenProfile} className={profile.avatar ? "size-9 overflow-hidden rounded-full border border-border" : "study-avatar size-9"} aria-label="Open profile">{profile.avatar ? <img src={profile.avatar} alt="Profile" className="size-full object-cover" /> : (profile.name || "L").slice(0, 1).toUpperCase()}</button>;
}

type CompactWorkspacePanel = "source" | "chat" | "watch";

function useIsCompactWorkspace() {
  const [isCompact, setIsCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1199px)");
    const sync = () => setIsCompact(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return isCompact;
}

export function CompactWorkspaceNavigation({ activePanel, onChange }: { activePanel: CompactWorkspacePanel; onChange: (panel: CompactWorkspacePanel) => void }) {
  const tabs: Array<{ id: CompactWorkspacePanel; label: string; icon: React.ReactNode }> = [
    { id: "source", label: "Source", icon: <BookOpenText className="size-4" /> },
    { id: "chat", label: "Chat", icon: <MessageCircleQuestion className="size-4" /> },
    { id: "watch", label: "Watch", icon: <Clock3 className="size-4" /> },
  ];
  return <nav className="study-compact-panel-nav" aria-label="Workspace panels">{tabs.map((tab) => <button key={tab.id} type="button" onClick={() => onChange(tab.id)} aria-pressed={activePanel === tab.id} className={`study-compact-panel-tab ${activePanel === tab.id ? "is-active" : ""}`}>{tab.icon}<span>{tab.label}</span></button>)}</nav>;
}

export default function StudyWorkspace() {
  const isCompact = useIsCompactWorkspace();
  const [, setLocation] = useLocation();
  const { hydrated, hydrate, profile, sessions, activeSessionId, createSession, setActiveSession } = useStudyStore();
  const [sourceVisible, setSourceVisible] = useState(true);
  const [watchVisible, setWatchVisible] = useState(true);
  const [compactPanel, setCompactPanel] = useState<CompactWorkspacePanel>("chat");
  const localAiRouter = trpc.study.localAiRouterStatus.useQuery(undefined, { staleTime: 60_000 });

  useEffect(() => { void hydrate(); }, [hydrate]);
  useEffect(() => {
    if (localAiRouter.data?.enabled && localStorage.getItem("studyos_ai_model") !== "local-9router") {
      localStorage.setItem("studyos_ai_model", "local-9router");
    }
  }, [localAiRouter.data?.enabled]);
  useEffect(() => {
    if (hydrated && sessions.length === 0) createSession();
    if (hydrated && sessions.length > 0 && !activeSessionId) setActiveSession(sessions[0].id);
  }, [hydrated, sessions.length, activeSessionId, createSession, setActiveSession]);
  useEffect(() => { if (!isCompact) setCompactPanel("chat"); }, [isCompact]);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  if (!hydrated || !activeSession) return <div className="study-loading"><span>StudyOS</span><i>Preparing a fresh study session</i></div>;

  const createAndFocus = () => { const id = createSession(); setActiveSession(id); };
  return (
    <div className={`flex flex-col overflow-hidden bg-background text-foreground ${isCompact ? "h-[100dvh] min-h-0" : "h-screen min-h-[600px]"}`}>
      <header className="study-workspace-header">
        <button type="button" onClick={() => setLocation("/")} className="group flex items-center gap-3 text-left"><span className="font-display text-2xl italic tracking-tight">StudyOS</span><span className="hidden border-l border-border pl-3 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground sm:inline">Learning Companion</span></button>
        <div className="flex items-center gap-2">{!isCompact && <><button type="button" onClick={() => setSourceVisible((value) => !value)} className="study-icon-button" aria-label="Toggle source panel">{sourceVisible ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}</button><button type="button" onClick={() => setWatchVisible((value) => !value)} className="study-icon-button" aria-label="Toggle watch panel">{watchVisible ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}</button></>}<ThemeShuffleButton /><WorkspaceProfileButton profile={profile} onOpenProfile={() => setLocation("/")} /></div>
      </header>
      <main className={`flex min-h-0 flex-1 flex-col ${isCompact ? "p-0" : "p-3 sm:p-4"}`}>
        {isCompact ? <section className="study-compact-workspace"><div className="flex min-h-0 flex-1 flex-col"><div className={compactPanel === "source" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><SourcePanel session={activeSession} /></div><div className={compactPanel === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><ChatPanel session={activeSession} onNewSession={createAndFocus} onOpenDashboard={() => setLocation("/")} onOpenSessions={() => setLocation("/sessions")} /></div><div className={compactPanel === "watch" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><WatchPanel session={activeSession} /></div></div><CompactWorkspaceNavigation activePanel={compactPanel} onChange={setCompactPanel} /></section> : <ResizablePanelGroup direction="horizontal" className="study-panel-group overflow-hidden rounded-2xl border border-border">
          {sourceVisible && <><ResizablePanel id="source-panel" order={1} defaultSize={22} minSize={17} className="min-h-0"><SourcePanel session={activeSession} /></ResizablePanel><ResizableHandle id="source-chat-handle" withHandle /></>}
          <ResizablePanel id="chat-panel" order={2} minSize={35} className="min-h-0"><ChatPanel session={activeSession} onNewSession={createAndFocus} onOpenDashboard={() => setLocation("/")} onOpenSessions={() => setLocation("/sessions")} /></ResizablePanel>
          {watchVisible && <><ResizableHandle id="chat-watch-handle" withHandle /><ResizablePanel id="watch-panel" order={3} defaultSize={25} minSize={19} className="min-h-0"><WatchPanel session={activeSession} /></ResizablePanel></>}
        </ResizablePanelGroup>}
      </main>
    </div>
  );
}

type AiActivityDetail = { id: string; label: string; pending: boolean; cancel?: () => void };

export function AiCancellationDock() {
  const sourceAi = useOptionalSourceAiActivity();
  const [activities, setActivities] = useState<Record<string, AiActivityDetail>>({});
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const sync = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as AiActivityDetail | undefined : undefined;
      if (!detail?.id) return;
      setActivities((current) => {
        const next = { ...current };
        if (detail.pending) next[detail.id] = detail;
        else delete next[detail.id];
        return next;
      });
    };
    window.addEventListener("studyos:ai-activity", sync);
    return () => window.removeEventListener("studyos:ai-activity", sync);
  }, []);
  const active = [...Object.values(activities), ...(sourceAi?.tasks.filter((task) => task.status === "pending").map((task) => ({ id: task.id, label: task.label, pending: true, cancel: () => sourceAi.cancelTask(task.id) })) ?? [])];
  useEffect(() => { if (active.length < 2) setExpanded(false); }, [active.length]);
  if (!active.length) return null;
  if (active.length === 1) return <div className="study-cancel-controls" aria-live="polite"><button type="button" onClick={active[0].cancel} className="study-cancel-dock-button"><X className="size-3.5" />Cancel {active[0].label}</button></div>;
  return <div className="study-cancel-controls" aria-live="polite">
    <button type="button" aria-label={`Manage ${active.length} AI tasks`} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="study-cancel-summary"><Loader2 className="size-3.5 animate-spin" />{active.length} AI tasks</button>
    {expanded && <div className="study-cancel-popover" role="status" aria-label="Active AI tasks">{active.map((activity) => <button key={activity.id} type="button" onClick={activity.cancel} className="study-cancel-dock-button"><X className="size-3.5" />Cancel {activity.label}</button>)}</div>}
  </div>;
}

function SourcePanelContent({ session }: { session: StudySession }) {
  const { addMaterial, deleteMaterial } = useStudyStore();
  const sourceAi = useSourceAiActivity();
  const [tab, setTab] = useState<"sources" | "read">("sources");
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(session.materials[0]?.id ?? null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [translateChat, setTranslateChat] = useState(false);
  const [translationTarget, setTranslationTarget] = useState<"english" | "indonesian">("english");
  const [translatePending, setTranslatePending] = useState(false);
  const [untranslatedMessageCount, setUntranslatedMessageCount] = useState(0);
  const [selection, setSelection] = useState("");
  const keyTermTask = sourceAi.tasks.find((task) => task.sessionId === session.id && task.kind === "key-term" && task.status === "review");
  const sourceError = sourceAi.tasks.find((task) => task.sessionId === session.id && task.status === "error");
  const keyTermDraft = keyTermTask?.draft ?? null;
  const setKeyTermDraft = (draft: KeyTermDraft | null) => { if (!draft && keyTermTask) sourceAi.discardTask(keyTermTask.id); };
  useEffect(() => { if (sourceError?.error) setError(sourceError.error); }, [sourceError?.error]);
  useEffect(() => { const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Element) || event.target.closest(".study-selection-popover")) return; setSelection(""); }; const dismissWithEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setSelection(""); }; document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", dismissWithEscape); return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", dismissWithEscape); }; }, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const explain = { isPending: sourceAi.isPending(session.id, "explain") };
  const draftKeyTerm = { isPending: sourceAi.isPending(session.id, "key-term") };
  const draftVocabulary = { isPending: sourceAi.isPending(session.id, "vocabulary") };
  const fetchSource = trpc.study.fetchSource.useMutation({
    onSuccess: ({ html, title, url: sourceUrl }) => {
      const content = extractText(html).slice(0, 50000);
      if (!content.trim()) { setError("No readable text was found at this URL. Try a different public page."); return; }
      addMaterial(session.id, { title, type: "url", url: sourceUrl, content });
      setUrl("");
      setTab("sources");
    },
    onError: (reason) => setError(reason.message),
  });
  const uploadDocument = trpc.study.uploadDocument.useMutation({
    onSuccess: ({ title, url: documentUrl, content, format }) => { addMaterial(session.id, { title, type: "file", url: documentUrl, content, format }); setTab("sources"); },
    onError: (reason) => setError(reason.message),
  });

  useEffect(() => { if (!session.materials.some((material) => material.id === selectedMaterialId)) setSelectedMaterialId(session.materials[0]?.id ?? null); }, [session.materials, selectedMaterialId]);
  useEffect(() => {
    const focusSource = (event: Event) => {
      const target = (event as CustomEvent<SourceFocusTarget>).detail;
      if (target.sessionId !== session.id || !session.materials.some((material) => material.id === target.materialId)) return;
      setSelectedMaterialId(target.materialId);
      window.location.hash = materialChunkDomId(target.materialId, target.ordinal);
      setTab("read");
    };
    window.addEventListener("studyos:focus-source", focusSource);
    return () => window.removeEventListener("studyos:focus-source", focusSource);
  }, [session.id, session.materials]);
  const selected = session.materials.find((material) => material.id === selectedMaterialId);
  const context = materialContext(session);

  const addUrl = () => { const candidate = url.trim(); if (!candidate || fetchSource.isPending) return; setError(""); fetchSource.mutate({ url: candidate }); };

  const maxDocumentBytes = import.meta.env.VITE_DEPLOY_TARGET === "vercel" ? 3_000_000 : 5_000_000;
  const maxDocumentLabel = import.meta.env.VITE_DEPLOY_TARGET === "vercel" ? "3 MB" : "5 MB";

  const addFile = async (file?: File) => {
    if (!file || uploadDocument.isPending) return; setError("");
    if (file.size > maxDocumentBytes) { setError(`Choose a PDF, DOCX, Markdown, CSV, or text file smaller than ${maxDocumentLabel}.`); return; }
    const mimeType = documentMimeType(file);
    if (!mimeType) { setError("Choose a PDF, DOCX, Markdown, CSV, or plain-text document."); return; }
    try { const dataUrl = await fileAsDataUrl(file); uploadDocument.mutate({ name: file.name, mimeType, dataUrl }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to read this file."); }
    finally { if (fileRef.current) fileRef.current.value = ""; }
  };

  const requestFromSelection = () => { const preferences = readAiSettings(); return { sessionId: session.id, sessionName: session.name, materials: materialContext(session, selection, preferences.responseStyle), responseStyle: preferences.responseStyle, model: preferences.model, selection: selection.trim() }; };
  const saveSelection = () => { if (!selection.trim() || draftKeyTerm.isPending) return; setError(""); sourceAi.startKeyTerm(requestFromSelection()); setSelection(""); };
  const saveVocabulary = () => { if (!selection.trim() || draftVocabulary.isPending) return; setError(""); sourceAi.startVocabulary(requestFromSelection()); setSelection(""); };
  const saveKeyTermDraft = (draft: KeyTermDraft) => { if (keyTermTask) sourceAi.saveKeyTerm(keyTermTask.id, draft); setSelection(""); };
  const explainSelection = () => { if (!selection.trim() || explain.isPending) return; setError(""); sourceAi.startExplain(requestFromSelection()); setSelection(""); };
  useEffect(() => {
    const syncTranslate = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if (typeof detail === "boolean") { setTranslateChat(detail); return; }
      if (detail && typeof detail === "object" && "active" in detail) {
        const next = detail as { active: boolean; target?: "english" | "indonesian" };
        setTranslateChat(next.active);
        if (next.target) setTranslationTarget(next.target);
        if (!next.active) setUntranslatedMessageCount(0);
      }
    };
    const syncPending = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if (detail && typeof detail === "object" && "pending" in detail) {
        const next = detail as { pending: boolean; target?: "english" | "indonesian"; untranslatedMessageCount?: number };
        setTranslatePending(next.pending);
        if (next.target) setTranslationTarget(next.target);
        if (typeof next.untranslatedMessageCount === "number") setUntranslatedMessageCount(next.untranslatedMessageCount);
      }
    };
    window.addEventListener("studyos:chat-translate", syncTranslate);
    window.addEventListener("studyos:chat-translation-status", syncPending);
    return () => { window.removeEventListener("studyos:chat-translate", syncTranslate); window.removeEventListener("studyos:chat-translation-status", syncPending); };
  }, []);
  const toggleTranslate = () => {
    if (translatePending) return;
    const nextTarget = translateChat && untranslatedMessageCount > 0 ? translationTarget : nextChatTranslationTarget(session.chatHistory, translateChat, translationTarget);
    setTranslateChat(true); setTranslationTarget(nextTarget); localStorage.setItem("studyos_translate_mode", "true"); localStorage.setItem("studyos_chat_translation_target", nextTarget);
    window.dispatchEvent(new CustomEvent("studyos:chat-translate", { detail: { active: true, target: nextTarget, request: true } }));
  };
  const nextTranslationTarget = translateChat && untranslatedMessageCount > 0 ? translationTarget : nextChatTranslationTarget(session.chatHistory, translateChat, translationTarget);
  const nextTranslationLabel = nextTranslationTarget === "english" ? "English" : "Indonesian";
  const translateButtonLabel = translateChat && untranslatedMessageCount > 0 ? `Translate new to ${nextTranslationLabel}` : `Translate to ${nextTranslationLabel}`;

  return <section className="study-panel study-source-panel"><PanelTitle title="Source" icon={<BookOpenText className="size-4" />} /><div className="space-y-2 p-3"><div className="flex gap-2"><Input value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addUrl(); }} placeholder="Paste a URL" className="h-10 rounded-xl border-border bg-secondary text-sm" /><Button onClick={addUrl} disabled={fetchSource.isPending || !url.trim()} size="icon" className="h-10 w-10 rounded-xl bg-primary text-primary-foreground">{fetchSource.isPending ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}</Button></div><div className="grid grid-cols-2 gap-2"><Button variant="outline" onClick={addUrl} disabled={fetchSource.isPending || !url.trim()} className="rounded-xl border-border bg-transparent text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"><FolderPlus className="mr-2 size-3.5" />Fetch</Button><Button variant="outline" disabled={uploadDocument.isPending} onClick={() => fileRef.current?.click()} className="rounded-xl border-border bg-transparent text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">{uploadDocument.isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Upload className="mr-2 size-3.5" />}{uploadDocument.isPending ? "Importing" : "File"}</Button><input ref={fileRef} type="file" accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/plain,text/markdown,text/csv,.txt,.md,.csv" className="hidden" onChange={(event) => void addFile(event.target.files?.[0])} /></div><p className="px-1 text-[10px] leading-relaxed text-muted-foreground">PDF, DOCX, Markdown, CSV, and text · up to {maxDocumentLabel}</p>{error && <p className="rounded-xl border border-[#BA2D0B]/40 bg-[#BA2D0B]/10 p-2 text-xs leading-relaxed text-[#EEF1EF]">{error}</p>}</div><div className="min-h-0 flex-1 px-3 pb-3">{tab === "sources" ? <ScrollArea className="h-full pr-2">{session.materials.length ? <div className="space-y-2">{session.materials.map((material) => <div key={material.id} className={`study-material-row ${selectedMaterialId === material.id ? "is-selected" : ""}`}><button type="button" onClick={() => { setSelectedMaterialId(material.id); setTab("read"); }} className="flex min-w-0 flex-1 items-center gap-2 text-left"><FileText className="size-4 shrink-0 text-[#BA2D0B]" /><span className="min-w-0 flex-1"><span title={material.title} className="study-material-title block text-xs">{material.title}</span>{material.sourceDomain ? <span className="block truncate pt-0.5 text-[9px] text-muted-foreground">{material.sourceDomain}</span> : null}</span>{material.format && <span className="font-mono text-[8px] tracking-wide text-muted-foreground">{material.format}</span>}</button><button type="button" onClick={() => deleteMaterial(session.id, material.id)} aria-label={`Delete ${material.title}`} className="study-inline-delete"><X className="size-3.5" /></button></div>)}</div> : <EmptyPanel text="Add a public link or import a document to start reading." />}</ScrollArea> : <ReadMaterial material={selected} vocabulary={session.vocabulary.map((entry) => entry.term)} onSelect={(text) => setSelection(text)} />}</div><div className="border-t border-border px-3 py-3"><div className="flex rounded-xl bg-secondary p-1"><button type="button" onClick={() => setTab("sources")} className={`study-tab ${tab === "sources" ? "is-active" : ""}`}>Sources</button><button type="button" onClick={() => setTab("read")} className={`study-tab ${tab === "read" ? "is-active" : ""}`}>Read</button></div><button type="button" disabled={translatePending} onClick={toggleTranslate} className={`study-translate-button ${translateChat ? "is-on" : ""}`}><span className="inline-flex items-center gap-2">{translatePending ? <Loader2 className="size-3.5 animate-spin" /> : <Languages className="size-3.5" />}{translatePending ? `Translating to ${translationTarget === "english" ? "English" : "Indonesian"}…` : translateButtonLabel}</span></button></div>{selection && <div className="study-selection-popover"><span className="line-clamp-1">{selection}</span><div className="flex flex-wrap gap-1"><button type="button" disabled={draftKeyTerm.isPending} onClick={saveSelection}>{draftKeyTerm.isPending ? "Drafting…" : "Save terms"}</button><button type="button" disabled={draftVocabulary.isPending} onClick={saveVocabulary}>{draftVocabulary.isPending ? "Saving…" : "Save vocab"}</button><button type="button" disabled={explain.isPending} onClick={explainSelection}>{explain.isPending ? "Thinking…" : "Explain"}</button></div></div>}<KeyTermEditor draft={keyTermDraft} onClose={() => setKeyTermDraft(null)} onSave={saveKeyTermDraft} /></section>;
}

type SourceSearchScope = "web" | "academic";
type SourceSearchResult = { id: string; scope: SourceSearchScope; title: string; url: string; summary: string; metadata: string };

function SourceSearchDialog({ session }: { session: StudySession }) {
  const { addMaterial } = useStudyStore();
  const selectedResultRef = useRef<SourceSearchResult | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SourceSearchScope>("web");
  const [results, setResults] = useState<SourceSearchResult[]>([]);
  const [addedResultIds, setAddedResultIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");
  const searchSources = trpc.study.searchSources.useMutation({
    onSuccess: ({ results: nextResults }) => { setResults(nextResults); if (!nextResults.length) setError("No sources found. Try a different topic or phrase."); },
    onError: (reason) => setError(reason.message),
  });
  const fetchSource = trpc.study.fetchSource.useMutation({
    onSuccess: ({ html, title, url }) => {
      const content = extractText(html).slice(0, 50_000);
      if (!content.trim()) { setError("This source did not return readable text. Try another result."); return; }
      const selectedResult = selectedResultRef.current;
      selectedResultRef.current = null;
      addMaterial(session.id, { title: selectedResult?.title || title, type: "url", url, content, ...(selectedResult ? { sourceDomain: displaySourceDomain(selectedResult.url) } : {}) });
      if (selectedResult) setAddedResultIds((current) => new Set([...Array.from(current), selectedResult.id]));
      setError("");
    },
    onError: (reason) => { selectedResultRef.current = null; setError(reason.message); },
  });
  const search = () => {
    const term = query.trim();
    if (term.length < 2 || searchSources.isPending) return;
    setError(""); setResults([]); setAddedResultIds(new Set()); searchSources.mutate({ query: term, scope });
  };
  const selectResult = (result: SourceSearchResult) => {
    if (fetchSource.isPending || addedResultIds.has(result.id)) return;
    selectedResultRef.current = result;
    setError(""); fetchSource.mutate({ url: result.url });
  };
  const busy = searchSources.isPending || fetchSource.isPending;
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label="Search sources" className="study-icon-button absolute right-3 top-1 z-10" title="Search sources"><Compass className="size-4" /></button>
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!busy) setOpen(nextOpen); }}>
      <DialogContent className="max-h-[82vh] max-w-lg overflow-hidden rounded-2xl border-border bg-card p-0 text-card-foreground">
        <DialogHeader className="border-b border-border px-5 pb-4 pt-5"><DialogTitle className="font-display text-xl italic">Find a source</DialogTitle><DialogDescription>Search the web or academic papers, then choose one to add to this session.</DialogDescription></DialogHeader>
        <div className="space-y-3 p-5"><div className="flex rounded-xl bg-secondary p-1"><button type="button" onClick={() => { setScope("web"); setResults([]); setAddedResultIds(new Set()); setError(""); }} className={`study-tab ${scope === "web" ? "is-active" : ""}`}>Web</button><button type="button" onClick={() => { setScope("academic"); setResults([]); setAddedResultIds(new Set()); setError(""); }} className={`study-tab ${scope === "academic" ? "is-active" : ""}`}>Academic</button></div><form onSubmit={(event) => { event.preventDefault(); search(); }} className="flex gap-2"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={scope === "web" ? "Search a topic, guide, or article" : "Search papers, journals, or researchers"} className="h-10 rounded-xl border-border bg-secondary text-sm" autoFocus /><Button type="submit" disabled={busy || query.trim().length < 2} className="h-10 rounded-xl px-3">{searchSources.isPending ? <Loader2 className="size-4 animate-spin" /> : <><Search className="mr-1.5 size-4" />Search</>}</Button></form><p className="px-1 text-[10px] leading-relaxed text-muted-foreground">{scope === "web" ? "Web search uses Tavily Basic and returns up to 5 results." : "Academic search uses OpenAlex and returns up to 5 papers."}</p>{error ? <p role="alert" className="rounded-xl border border-[#BA2D0B]/40 bg-[#BA2D0B]/10 p-2 text-xs leading-relaxed text-[#EEF1EF]">{error}</p> : null}<div data-testid="source-search-results" className="study-source-search-results h-[38vh] min-h-0 overflow-y-auto pr-2">{results.length ? <div className="space-y-2">{results.map((result) => { const added = addedResultIds.has(result.id); const adding = fetchSource.isPending && selectedResultRef.current?.id === result.id; return <article key={result.id} className="rounded-xl border border-border bg-secondary/40 p-3"><div className="flex gap-3"><div className="min-w-0 flex-1"><p className="line-clamp-2 text-sm font-semibold leading-snug">{result.title}</p><p className="mt-1 text-[10px] text-muted-foreground">{result.metadata}</p><p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{result.summary}</p></div></div><div className="mt-3 flex items-center justify-between gap-2"><a href={result.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">Open <ExternalLink className="size-3" /></a><Button size="sm" onClick={() => selectResult(result)} disabled={busy || added} className="h-8 rounded-lg px-3 text-xs">{adding ? <Loader2 className="size-3.5 animate-spin" /> : added ? "Added" : "Add source"}</Button></div></article>; })}</div> : !searchSources.isPending && !error ? <div className="rounded-xl border border-dashed border-border p-5 text-center text-xs leading-relaxed text-muted-foreground">Search for a topic, then choose a result to add as a source.</div> : null}</div></div>
      </DialogContent>
    </Dialog>
  </>;
}

export function SourcePanel({ session }: { session: StudySession }) {
  return <div className="relative h-full min-h-0"><SourcePanelContent session={session} /><SourceSearchDialog session={session} /></div>;
}

export function ChatPanel({ session, onNewSession, onOpenDashboard, onOpenSessions }: { session: StudySession; onNewSession: () => void; onOpenDashboard: () => void; onOpenSessions?: () => void }) {
  const { profile, updateSession, deleteSession, addMessage } = useStudyStore();
  const sourceAi = useOptionalSourceAiActivity();
  const translateChatMessages = trpc.study.translateChat.useMutation();
  const aiName = profile.aiName?.trim() || "StudyOS";
  const [input, setInput] = useState(""); const [renaming, setRenaming] = useState(false); const [menuOpen, setMenuOpen] = useState(false); const [error, setError] = useState(""); const [translationError, setTranslationError] = useState(""); const [translationRequestVersion, setTranslationRequestVersion] = useState(0); const [translationProgress, setTranslationProgress] = useState<ChatTranslationProgress | null>(null); const [streaming, setStreaming] = useState(false); const [streamRecovery, setStreamRecovery] = useState(false); const [streamedText, setStreamedText] = useState(""); const [streamProvider, setStreamProvider] = useState("");
  const followLatestRef = useRef(true); const pendingScrollRef = useRef(false); const composerRef = useRef<HTMLTextAreaElement | null>(null); const streamedTextRef = useRef(""); const streamProviderRef = useRef(""); const streamRecoveryRef = useRef(false); const streamAbortRef = useRef<AbortController | null>(null); const chatRunRef = useRef(0); const translationRunRef = useRef(0); const translatingIdsRef = useRef(new Set<string>()); const translationFailuresRef = useRef(new Set<string>());
  const [translateChat, setTranslateChat] = useState(false);
  const [translationTarget, setTranslationTarget] = useState<"english" | "indonesian">("english");
  const [translatedMessages, setTranslatedMessages] = useState<ChatTranslationCache>(emptyChatTranslationCache);
  const emptyTranslations = useMemo(emptyChatTranslationCache, []);
  const savedTranslations = sourceAi ? sourceAi.chatTranslationsFor(session.id) : emptyTranslations;
  const backgroundTranslationProgress = sourceAi?.chatTranslationProgressFor(session.id) ?? null;
  const storedTranslationTarget = sourceAi?.chatTranslationTarget(session.id) ?? null;
  const translationCache = useMemo(() => ({ english: { ...savedTranslations.english, ...translatedMessages.english }, indonesian: { ...savedTranslations.indonesian, ...translatedMessages.indonesian } }), [savedTranslations, translatedMessages]);
  const translationPending = sourceAi ? sourceAi.isPending(session.id, "chat-translation") : translateChatMessages.isPending;
  const activeTranslationProgress = backgroundTranslationProgress ?? translationProgress;
  const translationBusy = translationPending || activeTranslationProgress !== null;
  const translationProgressCompleted = useMemo(() => activeTranslationProgress ? activeTranslationProgress.messageIds.filter((id) => Boolean(translationCache[activeTranslationProgress.target][id])).length : 0, [translationCache, activeTranslationProgress]);
  const translationPercent = activeTranslationProgress ? Math.round((translationProgressCompleted / activeTranslationProgress.messageIds.length) * 100) : 0;
  const untranslatedMessageCount = translateChat ? session.chatHistory.filter((message) => message.content.trim() && !translationCache[translationTarget][message.id]).length : 0;
  useEffect(() => { if (!menuOpen) return; const dismiss = (event: PointerEvent) => { if (event.target instanceof Element && event.target.closest(".study-menu, [aria-label='Session menu']")) return; setMenuOpen(false); }; const dismissWithEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); }; document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", dismissWithEscape); return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", dismissWithEscape); }; }, [menuOpen]);
  useEffect(() => {
    const focusComposer = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || document.querySelector("[role='dialog']")) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement || (active instanceof HTMLElement && (active.isContentEditable || active.getAttribute("role") === "textbox"))) return;
      event.preventDefault();
      composerRef.current?.focus();
    };
    window.addEventListener("keydown", focusComposer);
    return () => window.removeEventListener("keydown", focusComposer);
  }, []);
  const saveAssistantResponse = (response: { text: string; citations: Array<{ title: string; ordinal: number }>; truncated: boolean; provider?: string }) => addMessage(session.id, { role: "assistant", content: response.text, citations: attachMaterialIds(session, response.citations), truncated: response.truncated, ...(response.provider ? { provider: response.provider } : {}) });
  const friendlyChatError = (message: string) => /(?:Respons Chat belum tersedia karena kuota AI provider|Google Gemini sedang membatasi request|Google Gemini sedang tidak tersedia)/i.test(message) ? message : /too_big|too_small|expected string|materials|history/i.test(message) ? "Konteks chat terlalu besar atau belum lengkap. StudyOS sudah merapikannya—silakan kirim ulang pesanmu." : "Respons AI belum bisa diproses. Coba kirim ulang atau periksa AI Settings.";
  const friendlyTranslationError = (message: string) => /(?:Penerjemahan Chat tidak tersedia karena kuota AI provider|Google Gemini sedang membatasi request|Google Gemini sedang tidak tersedia)/i.test(message) ? message : "Penerjemahan sedang tidak tersedia. Teks asli tetap aman—coba lagi beberapa saat lagi atau gunakan provider AI lain.";
  const clearStreamPreview = () => { setStreaming(false); setStreamRecovery(false); setStreamedText(""); setStreamProvider(""); streamedTextRef.current = ""; streamProviderRef.current = ""; streamRecoveryRef.current = false; };
  const chat = trpc.study.chat.useMutation();
  const continueAnswer = trpc.study.continue.useMutation({ onSuccess: saveAssistantResponse, onError: (reason) => setError(friendlyChatError(reason.message)) });
  useEffect(() => {
    const syncChatTranslate = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if (typeof detail === "boolean") { setTranslateChat(detail); return; }
      if (detail && typeof detail === "object" && "active" in detail) {
        const next = detail as { active: boolean; target?: "english" | "indonesian"; request?: boolean };
        setTranslateChat(next.active);
        if (next.target) setTranslationTarget(next.target);
        if (next.request && next.active) { translationFailuresRef.current.clear(); setTranslationError(""); setTranslationRequestVersion((value) => value + 1); }
        return;
      }
      setTranslateChat(localStorage.getItem("studyos_translate_mode") === "true");
    };
    window.addEventListener("studyos:chat-translate", syncChatTranslate);
    window.addEventListener("storage", syncChatTranslate);
    return () => { window.removeEventListener("studyos:chat-translate", syncChatTranslate); window.removeEventListener("storage", syncChatTranslate); };
  }, []);
  useEffect(() => {
    const syncTranslationResult = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { sessionId?: string; translations?: { english?: Array<{ id: string; content: string }>; indonesian?: Array<{ id: string; content: string }> } } | undefined : undefined;
      const translations = detail?.translations;
      if (detail?.sessionId !== session.id || !translations) return;
      setTranslatedMessages((current) => ({
        english: { ...current.english, ...Object.fromEntries((translations.english ?? []).map((item) => [item.id, item.content])) },
        indonesian: { ...current.indonesian, ...Object.fromEntries((translations.indonesian ?? []).map((item) => [item.id, item.content])) },
      }));
    };
    window.addEventListener("studyos:chat-translation-result", syncTranslationResult);
    return () => window.removeEventListener("studyos:chat-translation-result", syncTranslationResult);
  }, [session.id]);
  useEffect(() => { setTranslatedMessages(emptyChatTranslationCache()); setTranslationProgress(null); translatingIdsRef.current.clear(); translationFailuresRef.current.clear(); setTranslationError(""); setTranslationRequestVersion(0); }, [session.id]);
  useEffect(() => { if (storedTranslationTarget) { setTranslateChat(true); setTranslationTarget(storedTranslationTarget); } }, [session.id, storedTranslationTarget]);
  useEffect(() => { const sourceError = sourceAi?.chatTranslationError(session.id); if (sourceError) { setTranslationError(friendlyTranslationError(sourceError)); setTranslationProgress(null); setTranslationRequestVersion(0); } }, [session.id, sourceAi, sourceAi?.chatTranslationError(session.id)]);
  useEffect(() => {
    if (!translateChat || translationRequestVersion === 0 || translationProgress) return;
    const messageIds = session.chatHistory.filter((message) => message.content.trim() && !translationCache[translationTarget][message.id] && !translationFailuresRef.current.has(message.id)).map((message) => message.id);
    if (messageIds.length) setTranslationProgress({ target: translationTarget, messageIds });
    else setTranslationRequestVersion(0);
  }, [translateChat, translationRequestVersion, translationProgress, translationTarget, translationCache, session.chatHistory]);
  useEffect(() => {
    if (!translationProgress || translationProgressCompleted < translationProgress.messageIds.length) return;
    const timer = window.setTimeout(() => { setTranslationProgress(null); setTranslationRequestVersion(0); }, 260);
    return () => window.clearTimeout(timer);
  }, [translationProgress, translationProgressCompleted]);
  useEffect(() => {
    if (!translateChat || translationRequestVersion === 0) return;
    const missing = session.chatHistory.filter((message) => message.content.trim() && !translationCache[translationTarget][message.id] && !translatingIdsRef.current.has(message.id) && !translationFailuresRef.current.has(message.id));
    if (!missing.length) return;
    const preferences = readAiSettings();
    if (sourceAi) { sourceAi.startChatTranslation({ sessionId: session.id, sessionName: session.name, model: preferences.model, target: translationTarget, messages: missing.map(({ id, content }) => ({ id, content })) }); return; }
    const batch = missing.slice(0, 6);
    const run = translationRunRef.current;
    batch.forEach((message) => translatingIdsRef.current.add(message.id));
    void translateChatMessages.mutateAsync({ model: preferences.model, target: translationTarget, messages: batch.map(({ id, content }) => ({ id, content })) })
      .then(({ translations }) => { if (run !== translationRunRef.current) return; setTranslatedMessages((current) => ({ english: { ...current.english, ...Object.fromEntries(translations.english.map((item) => [item.id, item.content])) }, indonesian: { ...current.indonesian, ...Object.fromEntries(translations.indonesian.map((item) => [item.id, item.content])) } })); setTranslationError(""); })
      .catch((reason: unknown) => {
        if (run !== translationRunRef.current) return;
        batch.forEach((message) => translationFailuresRef.current.add(message.id));
        setTranslateChat(false); localStorage.setItem("studyos_translate_mode", "false");
        window.dispatchEvent(new CustomEvent("studyos:chat-translate", { detail: { active: false, target: translationTarget } }));
        setTranslationProgress(null); setTranslationRequestVersion(0); setTranslationError(friendlyTranslationError(reason instanceof Error ? reason.message : ""));
      })
      .finally(() => batch.forEach((message) => translatingIdsRef.current.delete(message.id)));
  }, [translateChat, translationTarget, translationCache, translateChatMessages.mutateAsync, translationRequestVersion, sourceAi, session.id, session.name]);
  useEffect(() => { window.dispatchEvent(new CustomEvent("studyos:chat-translation-status", { detail: { pending: translationBusy, target: translationTarget, untranslatedMessageCount } })); }, [translationBusy, translationTarget, untranslatedMessageCount]);
  const streamChat = async (payload: { sessionName: string; materials: string; translate: boolean; responseStyle: "Fast" | "Balanced" | "Deep" | "Concise" | "Detailed"; model: "gpt-5-mini" | "claude-haiku-4-5" | "gemini-3-flash-preview" | "local-9router"; aiName: string; history: Array<{ role: "user" | "assistant"; content: string }>; continueAnswer?: boolean; resumePrefix?: string }) => {
    const run = ++chatRunRef.current;
    const controller = new AbortController();
    streamAbortRef.current = controller;
    setStreaming(true); setStreamRecovery(false); if (payload.resumePrefix) { setStreamedText(payload.resumePrefix); streamedTextRef.current = payload.resumePrefix; } else { setStreamedText(""); streamedTextRef.current = ""; } setStreamProvider(""); streamProviderRef.current = ""; streamRecoveryRef.current = false;
    try {
      const response = await fetch("/api/study/chat-stream", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", signal: controller.signal, body: JSON.stringify(payload) });
      if (!response.ok || !response.body) throw new Error("Streaming is unavailable.");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      let complete = false;
      while (!complete) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n"); buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const type = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
          const raw = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!type || !raw) continue;
          const data = JSON.parse(raw) as { token?: string; provider?: string; text?: string; citations?: Array<{ title: string; ordinal: number }>; truncated?: boolean; message?: string };
          if (type === "meta" && data.provider) { streamProviderRef.current = data.provider; setStreamProvider(data.provider); }
          if (type === "token" && data.token) { streamedTextRef.current += data.token; setStreamedText((value) => value + data.token); pendingScrollRef.current = true; }
          if (type === "done" && data.text !== undefined) { if (run === chatRunRef.current) saveAssistantResponse({ text: payload.resumePrefix ? `${payload.resumePrefix}\n\n${data.text}` : data.text, citations: data.citations ?? [], truncated: data.truncated ?? false, provider: data.provider }); complete = true; }
          if (type === "error") throw new Error(data.message ?? "StudyOS could not stream this response.");
        }
      }
      if (!complete) throw new Error("The streamed response ended too early.");
    } catch (reason) {
      if (run !== chatRunRef.current || (reason instanceof DOMException && reason.name === "AbortError")) return;
      const streamMessage = reason instanceof Error ? reason.message : "";
      if (/Google Gemini sedang (?:membatasi request|tidak tersedia)/i.test(streamMessage)) { clearStreamPreview(); setError(friendlyChatError(streamMessage)); return; }
      if (streamedTextRef.current.trim() && !payload.continueAnswer) { const partialText = streamedTextRef.current.trim(); streamRecoveryRef.current = true; setStreamRecovery(true); await streamChat({ ...payload, history: [...payload.history, { role: "assistant", content: partialText }], continueAnswer: true, resumePrefix: partialText }); return; }
      chat.mutate(payload, { onSuccess: (response) => { if (run !== chatRunRef.current) return; saveAssistantResponse(response); clearStreamPreview(); }, onError: (error) => { if (run !== chatRunRef.current) return; const partialText = streamedTextRef.current.trim(); if (streamRecoveryRef.current && partialText) saveAssistantResponse({ text: partialText, citations: [], truncated: true, ...(streamProviderRef.current ? { provider: streamProviderRef.current } : {}) }); clearStreamPreview(); setError(friendlyChatError(error.message)); } });
    } finally {
      if (run === chatRunRef.current) { streamAbortRef.current = null; setStreaming(false); if (!streamRecoveryRef.current) { setStreamedText(""); setStreamProvider(""); streamedTextRef.current = ""; streamProviderRef.current = ""; } }
    }
  };
  const chatViewport = () => document.querySelector<HTMLElement>(".study-chat-panel [data-slot='scroll-area-viewport']");
  const scrollToLatest = (behavior: ScrollBehavior = "smooth") => { const viewport = chatViewport(); if (!viewport) return; followLatestRef.current = true; window.requestAnimationFrame(() => { if (typeof viewport.scrollTo === "function") viewport.scrollTo({ top: viewport.scrollHeight, behavior }); else viewport.scrollTop = viewport.scrollHeight; }); };
  useEffect(() => { followLatestRef.current = true; pendingScrollRef.current = true; }, [session.id]);
  useEffect(() => { const viewport = chatViewport(); if (!viewport) return; const updateFollowState = () => { followLatestRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 72; }; updateFollowState(); viewport.addEventListener("scroll", updateFollowState, { passive: true }); return () => viewport.removeEventListener("scroll", updateFollowState); }, [session.id]);
  useEffect(() => { if (!followLatestRef.current && !pendingScrollRef.current) return; scrollToLatest(pendingScrollRef.current ? "smooth" : "auto"); pendingScrollRef.current = false; }, [session.id, session.chatHistory.length, chat.isPending, continueAnswer.isPending, streaming, streamRecovery, streamedText]);
  const compactHistory = (history: Array<{ role: "user" | "assistant"; content: string }>) => history.filter((message) => message.content.trim().length > 0).slice(-30).map(({ role, content }) => ({ role, content: content.trim().slice(0, 6_000) }));
  const safeMaterials = (query: string, responseStyle: "Fast" | "Balanced" | "Deep" | "Concise" | "Detailed") => materialContext(session, query, responseStyle).slice(0, 10_000);
  const send = () => { const content = input.trim(); if (!content || chat.isPending || continueAnswer.isPending || streaming || streamRecovery) return; const preferences = readAiSettings(); const payload = { sessionName: session.name, materials: safeMaterials(content, preferences.responseStyle), translate: false, responseStyle: preferences.responseStyle, model: preferences.model, aiName, history: [...compactHistory(session.chatHistory.slice(-29)), { role: "user" as const, content }] }; setError(""); pendingScrollRef.current = true; addMessage(session.id, { role: "user", content }); setInput(""); scrollToLatest(); pendingScrollRef.current = false; void streamChat(payload); };
  const continueTruncatedAnswer = () => { if (chat.isPending || streaming || streamRecovery) return; const preferences = readAiSettings(); const priorQuestion = [...session.chatHistory].reverse().find((message) => message.role === "user")?.content ?? ""; setError(""); pendingScrollRef.current = true; scrollToLatest(); pendingScrollRef.current = false; void streamChat({ sessionName: session.name, materials: safeMaterials(priorQuestion, preferences.responseStyle), translate: false, responseStyle: preferences.responseStyle, model: preferences.model, aiName, history: compactHistory(session.chatHistory.slice(-30)), continueAnswer: true }); };
  const toggleChatTranslation = () => {
    if (translationBusy) return;
    const nextTarget = translateChat && untranslatedMessageCount > 0 ? translationTarget : nextChatTranslationTarget(session.chatHistory, translateChat, translationTarget);
    translationFailuresRef.current.clear(); sourceAi?.clearChatTranslationErrors(session.id); setTranslationError(""); setTranslateChat(true); setTranslationTarget(nextTarget); setTranslationRequestVersion((value) => value + 1); localStorage.setItem("studyos_translate_mode", "true"); localStorage.setItem("studyos_chat_translation_target", nextTarget);
    window.dispatchEvent(new CustomEvent("studyos:chat-translate", { detail: { active: true, target: nextTarget } }));
  };
  const retryTranslation = () => { if (translationBusy) return; translationFailuresRef.current.clear(); sourceAi?.clearChatTranslationErrors(session.id); setTranslationError(""); setTranslationProgress(null); setTranslateChat(true); setTranslationRequestVersion((value) => value + 1); localStorage.setItem("studyos_translate_mode", "true"); window.dispatchEvent(new CustomEvent("studyos:chat-translate", { detail: { active: true, target: translationTarget } })); };
  const cancelTranslation = () => { translationRunRef.current += 1; setTranslationProgress(null); setTranslationRequestVersion(0); translatingIdsRef.current.clear(); if (sourceAi) sourceAi.cancelChatTranslation(session.id); else translateChatMessages.reset(); setTranslateChat(false); setTranslationError(""); localStorage.setItem("studyos_translate_mode", "false"); window.dispatchEvent(new CustomEvent("studyos:chat-translate", { detail: { active: false, target: translationTarget } })); };
  const cancelChatResponse = () => { chatRunRef.current += 1; streamAbortRef.current?.abort(); streamAbortRef.current = null; chat.reset(); clearStreamPreview(); setError(""); };
  useEffect(() => { if (!sourceAi) window.dispatchEvent(new CustomEvent("studyos:ai-activity", { detail: { id: "translate", label: "Translate", pending: translateChatMessages.isPending, cancel: cancelTranslation } })); }, [sourceAi, translateChatMessages.isPending]);
  useEffect(() => { window.dispatchEvent(new CustomEvent("studyos:ai-activity", { detail: { id: "chat", label: "AI response", pending: streaming || chat.isPending || streamRecovery, cancel: cancelChatResponse } })); }, [streaming, chat.isPending, streamRecovery]);
  const nextTranslationTarget = translateChat && untranslatedMessageCount > 0 ? translationTarget : nextChatTranslationTarget(session.chatHistory, translateChat, translationTarget);
  const nextTranslationLabel = nextTranslationTarget === "english" ? "English" : "Indonesian";
  const translateButtonLabel = translateChat && untranslatedMessageCount > 0 ? `Translate new to ${nextTranslationLabel}` : `To ${nextTranslationLabel}`;
  const exportNotes = () => { const text = session.notes.map((note) => `# ${note.name}\n\n${plainText(note.content)}`).join("\n\n---\n\n") || "No notes yet."; const url = URL.createObjectURL(new Blob([text], { type: "text/plain" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${session.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-notes.txt`; anchor.click(); URL.revokeObjectURL(url); setMenuOpen(false); };
  return (
    <section className="study-panel study-chat-panel">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          {renaming ? <input autoFocus value={session.name} onChange={(event) => updateSession(session.id, { name: event.target.value })} onBlur={() => setRenaming(false)} onKeyDown={(event) => { if (event.key === "Enter") setRenaming(false); }} className="w-full font-display text-xl italic outline-none" /> : <button type="button" onClick={() => setRenaming(true)} className="max-w-full truncate text-left font-display text-xl italic hover:text-muted-foreground">{session.name}</button>}
        </div>
        <button type="button" disabled={translationBusy} onClick={toggleChatTranslation} aria-label={`Translate chat to ${nextTranslationLabel}`} aria-pressed={translateChat} className={`study-mobile-chat-translate ${translateChat ? "is-on" : ""}`}>{translationBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Languages className="size-3.5" />}<span>{translationBusy ? "Translating…" : translateButtonLabel}</span></button>
        <div className="relative">
          <button type="button" aria-label="Session menu" onClick={() => setMenuOpen((value) => !value)} className="study-icon-button"><MoreHorizontal className="size-4" /></button>
          {menuOpen && <div className="study-menu">
            <button type="button" onClick={() => { onNewSession(); setMenuOpen(false); }}><Plus className="size-3.5" />New session</button>
            <button type="button" onClick={() => { (onOpenSessions ?? onOpenDashboard)(); setMenuOpen(false); }}><FolderOpen className="size-3.5" />Change session</button>
            <button type="button" onClick={exportNotes}><FileText className="size-3.5" />Export notes</button>
            <button type="button" onClick={() => { if (window.confirm("Delete this session and all of its study data?")) { deleteSession(session.id); setMenuOpen(false); } }} className="text-[#BA2D0B]"><Trash2 className="size-3.5" />Delete session</button>
          </div>}
        </div>
        </div>
        {activeTranslationProgress !== null ? <div role="status" aria-live="polite" className="study-translation-progress"><div role="progressbar" aria-label="Translation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={translationPercent} className="study-translation-progress-track"><i style={{ width: `${translationPercent}%` }} /></div><strong>{translationPercent}%</strong></div> : null}
      <ScrollArea className="study-chat-scroll-area h-0 min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-5 p-5 sm:p-8">
          {session.chatHistory.length ? session.chatHistory.map((message, index) => {
            const content = translateChat ? translationCache[translationTarget][message.id] ?? message.content : message.content;
            return <div key={message.id} className={`study-chat-message ${message.role === "user" ? "is-user" : "is-ai"}`}>
              {message.role === "assistant" && <span className="study-ai-label">{aiName}</span>}
              <div className="study-message-bubble min-w-0 w-fit max-w-[calc(100%-1rem)]">{message.role === "assistant" ? <ChatMarkdown content={content} /> : <span className="whitespace-pre-wrap">{content}</span>}</div>
              {message.role === "assistant" && message.provider ? <p data-testid="ai-provider-label" className="mt-2 font-mono text-[9px] uppercase tracking-[0.11em] text-muted-foreground">Used: {message.provider}</p> : null}
              {message.role === "assistant" && message.citations?.length ? <CitationChips citations={message.citations} sessionId={session.id} /> : null}
              {message.role === "assistant" && message.truncated && index === session.chatHistory.length - 1 ? <button type="button" onClick={continueTruncatedAnswer} disabled={continueAnswer.isPending || chat.isPending || streaming || streamRecovery} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-primary/45 bg-primary/10 px-2.5 py-1.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"><ChevronRight className="size-3.5" />{continueAnswer.isPending ? "Continuing…" : "Continue answer"}</button> : null}
            </div>;
          }) : <div className="flex flex-1 flex-col items-center justify-center text-center"><span className="font-display text-4xl italic text-muted-foreground">Ask anything.</span><p className="mt-3 max-w-xs text-xs leading-relaxed text-muted-foreground">StudyOS will use your source material whenever you add it to this session.</p></div>}
          {(chat.isPending || continueAnswer.isPending || streaming || streamRecovery) && <div className="study-chat-message is-ai"><span className="study-ai-label">{aiName}</span><div className="study-message-bubble min-w-0 w-fit max-w-[calc(100%-1rem)]">{streamedText ? <ChatMarkdown content={streamedText} /> : <span className="study-thinking"><i /><i /><i /></span>}</div>{streamProvider ? <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.11em] text-muted-foreground">Using: {streamProvider}</p> : null}</div>}
          {translationError && <p role="alert" className="rounded-xl border border-[#BA2D0B]/40 bg-[#BA2D0B]/10 p-3 text-xs text-[#EEF1EF]">{translationError} <button type="button" onClick={retryTranslation} className="underline underline-offset-2">Try translation again</button></p>}
          {error && <p className="rounded-xl border border-[#BA2D0B]/40 bg-[#BA2D0B]/10 p-3 text-xs text-[#EEF1EF]">{error} <button type="button" onClick={onOpenDashboard} className="underline underline-offset-2">Review AI settings</button></p>}
        </div>
      </ScrollArea>
      <div className="study-chat-composer"><div className={`study-chat-input-shell ${input ? "has-value" : ""}`}><textarea ref={composerRef} rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="Ask Anything" aria-label="Ask StudyOS" /><div className="study-chat-composer-actions"><AiCancellationDock /><button type="button" onClick={send} disabled={!input.trim() || chat.isPending || continueAnswer.isPending || streaming || streamRecovery} aria-label="Send message"><Send className="size-4" /></button></div></div></div>
    </section>
  );
}

export function WatchPanel({ session }: { session: StudySession }) {
  const { updateSession, saveQuizResult, addNote, updateNote, deleteNote, reviewVocabulary } = useStudyStore();
  const sourceAi = useSourceAiActivity();
  const watchTimer = useWatchTimer();
  const preferences = readAiSettings();
  const [openQuiz, setOpenQuiz] = useState<Quiz | null>(null);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [previewTerm, setPreviewTerm] = useState<VocabItem | null>(null);
  const [hoveredTermId, setHoveredTermId] = useState<string | null>(null);
  const [quizSettingsOpen, setQuizSettingsOpen] = useState(false);
  const [quizSettings, setQuizSettings] = useState<QuizGenerationSettings>(defaultQuizGenerationSettings);
  const quiz = { isPending: sourceAi.isPending(session.id, "quiz") };
  const quizError = sourceAi.tasks.find((task) => task.sessionId === session.id && task.kind === "quiz" && task.status === "error")?.error ?? "";
  const generateQuiz = (settings: QuizGenerationSettings | React.MouseEvent<HTMLButtonElement> = quizSettings) => { if ("currentTarget" in settings) { setQuizSettingsOpen(true); return; } if (quiz.isPending) return; setQuizSettingsOpen(false); sourceAi.startQuiz({ sessionId: session.id, sessionName: session.name, materials: materialContext(session), responseStyle: preferences.responseStyle, model: preferences.model, quiz: settings }); };
  const timer = watchTimer.timerFor(session.id);
  const vocabSlice = session.vocabulary;
  const dueCount = session.vocabulary.filter((item) => isVocabularyDue(item)).length;
  const note = session.notes.find((item) => item.id === openNoteId);
  if (quizSettingsOpen) return <><WatchPanel session={session} /><QuizGeneratorDialog open settings={quizSettings} pending={quiz.isPending} hasMaterials={session.materials.length > 0} onOpenChange={setQuizSettingsOpen} onSettingsChange={setQuizSettings} onGenerate={() => generateQuiz(quizSettings)} /></>;
  if (note) return <section className="study-panel p-4"><NoteEditor note={note} onBack={() => setOpenNoteId(null)} onRename={(name) => updateNote(session.id, note.id, { name })} onContentChange={(content) => updateNote(session.id, note.id, { content })} onDelete={() => { if (window.confirm("Delete this note?")) { deleteNote(session.id, note.id); setOpenNoteId(null); } }} /></section>;
  return <section className="study-panel study-watch-panel"><PanelTitle title="Watch" icon={<Clock3 className="size-4" />} /><ScrollArea className="min-h-0 flex-1"><div className="space-y-6 p-3 pb-6"><Timer seconds={timer.seconds} running={timer.running} onToggle={() => watchTimer.toggle(session.id)} onReset={() => watchTimer.reset(session.id)} onPin={() => watchTimer.pin(session.id, session.name, session.studySeconds)} /><section><SectionHeader label="Quiz" action={<button type="button" onClick={generateQuiz} disabled={quiz.isPending} aria-label="Generate quiz" className="study-section-action">{quiz.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}</button>} />{quizError && <p className="mt-2 text-[11px] leading-relaxed text-[#BA2D0B]">{quizError}</p>}<div className="study-quiz-scroll mt-3 grid grid-cols-2 gap-2">{session.quizzes.length ? session.quizzes.map((item) => <button key={item.id} type="button" onClick={() => setOpenQuiz(item)} className="study-quiz-button">{item.label}<span aria-label={item.result ? `Nilai ${Math.round((item.result.score / item.result.total) * 100)} persen, ${item.result.score} dari ${item.result.total} benar` : "Belum dikerjakan"}>{item.result ? `${Math.round((item.result.score / item.result.total) * 100)}% · ${item.result.score}/${item.result.total} benar` : "Belum dikerjakan"}</span></button>) : <div className="col-span-2"><EmptyPanel text="Generate a quiz from your sources." /></div>}</div></section><section><SectionHeader label="Key Terms" action={session.vocabulary.length ? <button type="button" onClick={() => setReviewOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-primary/45 bg-primary/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] text-primary transition-colors hover:bg-primary/20" aria-label="Review key terms flashcards"><Sparkles className="size-3" />Review {dueCount ? `· ${dueCount} due` : ""}</button> : undefined} /><div className="study-key-terms-scroll mt-3 grid grid-cols-2 gap-2">{vocabSlice.length ? vocabSlice.map((entry) => <HoverCard key={entry.id} open={hoveredTermId === entry.id} onOpenChange={(open) => setHoveredTermId(open ? entry.id : null)} openDelay={140} closeDelay={100}><HoverCardTrigger asChild><button type="button" className="study-key-term-trigger" onMouseEnter={() => setHoveredTermId(entry.id)} onFocus={() => setHoveredTermId(entry.id)} onBlur={() => setHoveredTermId(null)} onClick={() => setPreviewTerm(entry)} aria-label={`Preview key term ${entry.term}`}><span className="truncate">{compactKeyTermText(entry.term, 80)}</span><em className={isVocabularyDue(entry) ? "text-[#BA2D0B]" : "text-muted-foreground"}>{isVocabularyDue(entry) ? "Due" : "View"}</em></button></HoverCardTrigger><HoverCardContent side="left" align="start" className="w-64 rounded-xl border-border bg-card p-3 text-card-foreground"><p className="font-display text-lg italic">{compactKeyTermText(entry.term, 80)}</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{compactKeyTermText(entry.definition, 180)}</p></HoverCardContent></HoverCard>) : <div className="col-span-2"><EmptyPanel text="Save a selection to build key terms." /></div>}</div></section><section><SectionHeader label="Notes" action={<button type="button" onClick={() => setOpenNoteId(addNote(session.id))} className="study-add-notes">Add note</button>} /><div className="study-notes-scroll mt-3 space-y-2">{session.notes.length ? session.notes.map((item) => <button key={item.id} type="button" onClick={() => setOpenNoteId(item.id)} className="study-note-row"><FileText className="size-3.5 text-[#BA2D0B]" /><span className="min-w-0 flex-1 truncate text-left text-xs">{item.name}</span><span className="font-mono text-[9px] text-muted-foreground">{new Date(item.updatedAt).toLocaleDateString()}</span></button>) : <EmptyPanel text="Capture your learning in a note." />}</div></section></div></ScrollArea><QuizModal quiz={openQuiz} onOpenChange={(open) => { if (!open) setOpenQuiz(null); }} onComplete={(item, result) => saveQuizResult(session.id, item.id, result.score, result.total)} /><FlashcardReview session={session} open={reviewOpen} onOpenChange={(open) => { if (!open) setReviewOpen(false); }} onReview={(vocabId, rating) => reviewVocabulary(session.id, vocabId, rating)} /><KeyTermPreviewDialog entry={previewTerm} onOpenChange={(open) => { if (!open) setPreviewTerm(null); }} /></section>;
}

function KeyTermPreviewDialog({ entry, onOpenChange }: { entry: VocabItem | null; onOpenChange: (open: boolean) => void }) {
  if (!entry) return null;
  return <Dialog open={!!entry} onOpenChange={onOpenChange}><DialogContent className="rounded-3xl border-border bg-card text-card-foreground sm:max-w-md"><DialogHeader><DialogTitle className="font-display text-3xl italic">{compactKeyTermText(entry.term, 100)}</DialogTitle><DialogDescription>Key Term preview</DialogDescription></DialogHeader><p className="text-sm leading-relaxed text-foreground">{compactKeyTermText(entry.definition, 240)}</p>{entry.context && <div className="rounded-xl border border-border bg-secondary/35 p-3"><p className="font-mono text-[9px] uppercase tracking-[0.12em] text-primary">Context</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{compactKeyTermText(entry.context, 180)}</p></div>}{entry.example && <div className="rounded-xl border border-border bg-secondary/35 p-3"><p className="font-mono text-[9px] uppercase tracking-[0.12em] text-primary">Example</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{compactKeyTermText(entry.example, 180)}</p></div>}<Button type="button" onClick={() => onOpenChange(false)} className="w-full rounded-xl bg-primary text-primary-foreground">Close preview</Button></DialogContent></Dialog>;
}

function Timer({ seconds, running, onToggle, onReset, onPin }: { seconds: number; running: boolean; onToggle: () => void; onReset: () => void; onPin: () => void }) {
  const { activeSessionId } = useStudyStore();
  const watchTimer = useWatchTimer();
  const activeTimer = activeSessionId ? watchTimer.timerFor(activeSessionId) : { mode: "stopwatch" as const, seconds, elapsedSeconds: seconds, durationSeconds: 25 * 60, running, completed: false };
  const isCountdown = activeTimer.mode === "countdown";
  const percent = isCountdown ? Math.min(1, activeTimer.seconds / activeTimer.durationSeconds) : 0;
  const setMode = (mode: "stopwatch" | "countdown") => { if (activeSessionId) watchTimer.setMode(activeSessionId, mode); };
  const setDuration = (duration: number) => { if (activeSessionId) watchTimer.setCountdownDuration(activeSessionId, duration); };
  const toggle = () => activeSessionId ? watchTimer.toggle(activeSessionId) : onToggle();
  const reset = () => activeSessionId ? watchTimer.reset(activeSessionId) : onReset();
  return <section className="study-timer study-timer-v2">
    <div className="study-timer-mode" role="tablist" aria-label="Watch mode">
      <button type="button" role="tab" aria-selected={!isCountdown} onClick={() => setMode("stopwatch")} className={!isCountdown ? "is-active" : ""}>Stopwatch</button>
      <button type="button" role="tab" aria-selected={isCountdown} onClick={() => setMode("countdown")} className={isCountdown ? "is-active" : ""}>Timer</button>
    </div>
    <div className={`study-timer-face ${isCountdown ? "is-countdown" : ""}`}>
      {isCountdown && <svg viewBox="0 0 100 100" className="study-timer-ring" aria-hidden="true"><circle cx="50" cy="50" r="43" fill="none" stroke="currentColor" strokeWidth="3" className="text-border" /><circle cx="50" cy="50" r="43" fill="none" stroke="var(--primary)" strokeWidth="3" strokeLinecap="round" strokeDasharray="270.18" strokeDashoffset={270.18 * (1 - percent)} /></svg>}
      <span>{formatClock(activeTimer.seconds)}</span>
      <small>{activeTimer.completed ? "Time’s up" : isCountdown ? "remaining" : activeTimer.running ? "focus time" : "ready when you are"}</small>
    </div>
    {isCountdown && !activeTimer.running && <div className="study-timer-setup"><div className="study-timer-presets"><button type="button" onClick={() => setDuration(15 * 60)}>15m</button><button type="button" onClick={() => setDuration(25 * 60)} className={activeTimer.durationSeconds === 25 * 60 ? "is-active" : ""}>25m</button><button type="button" onClick={() => setDuration(45 * 60)}>45m</button></div><div className="study-timer-custom"><button type="button" aria-label="Kurangi lima menit" onClick={() => setDuration(activeTimer.durationSeconds - 5 * 60)}>−</button><span>{Math.floor(activeTimer.durationSeconds / 60)} min</span><button type="button" aria-label="Tambah lima menit" onClick={() => setDuration(activeTimer.durationSeconds + 5 * 60)}>+</button></div></div>}
    <div className="study-timer-actions"><button type="button" onClick={toggle} className="study-timer-start">{activeTimer.running ? <Pause className="size-4" /> : <Play className="size-4" />}{activeTimer.running ? "Pause" : activeTimer.completed ? "Start again" : "Start"}</button><button type="button" onClick={reset} className="study-timer-action" aria-label="Reset watch"><RotateCcw className="size-3.5" />Reset</button><button type="button" disabled={!activeTimer.elapsedSeconds} onClick={onPin} className="study-timer-action" aria-label="Pin study time"><Pin className="size-3.5" />Pin</button></div>
  </section>;
}
function QuizModal({ quiz, onOpenChange, onComplete }: { quiz: Quiz | null; onOpenChange: (open: boolean) => void; onComplete: (quiz: Quiz, result: { score: number; total: number }) => void }) { const [answers, setAnswers] = useState<Record<number, number>>({}); useEffect(() => setAnswers({}), [quiz?.id]); if (!quiz) return null; const finished = Object.keys(answers).length === quiz.questions.length; const result = finished ? scoreQuiz(quiz, answers) : null; const select = (questionIndex: number, optionIndex: number) => { if (answers[questionIndex] !== undefined) return; const next = { ...answers, [questionIndex]: optionIndex }; setAnswers(next); if (Object.keys(next).length === quiz.questions.length) onComplete(quiz, scoreQuiz(quiz, next)); }; return <Dialog open={!!quiz} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] overflow-y-auto rounded-3xl border-border bg-card text-card-foreground sm:max-w-3xl"><DialogHeader><DialogTitle className="font-display text-3xl italic">{quiz.label}</DialogTitle><DialogDescription>Choose an answer to receive immediate feedback.</DialogDescription></DialogHeader><div className="space-y-6 py-3">{quiz.questions.map((question, questionIndex) => <div key={questionIndex} className="rounded-2xl border border-border bg-secondary/35 p-4"><p className="text-sm leading-relaxed text-foreground"><span className="mr-2 font-mono text-[10px] text-muted-foreground">{String(questionIndex + 1).padStart(2, "0")}</span>{question.question}</p><div className="mt-4 grid gap-2 sm:grid-cols-2">{question.options.map((option, optionIndex) => { const chosen = answers[questionIndex] === optionIndex; const isCorrect = optionIndex === question.correct; const revealed = answers[questionIndex] !== undefined; return <button key={optionIndex} type="button" disabled={revealed} onClick={() => select(questionIndex, optionIndex)} className={`study-answer ${revealed && isCorrect ? "is-correct" : revealed && chosen ? "is-wrong" : ""}`}><span>{String.fromCharCode(65 + optionIndex)}</span>{option}</button>; })}</div>{answers[questionIndex] !== undefined && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{question.explanation}</p>}</div>)}</div>{result && <div className="rounded-2xl border border-primary/60 bg-primary/10 p-4 text-center"><p className="font-display text-3xl italic">{result.score} / {result.total}</p><p className="mt-1 text-xs text-muted-foreground">Your score has been saved to this session.</p></div>}<Button onClick={() => onOpenChange(false)} className="w-full rounded-xl bg-primary text-primary-foreground">Close quiz</Button></DialogContent></Dialog>; }

export function FlashcardReview({ session, open, onOpenChange, onReview }: { session: StudySession; open: boolean; onOpenChange: (open: boolean) => void; onReview: (vocabId: string, rating: VocabReviewRating) => void }) {
  const [cardIds, setCardIds] = useState<string[]>([]); const [index, setIndex] = useState(0); const [revealed, setRevealed] = useState(false);
  useEffect(() => { if (!open) return; setCardIds([...session.vocabulary].sort((a, b) => vocabularyDueAt(a) - vocabularyDueAt(b) || a.term.localeCompare(b.term)).map((item) => item.id)); setIndex(0); setRevealed(false); }, [open, session.id]);
  const card = session.vocabulary.find((item) => item.id === cardIds[index]); const complete = cardIds.length > 0 && index >= cardIds.length;
  const rate = (rating: VocabReviewRating) => { if (!card) return; onReview(card.id, rating); setRevealed(false); setIndex((value) => value + 1); };
    return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] rounded-3xl border-border bg-card text-card-foreground sm:max-w-lg"><DialogHeader><DialogTitle className="font-display text-3xl italic">Key Terms review</DialogTitle><DialogDescription>{cardIds.length ? `${Math.min(index + 1, cardIds.length)} of ${cardIds.length} · review what you remember, then schedule it.` : "Your saved key terms will appear here."}</DialogDescription></DialogHeader>{complete ? <div className="rounded-2xl border border-primary/50 bg-primary/10 p-8 text-center"><Sparkles className="mx-auto size-6 text-primary" /><p className="mt-3 font-display text-2xl italic">Deck complete.</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">Each card has been scheduled based on how well you remembered it.</p></div> : card ? <div className="space-y-4"><button type="button" onClick={() => setRevealed(true)} className="w-full rounded-2xl border border-border bg-secondary/35 p-8 text-center transition-colors hover:border-primary/60"><p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{revealed ? "Definition" : "Term"}</p>{revealed ? <div className="mt-4 space-y-3 text-left"><p className="font-display text-3xl italic leading-tight text-center">{compactKeyTermText(card.definition, 180)}</p>{(card.context || card.example) && <details className="rounded-xl border border-border bg-background/35 p-3 text-xs leading-relaxed text-muted-foreground"><summary className="cursor-pointer font-mono text-[9px] uppercase tracking-[0.12em] text-primary">Context & example</summary>{card.context && <p className="mt-2">{compactKeyTermText(card.context, 150)}</p>}{card.example && <p className="mt-2">{compactKeyTermText(card.example, 150)}</p>}</details>}</div> : <><p className="mt-4 font-display text-4xl italic leading-tight">{compactKeyTermText(card.term, 80)}</p><p className="mt-6 text-xs text-muted-foreground">Tap the card or reveal the answer.</p></>}</button>{revealed ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><button type="button" onClick={() => rate("again")} className="rounded-xl border border-border bg-secondary/50 px-2 py-2 text-xs">Again<span className="mt-0.5 block font-mono text-[9px] text-muted-foreground">10 min</span></button><button type="button" onClick={() => rate("hard")} className="rounded-xl border border-border bg-secondary/50 px-2 py-2 text-xs">Hard<span className="mt-0.5 block font-mono text-[9px] text-muted-foreground">1 day</span></button><button type="button" onClick={() => rate("good")} className="rounded-xl border border-border bg-secondary/50 px-2 py-2 text-xs">Good<span className="mt-0.5 block font-mono text-[9px] text-muted-foreground">3+ days</span></button><button type="button" onClick={() => rate("easy")} className="rounded-xl border border-border bg-secondary/50 px-2 py-2 text-xs">Easy<span className="mt-0.5 block font-mono text-[9px] text-muted-foreground">7+ days</span></button></div> : <Button onClick={() => setRevealed(true)} className="w-full rounded-xl bg-primary text-primary-foreground">Reveal answer</Button>}</div> : <EmptyPanel text="No flashcards are available in this session yet." />}<Button variant="outline" onClick={() => onOpenChange(false)} className="w-full rounded-xl border-border">Close review</Button></DialogContent></Dialog>;
}

function KeyTermEditor({ draft, onClose, onSave }: { draft: KeyTermDraft | null; onClose: () => void; onSave: (draft: KeyTermDraft) => void }) {
  const [value, setValue] = useState<KeyTermDraft | null>(draft);
  useEffect(() => setValue(draft), [draft]);
  if (!value) return null;
  const update = (field: keyof KeyTermDraft, next: string) => setValue((current) => current ? { ...current, [field]: next } : current);
  const canSave = Boolean(value.term.trim() && value.definition.trim());
  return <Dialog open={!!draft} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[90vh] overflow-y-auto rounded-3xl border-border bg-card text-card-foreground sm:max-w-xl"><DialogHeader><DialogTitle className="font-display text-3xl italic">Review Key Term</DialogTitle><DialogDescription>Keep it like a flashcard: a short term and one short definition. Extra detail is optional.</DialogDescription></DialogHeader><div className="space-y-4 py-2"><label className="block space-y-1.5"><span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Term · up to 80 characters</span><Input aria-label="Key Term" maxLength={80} value={value.term} onChange={(event) => update("term", event.target.value)} className="rounded-xl border-border bg-secondary" /></label><label className="block space-y-1.5"><span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Definition · one sentence, up to 180 characters</span><textarea aria-label="Definition" maxLength={180} value={value.definition} onChange={(event) => update("definition", event.target.value)} className="min-h-20 w-full rounded-xl border border-border bg-secondary px-3 py-2 text-sm outline-none transition-colors focus:border-primary" /></label><label className="block space-y-1.5"><span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Context · optional</span><textarea aria-label="Context" maxLength={150} value={value.context} onChange={(event) => update("context", event.target.value)} className="min-h-16 w-full rounded-xl border border-border bg-secondary px-3 py-2 text-sm outline-none transition-colors focus:border-primary" /></label><label className="block space-y-1.5"><span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Example · optional</span><textarea aria-label="Example" maxLength={150} value={value.example} onChange={(event) => update("example", event.target.value)} className="min-h-16 w-full rounded-xl border border-border bg-secondary px-3 py-2 text-sm outline-none transition-colors focus:border-primary" /></label></div><div className="grid grid-cols-2 gap-2"><Button variant="outline" onClick={onClose} className="rounded-xl border-border">Discard</Button><Button disabled={!canSave} onClick={() => onSave(value)} className="rounded-xl bg-primary text-primary-foreground">Save Key Term</Button></div></DialogContent></Dialog>;
}

function ReadMaterial({ material, vocabulary, onSelect }: { material?: StudySession["materials"][number]; vocabulary: string[]; onSelect: (text: string) => void }) {
  const chunks = useMemo(() => material ? buildMaterialChunks(material) : [], [material]);
  useEffect(() => {
    if (!material || !window.location.hash.startsWith("#study-material-")) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (target) window.setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "center" }), 40);
  }, [material, chunks.length]);
  if (!material) return <EmptyPanel text="Choose a source to begin reading." />;
  return <ScrollArea className="h-full"><article onMouseUp={() => { const activeSelection = window.getSelection(); const text = activeSelection?.toString().trim(); const range = activeSelection?.rangeCount ? activeSelection.getRangeAt(0) : undefined; const rect = range && typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0 }; if (text) { const panel = document.querySelector<HTMLElement>(".study-source-panel"); const popupWidth = 248; const x = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - popupWidth)); panel?.style.setProperty("--study-selection-x", `${x}px`); panel?.style.setProperty("--study-selection-y", `${Math.max(88, rect.top - 8)}px`); onSelect(text); } }} className="study-reading-content"><h3>{material.title}</h3>{chunks.map((chunk) => <section id={materialChunkDomId(material.id, chunk.ordinal)} key={chunk.ordinal} className="rounded-xl px-2 py-2 transition-colors target:bg-primary/10"><p className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">Source part {chunk.ordinal}</p><HighlightedText text={chunk.text} terms={vocabulary} /></section>)}</article></ScrollArea>;
}
function HighlightedText({ text, terms }: { text: string; terms: string[] }) { const store = useStudyStore() as Partial<{ sessions: StudySession[]; activeSessionId: string | null }>; const entries = store.sessions?.find((session) => session.id === store.activeSessionId)?.vocabulary ?? []; const entriesByTerm = useMemo(() => new Map(entries.map((entry) => [entry.term.trim().toLocaleLowerCase(), entry])), [entries]); const regex = useMemo(() => { const cleaned = terms.map((term) => term.trim()).filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRegExp); return cleaned.length ? new RegExp(`(${cleaned.join("|")})`, "i") : null; }, [terms]); if (!regex) return <>{text}</>; return <>{text.split(regex).map((part, index) => { const entry = entriesByTerm.get(part.trim().toLocaleLowerCase()); return entry ? <HoverCard key={index} openDelay={180} closeDelay={120}><HoverCardTrigger asChild><mark tabIndex={0} className="study-vocab-highlight">{part}</mark></HoverCardTrigger><HoverCardContent side="top" align="start" className="w-64 rounded-xl border-border bg-card p-3 text-card-foreground"><p className="font-semibold">{compactKeyTermText(entry.term, 80)}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{compactKeyTermText(entry.definition, 180)}</p>{entry.context ? <p className="mt-3 text-xs leading-relaxed text-muted-foreground"><strong className="text-foreground">Context: </strong>{compactKeyTermText(entry.context, 150)}</p> : null}{entry.example ? <p className="mt-2 text-xs leading-relaxed text-muted-foreground"><strong className="text-foreground">Example: </strong>{compactKeyTermText(entry.example, 150)}</p> : null}</HoverCardContent></HoverCard> : <span key={index}>{part}</span>; })}</>; }
function PanelTitle({ title, icon }: { title: string; icon: React.ReactNode }) { return <div className="flex items-center gap-2 border-b border-border px-4 py-3"><span className="text-muted-foreground">{icon}</span><h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{title}</h2></div>; }
function SectionHeader({ label, action }: { label: string; action?: React.ReactNode }) { return <div className="flex items-center justify-between"><h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</h3>{action}</div>; }
function EmptyPanel({ text }: { text: string }) { return <div className="flex min-h-20 items-center justify-center p-4 text-center font-display text-sm italic leading-relaxed text-muted-foreground">{text}</div>; }
type SourceFocusTarget = { sessionId: string; materialId: string; ordinal: number };
function materialContext(session: StudySession, query = "", responseStyle?: string) { return buildAdaptiveMaterialContext(session.materials, query, responseStyle); }
function attachMaterialIds(session: StudySession, citations: Array<{ title: string; ordinal: number }>): StudyCitation[] { return citations.map((citation) => ({ ...citation, materialId: session.materials.find((material) => material.title === citation.title)?.id })); }
function CitationChips({ citations, sessionId }: { citations: StudyCitation[]; sessionId: string }) { return <div className="study-citation-chips mt-2 flex flex-wrap items-center gap-1.5"><span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">Sources</span>{citations.map((citation) => <button key={`${citation.title}-${citation.ordinal}`} type="button" disabled={!citation.materialId} onClick={() => citation.materialId && window.dispatchEvent(new CustomEvent<SourceFocusTarget>("studyos:focus-source", { detail: { sessionId, materialId: citation.materialId, ordinal: citation.ordinal } }))} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border bg-secondary/70 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:cursor-default disabled:opacity-60"><FileText className="size-3 shrink-0 text-[#BA2D0B]" /><span className="min-w-0 max-w-32 truncate">{citation.title}</span><span className="shrink-0 font-mono text-[9px] text-primary">part {citation.ordinal}</span></button>)}</div>; }
function fileAsDataUrl(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("Unable to read this file.")); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file); }); }
function documentMimeType(file: File): "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "text/plain" | "text/markdown" | "text/csv" | null { const name = file.name.toLowerCase(); if (file.type === "application/pdf" || name.endsWith(".pdf")) return "application/pdf"; if (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; if (file.type === "text/markdown" || name.endsWith(".md") || name.endsWith(".markdown")) return "text/markdown"; if (file.type === "text/csv" || name.endsWith(".csv")) return "text/csv"; if (file.type === "text/plain" || name.endsWith(".txt")) return "text/plain"; return null; }
function displaySourceDomain(value: string) { try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return ""; } }
function formatClock(seconds: number) { const mins = Math.floor(seconds / 60).toString().padStart(2, "0"); const secs = (seconds % 60).toString().padStart(2, "0"); return `${mins}:${secs}`; }
function readAiSettings(): { model: "gpt-5-mini" | "claude-haiku-4-5" | "gemini-3-flash-preview" | "local-9router"; responseStyle: "Fast" | "Balanced" | "Deep" } { const model = localStorage.getItem("studyos_ai_model"); const responseStyle = localStorage.getItem("studyos_ai_style"); return { model: model === "claude-haiku-4-5" || model === "gemini-3-flash-preview" || model === "gpt-5-mini" || model === "local-9router" ? model : "gpt-5-mini", responseStyle: responseStyle === "Fast" || responseStyle === "Concise" ? "Fast" : responseStyle === "Deep" || responseStyle === "Detailed" ? "Deep" : "Balanced" }; }
function extractText(html: string) { const doc = new DOMParser().parseFromString(html, "text/html"); doc.querySelectorAll("script, style, nav, footer, header, noscript").forEach((node) => node.remove()); return doc.body.textContent?.replace(/\s+/g, " ").trim() ?? ""; }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
