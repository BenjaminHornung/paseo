import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(
  readFileSync(path.join(root, "packages/orchestrator/lint-baseline.json"), "utf8"),
);
const arguments_ = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [path.join(root, "node_modules/oxlint/bin/oxlint"), "--format", "json", ...arguments_],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true },
);
if (result.error) throw result.error;
let output;
try {
  output = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stderr || result.stdout || "Oxlint did not return diagnostics.\n");
  process.exit(1);
}
if (!Array.isArray(output.diagnostics) || result.status === null || result.status > 1) {
  throw new Error("Oxlint failed before completing its source scan");
}
const sourceCache = new Map();
function diagnosticIdentity(diagnostic) {
  const filename = diagnostic.filename.replaceAll("\\", "/");
  let source = sourceCache.get(filename);
  if (!source) {
    source = readFileSync(path.join(root, filename));
    sourceCache.set(filename, source);
  }
  const hash = createHash("sha256");
  for (const label of diagnostic.labels) {
    hash.update(source.subarray(label.span.offset, label.span.offset + label.span.length));
    hash.update("\0");
  }
  return JSON.stringify([filename, diagnostic.code, diagnostic.message, hash.digest("hex")]);
}
const remaining = new Map();
for (const entry of baseline.entries) {
  if (
    !entry.file.startsWith("packages/orchestrator/") ||
    !Number.isSafeInteger(entry.count) ||
    entry.count < 1
  ) {
    throw new Error("Invalid controller lint baseline entry");
  }
  const identity = JSON.stringify([entry.file, entry.rule, entry.message, entry.sourceSha256]);
  if (remaining.has(identity)) throw new Error("Duplicate controller lint baseline entry");
  remaining.set(identity, entry.count);
}
let inherited = 0;
const failures = [];
for (const diagnostic of output.diagnostics) {
  const identity = diagnosticIdentity(diagnostic);
  const count = remaining.get(identity) ?? 0;
  if (count > 0) {
    remaining.set(identity, count - 1);
    inherited++;
  } else {
    failures.push(diagnostic);
  }
}
for (const diagnostic of failures) {
  const span = diagnostic.labels[0]?.span;
  console.error(
    `${diagnostic.filename}:${span?.line ?? 1}:${span?.column ?? 1} ${diagnostic.code}: ${diagnostic.message}`,
  );
}
console.log(
  `Oxlint: ${failures.length} new diagnostics; ${inherited} exact controller baseline diagnostics.`,
);
if (arguments_.length === 0) {
  const stale = [...remaining.values()].reduce((total, count) => total + count, 0);
  if (stale)
    console.log(`Controller baseline has ${stale} stale entries to remove after source cleanup.`);
}
process.exitCode =
  failures.length || (result.status !== 0 && output.diagnostics.length === 0) ? 1 : 0;
