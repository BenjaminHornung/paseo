import { lstatSync, realpathSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

export const MISSING_AGENT_CWD_ERROR_CODE = "AGENT_CWD_MISSING" as const;

export class MissingAgentCwdError extends Error {
  readonly code = MISSING_AGENT_CWD_ERROR_CODE;
  readonly agentId: string;
  readonly cwd: string;

  constructor(agentId: string, cwd: string) {
    const absoluteCwd = resolve(cwd);
    super(
      [
        `Agent ${agentId} exists but its working directory is missing: ${absoluteCwd}.`,
        "Recreate the worktree or rebind the agent cwd, then retry send/continue.",
        "Timeline/logs can still be read when durable or in-memory history is available.",
      ].join(" "),
    );
    this.name = "MissingAgentCwdError";
    this.agentId = agentId;
    this.cwd = absoluteCwd;
  }
}

export function isMissingAgentCwdError(error: unknown): error is MissingAgentCwdError {
  return (
    error instanceof MissingAgentCwdError ||
    (error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === MISSING_AGENT_CWD_ERROR_CODE)
  );
}

function isMissingPathFsError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function pathIsExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathFsError(error)) return false;
    throw error;
  }
}

export async function assertAgentCwdExists(agentId: string, cwd: string): Promise<void> {
  const absoluteCwd = resolve(cwd);
  try {
    const stats = await stat(absoluteCwd);
    if (!stats.isDirectory()) throw new MissingAgentCwdError(agentId, absoluteCwd);
  } catch (error) {
    if (isMissingAgentCwdError(error)) throw error;
    if (isMissingPathFsError(error)) throw new MissingAgentCwdError(agentId, absoluteCwd);
    throw error;
  }
}

export function pathIsExistingDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (isMissingPathFsError(error)) return false;
    throw error;
  }
}

function recoveryPathHasLinkedSegment(candidate: string, root: string): boolean {
  let segment = candidate;
  while (segment !== root) {
    if (lstatSync(segment).isSymbolicLink()) return true;
    segment = dirname(segment);
  }
  return false;
}

function missingRecoveryCwd(agentId: string, absoluteCwd: string): MissingAgentCwdError {
  return new MissingAgentCwdError(agentId, absoluteCwd);
}

function assertRecoveryCandidateStable(
  agentId: string,
  absoluteCwd: string,
  candidate: string,
  root: string,
): string {
  try {
    if (recoveryPathHasLinkedSegment(candidate, root)) {
      throw missingRecoveryCwd(agentId, absoluteCwd);
    }

    const realCandidate = realpathSync.native(candidate);
    if (!pathIsExistingDirectorySync(realCandidate)) {
      throw missingRecoveryCwd(agentId, absoluteCwd);
    }
    if (realCandidate === parse(realCandidate).root) {
      throw missingRecoveryCwd(agentId, absoluteCwd);
    }

    if (recoveryPathHasLinkedSegment(candidate, root)) {
      throw missingRecoveryCwd(agentId, absoluteCwd);
    }

    const revalidatedRealCandidate = realpathSync.native(candidate);
    if (revalidatedRealCandidate !== realCandidate) {
      throw missingRecoveryCwd(agentId, absoluteCwd);
    }
    if (!pathIsExistingDirectorySync(revalidatedRealCandidate)) {
      throw missingRecoveryCwd(agentId, absoluteCwd);
    }
    if (revalidatedRealCandidate === parse(revalidatedRealCandidate).root) {
      throw missingRecoveryCwd(agentId, absoluteCwd);
    }

    return revalidatedRealCandidate;
  } catch (error) {
    if (isMissingAgentCwdError(error)) throw error;
    if (isMissingPathFsError(error)) throw missingRecoveryCwd(agentId, absoluteCwd);
    throw error;
  }
}

export function assertAgentCwdExistsSync(agentId: string, cwd: string): void {
  const absoluteCwd = resolve(cwd);
  if (!pathIsExistingDirectorySync(absoluteCwd)) {
    throw new MissingAgentCwdError(agentId, absoluteCwd);
  }
}

/**
 * Resolve a runtime-only recovery cwd for provider launch and recovery
 * loadSession/unstable_resumeSession calls. The fallback is constrained to an
 * existing, non-root ancestor of the recorded cwd, so recovery never launches
 * a provider in an unrelated temp or daemon directory and never changes the
 * recorded cwd used for persistence. Linkage and canonical identity are
 * revalidated, but this is not an atomic path-to-spawn guarantee: callers must
 * use it under a stable filesystem because concurrent mutation after this
 * function returns can still change the path before spawn.
 */
export function resolveSafeReadRecoveryCwd(agentId: string, recordedCwd: string): string {
  const absoluteCwd = resolve(recordedCwd);
  const root = parse(absoluteCwd).root;
  let candidate = dirname(absoluteCwd);

  while (candidate !== root) {
    if (pathIsExistingDirectorySync(candidate)) {
      return assertRecoveryCandidateStable(agentId, absoluteCwd, candidate, root);
    }
    candidate = dirname(candidate);
  }

  throw new MissingAgentCwdError(agentId, absoluteCwd);
}
