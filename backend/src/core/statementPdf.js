import { Worker } from "node:worker_threads";
import { ApiError, ensure } from "./errors.js";

export const MAX_STATEMENT_PDF_BYTES = 3 * 1024 * 1024;
export const MAX_STATEMENT_PDF_PAGES = 100;
export const MAX_STATEMENT_PDF_TEXT = 500_000;
const MAX_BASE64_LENGTH = Math.ceil(MAX_STATEMENT_PDF_BYTES / 3) * 4;

export function decodeStatementPdf(base64) {
  ensure(typeof base64 === "string" && base64.length > 0, "Choose a PDF statement to import.", 400, "INVALID_PDF");
  ensure(base64.length <= MAX_BASE64_LENGTH, "Choose a PDF statement smaller than 3 MB.", 413, "PDF_TOO_LARGE");
  ensure(base64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64), "The PDF upload is invalid. Choose the file again.", 400, "INVALID_PDF");
  const buffer = Buffer.from(base64, "base64");
  ensure(buffer.byteLength <= MAX_STATEMENT_PDF_BYTES, "Choose a PDF statement smaller than 3 MB.", 413, "PDF_TOO_LARGE");
  ensure(buffer.subarray(0, 5).toString("ascii") === "%PDF-", "Choose a valid PDF statement.", 400, "INVALID_PDF");
  return buffer;
}

// Parse uploaded bytes only. No document URL, remote font, image rendering or
// statement storage is exposed. The worker bounds CPU/heap independently of the
// API request so malformed PDFs cannot keep its Node event loop blocked.
export async function extractStatementPdf(base64) {
  const buffer = decodeStatementPdf(base64);
  const bytes = Uint8Array.from(buffer);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./statementPdfWorker.mjs", import.meta.url), {
      workerData: { bytes, maxPages: MAX_STATEMENT_PDF_PAGES, maxText: MAX_STATEMENT_PDF_TEXT },
      transferList: [bytes.buffer],
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    // PDF.js warnings can include document internals. Never persist them in
    // CloudWatch, and never return parser stack traces to the client.
    worker.stdout.resume();
    worker.stderr.resume();
    let finished = false;
    const finish = (failure, result, hardStop = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Do not immediately kill a successful worker while PDF.js destroys its
      // streams. Let cleanup finish, with a short hard-stop fallback. Abrupt
      // termination during that cleanup can crash Node on Windows.
      if (hardStop) void worker.terminate();
      else {
        const cleanup = setTimeout(() => { void worker.terminate(); }, 500);
        cleanup.unref();
        worker.once("exit", () => clearTimeout(cleanup));
      }
      if (failure) reject(failure); else resolve(result);
    };
    const timer = setTimeout(() => finish(new ApiError(422, "This PDF took too long to read. Try a smaller date range.", "PDF_EXTRACTION_TIMEOUT"), undefined, true), 8_000);
    worker.once("message", result => {
      if (result?.error) return finish(new ApiError(result.error.status || 422, result.error.message, result.error.code || "INVALID_PDF"));
      if (!Array.isArray(result?.pages) || result.pages.length > MAX_STATEMENT_PDF_PAGES || !result.pages.every(page => typeof page === "string") || result.pages.reduce((sum, page) => sum + page.length, 0) > MAX_STATEMENT_PDF_TEXT) {
        return finish(new ApiError(422, "The PDF statement could not be read.", "INVALID_PDF"));
      }
      finish(null, { pages: result.pages });
    });
    worker.once("error", () => finish(new ApiError(422, "This PDF could not be read within the import limits. Try a smaller statement.", "PDF_EXTRACTION_FAILED")));
    worker.once("exit", () => { if (!finished) finish(new ApiError(422, "The PDF statement could not be read.", "PDF_EXTRACTION_FAILED")); });
  });
}
