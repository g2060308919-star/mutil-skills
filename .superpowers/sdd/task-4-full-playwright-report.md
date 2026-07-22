# Task 4 Full Playwright Runner Report

## Result

Implemented and hardened `runFullPlaywrightCase()` as the public orchestration boundary for an
approved `full-playwright/v1` program. The follow-up review fixes are an append-only commit after
`ecc8cf9`; external `progress.md` and spec edits were deliberately left untouched.

## Review-fix RED / GREEN

- Root export RED proved the public package exposed test assembly; GREEN moved controlled-session
  authorization to an internal WeakMap capability issuer. `npm pack --dry-run` confirms the package
  root exports the runner but not a test assembly factory.
- Five terminal stage faults (`complete`, `release`, `markUnknown`, `quarantine`, `sign`) went RED,
  then GREEN with bounded idempotent recovery and actual Authority/lease/outcome receipts.
  `complete` now binds the final `outcome.signedDigest`.
- Persistent sign failure returns a stable `terminal-failed` intent with only the already-issued
  lease receipt. Re-entering the same session/attempt resumes signing and Authority finalization
  without rerunning browser code or inventing a receipt.
- A post-reservation fault table covers after-evidence, effect observation, duplicate/missing
  evidence, Gateway finalization, and malformed Gateway summaries. Every case finishes as
  markUnknown + quarantine, with no retry.
- The focused runner matrix is now 33/33 GREEN.

## Security and identity closure

- `AttemptExecutionContextSchema` is exported and strictly parsed; extra fields fail closed.
- Controlled session and runtime bind asset, generation, PRD revision, run, case, step, action,
  program/cleanup/plan, lease/fence/target, Gateway session/policy, and a source-set digest distinct
  from the individual program digest.
- The production runner rejects `test-only` runtime sessions. Trusted-compiler and production
  isolation bindings carry the same asset/generation/PRD/source-set identity.
- Both write and lease execution clients must carry the exact four-field approval execution binding.
  Authenticated-RPC clients must also match the runtime Authority public-key digest.
- Program and cleanup receive separately branded Browser facades bound to different lifecycle
  session IDs and the same Gateway session. `Browser.close` is absent from both facades; lifecycle
  retirement remains host-owned.

## Terminal and evidence semantics

- Required screenshot, DOM, URL, and trace summaries are checked at before/after/cleanup stages;
  IDs must be globally unique. Gateway summary counters and digest are validated before publication.
- Unknown finalization independently attempts quarantine and markUnknown, retaining only genuine
  receipt digests. One failure never suppresses the other operation.
- Success releases the lease, signs an outcome containing the real lease receipt, then completes the
  reservation with that signed outcome digest. Unknown paths quarantine, sign the unknown outcome,
  then mark the reservation unknown.

## Real Chromium Golden

The Golden now uses a dynamic loopback port and imports a side-effect-free fixture module, so it
runs exactly one test. All browser/context/page/request outlets are recorded by a real signed Gateway
publication-audit recorder. The test verifies both the Ed25519 execution outcome and publication
audit, while exercising real Chromium Page/Locator, popup, extra BrowserContext, API request,
independent cleanup context, and evidence capture.

## Verification

- `npx vitest run packages/e2e-playwright-runtime/test/full-playwright-runner.test.ts`: 33 passed.
- `npm run build`: passed.
- `npx vitest run --config vitest.e2e.config.ts scripts/e2e-full-playwright.golden.test.ts`: 1 passed.
- `npm pack --dry-run --workspace @mutil-skills/e2e-playwright-runtime`: passed.
- `git diff --check`: passed.

The Golden requires loopback-listen permission outside the restricted sandbox; the authorized run
completed successfully.
