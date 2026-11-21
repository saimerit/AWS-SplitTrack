import { parentPort, workerData } from "node:worker_threads";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";

// Node does not need browser Worker/Canvas/DOM globals for getTextContent.
// Install the library's in-process message handler before loading its display
// entry so the deployed bundle never resolves a separate browser worker URL.
globalThis.pdfjsWorker = { WorkerMessageHandler };
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

function pageText(items) {
  const positioned = items.filter(item => typeof item.str === "string" && item.str.trim()).map((item, index) => ({ item, index }));
  positioned.sort((a, b) => {
    const yDifference = b.item.transform[5] - a.item.transform[5];
    return Math.abs(yDifference) > 2 ? yDifference : a.item.transform[4] - b.item.transform[4] || a.index - b.index;
  });
  const lines = [];
  let line = [], lineY;
  for (const { item } of positioned) {
    const y = item.transform[5];
    if (line.length && Math.abs(y - lineY) > 2) { lines.push(line.join(" ")); line = []; }
    if (!line.length) lineY = y;
    line.push(item.str.replace(/[\r\n]+/g, " "));
  }
  if (line.length) lines.push(line.join(" "));
  return lines.join("\n");
}

let task;
let result;
try {
  task = getDocument({
    data: workerData.bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: true,
    maxImageSize: 0,
    enableXfa: false,
    verbosity: 0,
  });
  // Reject password-protected documents; no passwords are accepted or stored.
  task.onPassword = () => { throw Object.assign(new Error("Encrypted PDF"), { name: "PasswordException" }); };
  const document = await task.promise;
  if (document.numPages > workerData.maxPages) throw Object.assign(new Error("Use a PDF statement with no more than 100 pages."), { code: "PDF_TOO_MANY_PAGES", status: 413 });
  const pages = [];
  let totalText = 0;
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const text = pageText((await page.getTextContent()).items);
    totalText += text.length;
    if (totalText > workerData.maxText) throw Object.assign(new Error("This statement contains too much text. Try a smaller date range."), { code: "PDF_TOO_LARGE", status: 413 });
    pages.push(text);
    page.cleanup();
  }
  if (!pages.some(page => /[\p{L}\p{N}]/u.test(page))) throw Object.assign(new Error("This PDF has no selectable text. Import a downloaded statement or a CSV/Excel file instead of a scanned image."), { code: "PDF_NO_TEXT" });
  result = { pages };
} catch (failure) {
  const encrypted = failure?.name === "PasswordException";
  result = { error: {
    status: failure?.status || 422,
    code: encrypted ? "PDF_PASSWORD_REQUIRED" : failure?.code || "INVALID_PDF",
    message: encrypted ? "This PDF is password-protected. Export an unlocked statement and try again." : failure?.code ? failure.message : "This PDF could not be read. Export the statement again or choose a CSV/Excel file.",
  } };
} finally {
  try { await task?.destroy(); } catch { /* Extraction result remains authoritative. */ }
  parentPort.postMessage(result);
  parentPort.close();
}
