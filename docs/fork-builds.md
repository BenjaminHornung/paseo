# Paseo Advanced Windows builds

The active-subagent sidebar requires the matching Advanced renderer, plugin UI API and
Orchestrator plugin from the same full Windows package. Do not install this plugin or
controller build as a standalone overlay on an earlier renderer. Build metadata records
the required public `ActiveSubagents` UI export. An older renderer shows an upgrade
message instead of a fabricated empty subagent list.

The `Paseo Advanced Windows artifacts` workflow builds unsigned Windows x64 downloads in
`BenjaminHornung/paseo` by manual dispatch on the desired branch.
It uses the committed npm lockfile and upstream's desktop build and packaged-app
smoke. Ordinary pushes and PR updates do not start a package build.

## Fork CI usage

Only `fork-windows.yml` is enabled in this fork's repository Actions settings.
The twelve inherited upstream workflows are disabled there, including the broad
PR test matrix, Linux packaging, deployment, Docker and release workflows. Their
source files remain intact for upstream merges and deliberate future use.
The last observed upstream PR run used 21 jobs plus a separate Linux package job;
the Advanced workflow uses one Windows x64 job with its existing checks and smoke.

Start a complete verified package only when a new download is needed:

```powershell
gh workflow run fork-windows.yml --repo BenjaminHornung/paseo --ref feature/orchestrator-composer-windows-ci
```

Concurrent runs on the same branch cancel the superseded run. Dependency caching,
14-day artifact retention and all package acceptance checks are retained.
When re-enabling fork Actions, verify that only the Advanced workflow is active;
do not enable the inherited workflows together unless their jobs are needed.

## Download and update

1. Open the successful **Paseo Advanced Windows artifacts** run for the desired commit in
   [GitHub Actions](https://github.com/BenjaminHornung/paseo/actions/workflows/fork-windows.yml).
2. Download `paseo-advanced-windows-x64-<commit>`. Extract the outer Actions ZIP to find
   the NSIS installer, application ZIP, `SHA256SUMS.txt` and `build-info.json`.
3. Compare the run commit with `build-info.json` and check the installer/application
   ZIP with `Get-FileHash -Algorithm SHA256` before choosing an install time.

These artifacts are unsigned. Windows may show an unknown-publisher prompt.
The pipeline never installs them, replaces a running renderer, publishes a release,
sets secrets or uses a paid runner. Installing is a separate user action.
Advanced uses a different Windows installer identity and can coexist with upstream:

| Item                     | Upstream           | This Windows fork          |
| ------------------------ | ------------------ | -------------------------- |
| Product                  | Paseo              | Paseo Advanced             |
| Installer application ID | `sh.paseo.desktop` | `sh.paseo.advanced`        |
| Executable               | `Paseo.exe`        | `PaseoAdvanced.exe`        |
| Optional installed CLI   | `paseo.cmd`        | `paseo-advanced.cmd`       |
| Desktop profile          | `%APPDATA%/Paseo`  | `%APPDATA%/Paseo Advanced` |
| Default daemon home      | `~/.paseo`         | `~/.paseo-advanced`        |
| Default daemon TCP port  | `6767`             | `6777`                     |
| OS agent-link protocol   | `paseo://`         | `paseo-advanced://`        |

The renderer's internal `paseo://app` origin remains unchanged; it is separate
from OS protocol registration. Existing explicit home/listen overrides and daemon
configuration still win over defaults. No original profiles or credentials are copied.
The Advanced CLI opens its own executable, including from a portable ZIP, and its
optional PATH installation uses a distinct command. Profiles, single-instance locks
and daemon ownership are separate by default. Other platform packaging keeps the
upstream identity; this renamed distribution currently targets Windows only.

The desktop version maps upstream `0.MINOR.PATCH` to `1.MINOR.PATCH`, initially
`1.16.0-beta.1`, and is shown in the app's About settings. Prerelease suffixes are
preserved. Package metadata records the
exact upstream version separately; server/client/plugin source packages keep their
upstream versions. Daemon restart decisions compare the bundled upstream version,
so the branding change cannot trigger a version-mismatch restart loop. The config
stops with a clear error if upstream moves beyond major zero, requiring a new mapping.
The bundled updater points to `BenjaminHornung/paseo`, not `getpaseo/paseo`.
This workflow does not publish updater manifests or enable automatic fork releases;
updates from these Actions artifacts are manual.

Artifacts expire after 14 days. Re-run a build to obtain fresh downloads.
The `fork-windows-smoke-<commit>` artifact contains isolated packaged-runtime evidence.
Package smoke does not establish acceptance against the user's running controller.

## Permanent automation acceptance

### Existing main and isolated source workspace

An existing main may keep its non-Git umbrella directory. Use `orchestrator_worktree`
with the actual repository inside that directory, then pass the exact returned
worktree to `orchestrator_register_task`. No `workspace` ID or private
`workerPlacement` setting is required. An already-created worktree from the same
main is accepted when it still matches that operation's main-bound path, feature
branch, Git repository and contracted base. An unrelated checkout or a different
worktree path is rejected before opening a worker workspace.

For a separate writable worktree, registration opens/reuses the public source
workspace and pins its verified identity in the task contract. The worker's
actual provider cwd and write root are that isolated source directory. The main
retains its original workspace, cwd, native session and history. Parentage is
preserved: the worker remains in the main's Subagents track and is also opened
as a tab in its own source workspace, following the existing
[cross-workspace lifecycle](agent-lifecycle.md). Read-only/main-workspace placement
and the existing checks for later workspace drift are unchanged.

This path preserves input authorization, data scopes, routing/budget checks,
isolation, leases, process observations, checks and review. It is not permission
to edit a worktree outside the registered main's repository scope. Source checks
with SDK stubs do not establish installed-runtime or full COMPLETE acceptance.
The controller/plugin repair metadata includes the installed `8cde2ffce` controller
input as a compatible base. Deploying that matching code remains a separate
reviewed package-integration step; no private automation-state edit is needed.

An installer or composer receipt alone is not proof of autonomous orchestration.
The compatible controller/plugin must use the new daemon's actual public background-work
and native terminal-session metadata, with a capability preflight before starting writers.
An older standalone daemon or older controller SDK cannot acquire these capabilities
merely by connecting a newer renderer. This package bundles the controller/plugin
and the compiled fork SDK. Its code lives in `resources/orchestrator`; its configuration,
state, watch lease and credential storage live under `~/.paseo-advanced/orchestrator`.
The Advanced daemon registers that bundled plugin on first start. No original controller
configuration, state, funding or credentials are copied into these public build artifacts.
The initial configuration uses orchestration V3 with API access and dispatch disabled,
zero budgets and unverified routes. Complete the settings in the new Advanced profile
before enabling real routing; the package never grants a new API allowance.

The shipped plugin bundles its workspace SDK dependencies at build time. It needs no
checkout, plugin-local `node_modules` or dependency installation on the user's machine.
The Windows build smoke copies the packaged distribution outside the checkout before
starting it and requires the bundled plugin and its controller settings RPC to work there.
It also cold-starts the Advanced CLI in an isolated user profile without `PASEO_HOME`
or `--home`, exercising the default `.paseo-advanced` home. An inherited `PASEO_HOME`
still explicitly selects that home; from an upstream Paseo terminal use
`paseo-advanced.cmd --home C:/Users/<user>/.paseo-advanced ...` or clear that override
in the calling process. This does not change the user's global environment.

For plugin-only changes to an existing Advanced installation, the successful run provides
`paseo-advanced-plugin-repair-<commit>`. Check its `pluginFileSha256` values against
the three files in `paseo-plugin/` and confirm `pluginCompatibleControllerInputSha256`
includes the installed `resources/orchestrator/dist/build-info.json`'s
`compiledInputSha256`. The build's own controller hash can differ because its SDK
also includes the additive agent label action; the plugin bundles that SDK and
uses the existing daemon update operation. Copy only those
three files into `resources/orchestrator/paseo-plugin/`, preserving the existing
data/configuration, then run the Advanced CLI with its explicit home:
`plugin reload paseo-orchestrator`, followed by `plugin ls --json` and require `running`.
This repairs the bundled plugin without replacing the renderer or restarting the
daemon. The full installer/ZIP includes the same fix for new installations.

### Confirm an uncertain intake assessment

Open the main's Orchestrator panel, expand the Decisions history and select the
original human intake. **Modellbewertung bestätigen…** shows the model answer
and any single following unverified answer. Confirm only when that following
answer belongs to this assessment. The second button explicitly confirms the
selected assessment; it sends no chat message and starts no task or model call.
The original message, model response and human-origin evidence remain immutable.
The controller records a separate confirmation bound to the exact assessment and
the following answer's assessment hash. Another input, changed answer, different
scope, pending decision or non-idle main blocks the action.
Intake reads use the daemon's projected timeline: native agent reports are tool
messages, not new human requests. Human-origin receipts are still mandatory for
the original task; text that merely resembles a report is never sufficient proof.

An explicitly confirmed **new task** supersedes legacy classification markers
created before that task's original human-input receipt. This does not classify
those old observations, grant their instructions authority or clear newer pending
input. Change requests and approvals cannot supersede those markers.

The operator CLI uses the same identity/idle/head checks:
`intake-approve <agentId> <assessmentId> <originalMessageId> <reason> [confirmationJson]`.
The optional JSON has exactly `assessmentId`, `messageId` and `assessmentHash` for
the single following unverified assessment. It is an explicit classification of
that answer as confirmation, never a manufactured human receipt or a new grant.

This fix requires the matching controller **and** plugin. Use the successful
run's `paseo-advanced-controller-repair-<commit>` or full Windows package. The old
three-file plugin repair cannot upgrade an older controller for this operation;
its compatibility list deliberately excludes those old controller hashes.
The controller repair contains only compiled `dist/` code and verification metadata,
including the three compiled plugin files under `paseo-plugin/` inside that dist
tree. After independent source/artifact review and choosing an idle installation
time, back up the existing code, replace `resources/orchestrator/dist/`, and copy
its three `dist/paseo-plugin/` entries to `resources/orchestrator/paseo-plugin/`.
Preserve `~/.paseo-advanced/orchestrator` entirely. Public plugin reload applies the
code; no renderer replacement or daemon restart is required. An existing running
controller watch process must be verified stopped through its supported lifecycle
before replacing code; do not stop unrelated or unidentified processes.

### Prepare an existing main for the normal composer

From that chat, choose **Diesen Hauptchat für den Composer vorbereiten** in the
Command Center, or **Hauptchat vorbereiten** in its Orchestrator panel. The existing
project, workspace, model, reasoning and mode are fixed; select the data scope and
whether to prepare Auto-Routing. The form waits for an idle chat with no active turn
or pending permissions. The public `orchestrator.prepare-session` RPC accepts the
same fields as new-session preparation plus `agentId` and the existing `workspaceId`.
It rejects a busy or ineligible target without changing it.

Preparation keeps the agent/native session, cwd, workspace, title and history. It
requires a successful fresh, session-bound native background query with no known
terminal or provider-subagent work before marking the session. Reusing the same
request preserves the target and data scope; a changed request binding fails closed.
Requested Auto-Routing uses the normal existing-main activation: an idle recheck,
the supported orchestration-instruction prompt and an accepted send before `ready`.
Model, mode and sandbox settings remain unchanged; an existing main does not gain
the read-only launch configuration used when creating a new main. Its bootstrap
states that distinction and the no-implementation/stop rules. Unknown sends remain
`uncertain` and are never replayed by preparation retries. There is no reload,
completion attestation or synthetic human receipt. Only later real composer input records its own message ID through the existing
human-origin path. Auto-Routing activation retains existing off/uncertain outcomes
on retries. Preparation alone does not prove worker completion or V3 acceptance.

The bundled SDK connection for this repair requires the configured passwordless
loopback daemon. It reads no authentication secret; password-protected deployments
fail before mutation and require a separately supported authenticated connection.
If marking succeeds but activation then loses an idle race, the preparation label
remains. Use the existing Auto-Routing switch once the main is idle to recover;
an uncertain activation needs explicit reconciliation, not automatic resending.

Git and PowerShell 7 must already be available on PATH. The package resolves their
actual installed paths and runs the controller using its own Electron Node runtime
(Node >=24 with `node:sqlite`). Pi remains optional. Its Advanced-specific launcher
uses this distribution's roots, profile and job supervisor. Explicit installed Pi
coding-agent package/base-launcher paths are required; the guard and tool extension are
compiled into the Advanced bundle. No development-controller path is assumed.

The integrated acceptance gate is one isolated real prepared-composer task through
routing, worker changes, process settlement, configured checks, independent review,
main notification and COMPLETE, without operator attestation or a maintenance chat.
One active-work/missing-capability boundary must wait with an actionable reason.
This gate is pending until explicitly recorded with the compatible controller revision
and packaged runtime evidence; the Windows package smoke is a separate gate.

### Fresh public completion observation

The fork SDK exports `PaseoAgentBackgroundWorkObservation`. Controllers must
negotiate `server_info.features.agentBackgroundWorkRefresh === true` and await
`agent.backgroundWork.refresh()` after the worker becomes idle. Codex queries native
`thread/backgroundTerminals/list` after that request. Native Claude additionally
requires `agentBackgroundWorkClaudeRefresh`; the SDK acknowledges that negotiated
coverage with the optional request field `claudeBackgroundTasks`. Claude uses public
`Query.reinitialize()` and a fresh full task snapshot processed in the same native
Query generation. An unchanged empty inventory still produces a fresh response:

```typescript
{
  agentId: string;
  providerSessionId: string;
  observationId: string;
  coverage: "codex_background_terminals" | "claude_background_tasks";
  queryGeneration?: string;
  foregroundActive?: boolean;
  queriedProviderSessionIds: string[];
  items: AgentBackgroundWorkItem[];
  providerSubagents: ProviderSubagentDescriptorPayload[];
}
```

Compare `providerSessionId` exactly with the refreshed agent's
`runtimeInfo.sessionId`; reject a null, changed or unavailable session. For Claude,
also match `queryGeneration` exactly with
`runtimeInfo.extra.backgroundWorkGeneration` and require `foregroundActive: false`.
The existing initialized Query is consumed without creating a replacement process
to certify earlier work; a missing or retired Query is unavailable.

Completion requires no foreground turn, pending permission, returned work item or
known running provider subagent. Claude's full native roster includes subagent and
workflow work and pending task notifications; it is separate from the UI/stop list.
The controller also requires final stable projected tool history and matching live
native Bash or structured task-notification provenance before accepting Claude tool
completion. It does not manufacture an exit code or infer native provenance for
unmarked legacy history. This covers provider-reported work, not arbitrary OS
processes; raw detached commands remain blocked. Codex items preserve native
`providerSessionId` and `processId` when supplied.

Missing capability, unsupported provider/native method, query failure, timeout
or a changed session rejects the refresh. Never fall back to `list()`, a cached
`count: 0`, timestamps from another host or automatic operator attestation.
The ordinary cached list/subscription and stop-token behavior remain available
for display and control.

An isolated native subscription probe observed a running Bash task block the actual
completion assessor with `WAITING_PROCESSES`. After natural completion, matching
fresh native coverage and actual projected tool evidence produced `VERIFY`.
Closing the native Query then rejected refresh without creating a replacement.
This establishes the native mechanism; full real Composer-to-COMPLETE acceptance
remains pending. Private runtime evidence stays local and is not packaged.

This capability requires the matching full app, daemon, SDK and controller bundle.
An older three-file plugin overlay cannot provide it.

Projected Codex `shell` and `terminal` tool calls now preserve
`metadata.nativeThreadId` and `metadata.parentCallId`; the latter is the native
command item/call ID, not a display label. `metadata.processId` is included only
when the native event supplies it. Live V2 command items and resumed command
history use the same mapping. Empty/Ctrl-C terminal interactions retain these
references even when the original completed shell has no process ID. Never
reconstruct old missing IDs from time, order, output or command text. Identical
native interaction payloads retain existing deduplication because the provider
does not supply a distinct per-interaction event ID.

## Sync upstream and rebuild

Use a dedicated fork checkout. Keep local edits committed or preserved before sync.

```powershell
git fetch origin
git fetch upstream main
git switch -c feature/upstream-YYYY-MM-DD origin/main
git merge upstream/main
git push -u origin HEAD
gh pr create --repo BenjaminHornung/paseo --base main --head feature/upstream-YYYY-MM-DD
```

Configure `upstream` once as `https://github.com/getpaseo/paseo.git` if absent.
Resolve future merge conflicts by retaining the fork receipt wiring and workflow.
Check the feature-branch build and PR checks before reviewing the fork PR.
This integration is delivered as a feature branch and PR; merging `main` is separate.
Before a future merge, inspect the inherited workflow triggers: this upstream sync
changes website/protocol/package paths and would trigger **Deploy Website** on
`main`. Docker main pushes build without publishing; version tags can publish.
No main merge or tag is needed to download the feature-branch Windows artifacts.
An approved merge to fork `main` also starts a fresh Windows build; never push to upstream.

## Composer receipt contract

Only agents with `labels.orchestratorPreparation` use the public
`paseo-orchestrator` / `orchestrator.prepare-input` RPC before native message send.
The RPC and native send share the exact agent ID, generated message ID and text.
It must return `{ recorded: true }` or `{ enabled: false }`; an unavailable RPC,
rejection or uncertain receipt fails the submit and rolls back its optimistic row.
Receipt state is not revoked on ambiguous native send failures.

The normal composer and automatic queue drain share this dispatch. Native images,
structured attachments, steering, send retry and titles retain upstream behavior.
Blank text and text over 12,000 characters bypass the bounded classifier and send
natively; they do not grant controller work through a recorded receipt.
The RPC uses the existing trusted-local-client boundary, not cryptographic proof
of human authorship. Only this distribution's bundled controller/plugin is registered;
the original app and its controller are unchanged.

Upstream 0.16.0-beta.1 exposes `agent.turn.before` after the provider turn starts; it is
non-waiting and lacks text, message ID and submitting-client identity. Its composer
API edits/focuses drafts but provides no submit callback. Neither can replace this
pre-send receipt. Public `PaseoAgent.backgroundWork` supports `list`, `subscribe`
and `stop` for provider-reported live work; stopping requires provider support and
a valid stop token. It does not authenticate input or persist work inventory.

## Integration and verification

### Advanced branding

The Windows workflow sets `EXPO_PUBLIC_PASEO_DISTRIBUTION=advanced` before building
the renderer. Advanced uses its own orange A icon for the executable, installer,
notifications, app logo and browser/PWA assets. Visible product names and CLI
instructions use the selected distribution; desktop preload identity takes
precedence over the renderer build setting. Upstream builds retain their names.
`packages/app/scripts/export-web.mjs` also writes Advanced manifest and Apple
metadata into the exported HTML before JavaScript starts.

The source icon is `packages/desktop/assets/advanced/icon.svg`. Regenerate its
checked-in PNG and Windows ICO variants with `node scripts/generate-advanced-icons.mjs`.
The Windows download's `build-info.json` records the source icon hashes alongside
the source commit and existing package checksums. This Windows workflow does not
publish or install a release.

If Actions reports that workflows are paused on this fork because of usage scale,
a repository maintainer must use the re-enable control on the repository's Actions
page. The ordinary repository permission can already be enabled while that
separate fork pause still rejects workflow dispatch with HTTP 422.

Initial fork main: `1a1ff8828f002fce08e239bae3d46aff75e22f52`.
Integrated upstream main: `f68480482197d1b415a41d6197072d275d926bfa`.
This includes the 0.16.0-beta.1 release reconciliation, lockfile fix and subsequent
plugin update-recovery test isolation. The last runtime change is still
`e7432cb2a5968ecec5dbc3a9d66a218fbbdc306b`; the later commit changes one test file.
The initial sync used main through `63ea3e55618ab0849cf0a45d5fee02f509b58c73`, already
containing the beta's background-task and plugin features. The final refresh adds
release metadata, changelog presentation and tests. The original fork main had no unique
commits; subsequent fork implementation commits are preserved on the feature branch.
The installed desktop archive was read-only verified as 0.15.2 and was not changed;
the running daemon was not restarted or replaced. Fork client/plugin SDKs and
bundled server are 0.16.0-beta.1.

The focused composer regression file failed without the fix (four behavioral
failures) and passed with it. An additional inclusive-maximum regression catches
changing `<= 12000` to `< 12000`. Full workspace typecheck and targeted lint passed locally.
The real normal-composer E2E checks a held preflight, no native send before release,
the actual outgoing native file payload and the canonical message identity. Its
prepared-label wiring fault failed the receipt assertion and was restored.
Desktop isolation/CLI/lifecycle checks passed 20 tests; misclassifying the Advanced
executable failed the home, link-routing and CLI-path assertions.
CI compiles the renderer, desktop main process and bundled server stack and runs
upstream's actual packaged Windows smoke before uploading downloads. The Advanced
smoke also checks the native 1.x version, exact upstream daemon version, daemon PID
reuse on a second start, and the visible version in About settings.

Concurrent first controller connections share a per-database initialization lock
across WAL setup and schema initialization. The real eight-connection startup
regression fails without it with SQLite locks and duplicate-table errors; it passes
with the lock. Existing schema SQL and versions are preserved.
