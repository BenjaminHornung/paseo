# Advanced workflows with Playbooks

Advanced uses the Playbooks plugin for new managed workflows. The repository's
`.paseo/plugins/playbooks/work.yaml` runs one implementation writer, an independent
verifier and an independent reviewer. The graph has no model manager or Sidekick.
Each review edge permits one return to implementation, at most two returns in all.
An exhausted chain or loop limit remains visible for the lead to resolve.

The automatic tiers use the existing Claude, Codex and DeepSeek Go subscriptions.
Paid OpenAI API profiles remain configured for their existing uses and are absent
from the automatic tiers. Provider/model/mode/thinking are set per target. A target
that reports quota exhaustion advances to the next target in its tier.

## Pinned plugin and compatibility changes

The local installation is based on `lerenn/paseo-playbooks` v0.115.2, upstream commit
`47540935f9a3e738688174d5bd4bf31d67a1513d`. The adjacent
[`compatibility.patch`](../scripts/playbooks/compatibility.patch) records the local
changes: execute `.ps1` checks through PowerShell 7 on Windows and give replacement
step agents a concrete predecessor reference for `get_agent_activity`. It includes
the focused regression test for both PowerShell launch sites.

A replacement uses the same attempt and checkout with a new native session. Its
brief points to the predecessor's activity; it does not copy the entire transcript.
Before writing, it must inspect that activity, the actual diff and unfinished
processes. Starting a replacement is not evidence that a predecessor's background
work settled. Existing task-specific ownership and acceptance rules still apply.

## Pi subscription alias

The dedicated `pi-playbooks` provider extends `pi` and runs
[`pi-playbooks.mjs`](../scripts/playbooks/pi-playbooks.mjs) through the installed
Node executable. Its `PASEO_PLAYBOOKS_PI_BASE_LAUNCHER` environment value references
the existing Pi launcher. The wrapper resolves the current CLI and explicit
extension paths from that launcher on each start. It enables `builtin:mcp` and
its `builtin:codemode` discovery executor in addition to those explicit extensions,
omits the shared Freeflow extension, and retains `--no-extensions`. No subagent
extension is enabled.

This alias is necessary because the normal Pi launcher disables MCP. Normal Pi,
its existing profiles, authentication and launcher remain unchanged. The alias
uses the existing profile by reference; credentials never belong in this repository.
The host must have MCP injection enabled for plugin tools and `pwsh.exe` on PATH.

## Handover and rollback

Before switching a host, validate the actual playbook catalog and prove native
reporting, Windows checks and predecessor-context recovery on that host's runtime.
Preserve the current task's native writer and checkout until its work is handed off.
Do not start a second writer or replay a completed external action.

Pause dispatch in the old Orchestrator, then disable its plugin. Keep its database,
configuration, credential references and existing native sessions. The bundled
Advanced plugin registration preserves an explicit `enabled: false` setting.
Install and enable the pinned Playbooks directory, then verify its catalog and a
harmless real workflow. Installing the plugin does not migrate or rerun old tasks.

For rollback, stop new Playbooks starts and wait for owned work to settle, disable
Playbooks, then re-enable the preserved Orchestrator. Never let both dispatchers
own the same task. Database migrations, deployments and other external writes
continue to require the task's existing authorization and target checks.
