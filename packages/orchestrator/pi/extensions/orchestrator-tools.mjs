import path from "node:path";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { hash, pathInScope } from "../../src/contracts.ts";

function canonicalTarget(file) {
  let parent = path.resolve(file);
  while (!existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw Error("Unsafe path");
    parent = next;
  }
  const resolved = path.resolve(realpathSync(parent), path.relative(parent, path.resolve(file)));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export default function orchestratorTools(pi) {
  if (process.env.PASEO_ORCHESTRATOR_SUPERVISED !== "1") return;
  const root = canonicalTarget(process.env.PASEO_ORCHESTRATOR_WORKTREE ?? process.cwd());
  let allowed = [];
  try {
    allowed = JSON.parse(process.env.PASEO_ORCHESTRATOR_ALLOWED_PATHS ?? "[]");
  } catch {}
  const inScope = (file) => {
    const relative = path
      .relative(root, canonicalTarget(path.resolve(root, file)))
      .replaceAll("\\", "/");
    return (
      relative !== "" &&
      !relative.startsWith("../") &&
      !path.isAbsolute(relative) &&
      allowed.some((item) => pathInScope(relative, item))
    );
  };
  const allowedExecCalls = new Set(),
    ownedSessions = new Set();
  pi.on("tool_result", (event) => {
    if (
      event.toolName === "exec_command" &&
      allowedExecCalls.delete(event.toolCallId) &&
      Number.isSafeInteger(event.details?.session_id)
    )
      ownedSessions.add(event.details.session_id);
    if (event.toolName === "write_stdin" && typeof event.details?.exit_code === "number")
      ownedSessions.delete(event.input.session_id);
  });
  pi.on("tool_call", (event, context) => {
    let reason;
    try {
      if (["exec_command", "powershell", "bash"].includes(event.toolName)) {
        const cwd = event.input.workdir ?? event.input.cwd ?? context.cwd;
        if (canonicalTarget(cwd) !== root) reason = "ORCHESTRATOR_WORKTREE_CWD_REQUIRED";
        const command = event.input.cmd ?? event.input.command ?? "";
        if (
          /Invoke-WmiMethod|Invoke-CimMethod|Win32_Process|schtasks|Register-ScheduledTask|sc\.exe\s+create|-Verb\s+RunAs|\b(?:wsl|docker|podman)(?:\.exe)?\b|ShellExecute/im.test(
            command,
          )
        )
          reason = "ORCHESTRATOR_UNMONITORED_PROCESS_BLOCKED";
      } else if (event.toolName === "apply_patch") {
        const patch = event.input.input ?? event.input.patch ?? "";
        const targets = [
          ...patch.matchAll(/^\*\*\* (?:Add File:|Update File:|Delete File:|Move to:) (.+)$/gm),
        ].map((match) => match[1].trim());
        if (!targets.length || targets.some((file) => !inScope(file)))
          reason = "ORCHESTRATOR_PATCH_SCOPE_BLOCKED";
      } else if (
        [
          "write",
          "edit",
          "write_file",
          "edit_file",
          "hashline_edit",
          "replace",
          "insert",
          "replace_match",
          "undo_last_change",
        ].includes(event.toolName)
      ) {
        if (!inScope(event.input.path ?? event.input.filePath ?? ""))
          reason = "ORCHESTRATOR_WRITE_SCOPE_BLOCKED";
      } else if (event.toolName === "write_stdin") {
        if (!ownedSessions.has(event.input.session_id) || (event.input.chars ?? "") !== "")
          reason = "ORCHESTRATOR_SESSION_INPUT_BLOCKED";
      } else if (
        !["read", "read_file", "grep", "rg", "find", "ls", "list", "search", "view_image"].includes(
          event.toolName,
        )
      )
        reason = "ORCHESTRATOR_UNKNOWN_TOOL_BLOCKED";
    } catch {
      reason = "ORCHESTRATOR_TOOL_POLICY_UNAVAILABLE";
    }
    if (!reason) {
      if (event.toolName === "exec_command") allowedExecCalls.add(event.toolCallId);
      return;
    }
    const audit = process.env.PASEO_ORCHESTRATOR_POLICY_EVENTS;
    try {
      if (audit)
        appendFileSync(
          audit,
          JSON.stringify({ callId: event.toolCallId, inputHash: hash(event.input), reason }) + "\n",
          { mode: 0o600 },
        );
    } catch {}
    return {
      block: true,
      reason: `${reason}: Keep command cwd in the contracted worktree; use absolute paths for permitted reads. Write only contracted files. Do not delegate.`,
    };
  });
}
