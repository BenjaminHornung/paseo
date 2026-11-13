# Paseo Advanced controller

This private workspace vendors the sanitized 72-file controller candidate identified by
`INTEGRATION_MANIFEST.json`. That manifest records the original import, not hashes of the
subsequent integration changes. `dist/build-info.json` hashes the actual compiled inputs
and records the exact workspace SDK version. No original runtime state or credentials are included.

The Windows package bundles controller entries and the compiled fork client/protocol SDK.
Node 24 or newer is required for SQLite and native TypeScript development. The packaged
controller runs under the application's Electron Node runtime. Plugin server imports
stay within `client`, `server` and `shared`; the controller executes through bounded RPC
child processes. The watch heartbeat remains a separate module and worker entry.

`PASEO_ORCHESTRATOR_ROOT` selects code; `PASEO_ORCHESTRATOR_DATA_ROOT` selects writable
configuration/state. Advanced sets both, together with `PASEO_ORCHESTRATOR_NODE`,
`PASEO_ORCHESTRATOR_POWERSHELL`, `ORCHESTRATOR_CONFIG` and `ORCHESTRATOR_STATE`, from its
own executable/home. Original Paseo/controller directories are never defaults.

The initial configuration has zero API budgets, disabled API access/dispatch and no
credentials. Configure verified routes and approved funding through the new profile's
settings. Pi additionally requires explicit `PASEO_ORCHESTRATOR_PI_BASE_LAUNCHER` and
`PASEO_ORCHESTRATOR_PI_PACKAGE` (the installed Pi coding-agent package directory).
The package uses its own bundled guard through `PASEO_ORCHESTRATOR_LUNA_GUARD` and its
own profile under the data root. Only model/state catalog RPCs may pass without a
worker monitor; prompts require the supervised path. The Pi job supervisor remains
distinct from Codex-reported terminal observations.

Pi's Job Object proves process ownership, not an operating-system security sandbox.
Its provider guard reserves and caps ordinary provider requests and retries. It cannot
prevent deliberately hostile same-user code from editing its ledger/database or accessing
same-user credentials through shell commands. Treat approved repositories and commands as
trusted; do not describe these limits as tamperproof financial or credential isolation.
The default package grants no API spending. Stronger isolation would require a separate
credential broker and OS permission boundary, which this integration does not introduce.

Completion requires a new public background query bound to the exact provider session,
settled projected tools, configured checks and independent exact-diff review.
Decisions is advisory. The main reads the current input identity through
`orchestrator_interpret_input`, then submits an immutable `MainInputInterpretation`
bound to its authenticated human receipt, frozen facts hash and expected previous work
binding. Plan/review are read-only. Start/change authorize the stated objective;
question/status/unchanged continuation preserve only existing authority, stop revokes
it, and approval selects an exact pre-existing task/hash/package. Caller identity comes
from AgentToolContext. New uninterpreted input blocks writes; a notification cannot
become a human instruction. Existing accepted legacy assessments and operator
confirmations remain readable; contradictory reinterpretations are rejected.
New implementation packages carry `packageInterpretation` (complexity, optional
ui/general workKind, additionalPlanning and advisorNeeded) in the normal registration
tool. A separate immutable MainPackageInterpretation binds that declaration to exact
package facts; effectiveImplementation retains hard risk, tier and owner gates.
Advisory disabled/key-missing/low-confidence/timeout/PENDING/UNKNOWN states do not
override valid main authority. Their actual call/reservation records remain immutable
and are never replayed. This financial uncertainty is distinct from unknown processes,
which still block completion. Late advice cannot change authority or revive a stop.
An unregistered original package may then be admitted under its original intake;
registered packages keep their immutable binding and are not duplicated by a question.
Cached attempted or paid assessments are not reclassified or treated as new continuation evidence.
Approvals append exact task/contract/intake/package links; amendments create a new immutable
task revision after the predecessor settles. Missing capabilities remain explicit waits.
For a named task approval, call the normal `orchestrator_register_task` with the existing
package's workflowId, taskId and stored role. Only these fields select the target;
submitted changes cannot edit its stored contract. The task must have been registered
before the approval. One assessment binds atomically to one task; repeating that exact
binding is idempotent, while a different or unknown target waits. An accepted task
approval preserves the original objective's authority for ordinary work, including
while target selection is unresolved; it grants no new objective or permission to
another high-risk task. High-risk dispatch, continuation and verification still need
that task's audited owner approval.
Reviewer preference is preserved; unsupported completion boundaries are audited before
falling back to the next eligible saved route.

A terminal reviewer response with invalid JSON types remains rejected; native reviewers
receive the typed schema and a valid example (`unresolvedIssues` is an integer count).
For concrete corrections, `orchestrator_continue_task` can consume the existing rejected
review with its exact diffHash and scoped findings, even when the implementation attempt
still projects VERIFY. The reviewer must first be freshly confirmed idle and process-safe.
Active, unknown or changed reviewer bindings block continuation. The same Codex worker
retains its original lease and approval; superseded review/check records are atomically
archived before their projections are replaced. Its repaired turn receives fresh checks
and a distinct, idempotent native review request. This never accepts the rejected verdict
or substitutes for final independent review and any required visual acceptance.

After native history replay, controller-owned activation, wake and reminder messages
retain their internal origin through the existing receipt/session/message identity audit.
While a submitted prompt and its native echo are both observed, the public timeline's
optional `providerMessageId` preserves their exact correlation in that audit before
checkpoint slicing. This prospective proof survives native-only replay even when the
echo timestamp differs; it does not infer an unobserved historical alias.
If the first native alias is missing, capture reads complete history for the strict,
unique content-hash and timestamp match before classifying new input. Only unresolved
internal identities relevant to the checkpoint, an unverified intake/open pending binding,
or later input require that first proof; absent old transport does not force every pulse
to read complete history. This selection itself never proves origin. A proven internal
message never becomes human authority, including a historical unverified assessment
created before that alias was recovered. Its original facts/results and any financial
call state remain visible and unchanged. Ambiguous identities, incomplete history and
colliding human/operator claims block; genuine new human input still requires normal
interpretation. Both IDs of the proven timeline entry identify the same checkpoint.
Observe-only recovery waits when an implementation is not VERIFY; it does not restart
a closed worker, attest its processes or accept its review. Reopening the same existing
agent uses the normal public reload path with fresh identity and safety checks.

Finalization checks current task authority before evaluating quality and again inside
the finish transaction, including every affected cohort contract. Uninterpreted new
input or missing task-specific owner approval pauses the existing revision without
changing its verdict, repair counter or lease. After legitimate clarification, the
same revision can finish normally; this does not reopen previously failed attempts.

An exhausted task (`BLOCKED`, latest attempt `FAILED`) cannot be resumed by an agent.
An explicitly authorized historical approval-only finalization failure can instead use
the operator-only command `verification-recover <task-key> <request.json> <reason>`.
The strict request schema is `src/verification-recovery.ts`. It binds the attempt/fence,
original work intake, receipt and native message/session, contract/config, diff,
scope/check revisions and exact cached check/review/final-verdict hashes. Raw JSON
hashes use SHA-256 of the unchanged stored strings; `reviewRunSha256` hashes
`JSON.stringify` of the complete `SELECT * FROM review_runs` row. `checkBindingHash`
uses the existing canonical hash of `Store.checkCommandBinding(contract)`.

This command records separate operator provenance, never a human receipt or observed
native echo. One transaction archives the original failed verdict and reenters VERIFY
on the same attempt/lease without changing its repair counter. A durable marker then
allows only cached verification: missing/changed evidence or process uncertainty waits;
no new checks, reviewer, implementation, attempt or negative repair round is allowed.
The command advances only that attempt through the normal finalizer, never all READY
tasks. An exact replay reports existing state without repeating the exception; changed
bindings reject. Reentry alone is not completion. After legitimate same-ID runtime
recovery, use normal `workflow reconcile <attempt-id>` and `workflow advance <attempt-id>`
for that same revision. No generic historical status reset is provided.

After explicit authorization for one additional repair, an operator may run:

```text
node <installed-controller>/dist/src/cli.js terminal-repair-approve <task-key> <request.json> "Reason for the authorized extra round"
```

Use the intended installation's explicit code/data roots and daemon home. The request
contains `predecessorAttemptId`, `predecessorFence`, `agentId`, `nativeSessionId`,
`contractHash`, `configHash`, `diffHash`, `checkEvidenceSha256`, `scopeRevision`,
`checkRevision`. Optional `additionalAllowedPath` names exactly one existing file
outside the effective scope. Omit it for a repair entirely within the existing
scope; omission preserves that scope and its revision without a scope-extension
audit event. Null, empty and invalid paths are rejected.
`checkEvidenceSha256` hashes the unchanged raw `turn_checks.result_json` bytes.
Scope/check revisions use the controller's existing stable `hash` convention:
`{contractHash, paths: sortedEffectivePaths}` and
`{contractHash, checks: effectiveCommands, scriptHashes: externalScriptHashes}`.
Optional `checks` uses the normal build/test command arrays. The operator must retain
compilation and the original test assertions; diagnostic `--no-build` runs are not
final checks. Existing script/worktree validation remains mandatory.

Approval is CLI-only, not a human intake receipt or a main tool. It freezes the exact
terminal predecessor, old evidence and approved scope/check revisions. The usual
`orchestrator_continue_task` then supplies exact-diff, scoped findings. After fresh
identity, process, authority and ownership checks, its atomic claim consumes the grant
and creates a new attempt in the same task, Codex worker and native session. Its fence
exceeds the predecessor even if the old lease row is absent. Scope/check audit events
remain bound to the unchanged original contract. Failed claims leave no partial
consumption, scope, command, lease or outbox projection.

The terminal repair claim returns immediately as
`{agentId, continued:false, delivery:"pending", attemptId}`. It is durably accepted,
not confirmed started. The existing normal tick delivers that exact outbox intent
after repeating all delivery gates. The main ends its turn and waits for status or
actual controller/child notifications; it must not repeat continuation, approval or
registration because delivery is pending. Report an actual failed runner or concrete
delivery blocker. Non-terminal continuations that executed retain
`{agentId, continued:true}`. Neither result attests task completion.

The old failed attempt, checks, review evidence and rework count remain unchanged.
The successor receives fresh checks and a distinct independent review request. There
is no second grant for that task or generic continuation of this extra attempt; an
unknown send is reconciled through the existing outbox/run acknowledgement gates.
Another failure blocks without resetting `maxRework`, counters, budgets or history.
This path does not reload closed agents, change check timeouts, ignore job children,
or reinterpret exit 124 as success. An operator must first reopen the same existing
agent through the supported lifecycle when necessary.

Under **Rollen & Modelle → Reihenfolge je Rolle & Arbeitsart → UI-Implementierung**,
choose existing routes and order their priority, including routes created from Advanced
profiles. The optional `roleRoutes.ui` list applies to mutating implementation packages
whose bound package classification has `workKind: "ui"` or whose assessed execution facts
have `uiChanged: true`, regardless of their
`implement-simple`, `implement-normal` or `implement-complex` role. It does not change
complexity, tier, capability, repository approvals, budgets, writer coordination,
review or visual acceptance requirements. Repository and file boundaries remain mandatory.

Company `claude` and private `claude-private` routes can be saved in the same ordered
list. They retain separate subscription access and circuits; private routes require a
distinct effective native configuration directory, including inherited launcher
environment. Existing repository, tier, funding and capability gates still apply.
Saving a preference does not add repository approvals.

Data privacy classification is no longer a controller feature. Preparation and settings
have no public/personal/company/restricted selection or route allowlists. Account choices
such as company/private Claude still select distinct subscriptions, launchers and quotas.
Deprecated dataScope/dataScopes values load unchanged only to preserve legacy hashes;
they do not affect eligibility or authorize work. A latest, authenticated local-only
DECISIONS_SCOPE_BLOCKED assessment with no attempted call can enter the normal first-call
lifecycle once, with an atomic audit of the old local decision. Existing model answers,
unknown calls, operator-confirmed or superseded assessments are never replayed.

Absent UI preferences preserve ordinary role routing; removing all UI assignments restores
that behavior. Once configured, only the saved UI candidates are considered, in order,
including for compatible session reuse. Ineligible earlier candidates are recorded in
the routing detail (`category: "ui"`); if all are unsuitable, the controller waits with
`ui-no-safe-and-funded-candidate` and reports their skip reasons instead of silently
using the generic implementation list. Settings updates apply to newly admitted tasks;
existing tasks retain their pinned configuration.

Older saved decisions without `workKind` remain legacy evidence; replay does not turn
them into a new UI classification. Existing configurations remain compatible. UI work
retains its required visual acceptance independently of implementation complexity.

Under **Arbeitskategorie anlegen**, create a named category such as Datenbank, describe
the work it covers and choose its primary model route. Select it under **Rolle oder
Arbeitsart** to edit its name, description and ordered fallback routes, or delete it.
Save and reload through the existing settings controls. Creating or editing a category
preserves the existing UI preference. Each category requires at least one known route.
The optional `workCategories` configuration does not add defaults to legacy files.

New package facts freeze the actual category catalog and routing configuration identity.
Decisions advises from those choices; the main selects a bound `workKind` from the
catalog returned by `orchestrator_interpret_input`. A custom category takes precedence
over UI routing, while actual `uiChanged` and UI work still require visual acceptance.
An omitted or uncertain category uses ordinary role routing (with existing UI preference
where applicable). An explicit category uses only its saved routes, including native
session reuse; exhaustion waits rather than appending generic candidates. Registered
tasks keep their pinned catalog and configuration after later edits. Existing paid,
pending and unknown assessments are never reclassified by changing category settings.

For a new main-authorized implementation, unknown complexity or additional planning
returns the existing planning error before claiming package advice or authoritative
facts. After clarification, submit the same unregistered package with complete facts
and declaration. Complete declarations and registered contracts remain immutable;
existing advice with changed facts still fails closed instead of rewriting its history.

Existing focused checks run with `npm test` and `npm run typecheck` in this workspace.
Root lint keeps every rule active. Its exact diagnostic baseline records reviewed source
debt from this imported controller without ignoring the directory or accepting additional
diagnostics. Correctness findings are repaired or individually dispositioned; changed
source spans, messages and occurrence counts require renewed review.

Passing source checks, native API probes and package smoke are separate from full real V3
acceptance. A pilot with a mock Decisions classifier must be labelled as wiring evidence;
it cannot establish paid Decisions acceptance or grant an API budget.
