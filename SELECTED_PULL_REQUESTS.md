# Selected Paseo Pull Requests

This document is the implementation queue for the customized Paseo fork at
<https://github.com/BenjaminHornung/paseo>. It deliberately contains only changes that are still
useful after comparison with the frozen baseline.

## Baseline and delivery rules

- Frozen baseline: `main` at `aa6384babd0e8cc7e0d4ff9cfaf8a7eb469b3b79` (2026-07-22).
- Curation branch: `feature/selected-pr-backports`.
- The baseline is 42 commits ahead of `v0.2.0-beta.1`.
- Revalidate every upstream PR head and the current upstream `main` immediately before
  implementation. Remove work that has since landed or been superseded.
- Implement each queue item on its own `feature/<slug>` branch in the BenjaminHornung fork. Do not
  combine unrelated items.
- Preserve the original contributors' authorship and reference the source PR when adapting their
  work. Do not open a competing upstream PR for an already-open contribution unless coordinated
  with its author or maintainer.
- The TypeScript 7 migration is new work: store its complete branch in the fork and open a pull
  request from that branch to `getpaseo/paseo`.
- Existing PRs are not safe to cherry-pick unless an entry explicitly says otherwise. Most touch
  files that have since been substantially refactored.
- Respect protocol backward compatibility, current platform gates, and the repository's focused
  test policy. Public protocol additions must remain optional and capability-gated.

## Implementation order

This table is the authoritative execution order. `P0` protects security, user data, and session
correctness; `P1` establishes provider and platform foundations; `P2` improves frequent workflows;
`P3` contains optional, presentation-heavy, or higher-risk additions. Work top-to-bottom within a
priority unless the required upstream revalidation changes a dependency.

| Order | Item                                                                                                                                                          | Priority | Recommended integration                                        |
| ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
|     1 | [#1572](https://github.com/getpaseo/paseo/pull/1572) current `ws` security release                                                                            | P0       | Regenerate at current 8.21.1 or later                          |
|     2 | [#2277](https://github.com/getpaseo/paseo/pull/2277) preserve file format                                                                                     | P0       | Rebase or adapted port of active PR                            |
|     3 | [#131](https://github.com/getpaseo/paseo/pull/131) replay idempotency                                                                                         | P0       | Manual forward-port                                            |
|     4 | [#1826](https://github.com/getpaseo/paseo/pull/1826) durable message queue                                                                                    | P0       | Rebase after #131; preserve revisions                          |
|     5 | [#2272](https://github.com/getpaseo/paseo/pull/2272) OpenCode stream recovery                                                                                 | P0       | Rebase current reviewed head                                   |
|     6 | [#2292](https://github.com/getpaseo/paseo/pull/2292) provider-default mode alias                                                                              | P0       | Focused forward-port                                           |
|     7 | [Issue #2253](https://github.com/getpaseo/paseo/issues/2253) orphan workspace recovery                                                                        | P0       | New upstream-ready implementation after #2292                  |
|     8 | [#2295](https://github.com/getpaseo/paseo/pull/2295) history recovery without cwd                                                                             | P0       | Rebase reviewed head                                           |
|     9 | [#1829](https://github.com/getpaseo/paseo/pull/1829) resilient history rendering                                                                              | P0       | Port with newer catch-up fixes                                 |
|    10 | [#1865](https://github.com/getpaseo/paseo/pull/1865) forward config reads                                                                                     | P0       | Reimplement without losing unknown keys                        |
|    11 | [#1603](https://github.com/getpaseo/paseo/pull/1603) corrupt Markdown crash                                                                                   | P0       | Port behavior; rewrite tests                                   |
|    12 | [#2240](https://github.com/getpaseo/paseo/pull/2240) ACP SDK 1.2.1                                                                                            | P1       | Rebase and retain the legacy adapter                           |
|    13 | [Issue #1591](https://github.com/getpaseo/paseo/issues/1591) + [#1592](https://github.com/getpaseo/paseo/issues/1592) reliable ACP reconfiguration and resume | P1       | New upstream-ready lifecycle redesign                          |
|    14 | [#2241](https://github.com/getpaseo/paseo/pull/2241) typed question forms                                                                                     | P1       | Rebase after #2240 and recheck current review                  |
|    15 | [Issue #2244](https://github.com/getpaseo/paseo/issues/2244) ACP form elicitation                                                                             | P1       | New stacked upstream-ready implementation                      |
|    16 | TypeScript 7 stable migration                                                                                                                                 | P1       | New upstream-ready implementation                              |
|    17 | [#2243](https://github.com/getpaseo/paseo/pull/2243) Codex Plan mode                                                                                          | P1       | Cherry-pick or small forward-port                              |
|    18 | [Issue #2093](https://github.com/getpaseo/paseo/issues/2093) `/goal` in Plan mode                                                                             | P1       | New upstream-ready implementation                              |
|    19 | [#1209](https://github.com/getpaseo/paseo/pull/1209) first-class plans                                                                                        | P1       | Redesign on current protocol                                   |
|    20 | [#1703](https://github.com/getpaseo/paseo/pull/1703) OpenCode cwd scoping                                                                                     | P1       | Rebase current reviewed head — **in progress on feature/p0-integration-build** |
|    21 | [#485](https://github.com/getpaseo/paseo/pull/485) remaining OpenCode fixes                                                                                   | P1       | Extract only remaining behavior                                |
|    22 | [#523](https://github.com/getpaseo/paseo/pull/523) Codex skill warnings                                                                                       | P1       | Manual forward-port                                            |
|    23 | [#1907](https://github.com/getpaseo/paseo/pull/1907) default thinking                                                                                         | P1       | Small forward-port using shared normalization                  |
|    24 | [Issue #2254](https://github.com/getpaseo/paseo/issues/2254) lazy provider discovery                                                                          | P1       | New upstream-ready implementation                              |
|    25 | [#2042](https://github.com/getpaseo/paseo/pull/2042) project agent environment                                                                                | P1       | Manual security-aware port                                     |
|    26 | Hard-reload the current agent environment                                                                                                                     | P1       | Extend existing Reload agent action                            |
|    27 | [#1578](https://github.com/getpaseo/paseo/pull/1578) local bins for repo commands                                                                             | P1       | Adapt environment overlay                                      |
|    28 | [#1481](https://github.com/getpaseo/paseo/pull/1481) terminal worker environment                                                                              | P1       | Forward-port daemon snapshot IPC                               |
|    29 | [#1554](https://github.com/getpaseo/paseo/pull/1554) preserve subdirectory cwd                                                                                | P1       | Reimplement deterministic selection — **done (commit 136bb973e)** |
|    30 | [#2245](https://github.com/getpaseo/paseo/pull/2245) keep OMP parents active for running children                                                             | P1       | Recheck after review fixes; do not port current head unchanged |
|    31 | [#2136](https://github.com/getpaseo/paseo/pull/2136) multi-agent context                                                                                      | P1       | Rebase both reviewed commits                                   |
|    32 | [#1783](https://github.com/getpaseo/paseo/pull/1783) task progress                                                                                            | P1       | Manual protocol/UI port                                        |
|    33 | [#781](https://github.com/getpaseo/paseo/pull/781) active-turn steering                                                                                       | P1       | Rebase design onto current contracts                           |
|    34 | Provider-native `/`, `@`, and `$` autocomplete                                                                                                                | P1       | New upstream-ready implementation                              |
|    35 | Open trusted absolute file links in multi-project roots                                                                                                       | P1       | New upstream regression fix after #1214                        |
|    36 | [#1987](https://github.com/getpaseo/paseo/pull/1987) Windows file links                                                                                       | P2       | Cherry-pick or small forward-port                              |
|    37 | [#736](https://github.com/getpaseo/paseo/pull/736) remote web downloads                                                                                       | P2       | Extract download fallback; gate previews                       |
|    38 | [#1722](https://github.com/getpaseo/paseo/pull/1722) dropped file paths                                                                                       | P2       | Reimplement with one classifier                                |
|    39 | [#1911](https://github.com/getpaseo/paseo/pull/1911) newline shortcuts                                                                                        | P2       | Rebase current two-commit behavior                             |
|    40 | [#1613](https://github.com/getpaseo/paseo/pull/1613) long-press queue                                                                                         | P2       | Small forward-port after durable queue                         |
|    41 | [#2274](https://github.com/getpaseo/paseo/pull/2274) command-center agent settings                                                                            | P2       | Rebase after mode/thinking work                                |
|    42 | [#675](https://github.com/getpaseo/paseo/pull/675) find in pane                                                                                               | P2       | Reimplement on current pane architecture                       |
|    43 | [#821](https://github.com/getpaseo/paseo/pull/821) sidebar session view                                                                                       | P2       | Extract missing session view only                              |
|    44 | [#1204](https://github.com/getpaseo/paseo/pull/1204) archived-session recovery                                                                                | P2       | Add focused recovery entry after #821                          |
|    45 | [#1205](https://github.com/getpaseo/paseo/pull/1205) cwd-tail labels                                                                                          | P2       | Small forward-port                                             |
|    46 | [#1691](https://github.com/getpaseo/paseo/pull/1691) Windows terminal shell                                                                                   | P2       | Add configurable fallback chain                                |
|    47 | [#671](https://github.com/getpaseo/paseo/pull/671) prompt history                                                                                             | P2       | Reimplement on current composer                                |
|    48 | [#1185](https://github.com/getpaseo/paseo/pull/1185) attention hook                                                                                           | P2       | Reimplement on current config/runtime                          |
|    49 | [#1183](https://github.com/getpaseo/paseo/pull/1183) worktree labels                                                                                          | P2       | Reimplement on current workspace model                         |
|    50 | [#2050](https://github.com/getpaseo/paseo/pull/2050) chat workspaces                                                                                          | P2       | Manual port with recoverable cleanup                           |
|    51 | [#1883](https://github.com/getpaseo/paseo/pull/1883) live Pi context usage                                                                                    | P2       | Extract behavior; do not change lint rules                     |
|    52 | Provider-subagent identity and runtime metadata                                                                                                               | P3       | New upstream-ready additive protocol/UI PR                     |
|    53 | Configurable agent inactivity warnings                                                                                                                        | P3       | New upstream-ready warning-only PR after #2245                 |
|    54 | [#2298](https://github.com/getpaseo/paseo/pull/2298) live comparison tabs                                                                                     | P3       | Adapt after shared file actions                                |
|    55 | [#1598](https://github.com/getpaseo/paseo/pull/1598) restore closed tabs                                                                                      | P3       | Rebase current layout behavior                                 |
|    56 | [#1963](https://github.com/getpaseo/paseo/pull/1963) pinned tabs                                                                                              | P3       | Rebase after restore-closed-tabs                               |
|    57 | [#1595](https://github.com/getpaseo/paseo/pull/1595) collapsible thinking                                                                                     | P3       | Reimplement on current stream                                  |
|    58 | [#1596](https://github.com/getpaseo/paseo/pull/1596) prompt scroll indicators                                                                                 | P3       | Reimplement web-first                                          |
|    59 | [#1597](https://github.com/getpaseo/paseo/pull/1597) pinned prompt overlay                                                                                    | P3       | Reimplement on both stream strategies                          |
|    60 | [#1817](https://github.com/getpaseo/paseo/pull/1817) HTML preview                                                                                             | P3       | Security-hardened opt-in port                                  |
|    61 | [#1734](https://github.com/getpaseo/paseo/pull/1734) Mermaid rendering                                                                                        | P3       | Web-first port; gate native bundle                             |
|    62 | [Issue #2054](https://github.com/getpaseo/paseo/issues/2054) LaTeX rendering                                                                                  | P3       | New upstream-ready implementation using #355 as prior art      |
|    63 | [#1647](https://github.com/getpaseo/paseo/pull/1647) copy Markdown writes                                                                                     | P3       | Small adapted UI port                                          |
|    64 | [#1599](https://github.com/getpaseo/paseo/pull/1599) embedded sidebar tabs                                                                                    | P3       | Reassess and rebuild after sidebar work                        |
|    65 | Capability-gated provider-subagent stop and follow-up                                                                                                         | P3       | New provider-specific upstream PRs after metadata              |
|    66 | Installed provider-CLI version detector and update prompt                                                                                                      | P1       | New upstream-ready implementation                              |

The first implementation wave is items 1-11: security, byte preservation, durable messaging,
recoverable lifecycle state, history visibility, config preservation, and crash prevention. Item 4
depends on item 3; item 7 follows item 6. In the foundation wave, item 13 depends on item 12, item
15 depends on items 12 and 14, and item 18 follows item 17. Item 26 extends item 25's environment
contract, while item 13 must keep ACP soft reconfiguration distinct from that hard reload. Items 31
and 32 both add durable agent metadata and should coordinate their protocol fields. Item 40 builds
on item 4's queue contract; item 44 reuses item 43's session data; item 56 follows item 55. Item 30
must land with its review issues fixed before items 52 and 53; item 65 depends on item 52 and a
provider-specific acknowledged control contract. Items 35, 37, 38, 54, 60, 61, and 62 share file/
preview/rendering surfaces and require a cross-regression pass.

## Migrate Paseo fully to stable TypeScript 7

**Source:** User-requested upstream contribution; no source PR exists yet.

**Why this remains useful:** The baseline is only partially migrated. Typechecks already use
`tsgo` from `@typescript/native-preview@7.0.0-dev.20260423.1`, while build scripts still invoke the
TypeScript 5 compiler and workspaces retain mixed TypeScript 5.x dependencies. Stable TypeScript 7
is now available and should replace the stale preview while preserving the legacy compiler API for
the few tools and tests that import `typescript` programmatically.

**Affected areas:** Root/workspace manifests and lockfile, all `typecheck` and `build` scripts,
TypeScript configuration, CI/release checks, and tests that import the compiler API.

**Implementation:**

- Create `feature/typescript-7-port` from the then-current upstream `main`, push it to
  `BenjaminHornung/paseo`, and use it as the head of the upstream PR.
- Replace `@typescript/native-preview` and `tsgo` commands with stable TypeScript 7's `tsc`.
- Keep TypeScript 6 side-by-side through `@typescript/typescript6` where programmatic compiler APIs
  or dependency peer ranges still require the legacy API. Use the official alias arrangement so
  `tsc` resolves to TypeScript 7 and `tsc6` remains available for legacy tooling.
- Normalize workspace TypeScript dependencies instead of leaving independent 5.2/5.9 pins.
- Run TypeScript 7 for declaration emit and package builds as well as `--noEmit` checks. Do not add
  esbuild merely to bypass compiler memory usage; TypeScript 7 is the intended native compiler
  path.
- Audit removed TypeScript 6 options, module-resolution behavior, JavaScript/JSDoc checks, and
  packages that import `typescript` directly.
- Record before/after typecheck and build timings in the upstream PR description.

**Compatibility risks:** TypeScript 7.0 has no stable programmatic API. The baseline contains direct
compiler API imports in app/desktop tests and dependencies with TypeScript `<6` or `<7` peer ranges,
so removing the legacy package outright is not acceptable.

**Acceptance criteria:**

- `npx tsc --version` reports stable TypeScript 7 and `npx tsc6 --version` reports the retained
  compatibility compiler.
- Every workspace typecheck and every publishable package build succeeds using the intended
  compiler.
- Declaration output and package exports remain usable by downstream workspaces.
- Focused compiler-API tests, `npm run typecheck`, `npm run lint`, `npm run format:check`, and the
  release dry-run checks pass on Windows and CI platforms.
- The fork contains the final branch and an upstream PR targets `getpaseo/paseo:main`.

## PR #2240 - Update the Agent Client Protocol SDK to 1.2.1

**Source:** <https://github.com/getpaseo/paseo/pull/2240>

**Reviewed head:** `20d6d99d9aff4fe105f15c70cf2974299463a4c7`

**Drift:** One commit; synthetic merge is clean against the frozen baseline.

**Why selected:** The baseline still uses `@agentclientprotocol/sdk@^0.17.1`. Version 1.2.1 is the
current stable npm release as of 2026-07-22; no newer SDK-upgrade PR or newer ACP SDK version was
found. The PR adopts stable resume, close, and prompt types while retaining compatibility with ACP
agents that still publish the former top-level model response and `session/set_model` method.

**Implementation:** Rebase the single commit after the TypeScript 7 migration and regenerate the
lockfile. Keep the dated legacy model-selection adapter at the connection boundary. Do not widen
this dependency migration into unrelated ACP lifecycle fixes; evaluate those separately.

**Compatibility risks:** This is a protocol-library major-version jump. Stable and legacy agents
must both continue to discover/select models, resume, close, cancel, and report terminal state.

**Acceptance criteria:**

- Package and lockfile resolve exactly ACP SDK 1.2.1 or a later stable version verified immediately
  before implementation.
- Stable `configOptions` and legacy model-response/`session/set_model` paths both pass unit and
  smoke coverage.
- Cursor ACP and generic ACP wrapper smoke tests pass on Windows and a POSIX CI runner.
- No swallowed legacy request error is introduced without at least trace-level observability.

## PR #2243 - Preserve Codex built-in Plan mode instructions

**Source:** <https://github.com/getpaseo/paseo/pull/2243>

**Reviewed head:** `51ee61092b7c98221bce9b9a887565d4032e7f48`

**Drift:** One commit; synthetic merge is clean against the frozen baseline.

**Why selected:** Paseo currently composes host instructions into
`collaborationMode.settings.developer_instructions`, but Codex does not expose its built-in mode
instructions through `collaborationMode/list`. Supplying a replacement therefore erases the
built-in Plan-mode contract, and the same host prompt is also sent again at turn start.

**Implementation:** Keep `developer_instructions` null for built-in collaboration modes. Send
Paseo host instructions once at thread start/resume on the app-server surface intended for host
instructions, not as a turn-level duplicate. A cherry-pick is plausible, but recheck the current
Codex app-server schema after the TypeScript 7 work.

**Acceptance criteria:**

- Plan mode retains Codex's built-in read-only/planning behavior.
- Host instructions appear exactly once on new and resumed threads.
- Default mode and custom collaboration modes retain their current behavior.
- Unit, local app-server, real-provider Plan-mode, and approval UI regressions pass.

## PR #131 - Idempotent message replay and Codex terminal recovery

**Source:** <https://github.com/getpaseo/paseo/pull/131>

**Reviewed head:** `6d4b94acda99cc1bac4c9a4d8fc3e982f71773eb`

**Drift:** Five commits; six conflict sections against the frozen baseline.

**Why selected:** Current `clientMessageId` timeline reconciliation prevents duplicate optimistic
rows, but the central send path still does not reject or suppress a replayed message before starting
another provider run. Current Codex handling also lacks this PR's recovery for terminal events that
arrive before `turn_started` and idle thread-status completion.

**Implementation:** Forward-port the behavior into the current centralized `agent-prompt` /
`AgentManager` flow and current Codex provider. Preserve queued message IDs across retries. Treat the
same ID and same content as an accepted no-op; reject the same ID with different content. Do not use
text-only/time-window matching as the primary identity when a client ID exists.

**Acceptance criteria:**

- A reconnect replay with the same ID starts exactly one provider run and yields one canonical user
  row.
- Reusing an ID with different content returns an explicit rejection.
- Terminal-before-start and thread-idle events cannot leave Codex permanently running.
- Add focused manager/send-path, Codex provider, and daemon E2E regression tests.

## PR #1826 - Persist queued agent messages on the daemon

**Source:** <https://github.com/getpaseo/paseo/pull/1826>

**Reviewed head:** `ecc1f105b59946030b57df44ed65299c20dde2bc`

**Drift:** Fifteen commits; synthetic merge is clean against the frozen baseline.

**Why selected:** The app currently owns queued follow-up prompts. Refreshes, mobile app lifecycle
changes, disconnects, or switching clients can therefore lose large pending prompts. This PR makes
the daemon an atomically persisted, revisioned, per-agent queue and mirrors it to every capable
client.

**Dependencies:** Implement after #131 so queue dispatch, reconnect replay, and
`clientMessageId` idempotency share one contract. Coordinate with #781: queueing while busy and
steering an active turn are different user actions and must not silently replace one another.

**Implementation:** Rebase the reviewed head, preserve atomic persistence and monotonic revisions,
and keep the app mirror capability-gated for older daemons. Review every dequeue/dispatch race:
archive, edit, remove, reconnect migration, concurrent manual dispatch, auto-drain, and daemon
restart. A queue item must be removed only when its terminal disposition is explicit.

**Compatibility risks:** Adds persisted data and optional wire methods. Unknown new messages must
remain parse-compatible with old clients, and corruption must fail closed without deleting the last
known-good queue.

**Acceptance criteria:**

- Text, images, and structured attachments survive app/daemon restarts and reconnects.
- Concurrent clients converge by revision without duplicated dispatch.
- Archive, edit, remove, dispatch-now, and auto-drain races have deterministic outcomes and no
  silent loss.
- Legacy clients retain their local queue behavior against older daemons.
- Focused queue-store, mirror, client, manager, protocol, and daemon E2E tests pass.

## PR #2272 - Recover OpenCode turns after event-stream EOF

**Source:** <https://github.com/getpaseo/paseo/pull/2272>

**Reviewed head:** `1c085d652d647ab2605dcd400fe934e7435f5043`

**Drift:** Three commits; synthetic merge is clean against the frozen baseline.

**Why selected:** The baseline treats EOF/error from OpenCode's global SSE stream as immediate turn
failure even when the OpenCode session is still healthy and running. The reviewed head reconciles
status, messages, questions, and permissions, reconnects with bounded exponential backoff, and
deduplicates recovered content.

**Implementation:** Rebase the full three-commit head, including its post-review observability and
dedup tests. Preserve per-part prefix validation: divergent recovered/live text must fail open to
the live stream rather than corrupting the transcript. Keep session-lifetime request-ID dedup
documented and bounded by session lifetime.

**Acceptance criteria:**

- A dropped SSE stream no longer fails an otherwise healthy busy turn.
- Completion during the gap reconstructs missing text, reasoning, tool state, usage, and terminal
  status exactly once.
- Pending question/permission requests are neither lost nor duplicated.
- Zero-event reconnects back off to a bounded maximum and abort/close stops the loop immediately.
- Focused OpenCode recovery tests cover busy, idle, completed, ambiguous, duplicate, divergent, and
  repeated-EOF paths.

## PR #1703 - Scope OpenCode helper servers by working directory

**Source:** <https://github.com/getpaseo/paseo/pull/1703>

**Reviewed head:** `137f63f74b2145d4b4b4442265ca89b2575ec5ab`

**Drift:** Four commits; synthetic merge is clean against the frozen baseline.

**Why selected:** Baseline OpenCode helper processes default to the user's home directory, causing
over-broad file watching and losing workspace attribution. The PR keys shared helpers by cwd,
attributes dedicated helpers to agents/sessions, and hardens shutdown/startup races.

**Implementation:** Rebase all four commits and preserve the final shutdown-epoch fixes. Normalize
cwd keys consistently on Windows, including drive-letter casing and separators. Shared helpers may
be reused only for the same normalized cwd and compatible environment; dedicated helpers retain
agent/session attribution in the managed-process ledger.

**Acceptance criteria:**

- Helpers start in and are reused only within the requested normalized cwd.
- Two workspaces cannot retire or receive each other's server.
- Shutdown deterministically rejects or terminates every pending start without orphan processes.
- Import/resume retains the correct cwd, environment, agent, and session attribution.
- Server-manager and OpenCode integration tests cover Windows and POSIX path variants.

## PR #523 - Surface Codex skill validation warnings on first creation

**Source:** <https://github.com/getpaseo/paseo/pull/523>

**Reviewed head:** `0573abc7ca4eaad3a35eafecfe8c3a3294fbb1c4`

**Drift:** One commit; four conflict sections against the frozen baseline.

**Why selected:** The current Codex `skills/list` loader still ignores `errors[]`. The modern
create-agent flow also does not hydrate provider history immediately, so invalid `SKILL.md` warnings
can remain invisible until a later resume or refresh.

**Implementation:** Parse and deduplicate structured skill errors, emit them as durable timeline
warnings, and hydrate provider history in the current `createAgentCommand` path before the first
live snapshot is delivered. Do not transplant the old `Session` call site.

**Acceptance criteria:**

- A newly created Codex agent immediately shows each invalid-skill warning once.
- Resume/refresh does not duplicate an already-recorded warning.
- A successful empty error list clears cached warning state without deleting timeline history.
- Focused Codex provider and create-agent lifecycle tests pass.

## PR #485 - Extract the remaining OpenCode correctness fixes

**Source:** <https://github.com/getpaseo/paseo/pull/485>

**Reviewed head:** `f4aa3f1d4498d66cbb4cf2166cb535c42f39ecf7`

**Drift:** Twelve commits; two conflict sections, but most original behavior has since been replaced.

**Why selected:** Current `main` already contains persisted-session discovery, lifecycle recovery,
event translation, and other newer OpenCode work. Three concrete gaps remain: comma-containing
question answers are still split incorrectly, remote `question.replied`/`question.rejected` events
do not clear pending state, and rich prompts with attachments cannot invoke slash commands.

**Implementation:** Extract only those three behaviors. Represent multi-select answers structurally
instead of comma-joining strings, translate remote question-resolution events, and read the command
text from rich prompts without discarding attachments. Do not port the old monolithic provider file
or already-superseded session lifecycle code.

**Acceptance criteria:**

- Free-text and option labels containing commas round-trip unchanged.
- A question answered or rejected from another client disappears locally without a refresh.
- Supported slash commands still work when the prompt also contains attachments.
- Existing OpenCode session import, resume, abort, and event-translator tests remain green.

## Provider-native command and mention autocomplete for Codex and OpenCode

**Source:** User-requested upstream contribution; no source PR exists yet.

**Documentation checked:**

- Codex [Build skills](https://learn.chatgpt.com/docs/build-skills): CLI/IDE opens skills with
  `/skills` or a `$` mention; explicit invocation is `$skill-name`. Deprecated custom prompts
  remain root slash commands such as `/prompts:draftpr`.
- OpenCode [Commands](https://opencode.ai/docs/commands/): built-in and project/global custom
  commands use `/name`; command templates support arguments and `@path` file references.
- OpenCode [Agents](https://opencode.ai/docs/agents/): subagents are manually invoked with
  `@agent-name`.

**Why this remains useful:** The baseline already lists and executes root slash commands for Codex
and OpenCode and already has provider-agnostic file autocomplete. However, it renders every
provider skill as `/skill`, including Codex skills that officially require `$skill`, and it
replaces `@file` with a quoted plain path. It also has no OpenCode subagent mention suggestions.

**Affected areas:** Provider command/mention discovery, optional protocol metadata, composer
autocomplete parsing and replacement, OpenCode agent/reference discovery, Codex skill loading,
draft-agent context, rich prompts/attachments, i18n, and keyboard/accessibility behavior.

**Implementation:**

- Keep `/` for root client/provider commands. Do not regress the existing Codex and OpenCode
  command execution path.
- Add provider-native trigger metadata as optional wire fields so old clients and daemons continue
  to parse command lists.
- Show Codex skills only under `$` autocomplete and insert `$skill-name ` verbatim. Keep
  deprecated `/prompts:name` custom prompts separate and clearly labeled.
- For OpenCode, group `@` results by subagent, workspace file, and configured reference. Insert
  the provider-supported `@agent` or `@path` token rather than converting it to an ordinary
  quoted string.
- Resolve `@` ambiguity deterministically and keep autocomplete local to the active provider/cwd.
  Do not query or expose agents, files, or references outside that boundary.
- Reuse the current autocomplete popover, ranking, keyboard navigation, and rich-prompt send path.
  Never execute a selected command or mention merely by opening autocomplete.

**Compatibility risks:** The same punctuation currently has different meanings by provider.
Provider-neutral normalization would silently change prompts, so trigger and replacement behavior
must be selected from the active provider capability. Mention discovery may reveal file or agent
names and must respect existing access boundaries.

**Acceptance criteria:**

- Codex `$skill` invocation reaches the provider unchanged; `/skills` opens discovery and
  `/prompts:name` remains available where supported.
- OpenCode `/command`, `@agent`, `@file`, and configured `@reference/path` match the official
  CLI behavior, including command arguments.
- File paths with spaces, Unicode, Windows separators, and nested reference aliases are represented
  without prompt corruption.
- Suggestions work for existing agents and new-agent drafts and remain scoped to cwd/provider.
- Multiline editing, IME, mobile input, attachments, client slash commands, and Escape/arrow-key
  behavior remain unchanged.
- Focused parser/ranker/replacement, provider discovery, wire compatibility, composer, and real
  Codex/OpenCode smoke tests pass.

## PR #1907 - Apply the default model's default thinking option

**Source:** <https://github.com/getpaseo/paseo/pull/1907>

**Reviewed head:** `1d2b1ca5c126fe6b381b6ba43f19791401fef8d0`

**Drift:** One commit; synthetic merge is clean against the frozen baseline.

**Why selected:** When neither model nor thinking option is supplied, the server fills the default
model but currently leaves thinking unset. That differs from the create-agent picker and can disable
a provider's declared default reasoning mode.

**Implementation:** Forward-port the two-file fix, but reuse
`normalizeAgentModelDefinition` or another current shared helper for the
`defaultThinkingOptionId`/`isDefault` fallback instead of duplicating normalization. Never
override an explicitly supplied model or thinking option.

**Acceptance criteria:**

- Auto-selected models receive their declared default thinking option.
- Explicit model-only, thinking-only, model-plus-thinking, no-thinking, and unavailable-catalog
  cases preserve current intent.
- Server-created, app-created, MCP-created, imported, and resumed agents normalize consistently.
- Focused manager normalization tests pass for Claude, Codex, and a fake custom provider.

## PR #1829 - Keep the timeline rendered when history sync fails

**Source:** <https://github.com/getpaseo/paseo/pull/1829>

**Reviewed head:** `422e0b8c268ec614979fb63f164cb403cdfb1b1a`

**Drift:** One commit; synthetic merge is clean against the frozen baseline.

**Why selected:** A history-sync error can replace an otherwise valid cached/live agent timeline
with a full-screen error. The daemon may continue recording and pushing messages, so hiding that
timeline makes recoverable client sync failures look like data loss.

**Implementation:** Port the non-blocking initial-sync-error state and diagnostic serialization,
then reconcile it with newer upstream commit `b2139b140` (hydrated history remains visible during
visibility catch-up). Preserve a full-screen error only when there is no candidate agent/timeline to
render.

**Acceptance criteria:**

- Cached and live-pushed messages remain visible through initial sync failure and later catch-up.
- A visible sync-error banner reports the real serialized reason and offers the existing retry path.
- A truly missing agent with no renderable timeline still shows the blocking error/not-found state.
- State-machine and a real reconnect/catch-up browser regression cover first load and hydrated load.

## Open trusted absolute file links in multi-project roots

**Source:** User-reported regression; no current source PR exists. Related work is merged
[PR #1214](https://github.com/getpaseo/paseo/pull/1214), open
[Issue #684](https://github.com/getpaseo/paseo/issues/684), and display-only
[PR #1987](https://github.com/getpaseo/paseo/pull/1987).

**Why selected:** Assistant responses can contain valid absolute links to files that are readable by
the daemon but sit outside the active nested workspace, for example a shared `.codex` prompt under
the surrounding multi-project root. Clicking such a link currently reaches the preview with the
active workspace as its scope and fails with `Access outside of workspace is not allowed`. This
regresses the trusted-operator preview contract added by #1214 and makes otherwise valid agent
handoffs unusable in common Windows repository layouts.

**Affected areas:** Markdown file-link parsing and normalization, preview target resolution,
file-explorer read/subscription scoping, Windows path canonicalization, and read-only preview versus
editable workspace-file capabilities.

**Implementation:** Reproduce the complete click path from rendered assistant Markdown through
`resolveFilePreviewReadTarget`, live-file subscription, and the direct read endpoint. For a trusted
absolute regular-file target, derive one consistent filesystem read root (drive root or UNC share)
for both the initial read and later subscriptions. Preserve the current realpath/symlink containment
checks inside that derived root. Do not weaken workspace-scoped editing, mutation, or directory
browsing; an out-of-workspace assistant link remains a read-only preview. Normalize forward and
backslashes, drive-letter case, and Windows short/long path aliases before deciding scope. If the
local fix passes review, publish a fork branch and open an upstream draft PR with `gh`.

**Compatibility risks:** File preview is intentionally available to a connected trusted operator,
but edit and directory APIs have a narrower workspace boundary. Reusing the preview root for
mutating RPCs would be a security regression. Initial reads and live subscriptions must also agree
on the same canonical target or previews will open once and then fail on refresh.

**Acceptance criteria:**

- A link from a nested Neuburger workspace to
  `C:\IFI_SourceCode\AzureDevOps\Projects\Neuburger\.codex\release-newsletter-prompt.md` opens a
  read-only preview instead of the outside-workspace error.
- Same-workspace, sibling/parent-project, different-drive, UNC, mixed-separator, drive-case, and
  short-versus-long Windows paths have focused resolver and endpoint tests.
- Initial read, live update, unsubscribe, missing file, directory target, and symlink escape paths
  resolve consistently without granting edit, write, or directory-list access.
- POSIX absolute previews retain #1214 behavior, and #1987 changes only display text rather than the
  actual target.

## PR #1987 - Show Windows file links relative to their workspace

**Source:** <https://github.com/getpaseo/paseo/pull/1987>

**Reviewed head:** `603b38032111776c14d5f4a9073840a1d7ae7a0e`

**Drift:** Two commits; synthetic merge is clean against the frozen baseline.

**Why selected:** Mixed forward/backslash paths make in-workspace assistant links display absolute
Windows paths. Reusing the workspace resolver produces stable relative tooltips and preserves line
and range suffixes.

**Implementation:** Cherry-pick or forward-port both commits. Keep the reviewed root-path fallback
(`.`) and do not make out-of-workspace paths appear trusted or relative.

**Acceptance criteria:**

- Mixed-separator, drive-letter case, workspace-root, nested, out-of-workspace, missing-root, line,
  and range cases have focused tests.
- Display normalization does not change the actual file-open target.
- POSIX tooltip behavior remains unchanged.

## PR #781 - Steer active Claude and Codex turns

**Source:** <https://github.com/getpaseo/paseo/pull/781>

**Reviewed head:** `d1278aa8564c3006b398137c855dff5388f628c5` (draft)

**Drift:** Three commits; 23 conflict sections against the frozen baseline.

**Why selected:** Steering an active long-running turn is especially valuable from mobile. Current
`main` exposes native steering only as OMP commands; the normal send path still replaces an active
Claude or Codex run.

**Implementation:** Rebase the capability on the current centralized send path and provider
interfaces. Claude should enqueue into the active input stream and Codex should use its turn-steer
endpoint. Unsupported providers retain the existing replace behavior. Add one optional capability
and keep old clients/daemons parse-compatible; capability detection must happen in one place.

**Acceptance criteria:**

- A follow-up during an active Claude or Codex turn steers that turn without restarting it.
- Unsupported providers preserve current replacement behavior.
- Old clients parse new daemon messages and new clients work with old daemons.
- Add focused provider, send-path, protocol compatibility, and one real app smoke test.

## PR #2136 - Give spawned agents deterministic multi-agent context

**Source:** <https://github.com/getpaseo/paseo/pull/2136>

**Reviewed head:** `2d934ceebf4a62af74ce570d06d13eb60667a48a`

**Drift:** Two commits; synthetic merge is clean against the frozen baseline.

**Why selected:** Agents spawned through Paseo MCP currently depend on the parent to hand-write
Paseo's parent/report contract. The reviewed head makes parent identity, environment behavior, and
finish-notification semantics daemon-authored and also attributes later agent-to-agent messages.

**Dependencies:** Closed stacked PR #2142 was folded into the current #2136 head as the second
sender-envelope commit. Preserve both commits and do not separately port the older #2142 head.
Coordinate with #1826/#781 so messages to busy agents queue or steer according to an explicit mode
instead of destructively replacing work.

**Implementation:** Rebase both commits. Keep system spawn context hidden from the user timeline,
but present sender envelopes as readable attribution. XML-escape IDs/titles, keep
`notifyOnFinish` as the single source of automatic-delivery truth, and never wrap normal
human/app/schedule prompts as agent messages.

**Acceptance criteria:**

- A child always knows its parent identity, report expectations, and whether delivery is automatic.
- Agent-to-agent prompts display a stable sender header while the receiving model gets the complete
  reply contract.
- `notifyOnFinish: false`, detached agents, archived targets, title escaping, and old-client
  projections behave deterministically.
- MCP instructions, create-agent flow, send-agent-prompt, timeline projection, import/resume, and
  real parent-child smoke tests pass.

## PR #2042 - Resolve project-defined agent environments before launch

**Source:** <https://github.com/getpaseo/paseo/pull/2042>

**Reviewed head:** `72ea543cf59244b6b0e3c6427e955fc9e78fca09`

**Drift:** Two commits; synthetic merge is clean against the frozen baseline.

**Why selected:** Paseo launches provider CLIs and their MCP servers directly, before shell hooks or
worktree setup can load direnv/mise/project variables. Project MCP servers can consequently start
without required environment values.

**Implementation:** Forward-port `agentEnv` as a pre-launch environment layer shared by the agent
CLI and only the MCP processes it owns. Resolve static values and an explicitly configured
direnv/mise-style command before process spawn. Apply a bounded timeout/output cap, calculate only
the environment delta, and log key names and failure classes without values. Treat execution as
trusted-project behavior and show that trust boundary in UI/docs before a command is enabled.

**Compatibility risks:** Environment values frequently contain secrets. They must never be sent to
clients, persisted in agent snapshots/timelines, included in diagnostics, or inherited by unrelated
daemon helpers. A malformed unrelated `paseo.json` may remain fail-soft, but its warning must be
observable.

**Acceptance criteria:**

- Static and command-derived environment deltas reach the provider and its owned MCP servers before
  their first process starts.
- Daemon baseline variables are not copied back as project overrides.
- Timeout, non-zero exit, malformed JSON, unreadable config, and missing executable are bounded and
  actionable without exposing values.
- Windows and POSIX quoting/path behavior, worktree inheritance, redaction, and project-settings UI
  have focused tests.

## PR #1783 - Surface provider task lists as live progress

**Source:** <https://github.com/getpaseo/paseo/pull/1783>

**Reviewed head:** `d94aab112daaa79c58c27e43eb880a8c861324af`

**Drift:** Four commits; synthetic merge is clean against the frozen baseline.

**Why selected:** Claude TodoWrite/TaskCreate/TaskUpdate, Codex UpdatePlan, and OpenCode todos expose
useful structured progress that is currently buried in tool calls. A normalized durable snapshot
supports an inline progress track and a cross-workspace Tasks view.

**Implementation:** Port the final four-commit behavior, including monotonic task IDs. Normalize
full-list and incremental updates in one protocol helper used by server and app. Persist only the
latest bounded snapshot and keep all new snapshot/protocol fields optional. Reuse one progress
component and structural equality helper rather than duplicated UI and `JSON.stringify` checks.

**Acceptance criteria:**

- Full-list and incremental providers converge to the same normalized status/count model.
- Task deletion followed by creation cannot reuse a surviving task ID.
- Hydration, daemon restart, reconnect, archive, and old-client parsing retain correct progress.
- The Tasks dashboard filters/navigates across hosts without subscribing to unnecessary history.
- Protocol reducer, projections, persistence, UI, and real-provider samples pass focused tests.

## PR #736 - Remote-browser download fallback and gated file previews

**Source:** <https://github.com/getpaseo/paseo/pull/736>

**Reviewed head:** `98be9349f57a03f23942e6b6bae71b862e62fb80`

**Drift:** Three commits; 14 conflict sections against the frozen baseline.

**Why selected:** The current web download store still fails when a browser reaches a remote daemon
only through the active WebSocket and has no direct HTTP download host. Binary file reads already
exist in the current client, making a forward-port feasible.

**Implementation:** First extract the WebSocket-byte download fallback, bounded file-operation
timeouts, browser Blob download, cleanup, and progress/error behavior. Adapt it to the current
binary transfer protocol and file-pane model. Treat draw.io/docx/spreadsheet previews as a separate
optional follow-up: do not add `xlsx@0.18.5` or other stale parsers without a dependency, license,
bundle-size, and security review. If approved, preview parsing must be lazy-loaded and web-gated.

**Acceptance criteria:**

- A remote browser can download binary files without direct daemon HTTP reachability.
- Direct local downloads retain their existing fast path.
- Object URLs are revoked and large transfers fail with bounded, actionable errors.
- Focused download-store/client tests cover direct, relay fallback, timeout, and binary integrity.
- Optional office/draw.io previews are not part of Done unless their dependency review is recorded.

## PR #675 - Find in the focused pane

**Source:** <https://github.com/getpaseo/paseo/pull/675>

**Reviewed head:** `bcb3157e754c8080be63057edd283daa5d0df869`

**Drift:** Eight commits; 22 conflict sections against the frozen baseline.

**Why selected:** A consistent find action across terminal, file, agent stream, and browser panes is
a substantial desktop usability improvement and is absent from current `main`.

**Implementation:** Reimplement the shared registry/find bar on the current panel and agent-stream
architecture. The focused pane owns Cmd/Ctrl+F. Use native search adapters for terminal and Electron
webviews, searchable rendered text for files and loaded agent history, and a graceful browser-web
fallback. Preserve cleanup when panes switch or unmount.

**Acceptance criteria:**

- Search, next/previous, match count, no-match state, empty-query cleanup, Escape, and close work in
  every supported pane.
- Search never claims to cover unloaded/virtualized agent history.
- Electron browser search travels through the owning WebContents/preload bridge.
- Focused tests pass and a real Electron smoke test verifies browser search events.

## PR #1865 - Read newer config files without discarding their fields

**Source:** <https://github.com/getpaseo/paseo/pull/1865>

**Reviewed head:** `9eec33773ae42b686817cc6f62573891a1561ea3`

**Drift:** Two commits; synthetic merge is clean against the frozen baseline.

**Why selected:** Commands such as `paseo daemon status` should continue to read known settings
when a newer Paseo version has written additional config keys. The baseline's strict Zod objects
reject those files entirely.

**Implementation:** Do not copy the PR's blanket `.strip()` design: review correctly identified
that load-modify-save paths would silently erase future keys. Keep the raw parsed object alongside
the validated known projection, merge known writes back into the raw object, and atomically persist
the round-tripped result. Malformed known fields must still fail validation.

**Compatibility risks:** This is a forward-compatibility storage contract. Unknown keys may contain
future security-sensitive configuration; preserve them byte-semantically where practical but never
activate or expose them through the older runtime.

**Acceptance criteria:**

- Read-only status commands accept unknown root and nested keys while validating known fields.
- Changing a known field preserves all unknown siblings/descendants across save and restart.
- Removed legacy fields follow the existing explicit migration policy rather than being preserved
  accidentally.
- Corrupt JSON and invalid known values still fail closed with an actionable path.
- Read, merge, migration, atomic write, and round-trip tests pass.

## PR #1817 - Preview HTML files behind an explicit safe boundary

**Source:** <https://github.com/getpaseo/paseo/pull/1817>

**Reviewed head:** `fe678eded08b58cbc37e00aa9c7c2e152f619eca`

**Drift:** Four commits; synthetic merge is clean against the frozen baseline.

**Why selected:** Rendered HTML is valuable for inspecting agent-generated prototypes, and the PR
contains substantial navigation/isolation hardening. Automatically executing scripts merely by
opening an untrusted repository file is still too surprising for the customized fork.

**Implementation:** Reuse the classifier and navigation-guard work, but default to source or a
script-disabled sandbox. Require an explicit per-preview “Run interactive preview” action before
enabling scripts; do not persist that approval across files or reloads. Keep opaque origin, block
top navigation, open external URLs outside the preview under the existing URL policy, and never
grant filesystem/app bridge access. A line-targeted open always shows source.

**Acceptance criteria:**

- Opening HTML cannot execute script or issue preview-origin network requests until explicit user
  action.
- Interactive mode remains opaque-origin and cannot navigate the Paseo frame, access cookies/local
  storage, or reach preload/native bridges.
- File switches reset approval and navigation guards without timing races.
- HTML/HTM/XHTML, line-target, SVG classification, anchor, external link, and hostile navigation
  cases pass web, Electron, iOS, and Android-focused tests.

## PR #1734 - Render Mermaid fences as diagrams

**Source:** <https://github.com/getpaseo/paseo/pull/1734>

**Reviewed head:** `07952b92e9fbb3978a1ecd08fe2d616cfce35b95`

**Drift:** Seventeen commits; synthetic merge is clean against the frozen baseline.

**Why selected:** Mermaid sequence and architecture diagrams are common in agent output and
Markdown files. The current head includes diagram/source switching, strict Mermaid security,
theming, error/source fallback, copy, and fullscreen pan/zoom, and its earlier test-design review
findings were addressed.

**Implementation:** Rebase the web/Electron renderer after the download/file-preview foundations.
Lazy-load Mermaid and keep `securityLevel: strict`. Treat the generated native WebView artifact
(roughly 8 MB in the source PR) as a separate bundle-size/reproducibility decision: native support
is included only if a deterministic build and acceptable installed-size delta are recorded.

**Acceptance criteria:**

- Valid diagrams render with theme changes and Diagram/Source/fullscreen controls.
- Invalid or hostile Mermaid source cannot inject script/links and always leaves readable source.
- Rendering is canceled/ignored after unmount or source change and large diagrams have bounds.
- Web/Electron browser coverage passes; native coverage is required only if the reviewed generated
  bundle is included.
- Generated assets are reproducible and never hand-edited.

## PR #1722 - Drop non-image file paths into the composer

**Source:** <https://github.com/getpaseo/paseo/pull/1722>

**Reviewed head:** `24e7bae6b001d253c3cd2d77e1d83dc9e0cc55c0`

**Drift:** One commit; synthetic merge is clean against the frozen baseline.

**Why selected:** Dragging a file from the desktop is a convenient way to reference source and
documents. Images should remain attachments, while non-images should append a usable absolute or
provider-native reference without overwriting the draft.

**Implementation:** Reimplement rather than cherry-pick the reviewed head. Use one MIME/path
classifier so a drop cannot be handled as both image and text. Centralize the functional draft
updater across agent, workspace draft, and new-workspace composers. Feed eligible workspace files
through item 10's provider-native mention formatter where that preserves semantics; otherwise use a
properly quoted platform path.

**Acceptance criteria:**

- Every drop is classified exactly once as image attachment, text/path insertion, unsupported, or
  error.
- Multiple files append deterministically without stale-closure loss and preserve the existing
  draft/selection.
- Windows UNC/drive paths, POSIX paths, spaces, Unicode, misleading MIME/extensions, directories,
  and mixed image/non-image drops have focused tests.
- Browser limitations degrade clearly; Electron desktop drops work end to end.

## PR #1911 - Insert newlines with Shift+Enter and Alt+Enter

**Source:** <https://github.com/getpaseo/paseo/pull/1911>

**Reviewed head:** `deacb007551d7bde2a82600df202e8fcf1860897`

**Drift:** Two feature commits from the actual branch point; synthetic merge is clean against the
frozen baseline.

**Why selected:** Desktop/web composer Enter currently submits. Explicit Shift+Enter and Alt+Enter
newline insertion matches common chat/editor behavior while leaving plain Enter and Mod+Enter send
actions intact.

**Implementation:** Rebase the two focused composer commits, not unrelated branch history. Keep the
key decision and selection transformation in pure helpers. Derive clamped selection during render
instead of synchronizing it with an effect, and reuse exported event types in tests.

**Acceptance criteria:**

- Shift+Enter and Alt+Enter replace the current selection with one newline and place the cursor
  immediately after it.
- Plain Enter and the configured alternate send shortcut retain their send/queue actions.
- IME composition, autocomplete selection, multiline mobile input, and callback overrides take
  precedence as they do today.
- Tooltip/i18n copy is shown only on surfaces where the shortcut is active.
- Rerun these tests after prompt-history item #671.

## PR #1963 - Pin workspace tabs and sync their order

**Source:** <https://github.com/getpaseo/paseo/pull/1963>

**Reviewed head:** `b14f6396ec7c03b8bb4fa592ab2b504798ed9ad9`

**Drift:** Two feature commits from the actual branch point; synthetic merge is clean against the
frozen baseline.

**Why selected:** Deterministic tab keys already exist, but the baseline has no tab pin state.
Daemon-persisted pins keep important agent/file/terminal tabs leftmost and consistent across
devices.

**Implementation:** Rebase both feature commits onto the current workspace registry and existing
workspace pinning behavior. Preserve the final drag-reorder fix: visual pinned order and persisted
pin order must update together with an optimistic overlay. Keep the RPC and snapshot fields optional
for wire compatibility.

**Acceptance criteria:**

- Pin/unpin and pinned order converge across two connected clients and a daemon restart.
- Dragging within the pinned region persists; crossing pinned/unpinned boundaries does not silently
  change membership.
- Missing/closed tabs prune safely and deterministic IDs never leak client-local tab IDs.
- Desktop context menu, mobile action, multi-pane, cross-pane move, and old-client compatibility
  tests pass.

## PR #2050 - Start chat workspaces without selecting a project

**Source:** <https://github.com/getpaseo/paseo/pull/2050>

**Reviewed head:** `1fe78f24674ed5270d219f48f168a96337eec29b`

**Drift:** One commit; synthetic merge is clean against the frozen baseline.

**Why selected:** Quick model conversations should not require choosing a repository. Isolated chat
workspaces also avoid accidentally granting a simple chat access to an unrelated project tree.

**Implementation:** Port the focused chat-workspace design onto the current sidebar/new-workspace
flow. Create scratch directories under a validated `PASEO_HOME/chats` boundary and mark ownership
explicitly in the registry. Do not permanently delete scratch data as a side effect of ordinary
archive: use the project's recoverable retention/trash policy, with a separate confirmed purge.
If agent creation succeeds but workspace registration/navigation fails, expose and cleanly recover
the orphan through daemon state.

**Compatibility risks:** Introduces a workspace kind and lifecycle/storage policy. Old clients must
either display it as a normal bounded workspace or ignore optional metadata without corrupting it.

**Acceptance criteria:**

- New Chat from home/sidebar creates and opens an isolated registered workspace without a project.
- Chat scratch paths cannot escape the validated root through traversal, symlinks, or crafted IDs.
- Archive is recoverable; explicit purge is scoped, confirmed, and tested against resolved paths.
- Partial create, restart reconciliation, multi-client visibility, import, and old-client parsing
  behave deterministically.
- No unrelated pinning or sidebar bugfixes are imported from older versions of the branch.

## PR #1883 - Report Pi context-window usage during active turns

**Source:** <https://github.com/getpaseo/paseo/pull/1883>

**Reviewed head:** `5ee9f255aef60ebc3365defcd16fa8d1028106f9`

**Drift:** Nine commits; synthetic merge is clean against the frozen baseline.

**Why selected:** The baseline reads Pi usage only after turn completion. Long tool-heavy turns
benefit from context-window updates at tool/compaction milestones and, when explicitly enabled,
bounded polling.

**Implementation:** Extract the usage behavior, not the PR's `.oxlintrc.json` relaxation or
implementation-detail tests. Prefer event-driven milestone reads. Optional polling must be
disabled by default, enforce a sensible minimum interval, prevent overlapping requests, capture the
turn ID before await, discard stale results, deduplicate structurally, and stop on terminal,
interrupt, close, or error.

**Acceptance criteria:**

- Tool and compaction milestones emit changed usage for the correct active turn.
- Optional polling cannot overlap, leak timers, emit after terminal state, or attribute an old
  request to a replacement turn.
- Failures are non-fatal and bounded; unchanged usage does not rerender clients.
- No lint rule is weakened and tests assert observable events rather than private fields.
- Fake-timer cleanup and opt-in real OMP/Pi integration gating are deterministic.

## PR #1185 - Generic external agent-attention hook

**Source:** <https://github.com/getpaseo/paseo/pull/1185>

**Reviewed head:** `68e9be79668745ff87b9da3233d6a5a97bbaa11f`

**Drift:** Two commits; nine conflict sections against the frozen baseline.

**Why selected:** A generic daemon hook allows self-hosted notification systems without embedding
provider-specific services or credentials in Paseo. Current `main` already has a central attention
notification payload and policy that the hook can reuse.

**Implementation:** Add `notifications.hooks.agentAttention` to the current config model, generated
schema, and docs. Invoke it only when the existing attention policy emits an external notification.
Send a non-secret JSON payload on stdin; bound execution time and captured output; log failures as
warnings without blocking Expo/in-app notifications or daemon progress.

**Acceptance criteria:**

- Finished/error/permission decisions exactly match the existing attention policy.
- Timeout, spawn failure, stdin failure, and non-zero exit are bounded and non-fatal.
- No tokens, prompt bodies, credentials, or arbitrary environment values enter the payload/logs.
- Config parsing, persistence, hook runner, and notification integration tests pass on Windows and
  a POSIX CI runner.

## PR #1183 - Show the worktree slug where it disambiguates workspaces

**Source:** <https://github.com/getpaseo/paseo/pull/1183>

**Reviewed head:** `4765a4e927055b8b0ec6048a1d008bc408f180ca`

**Drift:** One commit; 12 conflict sections against the frozen baseline.

**Why selected:** Branch names are not enough to identify the physical Paseo worktree used by
containers and external tools. Current protocols carry creation slugs, but current workspace/tab UI
does not display a stable physical-worktree label.

**Implementation:** Resolve the slug from current workspace ownership/source metadata, with a
normalized basename fallback only for verified Paseo-owned worktree paths. Thread it through the
current panel presentation model and show it as muted secondary text in sidebar, header, tab option,
and agent list where space permits. Hide it when it duplicates the visible branch/title.

**Acceptance criteria:**

- Windows and POSIX Paseo worktree paths produce the same logical slug.
- Normal directories and external worktrees are not mislabeled as Paseo-owned.
- Compact/native layouts remain readable and accessible.
- Focused resolver, sidebar, workspace-header, and tab-presentation tests pass.

## PR #821 - Add a live Sessions view to the sidebar

**Source:** <https://github.com/getpaseo/paseo/pull/821>

**Reviewed head:** `bcd32962f753f7fa0948ce89b755275a50eb4736`

**Drift:** Eight commits; 17 conflict sections against the frozen baseline.

**Why selected:** A flat live-agent view across workspaces makes active remote work easier to find.
Current `main` already labels the existing archive destination as History, but it does not contain
the PR's Workspaces/Sessions sidebar mode.

**Implementation:** Extract only the missing live Sessions mode and filter/navigation behavior.
Reuse current sidebar rows, host/workspace stores, attention state, and navigation helpers; do not
copy the old sidebar shell or the already-landed History rename. Keep subscriptions inactive while
the Workspaces mode is selected.

**Acceptance criteria:**

- Sessions are sorted deterministically, filterable by project/host as supported by current data,
  and omit agents that cannot be mapped safely to a workspace.
- Selecting a session activates its workspace and exact agent tab.
- Workspaces mode incurs no session-list subscription/render churn.
- Targeted render-boundary/navigation tests and desktop/mobile sidebar journeys pass.

## PR #671 - Readline-style prompt history

**Source:** <https://github.com/getpaseo/paseo/pull/671>

**Reviewed head:** `de6122d6c24119fca01da06e943a79580e5fd77a`

**Drift:** One commit; one conflict section because the composer has since been decomposed.

**Why selected:** Arrow-key prompt recall is a useful keyboard workflow and remains absent from the
current composer.

**Implementation:** Rebuild the hook/store against the current composer modules. Scope persisted
history by server, cap it at 100 entries, suppress consecutive duplicates, and restore the exact
unsent draft when navigating back down. Arrow keys must retain normal cursor movement in multiline
text and autocomplete must take priority. Enable only on platforms that expose reliable physical
keyboard events.

**Acceptance criteria:**

- Empty input plus ArrowUp recalls newest prompts; repeated Up/Down navigates and restores the
  original draft.
- Multiline cursor movement, autocomplete, IME input, and native soft keyboards are unchanged.
- History remains isolated between hosts and survives an app reload.
- Focused store/hook/composer tests and an Electron/web keyboard smoke test pass.

## PR #1572 - Update all direct `ws` dependencies to the current security release

**Source:** <https://github.com/getpaseo/paseo/pull/1572>

**Reviewed head:** `b7910301b3c8e10b3eff50d4e3e723638c5428e7`

**Drift:** Two commits; seven conflict sections and a stale generated lockfile against the frozen
baseline.

**Why selected:** The baseline and current upstream still declare `ws` 8.20.0 at the root and
8.14.2 in runtime packages. The PR's 8.21.0 target fixed known memory-exhaustion denial-of-service
exposure, but npm now marks 8.21.1 as current as of 2026-07-22. No newer Paseo upgrade PR was found.

**Affected areas:** Root, app, CLI, desktop, relay, and server manifests plus `package-lock.json`.

**Implementation:** Do not cherry-pick the old lockfile. After the TypeScript migration, set every
direct workspace declaration consistently to the then-current compatible 8.21.x or later patched
release and regenerate the lockfile from the target branch. Inventory nested copies separately;
do not claim transitive build-tool copies were remediated when their owners still pin older lines.

**Acceptance criteria:**

- All direct runtime consumers resolve the verified patched release and no direct declaration
  silently remains on 8.14/8.20.
- WebSocket client/server, relay, encrypted transport, reconnect, frame-limit, and packaged desktop
  smoke coverage passes.
- `npm audit` and lockfile inspection report the exact remaining transitive copies and owners.

## PR #2292 - Resolve the generic default mode to the provider default

**Source:** <https://github.com/getpaseo/paseo/pull/2292>

**Reviewed head:** `cc267e1b3cb4680e9dee33922a6e0eeee31bf300`

**Drift:** Six commits, seven changed files; synthetic merge is clean against the frozen baseline.

**Why selected:** Worktree-agent creation can pass the generic mode `default`, while Codex exposes
concrete modes such as `auto`. The current resolver rejects the alias instead of using the default
advertised in the provider snapshot.

**Affected areas:** Agent-create mode resolution, provider snapshots, CLI help, lifecycle docs, and
focused resolver tests.

**Implementation:** Forward-port the focused resolver behavior. A literal provider mode named
`default` wins; otherwise the alias maps only to an advertised `defaultModeId` that is also present
in the available mode set. A provider with no valid advertised default must still reject it. Keep
the PR's unrelated ambiguous workspace-cleanup concern outside this item; cleanup after an
indeterminate create response requires reconciliation, not eager archive.

**Acceptance criteria:**

- Codex `default` resolves to its current advertised default, while Claude's literal `default`
  remains literal.
- Missing, stale, or non-advertised defaults fail with the available concrete modes.
- Direct CLI creation, worktree isolation, child-agent inheritance, and provider snapshot refresh
  tests pass without archiving a possibly live workspace.

## PR #2295 - Recover agent history when the recorded cwd is gone

**Source:** <https://github.com/getpaseo/paseo/pull/2295>

**Reviewed head:** `be953fa0ab8442d8b5c801e160fdf0785a5d51f4`

**Drift:** Seven commits, 16 changed files; synthetic merge is clean against the frozen baseline.

**Why selected:** Deleting a worktree should not make an existing agent's durable logs unreadable.
The reviewed head also fixes the discovered `ENOTDIR`, stale-record, pre-unarchive mutation, and
provider process-cwd isolation failure modes.

**Affected areas:** Agent loading/manager/prompt paths, ACP and Pi launch context, timeline fetch,
storage records, and structured errors.

**Implementation:** Rebase the reviewed head. Permit missing cwd only for read/history recovery.
Preserve the original cwd in session config and persistence, while using a validated temporary
`processCwd` solely to launch a provider needed for replay. Sending or starting new work must fail
with `MissingAgentCwdError` until the workspace is recreated or rebound. Prefer a resident agent's
valid rebound cwd over stale storage and perform the cwd preflight before unarchiving.

**Compatibility risks:** The new launch-only field must never be persisted or exposed as the
agent's workspace, and a read operation must not accidentally make an unrunnable agent writable.

**Acceptance criteria:**

- `ENOENT` and `ENOTDIR` histories load without rewriting recorded cwd.
- Send, continue, and new-session paths reject missing cwd with actionable recovery guidance.
- ACP and Pi tests prove spawn uses `processCwd` while protocol config/persistence uses original cwd.
- Rebound, archived, stored-only, provider-unavailable, and cleanup paths remain deterministic.

## PR #1603 - Prevent crashes on corrupt diagram-heavy Markdown code blocks

**Source:** <https://github.com/getpaseo/paseo/pull/1603>

**Reviewed head:** `0aacc36ccb86feb6043e18df53ab1193abd87e19`

**Drift:** One commit; one conflict section against the frozen baseline.

**Why selected:** A malformed Markdown attachment can send a large diagram fence through one React
Native Web text node and crash preview rendering. The baseline and current upstream do not contain
the PR's per-line code-block rendering.

**Affected areas:** Highlighted/plain code rendering, web overflow styling, copy behavior, and a
real corrupt-file regression fixture.

**Implementation:** Port the rendering contract onto the current Markdown component. Render each
line as a bounded preformatted row, preserve token colors and exact whitespace, and provide
horizontal overflow without forcing large text layout. Replace the PR's mock-heavy JSDOM suite and
unbounded content-based React keys with pure line-splitting/key tests plus one real browser preview
regression.

**Acceptance criteria:**

- The issue fixture and large plain/highlighted fences render without crash, joined lines, or lost
  whitespace.
- Copy returns the original full code, not visual row artifacts.
- Stable bounded keys handle duplicate lines; accessibility and horizontal keyboard/touch scrolling
  remain usable.
- Pure renderer tests and a web/Electron regression pass.

## PR #1209 - Render provider plans as first-class chat items

**Source:** <https://github.com/getpaseo/paseo/pull/1209>

**Reviewed head:** `71ce3b434e131bc657eca36d764353741f5dd441`

**Drift:** Two commits; 22 conflict sections across protocol, client, server, providers, and stream
UI.

**Why selected:** Plans should be visible as plans, not leaked through generic permission or tool
shapes. This complements Codex Plan mode and also supports Claude/OpenCode plan actions and plan
files.

**Implementation:** Rebuild on current timeline projection and compatibility boundaries rather
than cherry-picking. Add an optional capability-gated plan timeline item and translate it to the
legacy tool-call shape for old clients. Unify live and canonical replay for both plan-file writes
and edits. For every action response, resolve or reject the associated permission promise even
when the action ID is unknown; the reviewed PR's unresolved-permission path is a ship blocker.

**Compatibility risks:** Public protocol/timeline addition, provider-specific action semantics,
durable replay, and old-client wire projection. A plan response must be idempotent and scoped to
the correct pending request.

**Acceptance criteria:**

- Codex, Claude, and OpenCode plans render equivalently live, after reconnect, and after restart.
- Accept/reject/unknown/stale action IDs always settle their pending permission exactly once.
- Plan-file write and edit events replay identically and path allowlists prevent arbitrary files
  from becoming plan cards.
- New/old client-daemon combinations, provider unit tests, stream reduction, and daemon E2E pass.

## Hard-reload the current agent environment after configuration changes

**Source:** User-requested enhancement of the existing Reload agent action; no source PR exists.

**Existing behavior:** The frozen baseline already exposes **Reload agent** in the agent-tab menu.
It interrupts an active run, resumes or creates a replacement provider session, closes the old
session, rehydrates provider history, and preserves the Paseo agent/tab identity. Its tooltip
already promises refreshed skills, MCPs, and login state.

**Remaining gap and benefit:** Reload currently starts from the agent's stored session config and
the daemon's launch environment. It does not explicitly guarantee a fresh project `paseo.json`
read, newly resolved `agentEnv`, or rotation of a shared provider helper such as OpenCode's server.
The action should have a strict hard-reload contract for configuration changes without restarting
the whole Paseo daemon.

**Affected areas:** Tab action/RPC status, workspace config service, agent manager, provider launch
context, shared provider-helper generations, catalogs/commands/features, queue and timeline state.

**Implementation:** Extend the existing action rather than adding a duplicate. Snapshot the stable
agent identity and persistence handle; block new sends, explicitly cancel or obtain confirmation
for an active turn, close the provider session, release owned helper/MCP processes, reload and
validate current project configuration/environment, then start a fresh provider generation and
resume the same provider history. Preserve the Paseo timeline, labels, workspace, and tab. On
failure, keep an explicit recoverable error state and never silently discard queued messages.

**Compatibility risks:** Capability-gate any new RPC fields/statuses. Provider helpers may be
shared, so rotation must retire generations through reference counting rather than killing other
agents. OS/login-shell environment refresh is distinct from rereading project config and must be
documented honestly.

**Acceptance criteria:**

- Editing skills, MCP/provider config, or `paseo.json` `agentEnv`, then Reload, demonstrably changes
  the replacement provider process without changing agent ID or losing history.
- OpenCode receives a new helper generation only when required; Codex and other per-session
  providers fully close their old process/session.
- Running turns, permissions, durable queue items, concurrent reload clicks, timeout, invalid
  config, and restart failure have deterministic tested outcomes.
- Provider catalogs, modes, commands, features, and autocomplete refresh after success.

## PR #1578 - Resolve local project binaries for `paseo.json` commands

**Source:** <https://github.com/getpaseo/paseo/pull/1578>

**Reviewed head:** `010bf752b72f9cf0b5041617d4bb8a46c597b526`

**Drift:** One commit; five conflict sections against the frozen baseline.

**Why selected:** Setup, teardown, service scripts, and configured worktree terminals can fail with
exit 127 because a packaged daemon's PATH does not contain the repository's `node_modules/.bin`.

**Implementation:** Forward-port the shared, Windows-case-insensitive PATH helper into current
external-process environment construction. Apply the cwd-local bin overlay consistently to all
four command sources and after runtime metadata so future PATH-like runtime keys cannot erase it.
Keep manual terminals and agents unchanged. Do not search ancestor projects and do not require the
directory to exist before dependency installation.

**Compatibility risks:** Local binaries intentionally gain command-resolution precedence. The
resolved cwd must be the trusted repo/worktree command cwd, not user-controlled traversal outside
it.

**Acceptance criteria:**

- Bare local CLIs work in setup, teardown, service scripts, and configured worktree terminals from
  packaged/global daemon launches.
- Windows `Path`/`PATH` casing produces one effective key; POSIX behavior remains ordered.
- Manual terminals/agents do not gain the overlay, outer-project bins do not leak in, and missing
  `node_modules/.bin` remains harmless.

## PR #1481 - Remove the terminal worker's stale environment snapshot

**Source:** <https://github.com/getpaseo/paseo/pull/1481>

**Reviewed head:** `65fd0a02618c31a3b345daa74826b70a2fba6b88`

**Drift:** Four commits; eight conflict sections against the frozen baseline.

**Why selected:** A terminal worker may be forked long before a terminal is created, so its
`process.env` can be older than the daemon's. Passing the daemon-side base environment through
worker IPC removes that extra stale snapshot.

**Affected areas:** Terminal worker protocol/manager, shell resolution, PTY environment assembly,
and focused worker tests.

**Implementation:** Port the explicit `baseEnv` request field and use it for both default-shell
resolution and the existing filtered external-process environment builder. Preserve overlay order:
daemon base, cwd defaults, terminal options, then TERM metadata. Keep this distinct from refreshing
the daemon from the operating system; combine its contract with hard reload without claiming that
already-running terminals change.

**Acceptance criteria:**

- A worker created before a daemon env change uses the daemon snapshot supplied at terminal create.
- Runtime-control variables are still stripped and explicit terminal/cwd overrides win.
- Worker and in-process terminal paths match on Windows and POSIX; existing terminals remain
  untouched.

## PR #1554 - Preserve a workspace subdirectory when creating a worktree

**Source:** <https://github.com/getpaseo/paseo/pull/1554>

**Reviewed head:** `f9c1ed1e9bc815fc657fbeb239d161ebb784513c`

**Drift:** Two commits; two conflict sections against the frozen baseline.

**Why selected:** Creating a worktree from `repo/packages/app` currently opens the new workspace at
the worktree root instead of `new-worktree/packages/app`.

**Implementation:** Reimplement the relative-subdirectory mapping in the current worktree service.
Do not use the PR's first-match `projectId` lookup: multiple active workspaces can share a project.
Prefer the exact source workspace ID in the request; otherwise require an unambiguous normalized
cwd/repo-root match and fall back safely to root. Resolve real paths where they exist, handle only
expected missing-path errors, and reject offsets that are absolute or escape the repo.

**Compatibility risks:** If a source subdirectory does not exist in the target branch, the new
workspace must not be registered at a dead cwd without an explicit fallback/error policy.

**Acceptance criteria:**

- Root, nested, symlinked, Windows-case, missing-target, multiple-workspace, and path-escape cases
  resolve deterministically.
- Every worktree entry point uses the same server contract.
- The resulting workspace, terminal, agent cwd, copy-path, and teardown ownership all agree.

## PR #1613 - Queue a message by long-pressing Send

**Source:** <https://github.com/getpaseo/paseo/pull/1613>

**Reviewed head:** `29a54794513faaf67605a81c4a45ea500840ae6e`

**Drift:** One commit; three conflict sections against the frozen baseline.

**Why selected:** Mobile users need a direct way to queue a follow-up while an agent is busy.
Long-press exposes the existing queue action without changing ordinary tap/click behavior.

**Affected areas:** Composer input/state, accessibility hint, native haptics, and queue tests.

**Implementation:** Forward-port only the gesture and its pure success-result helper after the
durable queue item. Gate it on a send-state composer that supports queueing; fire haptics only when
a non-empty message was actually accepted. Prevent a long-press from also firing the normal send
action, and preserve Mod+Enter/configured queue behavior.

**Acceptance criteria:** Tap sends once; long-press queues once; canceled/empty/unsupported presses
do nothing. Screen-reader hint and keyboard behavior remain correct, and iOS/Android device smoke
tests cover gesture threshold, haptic, and no double dispatch.

## PR #2274 - Switch agent settings from the Command Center

**Source:** <https://github.com/getpaseo/paseo/pull/2274>

**Reviewed head:** `b790d914776c36577f0fb9119c79c33b60d25a80`

**Drift:** One draft commit, 15 changed files and eight conflict sections against the frozen
baseline.

**Why selected:** Cmd-K access to thinking, permission mode, Plan mode, and Fast mode makes focused
agent and draft setup substantially faster without cluttering the default palette.

**Affected areas:** Command-center contributions, agent controls, draft composer, icons, i18n, and
setting-builder tests.

**Dependencies:** Implement after Codex Plan mode and default-thinking normalization. Reuse the
same provider mode/feature definitions as visible controls; never maintain a second semantic model.

**Implementation:** Rebase the pure contribution builders onto current command-center APIs. Show
setting choices only during search, identify the current value, and gate options by the selected
provider/model. Keep Plan dual-natured: provider `plan` mode for Claude/Copilot/OpenCode and Codex's
`plan_mode` feature. Selection must use the existing running-agent and draft setters.

**Acceptance criteria:** Search and selection stay synchronized with visible controls for running
agents and drafts; unavailable modes/features never appear. Plan on/off returns to the provider's
advertised default, and web/native keyboard, accessibility, i18n parity, and focused builder tests
pass.

## PR #2298 - Open changed files in live comparison tabs

**Source:** <https://github.com/getpaseo/paseo/pull/2298>

**Reviewed head:** `b3f28d3c258529ca2aaff144b19436a92467b3f7`

**Drift:** Two commits, 24 changed files; synthetic merge is clean against the frozen baseline.

**Why selected:** A persistent comparison tab makes reviewing several workspace changes much
easier than repeatedly expanding inline rows. It can reuse the current diff engine and tab store.

**Dependencies:** Coordinate with open PR #2275's shared Files/Changes menu even if that PR is
implemented separately. One composed context menu should own Open file, Add to chat, and Open diff.

**Implementation:** Port comparison identity, tab persistence/migration, and the live working-diff
panel. A tab represents comparison mode, base ref, and whitespace policy, not a single file; opening
another file focuses the existing matching comparison. Preserve inline review and deleted-file
rendering. Fix the reviewed head's touch-web regression: long-press must continue to invoke the
context-menu handler rather than being replaced by the caller callback.

**Acceptance criteria:** Matching comparisons deduplicate; distinct bases/modes/policies do not.
Revert/rechange/delete, restart persistence, legacy state migration, scroll-to-file, desktop
right-click, touch-web long-press, native behavior, and current diff controls pass focused and E2E
coverage.

## PR #1595 - Collapse long thinking groups in the agent stream

**Source:** <https://github.com/getpaseo/paseo/pull/1595>

**Reviewed head:** `2baa01e2ee2b943d95b54b5a6ca119b0b09d4e0d`

**Drift:** Five draft commits; 15 conflict sections against the frozen baseline.

**Why selected:** Long reasoning traces dominate chat history. A persisted three-state appearance
setting can keep them expanded, collapsed, or automatically collapsed while retaining access.

**Implementation:** Reimplement grouping against the current timeline projection and web/native
stream strategies. Group only contiguous thinking items belonging to the same turn; never absorb
tool calls, permissions, user messages, errors, or final answers. Preserve bottom-anchor and footer
reveal behavior when a group changes height. Apply the setting consistently to live and replayed
history.

**Acceptance criteria:** Boundaries, streaming append, reconnect, virtualized history, manual
toggle, persisted setting migration, accessibility labels, and scroll anchoring have focused tests
on web and native strategies.

## PR #1596 - Add prompt-position indicators to long chats

**Source:** <https://github.com/getpaseo/paseo/pull/1596>

**Reviewed head:** `25515d0687cb27f65c55d395d413ad9db3f6ffde`

**Drift:** Eight draft commits; 12 conflict sections against the frozen baseline.

**Why selected:** Markers for user prompts provide useful landmarks in long sessions and a faster
way to navigate between turns.

**Implementation:** Rebuild web-first on the current stream measurement/virtualization APIs. Derive
marker positions from stable message/turn IDs and measured scroll extent; clamp previews and
recompute on resize, history prepend, collapse/expand, and streaming layout changes. Keep the
feature optional and do not add native UI until the interaction has a native-appropriate design.

**Acceptance criteria:** Clicking a marker targets the correct prompt after prepend/reconnect and
with collapsed thinking; previews remain in viewport; zero-height/rapid resize/stale measurements
cannot produce NaN or jump to another turn; keyboard and screen-reader navigation work.

## PR #1597 - Pin the active user prompt while its turn streams

**Source:** <https://github.com/getpaseo/paseo/pull/1597>

**Reviewed head:** `5bde4734e2b6af58ccd1619501de7a9f767834ee`

**Drift:** Three draft commits; 16 conflict sections against the frozen baseline.

**Why selected:** Keeping the current prompt visible while a long response streams provides context
without repeatedly scrolling back to the turn start.

**Implementation:** Reimplement one shared prompt-selection model with thin web/native renderers.
Pin only the active/currently viewed turn according to the chosen appearance setting, avoid
duplicated accessibility reading, and reserve layout space without fighting bottom anchoring. The
overlay must disappear or switch deterministically on terminal events, history navigation,
reconnect, and a new prompt.

**Acceptance criteria:** Web/native tests cover long and short prompts, attachments, edits,
steering, queue dispatch, reconnect, orientation/resize, reduced motion, manual scrolling, and no
duplicate interaction targets.

## PR #1598 - Restore recently closed workspace tabs

**Source:** <https://github.com/getpaseo/paseo/pull/1598>

**Reviewed head:** `1e62e882d75351e81125a0d96cc565cfe13ed475`

**Drift:** One draft commit; 18 conflict sections against the frozen baseline.

**Why selected:** Accidental tab closure is common, and a bounded restore stack makes it recoverable
without affecting the underlying agent/file/terminal lifecycle.

**Implementation:** Port a bounded per-workspace closed-tab stack onto the current layout store.
Capture deterministic targets and pane placement before removal, deduplicate entries, and skip
targets that no longer exist or are already open. Restore must not unarchive/respawn resources
implicitly; delegate to the current safe open/recovery path. Wire menu and shortcut actions through
the central keyboard dispatcher.

**Acceptance criteria:** Restore preserves target and sensible pane placement, behaves across split
panes and restart per the chosen persistence policy, skips stale/duplicate targets, and composes
with later tab pinning and multi-client layout updates.

## PR #1599 - Optionally embed workspace tabs in the sidebar

**Source:** <https://github.com/getpaseo/paseo/pull/1599>

**Reviewed head:** `5b195e21c44fb0aa97ac83dd146d80c523247b4c`

**Drift:** One draft commit; 22 conflict sections across 25 files.

**Why selected:** For users who navigate primarily through the sidebar, showing a workspace's open
tabs in place can reduce movement between sidebar and top tab row. The value is real but lower than
the correctness and recovery work, so this remains P3.

**Dependencies:** Reassess after sidebar Sessions, archived recovery, restore-closed-tabs, and tab
pinning. Do not carry the draft's old sidebar/layout implementation forward.

**Implementation:** Start with a small persisted appearance mode and reuse the canonical current
tab presentation/actions. Virtualize/collapse inactive workspaces and preserve drag/drop,
attention, active target, pin state, and compact-sidebar behavior. Do not render two interactive
copies of the same tab row simultaneously.

**Acceptance criteria:** Large workspace lists remain bounded; tab focus/close/reorder/pin/restore
works from either presentation; mobile and screen-reader navigation are coherent; disabling the
mode returns to the normal row without losing state.

## PR #1647 - Copy Markdown content from Write tool details

**Source:** <https://github.com/getpaseo/paseo/pull/1647>

**Reviewed head:** `ff4b10248034f2d8d1e3e625ee36bb562a161399`

**Drift:** One commit; one conflict section against the frozen baseline.

**Why selected:** Long Markdown write results are awkward to select manually; a scoped copy action
is a small, useful convenience.

**Implementation:** Add the action only for `.md`, `.mdx`, and `.markdown` write details, using the
existing clipboard/toast primitives and without an extra nested fill-style wrapper. Copy the exact
written source. Extract path classification to a pure helper; follow repository test rules instead
of the PR's mock-heavy component suite, plus one real UI interaction test.

**Acceptance criteria:** Supported extensions are case-insensitive, unrelated writes show no
button, copy errors are visible and non-fatal, success state cleans up on unmount, and the copied
text exactly matches the tool payload.

## PR #1691 - Use a modern configurable default shell on Windows

**Source:** <https://github.com/getpaseo/paseo/pull/1691>

**Reviewed head:** `734af505a283ed4e31f5c1925ebde38ef86a347b`

**Drift:** Two commits, two files; synthetic merge is clean against the frozen baseline.

**Why selected:** New Windows terminals currently inherit `ComSpec` and open `cmd.exe`, which is a
poor default for the development workflows Paseo targets.

**Implementation:** Preserve the intent but do not hardcode an unconfigurable Windows PowerShell
5.1 switch. Add a documented user override, then prefer an executable PowerShell 7 (`pwsh`), fall
back to `%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, and finally `ComSpec`.
Keep `.cmd`/`.bat` provider command routing through `cmd.exe /c`; default interactive terminal
selection must not alter agent launch semantics.

**Acceptance criteria:** Override, pwsh discovery, relocated `SystemRoot`, Windows PowerShell and
cmd fallback paths are deterministic and tested; quoting and shell integration are correct; POSIX
selection is unchanged.

## PR #1204 - Make archived sessions discoverable and recoverable in a workspace

**Source:** <https://github.com/getpaseo/paseo/pull/1204>

**Reviewed head:** `5e38bcbfdc2704929bff8114f2987eb9784ac55a`

**Drift:** Eleven commits; four conflict sections against the frozen baseline.

**Why selected:** Closing a root-agent tab archives it, but Import excludes already-known sessions.
Users need an obvious path to restore a session in the workspace where it lived.

**Dependencies:** Build after the sidebar Sessions view and reuse its authoritative data/cache. Do
not introduce the PR's cycle between a hidden zero-count pill and the sheet that fills its cache,
nor an eager per-workspace polling subscription.

**Implementation:** Add a lightweight recovery entry whose visibility comes from the shared
session index. Filter by normalized workspace identity, not raw cwd string alone. Separate
unarchive from opening the tab so errors say which phase failed, clear transient sheet state on
close, and invalidate shared data once after mutation.

**Acceptance criteria:** Cold start with archived sessions is discoverable without background
polling every workspace; restore opens exactly one tab; open failure does not claim unarchive
failed; cross-host/similar-cwd sessions cannot leak; empty, stale, concurrent, mobile, and restart
flows pass.

## PR #1205 - Show the meaningful cwd tail in Sessions rows

**Source:** <https://github.com/getpaseo/paseo/pull/1205>

**Reviewed head:** `3f769bfe14d6e3ebfb13476f1877527ec0f6014f`

**Drift:** Seven commits; two conflict sections against the frozen baseline.

**Why selected:** Tail CSS truncation hides the project/worktree suffix and leaves identical home
prefixes visible, making Sessions rows hard to distinguish.

**Implementation:** Forward-port the tested `shortenPathTail` behavior into the current shared path
presentation model. Prefer segment-boundary truncation and home shortening, retain a bounded
fallback for a single overlong segment, and avoid fixed character budgets where measured layout or
responsive width is available. Use the same display helper in all session-list surfaces.

**Acceptance criteria:** POSIX, Windows drive/UNC, home root, null, short, trailing-separator,
single-long-segment, compact mobile, desktop width, and accessibility/full-path tooltip cases pass
without double truncation.

## PR #2241 - Generalize question forms for typed answers

**Source:** <https://github.com/getpaseo/paseo/pull/2241>

**Reviewed head:** `d89f8e711b2f621bbd0808fbdbd056111ffc6c14`

**Drift:** Two commits, nine files, and a clean synthetic merge against the frozen baseline. The PR
is open and mergeable on the current upstream base. Recheck its review threads before integration;
the previously reported test-environment and multi-select ordering concerns appear resolved at the
reviewed head.

**Why selected:** ACP form elicitation needs stable machine-readable question keys and typed
answers. This PR separates that data model from the existing permission adapter while retaining the
current question UI.

**Affected areas:** Shared question-form model, question card and hooks, permission adaptation,
tests, and form documentation.

**Dependencies:** Apply after the ACP SDK update and before Issue #2244. Keep existing Codex and
OpenCode question behavior compatible.

**Implementation:** Prefer a rebase of the reviewed head. Preserve stable question keys, typed
single- and multi-select answers, documented answer ordering, and the permission adapter boundary.
Do not expose provider-specific wire objects to UI components.

**Acceptance criteria:** Existing permission prompts remain unchanged; text, single-select, and
multi-select forms round-trip typed values by stable key; cancellation and rejection remain
distinct; answer ordering is deterministic; focused model, adapter, and real component interaction
tests pass without prohibited DOM-hook test patterns.

## Issue #2244 - Implement ACP form elicitation end to end

**Source issue:** <https://github.com/getpaseo/paseo/issues/2244>

**Why selected:** Once the SDK and generalized form model are available, ACP agents should be able
to request structured user input instead of flattening questions into chat text or failing the
request.

**Affected areas:** ACP capability negotiation and connection lifecycle, protocol events and RPC,
daemon/session routing, app form presentation, typed responses, and ACP integration tests.

**Dependencies:** Stack this work after PRs #2240 and #2241. Prefer small upstream PRs for
capability plumbing, request lifecycle, and final enablement if one reviewable change would become
too broad.

**Implementation:** Advertise `elicitation/create` only when the connected client can render and
answer it. Translate ACP questions to the shared form model with stable machine keys, then map
typed answers back without display-label ambiguity. Define ownership when several clients observe
one agent. Every submit, reject, cancel, disconnect, timeout, and shutdown path must settle the ACP
request exactly once and release its resources. Preserve existing Codex/OpenCode question flows.

**Compatibility risks:** This adds an optional public protocol capability and crosses app/daemon/
ACP boundaries. Older clients must continue operating without the capability; a headless or
incapable client must never cause the server to advertise a request it cannot fulfill.

**Acceptance criteria:** Capability negotiation is client-specific; all supported field types
round-trip; submit/reject/cancel/disconnect/shutdown settle once; concurrent clients cannot answer
twice; unsupported clients receive no elicitation; focused protocol and lifecycle tests plus a real
`zcode-acp` smoke test pass.

## Issue #2093 - Make `/goal` behavior explicit in Codex Plan mode

**Source issue:** <https://github.com/getpaseo/paseo/issues/2093>

**Why selected:** The current command reports that a goal was set while Plan mode does not start
the automatic goal turn. That is a misleading success state and can leave the user waiting for work
that will never begin.

**Affected areas:** Codex app-server `/goal` handling, Plan-mode state, user-visible command
responses, and focused command/E2E tests.

**Dependencies:** Implement after PR #2243 establishes the authoritative Plan-mode contract. Do
not silently switch modes without explicit user intent.

**Implementation:** Add a mode-aware precondition around goal activation. Either block activation
with a precise instruction to leave Plan mode, or support an explicit confirmed transition before
starting the goal. Do not persist a half-activated goal or emit the current unconditional success
message when no automatic turn can run.

**Acceptance criteria:** Normal-mode `/goal` behavior is unchanged; Plan mode never reports a
running goal without scheduling it; the response explains the recovery action; retries create only
one goal/turn; restart and mid-turn cases are covered by focused unit and real Codex E2E tests.

## Issue #2253 - Validate agent mode before creating a run workspace

**Source issue:** <https://github.com/getpaseo/paseo/issues/2253>

**Why selected:** `paseo run` can create a directory or worktree workspace before the daemon rejects
an explicit invalid provider mode, leaving an empty workspace and making the next corrected command
create another one.

**Affected areas:** CLI run orchestration, provider-mode discovery, error reporting, and focused CLI
tests.

**Dependencies:** Build after PR #2292 so the generic `default` alias failure is fixed at its
source. This item covers the broader lifecycle problem that PR #2292 explicitly does not solve.

**Implementation:** Before `resolveRunWorkspace`, ask the daemon for the selected provider's modes
in the source cwd and reject an explicit unknown mode with the same available-mode guidance used by
agent creation. Do not add a lookup when no explicit mode was requested. The current CLI already
has workspace list/archive commands, so this fix must not duplicate them or add automatic cleanup.
Do not archive a workspace after an ambiguous agent-create response because an agent may already be
live even though the client lost the acknowledgement.

**Compatibility risks:** Provider discovery may be slow or unavailable. Surface a definitive
catalog error before mutation, but preserve the server's compatibility behavior when modes are
genuinely unknown and no error was reported.

**Acceptance criteria:** The reported `--mode bypass` reproduction fails before `createWorkspace`;
valid explicit modes continue; omitted modes do not add discovery work; provider catalog failures
leave no workspace; existing workspace selection and caller/ambient workspace behavior remain
unchanged; focused tests assert that `createWorkspace` was never called.

## PR #2277 - Preserve line endings and UTF-8 BOM during file edits

**Source:** <https://github.com/getpaseo/paseo/pull/2277>

**Tracked issue:** <https://github.com/getpaseo/paseo/issues/2276>

**Reviewed head:** `c3c358d5bc94c76f295bd1ccce888efc2b18d313`

**Drift:** One commit, nine files, and two synthetic conflict sections against the frozen baseline.
The PR is open and mergeable against current upstream `main`, with no blocking review feedback.

**Why selected:** The web editor currently rewrites CRLF files to LF and removes a UTF-8 BOM even
when the user changes only content. That creates noisy diffs and can break tooling that treats the
original format as a contract.

**Affected areas:** Editor/session models and pane, read-result decoding, line-ending helpers, file
write E2E coverage, and format-specific unit tests.

**Implementation:** Coordinate with the active author; rebase the reviewed head or forward-port it
through the two conflicts. Capture BOM presence and dominant line-ending style when reading, keep
the editor's internal text normalized, and restore the captured representation on write. A reload
from disk adopts the new disk format; a conflict overwrite keeps the local editing session's
captured format. Define deterministic behavior for empty and mixed-ending files.

**Acceptance criteria:** Exact bytes are preserved for unchanged UTF-8 BOM/no-BOM and CRLF/LF
formats; edited text retains the original format; reload adopts external format changes; conflict
overwrite follows the documented local-session rule; mixed/empty files are deterministic; browser
E2E asserts bytes rather than normalized text. Do not open a competing upstream PR while #2277 is
active.

## Issues #1591 and #1592 - Separate ACP soft reconfiguration from reliable hard reload

**Source issues:** <https://github.com/getpaseo/paseo/issues/1591> and
<https://github.com/getpaseo/paseo/issues/1592>

**Why selected:** ACP reload can replace the process and lose providers that do not persist
sessions, while a failed `session/load` currently has no safe recovery. The issues identify one
lifecycle problem, but their proposed connection reuse and empty-MCP retry strategies are not safe
as unconditional fixes.

**Affected areas:** ACP connection/session lifecycle, reload and resume orchestration, persistence
handles, voice/MCP reconfiguration, retry classification, locks/timeouts, cleanup, and recovery UI.

**Dependencies:** Implement after the ACP SDK update. Keep this soft path distinct from the
explicit hard environment reload: configuration/environment changes that require a new process
must still use the hard-reload contract.

**Implementation:** Preserve the current ACP process/session only for settings that the provider
can apply in place, such as a supported mode or model update. Do not call `session/load` for an
already-open session merely to simulate reload. On real resume, retry the same idempotent load only
for classified transient failures with bounded backoff; never mutate the request to
`mcpServers: []`. If history cannot be resumed, keep the failure explicit and offer a deliberate
new-session/fork recovery with a new identity instead of silently presenting an empty session as
the old one. Centralize exactly-once cleanup and provider-specific compatibility decisions.

**Compatibility risks:** ACP providers differ in persistence and in-place configuration support.
Automatic fresh-session fallback would violate history and identity contracts; connection reuse
must not leave stale environment or MCP state.

**Acceptance criteria:** Persistent and nonpersistent providers take documented paths; transient
load failures retry without request mutation; invalid-parameter failures do not loop; no fallback
lies about retained history; locks clear on timeout/cancel/shutdown; old/new processes cannot both
own one session; voice, MCP, hard reload, and restart scenarios have focused lifecycle tests.

## Issue #2254 - Make provider discovery lazy and avoid unwanted CLI launches

**Source issue:** <https://github.com/getpaseo/paseo/issues/2254>

**Why selected:** Opening or creating a Claude-only workspace can currently warm every provider
catalog and launch Codex CLI processes per cwd. Discovery should not execute an unused provider or
repeat expensive probes for every workspace.

**Affected areas:** Provider snapshot management, catalog warming and caching, create-agent
resolution, workspace/UI provider status, refresh behavior, and discovery telemetry/tests.

**Implementation:** Separate cheap configured/available-provider metadata from expensive
workspace-specific model/mode discovery. Warm only the selected, visible, or explicitly requested
provider; coalesce concurrent probes and share safe global results while keeping cwd-sensitive data
properly keyed. Provide an explicit refresh path and preserve accurate status/error reporting for
providers that have not yet been probed.

**Compatibility risks:** Over-broad caching can leak stale cwd-specific modes/models, while fully
lazy discovery can make configured providers disappear from the UI. Availability and catalog
freshness must remain distinct states.

**Acceptance criteria:** A Claude-only flow starts no Codex process; repeated workspaces do not
duplicate provider probes; choosing Codex warms it once and resolves the requested config; force
refresh invalidates the correct scope; concurrent requests coalesce; cwd-specific catalogs cannot
cross-contaminate; unavailable/unprobed/error UI states remain distinguishable.

## Issue #2054 - Render LaTeX formulas safely in Markdown

**Source issue:** <https://github.com/getpaseo/paseo/issues/2054>

**Prior art:** Closed PR <https://github.com/getpaseo/paseo/pull/355> at
`ce548178d6f057bd8345146a4f90890ca80ef1e9`. It was closed during a general cleanup of old,
unaccepted PRs with a request to resubmit against the latest release, not for a documented
technical rejection.

**Why selected:** Paseo renders Markdown but not inline or block mathematical notation, so common
agent responses display raw LaTeX in Electron/web surfaces.

**Affected areas:** Shared Markdown parsing/rendering, renderer dependencies and bundled assets,
sanitization, styling, streaming performance, native fallback behavior, and rendering tests.

**Implementation:** Use PR #355 only as design prior art and implement against the current renderer.
Bundle the math renderer and fonts/assets; do not depend on a CDN or inject unsanitized HTML into a
WebView. Parse inline and display math without treating currency, escaped dollar signs, or fenced/
inline code as formulas. Keep unsupported native clients readable through a graceful source-text
fallback and avoid reparsing an entire long transcript on every streamed token.

**Compatibility risks:** Markdown delimiter ambiguity, HTML sanitization, bundle size, font
loading, accessibility, and rendering cost all cross public content behavior. Math support must not
weaken existing link/HTML security rules.

**Acceptance criteria:** Inline and display formulas render in Electron/web; currency, escaped
dollars, code spans/fences, malformed input, and mixed Markdown remain correct; output is
sanitized; keyboard selection/copy and screen-reader text remain usable; native fallback is
readable; focused parser/security/component tests and a real streaming render smoke test pass.

## PR #2245 - Keep OMP parents active while internal task subagents run

**Source:** <https://github.com/getpaseo/paseo/pull/2245>

**Reviewed head:** `5813abd27e571be98153cdf8576f27c86aaa569c`

**Drift:** One commit, ten files, and a clean base on current upstream `main` at
`4a4556f49982df9519a62a9d8045000e45f57909`. CI is green and GitHub reports the PR mergeable, but
there is no human approval and current review concerns still require code changes.

**Why selected:** OMP can report the parent idle or completed while provider-owned task subagents
are still running. That produces incorrect lifecycle state and would make any later inactivity
warning unreliable.

**Affected areas:** OMP runtime RPCs and types, parent idle gating, subagent snapshot reconciliation,
history discovery, fake OMP adapter, and focused lifecycle tests.

**Implementation:** Coordinate with the active author and do not port the reviewed head unchanged.
Add a short, cached capability probe for `get_subagents`; unsupported OMP versions must not pay the
general 30-second RPC timeout on every turn. Reconcile only changed snapshots, preserve terminal
child states against stale `running` snapshots, and distinguish `unknown`, `supported`, and
`unsupported` so a transient failure cannot immediately complete the parent. Keep orphan child
transcript discovery from the PR.

**Dependencies:** Land before provider-subagent metadata and inactivity warnings. The later
metadata work should consume the snapshot source without expanding this correctness PR.

**Acceptance criteria:** A parent stays running while any child runs and becomes idle exactly once
after all children terminate; old OMP versions are probed once with a short bound; transient errors
cannot falsely finish a supported parent; identical snapshots emit no updates; terminal states
never regress to running; cancellation races and orphan transcript discovery have focused tests;
real OMP fan-out passes manually.

## Show provider-subagent identity and runtime metadata

**Source:** User-requested upstream contribution; no source issue or PR exists yet.

**Why selected:** Provider-managed subagents currently expose only a title, provider, status,
description, cwd, and timeline. Users cannot consistently see the role/name, actual model,
thinking/effort, or context usage of a Codex, OpenCode, or OMP child.

**Affected areas:** Provider-subagent descriptor/store, optional protocol payloads, Codex/OpenCode/
OMP event mapping, subagent track and read-only panel, accessibility and focused tests.

**Dependencies:** Implement after PR #2245 so OMP snapshot reconciliation is stable. Store the
branch in `BenjaminHornung/paseo` and create a draft PR to `getpaseo/paseo` with `gh`.

**Implementation:** Add only optional descriptor fields such as `role`, `modelId`,
`thinkingOptionId`, `contextWindowUsedTokens`, and `contextWindowMaxTokens`. Preserve known metadata
across partial upserts. Map only provider-confirmed values: Codex already supplies child thread ID,
subagent type, and description; OpenCode supplies child session identity/title/cwd and sometimes an
explicit model; OMP supplies name/assignment and `resolvedModel`. Never inherit or guess a missing
child value from its parent. Display compact available facts in the track tooltip and a structured
panel header/details surface while keeping old clients and daemons compatible.

**Compatibility risks:** This is an additive public protocol change. Every new field must remain
optional, capability-gated where necessary, and accepted by old/new peers. Usage must retain its
child-thread association instead of being folded into parent totals.

**Acceptance criteria:** Complete, partial, and metadata-free descriptors render correctly; partial
upserts do not erase earlier values; old schemas remain accepted; provider fixtures prove no parent
fallback; model/effort/context appear only when sourced; role/name is accessible on desktop,
browser, and native layouts; focused protocol/store/UI tests pass.

## Warn when a running agent reports no activity for a configurable period

**Source:** User-requested upstream contribution; no exact source issue or PR exists yet.

**Why selected:** A long-running agent can become silent or stuck without the user noticing. Paseo
already has attention routing plus desktop/web and mobile notification paths, but no configurable
warning for a running turn that stops reporting progress.

**Affected areas:** Persisted daemon configuration, per-run activity tracking, capability-gated
protocol state/events, agent panel warning UI, notification policy/routing, desktop/web notifications,
mobile push, and deterministic timer/E2E tests.

**Dependencies:** Implement after the corrected PR #2245 so provider-child activity keeps the
parent active and unchanged OMP polling snapshots do not reset the timer. Create a separate branch
in the fork and a draft upstream PR with `gh`.

**Implementation:** Track a turn-scoped `lastProviderActivityAt` independent of the broad
`updatedAt`. Count turn start, timeline/tool progress, provider-child activity, and attributable
usage/heartbeat events. Do not count client heartbeats, focus, configuration changes, warning
dismissal, or state reprojection. Suppress warnings for idle/terminal/stopping/reloading/internal/
archived agents and while a permission is open. Add an opt-in persisted setting, initially
`enabled: false`, `thresholdMinutes: 30` with a conservative minimum, and repeat disabled by
default. Emit at most one warning per unchanged inactivity episode and reset it on real progress or
a new run.

**Compatibility risks:** Do not add `inactivity` to the existing closed `attentionReason` enum.
Use separate optional snapshot state plus a capability-gated warning event. A silent long-running
tool is not proof of a hang, so UI text must say that no activity was reported, not that the agent
is definitely stuck.

**Acceptance criteria:** Threshold, reset, run transition, and deduplication are deterministic;
child activity and open permissions prevent false alarms; old clients receive no unknown event;
the visible panel shows a dismissible warning and explicit Inspect/Stop/Reload choices; OS/push
notification occurs only when the agent is not already visible; clicking navigates without
mutating state; Stop/Reload require the existing confirmation/lifecycle contracts; no automatic
stop or restart occurs.

## Add capability-gated stop and follow-up actions for provider subagents

**Source:** User-requested upstream contribution; no source issue or PR exists yet.

**Why selected:** Provider-owned subagent panels are intentionally read-only today. Users should be
able to stop or continue a child only when its provider exposes a reliable child-session operation,
without pretending all Codex, OpenCode, and OMP children share one lifecycle.

**Affected areas:** Optional provider-subagent capabilities, new namespaced request/response RPCs,
provider adapters, parent/child authorization, panel/track actions, pending/error UI, and real
provider tests.

**Dependencies:** Implement after the metadata PR. Split provider implementations into separate
upstream PRs when their contracts differ. Start with OpenCode only after proving acknowledged
`session.abort` and idle-child `session.promptAsync`; create fork branches and draft upstream PRs
with `gh`.

**Implementation:** Each descriptor advertises the exact allowed actions. Validate parent-child
ownership server-side, reject unknown/terminal/stale sessions, never accept a raw provider session
ID as an unvalidated target, and report success only after provider acknowledgement. Follow-up is
available only for a confirmed idle, reusable child; Stop is available only while running. Do not
archive/delete provider-owned sessions or silently convert them into managed Paseo agents. Codex
remains unsupported until a real child-turn ID plus interrupt/start acknowledgement is proven; OMP
remains unsupported until it exposes a child-specific control RPC.

**Compatibility risks:** Public RPCs must be additive, dotted, optional, and capability-gated.
Incorrect capability advertising could interrupt the parent or report a follow-up that the provider
discarded.

**Acceptance criteria:** Actions appear only when advertised; pending/success/failure are visible;
wrong-parent, missing-child, terminal-state, duplicate, disconnect, timeout, and missing-capability
cases fail safely; OpenCode tests prove exact child identity/cwd and provider acknowledgement;
Codex/OMP show metadata without controls until equivalent real-provider evidence exists.

## Installed provider-CLI version detector and update prompt

**Source:** User-requested upstream contribution; no source PR exists.

**Why this remains useful:** Paseo launches provider CLIs (Codex, OpenCode, Pi, OMP) as spawned
processes. Users install and update these CLIs independently. Paseo currently has no visibility
into which provider CLI version is installed, so a stale CLI can cause confusing failures (missing
features, protocol mismatches, crashes) with no actionable diagnostic. A lightweight version
detector with an update prompt turns silent staleness into an explicit, actionable signal.

**Affected areas:** Provider-CLI discovery/availability checks, provider catalog or a new
diagnostic surface, settings/diagnostics UI, i18n, and the existing provider-availability and
launch paths.

**Implementation:**

- Detect the installed version of each provider CLI that Paseo already discovers for provider
  availability (Codex `codex --version`, OpenCode `opencode --version`, and equivalents for Pi
  and OMP where the CLI exposes a stable version flag). Do not install or auto-update CLIs.
- Run version detection lazily (on provider-availability check, settings open, or an explicit
  "Check for updates" action), not on every daemon poll. Bound execution time, suppress stderr,
  and treat detection failure as "unknown version" rather than an error.
- Compare the detected installed version against the latest published version from the provider's
  official release source (npm registry `dist-tags` for npm-distributed CLIs, GitHub Releases for
  binary-distributed CLIs). Use the provider's documented latest channel; fall back to "unknown
  latest" if the release source is unreachable. Never fetch or store credentials.
- Show the detected version and an update prompt in the settings/diagnostics surface where the
  provider's availability is already shown. An "Update available: vX.Y.Z" indicator with a link
  to the provider's install/update instructions is sufficient; Paseo must not download or execute
  an update itself.
- Keep detection extensible: a per-provider version probe descriptor (command, flag, parse rule,
  release-source URL) should be declarative so adding a new provider does not require code changes
  beyond registering the probe.
- Reuse the existing provider-discovery and external-process infrastructure. Do not add a new
  package manager dependency. Do not block daemon startup, provider launch, or normal operation
  on version detection.

**Compatibility risks:** Spawning `--version` on an untrusted or misconfigured PATH entry could
execute an unexpected binary. Detection must use the same trusted provider-binary resolution that
launch uses, never a bare PATH lookup. Release-source HTTP calls must be bounded, non-blocking, and
must not leak workspace or user identity. A provider that does not expose a version flag must show
"version unknown" without an update prompt.

**Acceptance criteria:**

- Each provider CLI that exposes a stable `--version` shows its detected version in the settings or
  diagnostics surface after a bounded, non-blocking probe.
- An update prompt appears only when a newer published version is confirmed; stale, unreachable, or
  unknown release sources show the detected version without a false update prompt.
- Detection failure, timeout, missing CLI, and PATH-injection resistance are tested with focused
  unit tests using fake process spawners and mocked release sources.
- No real network call or CLI spawn occurs during daemon startup or normal operation; detection is
  explicitly triggered or lazily cached.
- A new provider can register its version probe without changing detection logic.

## Final implementation gate

After all selected work is implemented, refresh upstream refs and run the smallest relevant focused
tests for each item, followed by `npm run typecheck`, `npm run lint`, `npm run format:check`, and
`git diff --check`. Do not run the full local test suite. Review the complete fork diff for duplicate
upstream work, protocol compatibility, generated artifacts, dependency risk, and attribution before
any commit, push, or upstream pull request.
