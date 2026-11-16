import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { decodeAndExtractDocument } from "./documentImport";

const toDataUrl = (mimeType: string, bytes: Uint8Array) =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

async function makeDocx(text: string) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  );
  zip
    .folder("_rels")
    ?.file(
      ".rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    );
  zip
    .folder("word")
    ?.file(
      "document.xml",
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    );
  return zip.generateAsync({ type: "uint8array" });
}

describe("document import", () => {
  it("extracts readable text from a PDF", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("StudyOS PDF concepts", { x: 50, y: 700, font });
    const bytes = await pdf.save();
    const output = await decodeAndExtractDocument({
      mimeType: "application/pdf",
      dataUrl: toDataUrl("application/pdf", bytes),
    });
    expect(output.format).toBe("PDF");
    expect(output.content).toContain("StudyOS PDF concepts");
    expect(output.bytes).toEqual(Buffer.from(bytes));
  });

  it("keeps text, accents, and line breaks from every PDF page in order", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf
      .addPage()
      .drawText("Bab pertama\nÉtude café naïve", { x: 50, y: 700, font });
    pdf
      .addPage()
      .drawText("Bab kedua\nKonsep berikutnya", { x: 50, y: 700, font });
    const output = await decodeAndExtractDocument({
      mimeType: "application/pdf",
      dataUrl: toDataUrl("application/pdf", await pdf.save()),
    });
    expect(output.content).toBe(
      "Bab pertama\nÉtude café naïve\nBab kedua\nKonsep berikutnya"
    );
  });

  it("rejects a blank PDF with a readable explanation", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    await expect(
      decodeAndExtractDocument({
        mimeType: "application/pdf",
        dataUrl: toDataUrl("application/pdf", await pdf.save()),
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "No readable text was found in this PDF document.",
    });
  });

  it("rejects an image-only PDF without claiming to provide OCR", async () => {
    const pdf = await PDFDocument.create();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1UAAAAASUVORK5CYII=",
      "base64"
    );
    const image = await pdf.embedPng(png);
    pdf.addPage().drawImage(image, { x: 50, y: 50, width: 500, height: 700 });
    await expect(
      decodeAndExtractDocument({
        mimeType: "application/pdf",
        dataUrl: toDataUrl("application/pdf", await pdf.save()),
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "No readable text was found in this PDF document.",
    });
  });

  it("extracts readable text from a DOCX", async () => {
    const mimeType =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
    const output = await decodeAndExtractDocument({
      mimeType,
      dataUrl: toDataUrl(mimeType, await makeDocx("StudyOS DOCX concepts")),
    });
    expect(output.format).toBe("DOCX");
    expect(output.content).toContain("StudyOS DOCX concepts");
  });

  it("rejects a PDF with an invalid signature", async () => {
    await expect(
      decodeAndExtractDocument({
        mimeType: "application/pdf",
        dataUrl: toDataUrl("application/pdf", new Uint8Array([1, 2, 3, 4])),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
