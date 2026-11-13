import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ key: "studyos/avatars/profile_test.png", url: "/manus-storage/studyos/avatars/profile_test.png" }),
}));

import { appRouter } from "./routers";
import { storagePut } from "./storage";
import type { TrpcContext } from "./_core/context";

const pngDataUrl = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString("base64")}`;
const jpegDataUrl = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), Buffer.alloc(24)]).toString("base64")}`;
const context = { user: null, req: {} as TrpcContext["req"], res: {} as TrpcContext["res"] } as TrpcContext;
const originalLocalMode = process.env.STUDYOS_LOCAL_MODE;

describe("study.uploadAvatar", () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.STUDYOS_LOCAL_MODE = "false"; });
  afterEach(() => {
    if (originalLocalMode === undefined) delete process.env.STUDYOS_LOCAL_MODE;
    else process.env.STUDYOS_LOCAL_MODE = originalLocalMode;
  });

  it("stores a validated PNG and returns its storage URL for the profile state", async () => {
    const result = await appRouter.createCaller(context).study.uploadAvatar({ imageDataUrl: pngDataUrl });

    expect(storagePut).toHaveBeenCalledWith("studyos/avatars/profile.png", expect.any(Buffer), "image/png");
    expect(result).toEqual({ url: "/manus-storage/studyos/avatars/profile_test.png" });
  });

  it("stores a validated JPEG with its normalized MIME type and extension", async () => {
    await appRouter.createCaller(context).study.uploadAvatar({ imageDataUrl: jpegDataUrl });

    expect(storagePut).toHaveBeenCalledWith("studyos/avatars/profile.jpg", expect.any(Buffer), "image/jpeg");
  });

  it("keeps a validated avatar in browser persistence and skips cloud storage in local mode", async () => {
    delete process.env.STUDYOS_LOCAL_MODE;

    await expect(appRouter.createCaller(context).study.uploadAvatar({ imageDataUrl: pngDataUrl })).resolves.toEqual({ url: pngDataUrl });
    expect(storagePut).not.toHaveBeenCalled();
  });
});
