import { create } from "zustand";
import { defaultSnapshot, loadStudySnapshot, saveStudySnapshot } from "@/lib/study-db";
import { makeId, normalizeTerm, scheduleVocabularyReview } from "@/lib/study-utils";
import type { Material, Profile, Quiz, StudyMessage, StudyNote, StudySession, StudySnapshot, TimerEntry, VocabItem, VocabReviewRating } from "@/lib/study-types";

// Legacy/local consumers start enabled. The owner gate suspends this store
// before access is decided and whenever the owner session ends.
let memorySuspended = false;
let hydrationEpoch = 0;

type StudyStore = StudySnapshot & {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  updateProfile: (profile: Partial<Profile>) => void;
  setActiveSession: (id: string | null) => void;
  createSession: () => string;
  deleteSession: (id: string) => void;
  updateSession: (id: string, patch: Partial<Pick<StudySession, "name" | "description" | "isPinned" | "studySeconds">>) => void;
  addMaterial: (sessionId: string, material: Omit<Material, "id" | "createdAt">) => void;
  deleteMaterial: (sessionId: string, materialId: string) => void;
  addMessage: (sessionId: string, message: Omit<StudyMessage, "id" | "createdAt">) => void;
  addVocabulary: (sessionId: string, term: string, definition: string, details?: Pick<VocabItem, "context" | "example" | "sourceExcerpt">) => void;
  deleteVocabulary: (sessionId: string, vocabId: string) => void;
  reviewVocabulary: (sessionId: string, vocabId: string, rating: VocabReviewRating, reviewedAt?: number) => void;
  addTimer: (entry: Omit<TimerEntry, "id" | "pinnedAt">) => void;
  deleteTimer: (timerId: string) => void;
  addQuiz: (sessionId: string, questions: Quiz["questions"]) => Quiz;
  saveQuizResult: (sessionId: string, quizId: string, score: number, total: number) => void;
  addNote: (sessionId: string) => string;
  updateNote: (sessionId: string, noteId: string, patch: Partial<Pick<StudyNote, "name" | "content">>) => void;
  deleteNote: (sessionId: string, noteId: string) => void;
};

function initialSession(): StudySession {
  const now = Date.now();
  return {
    id: makeId("session"),
    name: "New Session",
    createdAt: now,
    isPinned: false,
    materials: [],
    chatHistory: [],
    vocabulary: [],
    quizzes: [],
    notes: [],
    studySeconds: 0,
  };
}

function snapshotFrom(state: StudyStore): StudySnapshot {
  return { profile: state.profile, sessions: state.sessions, timers: state.timers, activeSessionId: state.activeSessionId };
}

export const useStudyStore = create<StudyStore>((set, get) => {
  const commit = (recipe: (state: StudyStore) => Partial<StudyStore>) => {
    if (memorySuspended) return;
    set((current) => {
      const next = { ...current, ...recipe(current) };
      void saveStudySnapshot(snapshotFrom(next));
      return next;
    });
  };

  return {
    ...defaultSnapshot,
    hydrated: false,
    hydrate: async () => {
      if (memorySuspended) return;
      const epoch = hydrationEpoch;
      const snapshot = await loadStudySnapshot();
      if (memorySuspended || epoch !== hydrationEpoch) return;
      set({ ...snapshot, hydrated: true });
    },
    updateProfile: (profile) => commit((state) => ({ profile: { ...state.profile, ...profile } })),
    setActiveSession: (id) => commit(() => ({ activeSessionId: id })),
    createSession: () => {
      const session = initialSession();
      commit((state) => ({ sessions: [session, ...state.sessions], activeSessionId: session.id }));
      return session.id;
    },
    deleteSession: (id) => commit((state) => {
      const sessions = state.sessions.filter((session) => session.id !== id);
      return { sessions, activeSessionId: state.activeSessionId === id ? sessions[0]?.id ?? null : state.activeSessionId };
    }),
    updateSession: (id, patch) => commit((state) => ({
      sessions: state.sessions.map((session) => session.id === id ? { ...session, ...patch } : session),
    })),
    addMaterial: (sessionId, material) => commit((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, materials: [{ ...material, id: makeId("material"), createdAt: Date.now() }, ...session.materials] }
        : session),
    })),
    deleteMaterial: (sessionId, materialId) => commit((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, materials: session.materials.filter((material) => material.id !== materialId) }
        : session),
    })),
    addMessage: (sessionId, message) => commit((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, chatHistory: [...session.chatHistory, { ...message, id: makeId("message"), createdAt: Date.now() }] }
        : session),
    })),
    addVocabulary: (sessionId, term, definition, details) => commit((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session;
        const exists = session.vocabulary.some((item) => normalizeTerm(item.term) === normalizeTerm(term));
        if (exists || !term.trim()) return session;
        const createdAt = Date.now();
        return { ...session, vocabulary: [...session.vocabulary, { id: makeId("vocab"), term: term.trim(), definition: definition.trim() || "Saved from your source", context: details?.context?.trim() || undefined, example: details?.example?.trim() || undefined, sourceExcerpt: details?.sourceExcerpt?.trim() || undefined, createdAt, review: { dueAt: createdAt, intervalDays: 0, repetitions: 0 } }] };
      }),
    })),
    deleteVocabulary: (sessionId, vocabId) => commit((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, vocabulary: session.vocabulary.filter((item) => item.id !== vocabId) }
        : session),
    })),
    reviewVocabulary: (sessionId, vocabId, rating, reviewedAt = Date.now()) => commit((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, vocabulary: session.vocabulary.map((item) => item.id === vocabId ? { ...item, review: scheduleVocabularyReview(item, rating, reviewedAt) } : item) }
        : session),
    })),
    addTimer: (entry) => commit((state) => ({ timers: [{ ...entry, id: makeId("timer"), pinnedAt: Date.now() }, ...state.timers] })),
    deleteTimer: (timerId) => commit((state) => ({ timers: state.timers.filter((timer) => timer.id !== timerId) })),
    addQuiz: (sessionId, questions) => {
      const quizCount = get().sessions.find((session) => session.id === sessionId)?.quizzes.length ?? 0;
      const created: Quiz = { id: makeId("quiz"), label: `Quiz ${quizCount + 1}`, questions, createdAt: Date.now() };
      commit((state) => ({
        sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, quizzes: [...session.quizzes, created] } : session),
      }));
      return created;
    },
    saveQuizResult: (sessionId, quizId, score, total) => commit((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, quizzes: session.quizzes.map((quiz) => quiz.id === quizId ? { ...quiz, result: { score, total, completedAt: Date.now() } } : quiz) }
        : session),
    })),
    addNote: (sessionId) => {
      const note: StudyNote = { id: makeId("note"), name: "Untitled note", content: "<p></p>", createdAt: Date.now(), updatedAt: Date.now() };
      commit((state) => ({
        sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, notes: [note, ...session.notes] } : session),
      }));
      return note.id;
    },
    updateNote: (sessionId, noteId, patch) => commit((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, notes: session.notes.map((note) => note.id === noteId ? { ...note, ...patch, updatedAt: Date.now() } : note) }
        : session),
    })),
    deleteNote: (sessionId, noteId) => commit((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId
        ? { ...session, notes: session.notes.filter((note) => note.id !== noteId) }
        : session),
    })),
  };
});

/** Clear private memory without changing the browser's saved learning data. */
export function resetStudyMemory() {
  memorySuspended = true;
  hydrationEpoch += 1;
  useStudyStore.setState({
    profile: { ...defaultSnapshot.profile },
    sessions: [],
    timers: [],
    activeSessionId: null,
    hydrated: false,
  });
}

/** Allow the authenticated owner (or explicit local legacy mode) to hydrate. */
export function resumeStudyMemory() {
  memorySuspended = false;
}
