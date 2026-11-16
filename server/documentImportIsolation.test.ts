import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadPdf } = vi.hoisted(() => ({
  loadPdf: vi.fn(),
}));

vi.mock("unpdf", () => {
  loadPdf();
  throw new Error("PDF parser unavailable in this test deployment");
});

import { decodeAndExtractDocument } from "./documentImport";

const dataUrl = (mime: string, text: string) =>
  `data:${mime};base64,${Buffer.from(text).toString("base64")}`;

beforeEach(() => {
  loadPdf.mockClear();
});

describe("PDF dependency isolation", () => {
  it("imports the module and extracts text without initializing PDF dependencies", async () => {
    const document = await decodeAndExtractDocument({
      mimeType: "text/plain",
      dataUrl: dataUrl("text/plain", "Readable study material"),
    });
    expect(document.content).toBe("Readable study material");
    expect(loadPdf).not.toHaveBeenCalled();
  });

  it("rejects a bad PDF signature before loading the PDF parser", async () => {
    await expect(
      decodeAndExtractDocument({
        mimeType: "application/pdf",
        dataUrl: dataUrl("application/pdf", "Not a PDF document"),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(loadPdf).not.toHaveBeenCalled();
  });

  it("reports a server error for unavailable PDF support without breaking text import", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      await expect(
        decodeAndExtractDocument({
          mimeType: "application/pdf",
          dataUrl: dataUrl("application/pdf", "%PDF-1.7\nfixture"),
        })
      ).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "PDF processing is unavailable on this server. Please try again later.",
      });
      expect(loadPdf).toHaveBeenCalledOnce();
      const document = await decodeAndExtractDocument({
        mimeType: "text/plain",
        dataUrl: dataUrl("text/plain", "Still available"),
      });
      expect(document.content).toBe("Still available");
    } finally {
      consoleError.mockRestore();
    }
  });
});
