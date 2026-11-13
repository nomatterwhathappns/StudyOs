import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { storagePut } = vi.hoisted(() => ({ storagePut: vi.fn() }));
vi.mock("./storage", () => ({ storagePut }));

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function context(): TrpcContext {
  return { user: null, req: {} as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("study.uploadDocument", () => {
  beforeEach(() => { storagePut.mockReset(); vi.stubEnv("STUDYOS_LOCAL_MODE", "false"); });
  afterEach(() => vi.unstubAllEnvs());

  it("imports text without cloud credentials in the default local mode", async () => {
    vi.stubEnv("STUDYOS_LOCAL_MODE", undefined);
    const dataUrl = `data:text/plain;base64,${Buffer.from("A locally stored study source.").toString("base64")}`;
    await expect(appRouter.createCaller(context()).study.uploadDocument({ name: "local.txt", mimeType: "text/plain", dataUrl })).resolves.toEqual({ title: "local.txt", url: "", content: "A locally stored study source.", format: "TXT" });
    expect(storagePut).not.toHaveBeenCalled();
  });

  it("extracts text, stores the original file, and returns source metadata", async () => {
    storagePut.mockResolvedValueOnce({ key: "studyos/materials/biology.txt", url: "/manus-storage/biology.txt" });
    const dataUrl = `data:text/plain;base64,${Buffer.from("Cells use membranes to control movement.").toString("base64")}`;
    const result = await appRouter.createCaller(context()).study.uploadDocument({ name: "biology notes.txt", mimeType: "text/plain", dataUrl });

    expect(storagePut).toHaveBeenCalledWith(expect.stringMatching(/studyos\/materials\/.*biology-notes\.txt$/), expect.any(Buffer), "text/plain");
    expect(result).toEqual({ title: "biology notes.txt", url: "/manus-storage/biology.txt", content: "Cells use membranes to control movement.", format: "TXT" });
  });

  it("rejects a declared PDF whose bytes are not a PDF", async () => {
    const dataUrl = `data:application/pdf;base64,${Buffer.from("not a pdf").toString("base64")}`;
    await expect(appRouter.createCaller(context()).study.uploadDocument({ name: "broken.pdf", mimeType: "application/pdf", dataUrl })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(storagePut).not.toHaveBeenCalled();
  });
});
