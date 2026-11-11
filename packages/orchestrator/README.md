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
settled projected tools, configured checks and independent exact-diff review. Informational
follow-ups preserve prior authorization while unclassified input blocks new writes.
Approvals append exact task/contract/intake/package links; amendments create a new immutable
task revision after the predecessor settles. Missing capabilities remain explicit waits.
Reviewer preference is preserved; unsupported completion boundaries are audited before
falling back to the next eligible saved route.

Under **Rollen & Modelle → Reihenfolge je Rolle & Arbeitsart → UI-Implementierung**,
choose existing routes and order their priority, including routes created from Advanced
profiles. The optional `roleRoutes.ui` list applies to mutating implementation packages
whose bound Decisions result has `workKind: "ui"` or whose assessed execution facts
have `uiChanged: true`, regardless of their
`implement-simple`, `implement-normal` or `implement-complex` role. It does not change
complexity, tier, capability, repository/data approvals, budgets, writer coordination,
review or visual acceptance requirements. Existing scope approvals remain mandatory.

Company `claude` and private `claude-private` routes can be saved in the same ordered
list. They retain separate subscription access and circuits; private routes require a
distinct effective native configuration directory, including inherited launcher
environment. Existing data/repository, tier, funding and capability gates still apply.
Saving a preference does not add data or repository approvals.

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

Existing focused checks run with `npm test` and `npm run typecheck` in this workspace.
Root lint keeps every rule active. Its exact diagnostic baseline records reviewed source
debt from this imported controller without ignoring the directory or accepting additional
diagnostics. Correctness findings are repaired or individually dispositioned; changed
source spans, messages and occurrence counts require renewed review.

Passing source checks, native API probes and package smoke are separate from full real V3
acceptance. A pilot with a mock Decisions classifier must be labelled as wiring evidence;
it cannot establish paid Decisions acceptance or grant an API budget.
