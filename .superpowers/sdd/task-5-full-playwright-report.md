# Task 5 Full Playwright Production Runtime Wiring Report

## Result

Status: `DONE_WITH_CONCERNS`.

The explicit `full-playwright` execution profile now has a production Runtime path from the frozen
artifact snapshot through strict projection, trusted Host dispatch, authenticated Authority/Lease
RPC, a real Gateway proxy, two independent Chromium Browser lifecycles, evidence capture, cleanup,
signed outcome finalization, and durable attempt persistence. Legacy read, fixed HTTP write, and
injection routes remain unchanged.

Two boundaries remain and are deliberately fail-closed rather than approximated:

- full-playwright intents whose payload is not `no-body` are rejected because the frozen intent has
  only a semantic payload digest, not the source bytes needed to derive the Gateway transport-body
  digest;
- a reopened checkpoint returns an already durable terminal output without rerunning Browser code,
  while a persistent `terminal-failed` checkpoint blocks Browser replay with
  `E2E_RUNTIME_FULL_PLAYWRIGHT_TERMINAL_RECOVERY_REQUIRED`; it does not yet reconstruct a fresh
  cross-process session and retry the remaining Authority/Lease terminal call automatically.

## RED / GREEN evidence

- Strict projector tests began RED against missing production projection and exposed that the
  runtime `SignedGrantSchema` did not accept the already-typed browser-local write capability.
  GREEN adds the runtime schema and seven projection/identity/drift tests.
- Durable checkpoint tests began RED with no checkpoint store. GREEN adds a bounded SQLite store,
  binding-digest conflict rejection, completed-entry GC, preservation of unknown/terminal-failed
  entries, restart reopening, and an Artifact-Authority-signed terminal receipt (2/2).
- Terminal recovery table additions first exposed persistent release/quarantine exceptions. GREEN
  returns a stable `terminal-failed` result for all five terminal stages and resumes only terminal
  closure on same-session reentry; the full runner matrix is 38/38.
- JSON Schema verification went RED after adding browser-local SignedWriteGrant parsing. Regenerating
  the immutable schema set and pointer returned the schema suite to GREEN (11/11 focused).

## Production closure

- `projectRuntimeFullPlaywrightSnapshot()` strictly parses the four frozen artifacts and closes
  profile, case/step/action, program/cleanup source, request set, lease/fence/target, approval
  projection, installation, capability, run bundle, and source-set identities.
- `trusted-action-runner` exposes a branded full-playwright executor capability. Runtime Host and CLI
  route to it only when the frozen action map explicitly declares `full-playwright`; no legacy
  Secret Broker/write/injection executor is opened for that route.
- Production wiring activates the signed grant, creates authenticated execution and maintenance RPC
  clients, starts the real Gateway proxy, and launches separate program and cleanup
  `ControlledBrowserHost` instances. Their raw Browser objects and lifecycle/profile ownership are
  distinct, while their approved state and Gateway session are shared through branded facades.
- Primary Page/Context traffic, extra Browser contexts, and APIRequestContext calls are correlated
  against the frozen request set. Out-of-set requests abort or throw before Gateway forwarding.
- Screenshot, DOM, URL, trace-summary, Gateway audit, Browser measurement, cleanup, lease, and signed
  outcome facts flow back through the normal Runtime write-attempt persistence and evidence
  quarantine boundaries.
- Cleanup failure/unknown paths attempt quarantine and reservation mark-unknown independently.
  Success releases the lease, signs the outcome, and completes the reservation with that exact
  signed outcome digest.

## Persistent terminal checkpoints

The Runtime-owned SQLite store lives outside the project tree and binds each entry to attempt/run,
asset/generation/PRD, action/capability, program and cleanup digests, source set, request set,
Authority public key, and Gateway policy. Entries are size-bounded, schema-strict, idempotent, and
carry a terminal receipt signed by the same Artifact Authority used by production Runtime wiring.
Completed entries are the only entries eligible for bounded GC; unknown and terminal-failed entries
are preserved. A binding drift on reopen fails closed before any Gateway or Browser is started.

## Chromium Golden

The Golden now launches two independent Chromium Browser instances rather than two contexts in one
Browser and verifies their lifecycle separation. It still uses the signed Gateway publication-audit
recorder fixture at the runner boundary; the actual child-process Gateway proxy is exercised by the
production wiring and real Gateway regression suites, not by this single Golden test.

The Golden requires loopback-listen permission outside the restricted workspace sandbox. The
authorized run passed 1/1 in 1.298 seconds.

## Verification

- `npm run generate:e2e-schemas`: passed (`npm run build` included).
- `npm run typecheck`: passed.
- `npm run lint:architecture`: passed.
- Authorized full five-package regression: 129 files, 1081/1081 tests passed.
- Focused full runner: 38/38 passed.
- Focused strict projector: 7/7 passed.
- Focused checkpoint/restart: 2/2 passed.
- Focused Runtime Host: 35/35 passed.
- Focused production session assembly: 2/2 passed.
- Authorized Chromium Golden: 1/1 passed.
- Authorized `npm pack --dry-run --workspace @mutil-skills/e2e-runtime`: passed.
- Authorized `npm pack --dry-run --workspace @mutil-skills/e2e-playwright-runtime`: passed.
- `git diff --check`: passed.

The full regression and pack commands needed the authorized boundary because the inner sandbox
blocks macOS `sandbox-exec`, loopback servers, and writes to the user npm cache. The same two
`sandbox-exec` tests were also isolated and passed 6/6 outside the inner sandbox.
