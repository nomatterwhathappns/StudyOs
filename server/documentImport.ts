import { TRPCError } from "@trpc/server";
import mammoth from "mammoth";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT = 80_000;

const acceptedMimes = {
  "application/pdf": { format: "PDF", extension: "pdf" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    format: "DOCX",
    extension: "docx",
  },
  "text/plain": { format: "TXT", extension: "txt" },
  "text/markdown": { format: "MD", extension: "md" },
  "text/csv": { format: "CSV", extension: "csv" },
} as const;

export type DocumentMimeType = keyof typeof acceptedMimes;

function normaliseText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[\t ]+/g, " ")
    .trim()
    .slice(0, MAX_DOCUMENT_TEXT);
}

function dataUrlBytes(dataUrl: string, mimeType: DocumentMimeType) {
  const match = dataUrl.match(/^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match || match[1] !== mimeType)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The file data is invalid. Choose the document again.",
    });
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES)
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: "Choose a document smaller than 5 MB.",
    });
  return bytes;
}

function hasPdfSignature(bytes: Buffer) {
  return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}
function hasZipSignature(bytes: Buffer) {
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

async function loadPdfParser() {
  try {
    // The serverless PDF.js build includes its worker and needs no native
    // Canvas dependency for text extraction. Load it only for PDF documents.
    return await import("unpdf");
  } catch (error) {
    console.error("[StudyOS PDF initialization]", error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "PDF processing is unavailable on this server. Please try again later.",
    });
  }
}

export async function decodeAndExtractDocument(input: {
  dataUrl: string;
  mimeType: DocumentMimeType;
}) {
  const details = acceptedMimes[input.mimeType];
  const bytes = dataUrlBytes(input.dataUrl, input.mimeType);
  let rawText = "";

  try {
    if (input.mimeType === "application/pdf") {
      if (!hasPdfSignature(bytes))
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This file is not a valid PDF.",
        });
      const { extractText } = await loadPdfParser();
      // PDF.js owns the data passed to it. Copy it so uploads retain their
      // original bytes; extractText releases its document after completion.
      rawText = (await extractText(new Uint8Array(bytes), { mergePages: true }))
        .text;
    } else if (
      input.mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      if (!hasZipSignature(bytes))
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This file is not a valid DOCX document.",
        });
      rawText = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else {
      rawText = bytes.toString("utf8");
    }
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    console.error("[StudyOS document extraction]", error);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `StudyOS could not read this ${details.format} file. Try an exported text-based document.`,
    });
  }

  const content = normaliseText(rawText);
  if (!content)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `No readable text was found in this ${details.format} document.`,
    });
  return {
    bytes,
    content,
    format: details.format,
    extension: details.extension,
    contentType: input.mimeType,
  };
}
