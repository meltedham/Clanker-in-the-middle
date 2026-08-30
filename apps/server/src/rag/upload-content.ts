import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface UploadInput {
  name: string;
  content?: string | undefined;
  contentBase64?: string | undefined;
  mimeType?: string | undefined;
}

export async function normalizeUploadContent(input: UploadInput): Promise<string> {
  if (input.contentBase64) {
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (isPdfUpload(input)) {
      return extractPdfText(bytes);
    }
    return bytes.toString("utf8");
  }
  return input.content ?? "";
}

function isPdfUpload(input: UploadInput): boolean {
  const mimeType = input.mimeType?.toLowerCase() ?? "";
  return mimeType === "application/pdf" || input.name.toLowerCase().endsWith(".pdf");
}

const pdfjsRoot = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const standardFontDataUrl = pathToFileURL(path.join(pdfjsRoot, "standard_fonts") + path.sep).href;
const cMapUrl = pathToFileURL(path.join(pdfjsRoot, "cmaps") + path.sep).href;

async function extractPdfText(buffer: Buffer): Promise<string> {
  const document = await getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useWorkerFetch: false,
  }).promise;

  try {
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let pageText = "";
      for (const item of textContent.items) {
        if (!("str" in item)) {
          continue;
        }
        pageText += item.str;
        if (item.hasEOL) {
          pageText += "\n";
        }
      }
      pageTexts.push(pageText.trim());
    }
    return pageTexts.filter((text) => text.length > 0).join("\n\n").trim();
  } finally {
    await document.destroy();
  }
}
