import test from "node:test";
import assert from "node:assert/strict";
import { decodeStatementPdf, extractStatementPdf, MAX_STATEMENT_PDF_BYTES } from "../src/core/statementPdf.js";
import { createHandler } from "../src/core/handler.js";
import { ApiError } from "../src/core/errors.js";

// A generated, synthetic PDF exercises real parser/worker packaging without
// storing financial statements, names or account numbers in the repository.
function pdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const children = [];
  for (const lines of pages) {
    const pageId = objects.length + 1, contentId = pageId + 1;
    children.push(`${pageId} 0 R`);
    const content = lines.map((line, index) => `BT /F1 12 Tf 36 ${760 - index * 20} Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${children.join(" ")}] >>`;
  let output = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output).toString("base64");
}

test("statement extraction keeps synthetic pages and logical rows separate", async () => {
  const result = await extractStatementPdf(pdf([["01 May, 2026", "Paid to Example Store", "UPI Transaction ID: 123456789"], ["02 May, 2026", "Received from Example", "35.15"]]));
  assert.equal(result.pages.length, 2);
  assert.match(result.pages[0], /01 May, 2026\nPaid to Example Store\nUPI Transaction ID: 123456789/);
  assert.match(result.pages[1], /02 May, 2026\nReceived from Example\n35\.15/);
});

test("statement upload rejects non-PDF, malformed base64 and oversized bytes before parsing", () => {
  for (const value of [undefined, "", "not base64", Buffer.from("not a PDF").toString("base64")]) assert.throws(() => decodeStatementPdf(value), error => error.code === "INVALID_PDF");
  assert.throws(() => decodeStatementPdf(Buffer.alloc(MAX_STATEMENT_PDF_BYTES + 1).toString("base64")), error => error.status === 413 && error.code === "PDF_TOO_LARGE");
});

test("statement extraction rejects scanned/image-only documents and excessive page counts", async () => {
  await assert.rejects(extractStatementPdf(pdf([[]])), error => error.code === "PDF_NO_TEXT");
  await assert.rejects(extractStatementPdf(pdf(Array.from({ length: 101 }, () => ["Statement"]))), error => error.status === 413 && error.code === "PDF_TOO_MANY_PAGES");
  await assert.rejects(extractStatementPdf(Buffer.from("%PDF-1.4\ninvalid").toString("base64")), error => error.code === "INVALID_PDF");
});

test("password-protected statements return an actionable error without accepting a password", async () => {
  const source = Buffer.from(pdf([["Statement"]]), "base64").toString("latin1");
  const encrypted = source.replace("/Root 1 0 R", "/Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>");
  await assert.rejects(extractStatementPdf(Buffer.from(encrypted, "latin1").toString("base64")), error => error.code === "PDF_PASSWORD_REQUIRED" && /unlocked statement/.test(error.message));
});

test("PDF endpoint requires Firebase auth and only extracts text without financial writes", async () => {
  const event = { rawPath: "/api/import/statement/pdf", requestContext: { http: { method: "POST" } }, body: JSON.stringify({ base64: pdf([["Statement"]]) }) };
  const denied = createHandler({}, async () => { throw new ApiError(401, "Sign in required."); }, {});
  assert.equal((await denied(event)).statusCode, 401);
  const allowed = createHandler({}, async () => ({ uid: "statement-test-user" }), {});
  const response = await allowed(event);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).pages.length, 1);
  assert.equal(response.body.includes("state"), false);
});
