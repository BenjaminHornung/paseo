# Composer predictions and harness context

Status: approved and implemented in the feature checkout. Installed Paseo/Advanced runtimes have not been updated. Verification and supported-runtime limits are recorded in the [implementation plan](plans/2026-11-11-composer.md).

## Confirmed requirements

- A host-wide Composer prediction setting selects an existing Paseo Agent profile, also used by Advanced. The selected profile runs predictions for all chats, independently of the chat provider (Codex, Pi or Claude).
- The context picker contains only capabilities available to the current chat harness, account, host and workspace. No cross-harness skill or plugin import.
- `@` and the attachment plus menu expose the same searchable capability catalog, alongside existing file selection.
- Accepting a prediction or selecting context never submits a message automatically.

## Existing implementation to extend

- Agent profiles: `packages/app/src/agent-profiles/`, persisted in `daemon.agentProfiles`. Advanced routes already refer to these profiles by ID; no second profile registry is needed.
- Internal structured generation: `packages/server/src/server/agent/agent-response-loop.ts`. Metadata generation already runs non-persisted internal helper agents. Its existing automatic provider fallback must not silently replace the explicitly selected Composer profile.
- Composer: `packages/app/src/composer/`. Preserve its editing session, draft ownership, keyboard routing and attachment submission paths.
- Autocomplete: `packages/app/src/hooks/use-agent-autocomplete.ts` currently combines slash commands and file mentions. Inline slash commands already filter to provider skills.
- Harness commands: Codex loads `skills/list`; Claude uses `supportedCommands()`; Pi uses its runtime `getCommands()`. These are the starting point for skills, not a filesystem-wide search.
- Plus menu: `packages/app/src/composer/index.tsx` already integrates plugin attachment sources. Those Paseo sources are distinct from a harness's own plugins/connectors.

## Prediction settings and execution

Add a Composer section beside Agent profiles in host settings, using established settings rows and profile controls. Persist `composerPredictions: { enabled, profileId }` as host daemon configuration; default disabled with no profile selected. The same section is available in Paseo and Advanced. It states that the setting applies to all chats on this host and that generating suggestions uses the selected provider's allowance.

Resolve the profile on each new prediction. Inherit its provider, model, supported reasoning and safe generation options. Validate current availability. Missing/deleted/disabled profiles produce an explicit configuration state and no prediction; never fall back to the chat model or another provider. Standalone prediction currently supports Pi and Claude with their default launch commands. Custom replacement commands and nonempty appended command arguments are excluded because they can restore tools or run hooks before the isolation flags apply. Normal chat launches retain their configured commands.

The generation request is bound to the source agent and latest completed turn. Read the source conversation on the daemon rather than accepting arbitrary client-supplied history. Include conversation messages with explicit roles, preserve original user wording and relevant prior requirements, and bound context size. If a history budget is required, preserve recent exchanges plus a separate bounded sample of earlier user messages for style. Clearly distinguish this approximation from Codex's inherited full-context sampling.

The prompt predicts this user's likely next message, including their language, register and characteristic phrasing. It must continue their actual intent rather than recommend a generic best practice. Return one concise suggestion or no suggestion. Do not deliberately add spelling mistakes, introduce new facts or turn the source conversation into executable instructions.

Prediction helpers are internal, non-persisted and incapable of acting on the workspace or invoking tools. Enforce that restriction in provider execution, not just the prompt. Reuse existing tool-policy support where effective; inspect and verify the Pi path before advertising tool-free execution for it. Do not inherit live tools, plugin MCP registrations or orchestration actions merely because the chosen profile normally supports them.

Deduplicate by source agent, source turn and effective profile revision. Bound concurrent jobs and generation lifetime; close helper resources on completion, cancellation and timeout. A new source turn, changed profile/configuration or disabled predictions invalidates old results. Store only ephemeral prediction results; do not create a new durable user conversation.

## Prediction interaction

Show a muted suggestion when the chat is idle, the source turn is still current and the composer is empty and editable. Tab accepts it as an ordinary editable draft on desktop/web; offer a touch-accessible acceptance action on mobile. Escape dismisses it for that turn. Typing remains immediate.

Existing autocomplete/popovers and IME composition retain keyboard priority. Never overwrite a draft, accept during IME composition, send on acceptance, or display a late suggestion after navigation/new work. Multiple clients may request the same prediction without spawning duplicate helper jobs. A prediction failure must not impair ordinary sending; settings and scoped diagnostics distinguish disabled, unavailable, timed out and failed states without recording conversation content.

## Harness capability catalog

Expose a normalized, session-scoped catalog with stable ID, kind (`skill`, `mcp`, `plugin`, `connector`), display name, description, origin and the native invocation identity. Entries come from the selected harness's effective runtime/catalog, not from another harness or a global installed-plugin cache. Do not include credentials, endpoint secrets or raw configuration.

Extend the existing provider contract with a read-only capability inventory. Use the already integrated commands/skills APIs first. Inspect installed/runtime-supported introspection for MCPs, plugin state and connectors per adapter; implement only verified calls. Pi's present command API is not proof that it exposes MCP/plugin/connector inventory: add a supported adapter/bridge path where necessary rather than fabricate an RPC name. Categories with no verified available entries are empty, with discovery failures distinguishable from successful empty results.

Availability means usable in the current session, not merely installed. Do not sign in, enable, install, or grant permissions through selection. Respect each provider's advertised catalog/tool-search behavior; never require every remote tool to be eagerly loaded just to list a connector. The originating harness owns its credentials and execution.

Reuse existing autocomplete and picker primitives. Group by kind and search across available entries; show names and provenance without technical configuration. `@` preserves existing file search, while the plus menu opens the same capability picker. Selecting an entry adds removable context to the current draft using the existing attachment/model path; switching chat/provider must not retain an executable reference to the previous harness.

At submission revalidate the reference against the actual destination harness. Translate selected skills into verified native skill invocation where supported, retaining an unambiguous identity and task text. For MCPs, plugins and connectors, pass the provider-supported explicit reference or a clear scoped instruction naming an available capability. Do not claim that selection guarantees invocation or that textual mentions grant access. Stale/unavailable selections require correction rather than silently becoming a different capability.

## Protocol and integration

Use the existing dotted request/response naming convention for prediction and capability requests. Add capability gates so old daemons do not receive unsupported operations. Preserve current command/attachment behavior for older peers. Register operation permissions: capability listing requires workspace read; prediction generation requires permission to execute model work as well as read the source conversation. Bind requests to the authorized agent/workspace/host.

Integrate daemon configuration through persistence, mutable patch/readback, SDK types and host settings, rather than storing only a local UI preference. Maintain existing Advanced/Paseo isolation; changing source here does not update, restart or deploy either installed runtime.

## Acceptance and proportionate verification

1. Settings save and reload the selected existing profile. A chat running each of Codex, Pi and Claude sends prediction work through that independent profile; a missing profile does not invoke another model.
2. A completed conversation can produce a suggestion in the user's language/style. Tab/touch acceptance changes only the draft; typing, Escape, IME, navigation, attachments and a new source turn protect user input and reject stale results.
3. Verify prediction isolation with a fixture that attempts a tool action: no tool side effect occurs. Verify owned helper cleanup after success and timeout/cancellation.
4. `@` and plus use the same catalog for the current harness. Switching Codex/Pi/Claude changes the results, unavailable entries stay absent, and selected skills reach the correct native invocation or verified reference path. Discovery failures remain visible.
5. Run compiling checks for affected protocol/client/server/app packages, existing focused command/profile/attachment checks and browser verification of the changed flows. Add only tests for consequential gaps (wrong profile, cross-harness capability leakage, tool execution, lost draft/stale acceptance), with one plausible fault proving each important new regression test's value. No blanket coverage or full-suite mandate.

Do not claim model-quality equivalence to Codex from unit tests. Compare predictions at a bounded set of real conversation checkpoints using meaning and personal phrasing as separate criteria; keep actual conversation contents private.
