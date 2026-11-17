import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/study-db", () => ({
  defaultSnapshot: { profile: { name: "Learner" }, sessions: [], timers: [], activeSessionId: null },
  loadStudySnapshot: vi.fn(),
  saveStudySnapshot: vi.fn().mockResolvedValue(undefined),
}));

import { defaultSnapshot, loadStudySnapshot, saveStudySnapshot } from "@/lib/study-db";
import { resetStudyMemory, resumeStudyMemory, useStudyStore } from "./useStudyStore";

beforeEach(() => {
  resumeStudyMemory();
  useStudyStore.setState({ ...defaultSnapshot, hydrated: false });
  vi.clearAllMocks();
});

describe("StudyOS store", () => {
  it("creates a session, deduplicates vocabulary, and persists state changes", () => {
    const store = useStudyStore.getState();
    const sessionId = store.createSession();
    store.addVocabulary(sessionId, "  Photosynthesis ", "Energy conversion in plants");
    store.addVocabulary(sessionId, "photosynthesis", "Duplicate should be ignored");

    const session = useStudyStore.getState().sessions[0];
    expect(session.id).toBe(sessionId);
    expect(session.vocabulary).toHaveLength(1);
    expect(session.vocabulary[0]).toMatchObject({ term: "Photosynthesis", definition: "Energy conversion in plants" });
    expect(saveStudySnapshot).toHaveBeenCalled();
  });

  it("persists a spaced-repetition review after a flashcard rating", () => {
    const store = useStudyStore.getState();
    const sessionId = store.createSession();
    store.addVocabulary(sessionId, "Recall", "Remember learned information");
    const vocabId = useStudyStore.getState().sessions[0].vocabulary[0].id;

    store.reviewVocabulary(sessionId, vocabId, "easy", 1_000);

    expect(useStudyStore.getState().sessions[0].vocabulary[0].review).toMatchObject({ dueAt: 1_000 + 7 * 86_400_000, intervalDays: 7, repetitions: 1, lastRating: "easy" });
    expect(saveStudySnapshot).toHaveBeenCalledWith(expect.objectContaining({ sessions: expect.arrayContaining([expect.objectContaining({ vocabulary: [expect.objectContaining({ id: vocabId, review: expect.any(Object) })] })]) }));
  });

  it("persists optional AI-drafted Key Term context and example", () => {
    const store = useStudyStore.getState();
    const sessionId = store.createSession();
    store.addVocabulary(sessionId, "AWS S3", "Object storage from AWS.", { context: "Stores objects in buckets.", example: "Save a PDF in a bucket.", sourceExcerpt: "AWS S3" });

    const item = useStudyStore.getState().sessions.find((session) => session.id === sessionId)?.vocabulary[0];
    expect(item).toMatchObject({ term: "AWS S3", definition: "Object storage from AWS.", context: "Stores objects in buckets.", example: "Save a PDF in a bucket.", sourceExcerpt: "AWS S3" });
  });

  it("records notes and pinned timers in the selected session state", () => {
    const store = useStudyStore.getState();
    const sessionId = store.createSession();
    const noteId = store.addNote(sessionId);
    store.updateNote(sessionId, noteId, { name: "Lecture notes", content: "<p>Key idea</p>" });
    store.addTimer({ sessionId, sessionName: "New Session", seconds: 150 });

    const state = useStudyStore.getState();
    expect(state.sessions[0]?.notes[0]).toMatchObject({ id: noteId, name: "Lecture notes", content: "<p>Key idea</p>" });
    expect(state.timers[0]).toMatchObject({ sessionId, seconds: 150 });
  });

  it("hydrates a persisted snapshot and restores the active session", async () => {
    const restoredSession = { id: "restored-session", name: "Restored session", createdAt: 1, isPinned: true, materials: [], chatHistory: [], vocabulary: [], quizzes: [], notes: [], studySeconds: 90 };
    vi.mocked(loadStudySnapshot).mockResolvedValue({ profile: { name: "Alya" }, sessions: [restoredSession], timers: [], activeSessionId: restoredSession.id });

    await useStudyStore.getState().hydrate();

    expect(useStudyStore.getState()).toMatchObject({ hydrated: true, activeSessionId: "restored-session", profile: { name: "Alya" } });
    expect(useStudyStore.getState().sessions[0]).toMatchObject(restoredSession);
  });

  it("persists a profile avatar URL returned after a successful upload", () => {
    useStudyStore.getState().updateProfile({ name: "Alya", avatar: "/manus-storage/studyos/avatars/profile_upload.png" });

    expect(useStudyStore.getState().profile).toEqual({ name: "Alya", avatar: "/manus-storage/studyos/avatars/profile_upload.png" });
    expect(saveStudySnapshot).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ avatar: "/manus-storage/studyos/avatars/profile_upload.png" }) }));
  });

  it("clears only in-memory data and blocks hydration and late writes while signed out", async () => {
    const store = useStudyStore.getState();
    const sessionId = store.createSession();
    store.updateProfile({
      name: "Private owner",
      avatar: "/private-avatar.png",
    });
    store.addTimer({ sessionId, sessionName: "Private session", seconds: 45 });
    useStudyStore.setState({ hydrated: true });
    vi.mocked(saveStudySnapshot).mockClear();
    vi.mocked(loadStudySnapshot).mockClear();

    resetStudyMemory();
    store.updateProfile({ name: "Late upload result" });
    store.addMessage(sessionId, {
      role: "assistant",
      content: "Late private response",
    });
    store.createSession();
    store.addTimer({ sessionId, sessionName: "Late timer", seconds: 5 });
    await store.hydrate();

    expect(useStudyStore.getState()).toMatchObject({
      ...defaultSnapshot,
      hydrated: false,
    });
    expect(saveStudySnapshot).not.toHaveBeenCalled();
    expect(loadStudySnapshot).not.toHaveBeenCalled();
  });

  it("ignores hydration started before logout even after a later session resumes", async () => {
    let finishOldLoad!: (snapshot: typeof defaultSnapshot) => void;
    vi.mocked(loadStudySnapshot).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOldLoad = resolve;
        })
    );
    const oldLoad = useStudyStore.getState().hydrate();

    resetStudyMemory();
    resumeStudyMemory();
    vi.mocked(loadStudySnapshot).mockResolvedValueOnce({
      ...defaultSnapshot,
      profile: { name: "Current owner" },
    });
    await useStudyStore.getState().hydrate();
    finishOldLoad({
      ...defaultSnapshot,
      profile: { name: "Stale private snapshot" },
    });
    await oldLoad;

    expect(useStudyStore.getState()).toMatchObject({
      hydrated: true,
      profile: { name: "Current owner" },
    });
    expect(saveStudySnapshot).not.toHaveBeenCalled();
  });

  it("rehydrates saved learning data and resumes persistence after authentication", async () => {
    const savedSession = {
      id: "saved-session",
      name: "Saved learning",
      createdAt: 1,
      isPinned: false,
      materials: [],
      chatHistory: [],
      vocabulary: [],
      quizzes: [],
      notes: [],
      studySeconds: 120,
    };
    const diskSnapshot = {
      ...defaultSnapshot,
      profile: { name: "Returning owner" },
      sessions: [savedSession],
      activeSessionId: savedSession.id,
    };
    vi.mocked(loadStudySnapshot).mockResolvedValue(diskSnapshot);

    resetStudyMemory();
    resumeStudyMemory();
    await useStudyStore.getState().hydrate();

    expect(useStudyStore.getState()).toMatchObject({
      ...diskSnapshot,
      hydrated: true,
    });
    expect(saveStudySnapshot).not.toHaveBeenCalled();
    useStudyStore.getState().updateProfile({ name: "Updated owner" });
    expect(saveStudySnapshot).toHaveBeenCalledTimes(1);
    expect(saveStudySnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sessions: [savedSession],
        profile: { name: "Updated owner" },
      })
    );
  });
});
