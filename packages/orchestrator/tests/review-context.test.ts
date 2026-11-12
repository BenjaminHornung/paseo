import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { localPath, type Contract } from "../src/contracts.ts";
import { Git } from "../src/git.ts";

function removeTestRepository(directory: string): void {
  if (process.platform !== "win32") {
    rmSync(directory, { recursive: true, force: true });
    return;
  }
  const target = path.resolve(directory);
  const parent = path.resolve(process.cwd());
  if (path.dirname(target) !== parent || !path.basename(target).startsWith(".review-context-test-"))
    throw Error("Refusing to remove a path outside the review-context test fixture");
  const escapedTarget = target.replaceAll("'", "''");
  const script =
    `$ErrorActionPreference = 'Stop'; $target = '${escapedTarget}'; ` +
    "Get-ChildItem -LiteralPath $target -File -Force -Recurse | ForEach-Object { $_.IsReadOnly = $false }; " +
    "Remove-Item -LiteralPath $target -Recurse -Force";
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  execFileSync(
    path.join(
      process.env.SystemRoot ?? "C:/Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
    {
      stdio: "ignore",
    },
  );
}

test("large review sources use a bounded exact patch and reject stale or oversized contexts", (context) => {
  const root = mkdtempSync(path.join(process.cwd(), ".review-context-test-"));
  const canonicalRoot = localPath(root);
  context.after(() => removeTestRepository(root));
  const gitExecutable = execFileSync(
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32/where.exe")
      : "/usr/bin/which",
    ["git"],
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean)!;
  const runGit = (args: string[]) =>
    execFileSync(gitExecutable, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

  runGit(["init"]);
  runGit(["checkout", "-b", "feature/review-context"]);
  runGit(["config", "user.name", "Review Context Test"]);
  runGit(["config", "user.email", "review-context@example.invalid"]);
  runGit(["config", "core.autocrlf", "false"]);

  const sourcePath = "src/large.ts";
  const quotedSourcePath = "src/quoted.ts";
  const smallSourcePath = "src/small.ts";
  const absoluteSourcePath = path.join(root, sourcePath);
  mkdirSync(path.dirname(absoluteSourcePath), { recursive: true });
  const absoluteQuotedSourcePath = path.join(root, quotedSourcePath);
  const absoluteSmallSourcePath = path.join(root, smallSourcePath);
  const targetLine = "export const target = 'before';\n";
  const quotedBaseContent = '// "\n'.repeat(50_000);
  const smallBaseContent = "export const small = 'before';\n";
  const lines = Array.from(
    { length: 50_000 },
    (_, index) => `export const item${index} = ${index}; // ${"source-body ".repeat(3)}\n`,
  );
  lines[25_000] = targetLine;
  const baseContent = lines.join("");
  assert.ok(Buffer.byteLength(baseContent) > 2_000_000);
  writeFileSync(absoluteSourcePath, baseContent);
  writeFileSync(absoluteQuotedSourcePath, quotedBaseContent);
  writeFileSync(absoluteSmallSourcePath, smallBaseContent);
  runGit(["add", sourcePath]);
  runGit(["add", quotedSourcePath]);
  runGit(["add", smallSourcePath]);
  runGit(["commit", "-m", "add large review source"]);

  const baseCommit = runGit(["rev-parse", "HEAD"]);
  const contract = {
    repository: canonicalRoot,
    worktree: canonicalRoot,
    baseCommit,
    reviewDiffHash: "",
    allowedPaths: ["src"],
  } as Contract;
  const git = new Git(gitExecutable);
  const smallAfterContent = smallBaseContent.replace("before", "after");
  writeFileSync(absoluteSmallSourcePath, smallAfterContent);
  const smallSnapshot = git.snapshot(contract);
  const inlineReview = git.reviewContext({ ...contract, reviewDiffHash: smallSnapshot.diffHash });
  assert.equal(inlineReview.format, "inline");
  if (inlineReview.format !== "inline")
    throw Error("Expected small source context to remain inline");
  assert.deepEqual(inlineReview.files, [
    { path: smallSourcePath, before: smallBaseContent, after: smallAfterContent },
  ]);

  writeFileSync(absoluteSmallSourcePath, smallBaseContent);
  const quotedAfterContent = quotedBaseContent.replace('// "\n', '// x"\n');
  assert.ok(Buffer.byteLength(quotedBaseContent) + Buffer.byteLength(quotedAfterContent) < 512_000);
  assert.ok(
    Buffer.byteLength(JSON.stringify(quotedBaseContent)) +
      Buffer.byteLength(JSON.stringify(quotedAfterContent)) >
      512_000,
  );
  writeFileSync(absoluteQuotedSourcePath, quotedAfterContent);
  const quotedSnapshot = git.snapshot(contract);
  const quotedReview = git.reviewContext({ ...contract, reviewDiffHash: quotedSnapshot.diffHash });
  assert.equal(quotedReview.format, "patch");
  if (quotedReview.format !== "patch")
    throw Error("Escaped inline content that exceeds the cap must fall back to patch context");
  assert.match(quotedReview.patch, /\+\/\/ x"/);
  assert.ok(Buffer.byteLength(quotedReview.patch) < 1_024);
  assert.deepEqual(
    quotedReview.manifest.map((file) => file.sourcePath),
    [quotedSourcePath],
  );
  assert.ok(Buffer.byteLength(JSON.stringify(quotedReview)) <= 512_000);

  writeFileSync(absoluteQuotedSourcePath, quotedBaseContent);
  writeFileSync(absoluteSmallSourcePath, smallAfterContent);
  const approvedContent = baseContent.replace(targetLine, targetLine.replace("before", "change"));
  writeFileSync(absoluteSourcePath, approvedContent);
  const newSourcePath = "src/new.ts";
  writeFileSync(path.join(root, newSourcePath), "export const created = true;\n");
  const approvedSnapshot = git.snapshot(contract);
  const approvedContract = { ...contract, reviewDiffHash: approvedSnapshot.diffHash };
  const review = git.reviewContext(approvedContract);
  assert.equal(review.format, "patch");
  if (review.format !== "patch") throw Error("Expected the large source set to use patch context");
  assert.match(review.patch, /-export const target = 'before';/);
  assert.match(review.patch, /\+export const target = 'change';/);
  assert.match(review.patch, /\+export const created = true;/);
  assert.ok(Buffer.byteLength(JSON.stringify(review)) <= 512_000);
  assert.deepEqual(
    review.manifest.map((file) => file.sourcePath),
    [sourcePath, newSourcePath, smallSourcePath],
  );
  assert.match(review.manifest[0].base?.gitBlobId ?? "", /^[a-f0-9]{40,64}$/);
  assert.equal(
    review.manifest[0].worktree?.sha256,
    createHash("sha256").update(approvedContent).digest("hex"),
  );

  assert.throws(
    () => git.reviewContext({ ...contract, reviewDiffHash: "0".repeat(64) }),
    /Review context differs from approved scope or snapshot/,
  );

  const oversizedContent = lines
    .map((line, index) => line.replace(`= ${index};`, `= ${index + 100_000};`))
    .join("");
  writeFileSync(absoluteSourcePath, oversizedContent);
  const oversizedSnapshot = git.snapshot(approvedContract);
  assert.throws(
    () => git.reviewContext({ ...approvedContract, reviewDiffHash: oversizedSnapshot.diffHash }),
    /Review context too large/,
  );
});
