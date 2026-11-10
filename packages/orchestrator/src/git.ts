import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { appRoot, codeRoot, powershellExecutable } from "./settings-files.ts";
import type { Contract } from "./contracts.ts";
import { localPath, pathInScope } from "./contracts.ts";

export interface InlineReviewFile {
  path: string;
  before: string | null;
  after: string | null;
}

export interface ReviewSourceIdentity {
  sourcePath: string;
  base: { gitBlobId: string; bytes: number; mode: string } | null;
  worktree: { sha256: string; bytes: number; mode: number } | null;
}

export type ReviewContext =
  | {
      format: "inline";
      baseCommit: string;
      diffHash: string;
      files: InlineReviewFile[];
    }
  | {
      format: "patch";
      baseCommit: string;
      diffHash: string;
      patch: string;
      manifest: ReviewSourceIdentity[];
    };

interface BaseFileIdentity {
  mode: string;
  gitBlobId: string;
  bytes: number;
}

interface WorktreeFileIdentity {
  sha256: string;
  bytes: number;
  mode: number;
}

interface ReviewFileState {
  path: string;
  base: BaseFileIdentity | null;
  worktree: WorktreeFileIdentity | null;
}

const MAX_REVIEW_CONTEXT_BYTES = 512_000;
const MAX_INLINE_REVIEW_CONTENT_BYTES = 512_000;

export class Git {
  readonly executable: string;
  private readonly peerAllowedPaths: (contract: Contract) => string[];
  constructor(executable: string, peerAllowedPaths: (contract: Contract) => string[] = () => []) {
    this.executable = localPath(executable);
    this.peerAllowedPaths = peerAllowedPaths;
  }
  run(cwd: string, args: string[]): string {
    return execFileSync(this.executable, ["--no-pager", "-c", "core.hooksPath=NUL", ...args], {
      cwd: localPath(cwd),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  isIsolatedWorkspace(cwd: string): boolean {
    try {
      const root = localPath(this.run(cwd, ["rev-parse", "--show-toplevel"]));
      const common = localPath(path.resolve(cwd, this.run(cwd, ["rev-parse", "--git-common-dir"])));
      const gitDirectory = localPath(this.run(cwd, ["rev-parse", "--absolute-git-dir"]));
      return (
        root === localPath(cwd) &&
        common !== gitDirectory &&
        this.run(cwd, ["branch", "--show-current"]).startsWith("feature/")
      );
    } catch {
      return false;
    }
  }
  validate(c: Contract): void {
    const root = this.run(c.worktree, ["rev-parse", "--show-toplevel"]);
    if (localPath(root) !== c.worktree) throw Error("Task worktree must be repository root");
    const common = (p: string) =>
      localPath(path.resolve(p, this.run(p, ["rev-parse", "--git-common-dir"])));
    if (common(c.repository) !== common(c.worktree))
      throw Error("Worktree belongs to another repository");
    if (this.run(c.worktree, ["rev-parse", "HEAD"]) !== c.baseCommit)
      throw Error("HEAD differs from contracted base; no automatic commit permitted");
    if (!this.run(c.worktree, ["branch", "--show-current"]).startsWith("feature/"))
      throw Error("Dedicated feature branch required");
  }
  createWorktree(repository: string, destination: string, slug: string): string {
    repository = localPath(repository);
    if (!/^[a-zA-Z0-9_-]+$/.test(slug) || existsSync(destination))
      throw Error("New worktree path and safe slug required");
    const parent = localPath(path.dirname(path.resolve(destination)));
    destination = path.join(parent, path.basename(destination));
    this.run(repository, ["worktree", "add", "-b", `feature/${slug}`, destination, "HEAD"]);
    return localPath(destination);
  }
  reviewContext(c: Contract): ReviewContext {
    const snapshot = this.snapshot(c);
    if (snapshot.scopeViolations || snapshot.diffHash !== c.reviewDiffHash)
      throw Error("Review context differs from approved scope or snapshot");
    const files = snapshot.files.map((name) => this.reviewFileState(c, name));
    const inlineContentBytes = files.reduce(
      (total, file) => total + (file.base?.bytes ?? 0) + (file.worktree?.bytes ?? 0),
      0,
    );

    let context: ReviewContext | undefined;
    if (inlineContentBytes <= MAX_INLINE_REVIEW_CONTENT_BYTES) {
      const inlineCandidate: ReviewContext = {
        format: "inline",
        baseCommit: c.baseCommit,
        diffHash: snapshot.diffHash,
        files: files.map((file) => this.inlineReviewFile(c, file)),
      };
      if (Buffer.byteLength(JSON.stringify(inlineCandidate)) <= MAX_REVIEW_CONTEXT_BYTES)
        context = inlineCandidate;
    }

    if (!context) {
      let patchBytes = 0;
      const patches: string[] = [];
      for (const file of files) {
        const remainingBytes = MAX_REVIEW_CONTEXT_BYTES - patchBytes;
        if (remainingBytes <= 0) throw Error("Review context too large");
        const patch = this.reviewFilePatch(c, file, remainingBytes);
        patchBytes += Buffer.byteLength(patch);
        if (patchBytes > MAX_REVIEW_CONTEXT_BYTES) throw Error("Review context too large");
        patches.push(patch);
      }
      context = {
        format: "patch",
        baseCommit: c.baseCommit,
        diffHash: snapshot.diffHash,
        patch: patches.join(""),
        manifest: files.map((file) => ({
          sourcePath: file.path,
          base: file.base,
          worktree: file.worktree,
        })),
      };
    }

    if (Buffer.byteLength(JSON.stringify(context)) > MAX_REVIEW_CONTEXT_BYTES)
      throw Error("Review context too large");
    const finalSnapshot = this.snapshot(c);
    if (
      finalSnapshot.scopeViolations ||
      finalSnapshot.diffHash !== snapshot.diffHash ||
      JSON.stringify(finalSnapshot.files) !== JSON.stringify(snapshot.files)
    )
      throw Error("Review context changed while reading");
    return context;
  }

  private reviewFileState(c: Contract, name: string): ReviewFileState {
    const absolute = this.reviewSourcePath(c, name);
    const base = this.baseFileIdentity(c, name);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { path: name, base, worktree: null };
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile())
      throw Error("Symlink/submodule changes require manual inspection");
    if (!localPath(absolute).startsWith(localPath(c.worktree) + path.sep))
      throw Error("Unsafe review source path");

    const content = readFileSync(absolute);
    if (content.includes(0)) throw Error("Review requires manual binary inspection");
    return {
      path: name,
      base,
      worktree: {
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
        mode: stat.mode & 0o777,
      },
    };
  }

  private reviewSourcePath(c: Contract, name: string): string {
    const absolute = path.resolve(c.worktree, name);
    const relative = path.relative(c.worktree, absolute);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      name.split("/").includes(".git")
    )
      throw Error("Unsafe review source path");
    return absolute;
  }

  private baseFileIdentity(c: Contract, name: string): BaseFileIdentity | null {
    const output = execFileSync(
      this.executable,
      ["ls-tree", "-z", c.baseCommit, "--", `:(literal)${name}`],
      {
        cwd: c.worktree,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const entries = output.split("\0").filter(Boolean);
    if (!entries.length) return null;
    if (entries.length !== 1) throw Error("Review base path is ambiguous");
    const entry = entries[0];
    const separator = entry.indexOf("\t");
    if (separator < 0 || entry.slice(separator + 1) !== name)
      throw Error("Review base path could not be verified");
    const [mode, type, gitBlobId] = entry.slice(0, separator).split(" ");
    const bytes = Number(this.run(c.worktree, ["cat-file", "-s", gitBlobId]));
    if (
      type !== "blob" ||
      !["100644", "100755"].includes(mode) ||
      !/^[a-f0-9]{40,64}$/.test(gitBlobId) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    )
      throw Error("Symlink/submodule or invalid base file requires manual inspection");
    return { mode, gitBlobId, bytes };
  }

  private inlineReviewFile(c: Contract, file: ReviewFileState): InlineReviewFile {
    let before: string | null = null;
    if (file.base) {
      const content = execFileSync(this.executable, ["cat-file", "blob", file.base.gitBlobId], {
        cwd: c.worktree,
        encoding: "buffer",
        maxBuffer: MAX_INLINE_REVIEW_CONTENT_BYTES + 1,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (content.byteLength !== file.base.bytes)
        throw Error("Review base content identity changed");
      if (content.includes(0)) throw Error("Review requires manual binary inspection");
      before = content.toString("utf8");
    }

    let after: string | null = null;
    if (file.worktree) {
      const content = readFileSync(this.reviewSourcePath(c, file.path));
      if (
        content.byteLength !== file.worktree.bytes ||
        createHash("sha256").update(content).digest("hex") !== file.worktree.sha256
      )
        throw Error("Review context changed while reading");
      if (content.includes(0)) throw Error("Review requires manual binary inspection");
      after = content.toString("utf8");
    }
    return { path: file.path, before, after };
  }

  private reviewFilePatch(c: Contract, file: ReviewFileState, remainingBytes: number): string {
    const args = file.base
      ? [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-renames",
          "--full-index",
          "--unified=3",
          c.baseCommit,
          "--",
          `:(literal)${file.path}`,
        ]
      : [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-renames",
          "--full-index",
          "--unified=3",
          "--",
          "/dev/null",
          file.path,
        ];
    const result = spawnSync(this.executable, ["--no-pager", "-c", "core.hooksPath=NUL", ...args], {
      cwd: c.worktree,
      encoding: "buffer",
      maxBuffer: remainingBytes + 1,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (
      ["ENOBUFS", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(
        (result.error as NodeJS.ErrnoException | undefined)?.code ?? "",
      )
    )
      throw Error("Review context too large");
    if (result.error) throw Error("Unable to generate exact review patch");
    if (result.status !== 0 && !(file.base === null && result.status === 1))
      throw Error("Unable to generate exact review patch");
    const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
    if (output.byteLength > remainingBytes) throw Error("Review context too large");
    const patch = output.toString("utf8");
    if (/^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch))
      throw Error("Review requires manual binary inspection");
    return patch;
  }
  snapshot(c: Contract): {
    diffHash: string;
    files: string[];
    scopeViolations: number;
    diffCheckExit: number;
  } {
    this.validate(c);
    // Keep NUL output intact: trim() would alter filenames ending in whitespace.
    const names = (args: string[]) =>
      execFileSync(this.executable, args, {
        cwd: c.worktree,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      })
        .split("\0")
        .filter(Boolean);
    const files = [
      ...new Set([
        ...names(["diff", "--no-renames", "--name-only", "-z", c.baseCommit, "--"]),
        ...names(["ls-files", "--others", "--exclude-standard", "-z"]),
      ]),
    ].sort();
    const h = createHash("sha256").update(c.baseCommit);
    for (const name of files) {
      const absolute = path.resolve(c.worktree, name);
      if (!absolute.startsWith(c.worktree + path.sep) || name.split("/").includes(".git"))
        throw Error("Unsafe diff path");
      if (!existsSync(absolute)) {
        h.update(JSON.stringify([name, "deleted"]));
        continue;
      }
      const st = lstatSync(absolute);
      if (st.isSymbolicLink() || !st.isFile())
        throw Error("Symlink/submodule changes require manual inspection");
      // Resolve every parent junction before reading repository content.
      if (!localPath(absolute).startsWith(c.worktree + path.sep))
        throw Error("File resolves outside worktree");
      const contentHash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      h.update(JSON.stringify([name, st.mode, contentHash]));
    }
    const allowed = [...c.allowedPaths, ...this.peerAllowedPaths(c)];
    const scopeViolations = files.filter(
      (file) => !allowed.some((allowedPath) => pathInScope(file, allowedPath)),
    ).length;
    const diffCheckExit =
      spawnSync(this.executable, ["diff", "--check", c.baseCommit, "--"], {
        cwd: c.worktree,
        stdio: "ignore",
      }).status ?? -1;
    return { diffHash: h.digest("hex"), files, scopeViolations, diffCheckExit };
  }
}

export function runCheck(
  command: string[],
  cwd: string,
  timeoutMs = 120000,
): {
  exit: number;
  logHash: string;
  quiescent: boolean;
  diagnostic?: {
    timedOut: boolean;
    rootExitBeforeCleanup: number | null;
    activeAtTimeout: number;
    codes: string[];
    counts: { outcome: string; count: number }[];
  };
} {
  const executable = localPath(command[0]);
  for (const arg of command.slice(1)) {
    const fileArgument = arg.match(/^[-/][^=]+=(.+)$/)?.[1] ?? arg;
    if (/\.(?:[cm]?js|ts|ps1|exe|cmd|bat)$/i.test(fileArgument))
      localPath(path.resolve(cwd, fileArgument));
  }
  if (/dotnet(?:\.exe)?$/i.test(executable) && command[1] === "test")
    throw Error("Use Invoke-DotnetTest.ps1 launcher");
  cwd = localPath(cwd);
  const scratch = path.join(appRoot, "state/check-tmp");
  mkdirSync(scratch, { recursive: true });
  const request = Buffer.from(
    JSON.stringify({ command: [executable, ...command.slice(1)], cwd, timeoutMs }),
  ).toString("base64");
  const r = spawnSync(
    localPath(powershellExecutable),
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(codeRoot, "scripts/check-job.ps1"),
      "-Request",
      request,
    ],
    {
      cwd,
      env: { ...process.env, TMP: scratch, TEMP: scratch },
      shell: false,
      encoding: "utf8",
      timeout: timeoutMs + 20000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const match = r.status === 0 && r.stdout?.trim().match(/ORCHESTRATOR_CHECK_RESULT:(\{[^\n]+\})$/);
  const result = match
    ? (JSON.parse(match[1]) as {
        exit: number;
        quiescent: boolean;
        timedOut?: boolean;
        rootExitBeforeCleanup?: number;
        activeAtTimeout?: number;
      })
    : undefined;
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  const codes = [
    ...new Set(
      output.match(
        /\b(?:TS\d{4}|CS\d{4}|MSB\d{4}|NETSDK\d{4}|ERR_NETWORK_ACCESS_DENIED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM)\b/g,
      ) ?? [],
    ),
  ].slice(0, 12);
  const counts = [...output.matchAll(/\b(\d+) (passed|failed|skipped|todo)\b/g)]
    .slice(-12)
    .map((match) => ({ outcome: match[2], count: Number(match[1]) }));
  // Store hashes, never raw tool output that may contain repository secrets.
  return {
    exit: result?.exit ?? -1,
    quiescent: result?.quiescent === true,
    logHash: createHash("sha256")
      .update(r.stdout ?? "")
      .update(r.stderr ?? "")
      .digest("hex"),
    diagnostic: {
      timedOut: result?.timedOut === true,
      rootExitBeforeCleanup: result?.rootExitBeforeCleanup ?? null,
      activeAtTimeout: result?.activeAtTimeout ?? 0,
      codes,
      counts,
    },
  };
}
