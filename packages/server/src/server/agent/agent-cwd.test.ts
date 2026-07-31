import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import {
  assertAgentCwdExists,
  assertAgentCwdExistsSync,
  isMissingAgentCwdError,
  pathIsExistingDirectory,
  resolveSafeReadRecoveryCwd,
} from "./agent-cwd.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("ENOENT and ENOTDIR become structured missing-cwd errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-agent-cwd-"));
  tempDirs.push(root);
  const fileAncestor = join(root, "not-a-dir");
  writeFileSync(fileAncestor, "x");
  const paths = [join(root, "missing"), join(fileAncestor, "worktree")];

  for (const cwd of paths) {
    expect(await pathIsExistingDirectory(cwd)).toBe(false);
    await expect(assertAgentCwdExists("agent-1", cwd)).rejects.toSatisfy((error: unknown) => {
      expect(isMissingAgentCwdError(error)).toBe(true);
      expect((error as Error).message).toMatch(/working directory is missing/i);
      expect((error as Error).message).not.toMatch(/ENOENT|ENOTDIR|Agent not found/i);
      return true;
    });
    expect(() => assertAgentCwdExistsSync("agent-1", cwd)).toThrow(/working directory is missing/i);
  }
});

test("read recovery chooses an existing ancestor and never an unrelated cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-agent-recovery-"));
  tempDirs.push(root);
  const recordedCwd = join(root, "deleted-worktree", "nested");
  expect(resolveSafeReadRecoveryCwd("agent-1", recordedCwd)).toBe(realpathSync.native(root));

  const fileAncestor = join(root, "not-a-directory");
  writeFileSync(fileAncestor, "x");
  expect(resolveSafeReadRecoveryCwd("agent-2", join(fileAncestor, "nested"))).toBe(
    realpathSync.native(root),
  );
});

test("read recovery rejects a linked ancestor and an effective filesystem root", () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-agent-recovery-links-"));
  tempDirs.push(root);

  const target = join(root, "real-parent");
  mkdirSync(target);
  const linkedParent = join(root, "linked-parent");
  symlinkSync(target, linkedParent, process.platform === "win32" ? "junction" : "dir");
  expect(() => resolveSafeReadRecoveryCwd("agent-linked", join(linkedParent, "deleted"))).toThrow(
    /working directory is missing/i,
  );

  const filesystemRoot = parse(root).root;
  const rootLink = join(root, "root-link");
  symlinkSync(filesystemRoot, rootLink, process.platform === "win32" ? "junction" : "dir");
  expect(() => resolveSafeReadRecoveryCwd("agent-root-link", join(rootLink, "deleted"))).toThrow(
    /working directory is missing/i,
  );
  expect(() =>
    resolveSafeReadRecoveryCwd("agent-direct-root", join(filesystemRoot, "paseo-missing-cwd")),
  ).toThrow(/working directory is missing/i);
});

test("read recovery rejects a real descendant under a linked ancestor", () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-agent-recovery-linked-descendant-"));
  tempDirs.push(root);

  const target = join(root, "real-parent");
  const targetChild = join(target, "child");
  mkdirSync(targetChild, { recursive: true });
  const linkedParent = join(root, "linked-parent");
  symlinkSync(target, linkedParent, process.platform === "win32" ? "junction" : "dir");

  expect(() =>
    resolveSafeReadRecoveryCwd("agent-linked-descendant", join(linkedParent, "child", "deleted")),
  ).toThrow(/working directory is missing/i);
});

test("read recovery fails closed when a candidate becomes linked before canonical resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-agent-recovery-race-"));
  const unrelated = mkdtempSync(join(tmpdir(), "paseo-agent-recovery-unrelated-"));
  tempDirs.push(root, unrelated);

  const candidate = join(root, "safe-parent");
  mkdirSync(candidate);
  const recordedCwd = join(candidate, "deleted-worktree");
  const originalRealpath = realpathSync.native.bind(realpathSync);
  const realpathSpy = vi.spyOn(realpathSync, "native");
  realpathSpy.mockImplementation((path, options) => {
    if (typeof path === "string" && path === candidate) {
      rmSync(candidate, { recursive: true, force: true });
      symlinkSync(unrelated, candidate, process.platform === "win32" ? "junction" : "dir");
    }
    return originalRealpath(path, options);
  });

  expect(() => resolveSafeReadRecoveryCwd("agent-race", recordedCwd)).toThrow(
    /working directory is missing/i,
  );
  expect(realpathSpy).toHaveBeenCalledWith(candidate);
});
