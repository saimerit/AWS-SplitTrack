import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, ".build");
await fs.mkdir(path.join(out, "handlers"), { recursive: true });
await build({
  entryPoints: [path.join(root, "src/core/handler.js")],
  outfile: path.join(out, "core.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await build({
  entryPoints: [path.join(root, "src/core/statementPdfWorker.mjs")],
  outfile: path.join(out, "statementPdfWorker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
for (const name of ["api", "auth", "state", "health", "changelog"])
  await fs.writeFile(
    path.join(out, "handlers", `${name}.js`),
    "export { handler } from '../core.mjs';\n",
  );
await fs.writeFile(
  path.join(out, "package.json"),
  JSON.stringify({ type: "module" }),
);
console.log("Built the shared Lambda bundle and five existing entry points.");
