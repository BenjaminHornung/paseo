# Fork composer receipts and Windows CI implementation plan

**Goal:** Integrate current upstream main in BenjaminHornung/paseo, retain fork history,
record normal-composer input receipts, and produce checked downloadable Windows artifacts.

**Spec:** User-authorized `HANDOFF_PASEO_FORK_CI.md` in the read-only controller checkout.
The user explicitly requested execution through CI, including push and a fork PR.

**Architecture:** Continue upstream's composer dispatch and desktop packaging flow.
Use the existing public orchestrator RPC before native dispatch for prepared sessions.
Keep upstream workflows; add a fork-only unsigned, nonpublishing Windows artifact job.

**Tech stack:** npm workspaces and committed lockfile, Expo renderer, Electron,
electron-builder, Vitest, Playwright, GitHub Actions windows-latest.

## Constraints

- Only this checkout may change; controller, customer worktrees and installed app remain untouched.
- No secrets, new credentials, signing, release publication or paid runners.
- Later explicit handoffs authorize public protocol/native-adapter changes and the vendored
  controller integration in this fork. Live controller/customer sources remain read-only.
  Preserve typing, attachments, queue, retry and titles.
- High-value tests only; no broad local test suite. A regression check must detect its intended fault.
- Lead integrates and accepts; Codex gpt-6-luna max children never delegate.

## Tasks

- [x] Clone fork main `1a1ff8828f002fce08e239bae3d46aff75e22f52`.
- [x] Fetch upstream main, refreshed through `e7432cb2a5968ecec5dbc3a9d66a218fbbdc306b`.
      Includes 0.16.0-beta.1 reconciliation. Advanced maps to 1.16.0-beta.1.
      Fork is an ancestor, 1883 commits behind, with no fork-only commits. Fast-forward only
      `feature/orchestrator-composer-windows-ci`; keep fork main for PR review.
- [x] Inspect public hooks and background work with a read-only Luna child.
- [x] Port receipt dispatch in `packages/app/src/composer/actions.ts`, wire the prepared
      label in `composer/index.tsx` and `runtime/host-runtime.ts`. Extend the existing
      attachment test and cover refusal/ordinary-send boundaries in `actions.test.ts`.
- [x] Add a fork-only Windows workflow using `npm ci` via the upstream retry script,
      focused composer tests, compiling checks, `build:desktop -- --publish never --win --x64`,
      existing packaged-app smoke, and uploaded installer/ZIP/checksums/provenance.
- [x] Verify the actual composer flow through an isolated supported-origin test runtime.
- [x] Add the user-requested Paseo Advanced Windows identity and major-one desktop version.
      Isolate installer, executable, profile, daemon defaults, CLI and OS protocol; keep
      bundled server/SDK source versions exact and check daemon reuse across version namespaces.
- [x] Complete independent review of the expanded Advanced distribution diff.
- [ ] Implement and prove the permanent automation boundary from the later user handoff:
      exact native command-session correlation, authoritative background-work coverage,
      compatible controller capability preflight and one private packaged-runtime pilot
      through COMPLETE. This agent now owns all permanent integration in its isolated copy
      of sanitized candidate 80c9ef3a278d8be4; the operational root retains UI V2/Neuburger.
      No operator attestation, manual wake, fresh API allowance or copied credentials.
- [x] Push initial verified checkpoints and open draft fork PR #2.
- [ ] Push final integration, inspect successful CI, download and check artifacts.
- [x] Document repeatable upstream sync, build/download and separately authorized install steps.

## Review focus

Receipt ordering and matching message identity; native attachment payload preservation;
prepared-session failure rollback; queue/retry entry points; updater behavior of fork artifacts.

## Verification record

`npm run test --workspace=@getpaseo/app -- src/composer/actions.test.ts --bail=1`:
53 passing. Original missing-preflight fault caused four behavioral failures;
changing `<= 12000` to `< 12000` failed the inclusive-limit assertion, then was restored.
`npm run build:app-deps`, `npm run build:server`, `npm run typecheck` and targeted
`npm run lint -- <five changed TypeScript files>` passed.

The real composer + plugin RPC + native file-attachment E2E passed in an isolated
Chrome test profile with local video recording disabled. Removing its prepared-label
wiring caused the intended receipt-count assertion to fail (expected 1, received 0);
the source was restored. Advanced distribution and adjacent lifecycle/CLI checks:
20 passing. A wrong executable classification caused three failures for the daemon
home, Advanced link routing and CLI path. Restored source is checked before commit.
The desktop main process compiled; official builder config loading and validation
confirmed only the Advanced protocol and CLI resource (builder `extends` concatenates
these arrays, so the fork config replaces them explicitly).

Draft PR #2 exists. The initial CI runs exposed build ordering and first-run setup in the
packaged About smoke; both are addressed in source. Final successful CI and artifact
verification remain pending; their run records carry the final outcome. The expanded
branding was independently reviewed. Composer and installer
checks do not establish permanent automation acceptance; the integrated pilot and its
one negative boundary remain required before the overall completion claim.
