# Product readiness and unfinished engineering

Updated September 22, 2026. This is the product engineering backlog for a technical stakeholder review. It is not a presentation plan.

Solaris has a working evaluation loop: configure a run, execute the Python harness in an isolated cloud worker, retain private evidence, review trials, compare independent runs, and apply conservative release gates. The major remaining gaps concern operating and validating that system with real providers.

## Delivered in this iteration: owner-controlled cancellation

New cloud jobs support **Stop evaluation** in Execution jobs. The API persists a cancellation request using conditional writes. The worker polls with its job credential, independently of artifact uploads, and sends the harness one interrupt. The harness's existing cancellation finalizers retain ownership of verification, desktop destruction and partial result publication. The worker allows 150 seconds for finalization before a forced stop.

- `cancelling` means a durable request is waiting for worker acknowledgment; it does not mean the process stopped.
- `cancelled` means the worker acknowledged the request after the process ended, or before it launched. It does not independently verify deletion of a Solari desktop.
- Partial evidence continues uploading until final completion. A cancellation that precedes manifest creation remains a job record with an explicit missing-manifest explanation.
- A forced stop, failed persistence or missing evidence remains visible. An unacknowledged request expires to `interrupted`, never silently to success.
- Natural completion can win a late cancellation. Repeated stop requests preserve the original request time and do not replay execution.
- Older jobs without the control protocol refuse cancellation rather than claiming it worked. Source overrides must point to a compatible worker revision.
- Control is checked before and after dependency installation. Installation is bounded to four minutes and is not interrupted by the stop request. During evaluation the independent monitor checks about every five seconds, with a five-second request timeout. Three consecutive control failures stop execution conservatively; inability to check before launch prevents evaluation startup.
- Stopping the Vercel worker is separate from deleting external desktops. This change does not implement provider inventory reconciliation or execution resume.

Validation: 425 Python tests and 124 TypeScript tests pass, along with lint, formatting, typecheck and the production build. New cases cover authenticated cancellation, repeated requests, completion races, expiry, old workers, partial uploads, forced-stop uncertainty, control outages, malformed replies and a real subprocess finalizing while the uploader is blocked. These tests do not establish real Solari cleanup behavior.

## Priority 1: validate real desktop and model execution

**Unfinished:** neither implemented provider adapter has been validated end-to-end against a real Solari desktop in this deployment. Diagnostic runs verify orchestration, not AI task completion.

**Required input:** privately configured Solari and selected-model credentials, an available model/template, and an agreed initial paid scope. Do not put credentials in tracked files or the browser.

**Engineering acceptance:** run T01/T02 once at concurrency one; verify desktop ownership, application provisioning, screenshots and actions, saved verifier outputs, cleanup acknowledgment and provider usage. Exercise cancellation during a live task and during cleanup. Then validate T08/T11 and the second model adapter. Diagnose actual failures before changing budgets. Preserve all failed evidence.

## Priority 2: reconcile resource ownership after worker loss

**Unfinished:** cooperative cancellation cannot prove cleanup after forced termination, lost allocation responses or callback/storage outages. The existing provider time limit bounds the Vercel worker, not necessarily an external Solari desktop.

**Engineering acceptance:** persist allocation ownership before use; reconcile provider inventory against durable ownership; expose outstanding resources and last reconciliation results; support explicit idempotent cleanup only for verified owned resources; test lost create responses, negative deletion acknowledgments, provider outages and process kills. Never report deletion merely because a worker disappeared.

## Priority 3: complete evidence export and restore

**Unfinished:** the current download exports a manifest, not a portable cloud backup. Full artifacts, review histories, presets, attempt links and relevant job provenance need a consistent export. Local recovery does not replace a cloud backup.

**Engineering acceptance:** export all referenced evidence and annotation revisions with checksums and a versioned inventory; exclude credentials; detect concurrent changes and missing objects; validate an archive before publishing a restore; refuse overwrites by default; restore into an isolated destination and compare reviews, audits and gates with the original. Exercise corrupt archives, interrupted transfers, duplicate restores and storage outages. Preserve ownership identities without restarting jobs.

## Priority 4: operational limits and cost controls

**Unfinished:** current per-job concurrency and time limits do not impose a workspace-wide spending limit. Provider cost reconciliation and complete archive pagination/retention are missing.

**Engineering acceptance:** enforce an atomic global active-job limit; prevent duplicate submissions with idempotency keys; validate estimates against actual model usage and desktop fees; distinguish unknown charges; introduce explicit admission budgets before allocation. Paginate jobs/runs without silently omitting older entries. Add retention previews and protect objects referenced by retained runs or reviews before deletion.

## Priority 5: release recovery and deployment acceptance

**Unfinished:** rollback and full restore have not been exercised. Physical-device and exhaustive accessibility/error-state coverage are incomplete. The current owner-key session is single-owner access, not team authorization.

**Engineering acceptance:** demonstrate rollback against persistent data, document protocol/schema compatibility, restore a backup, and run authenticated browser coverage for launch, stop, partial evidence, reviews, compare and gates. Add named users/roles and an administrative audit trail if team use is required. Do not turn diagnostics into benchmark claims.

## What the owner needs to do

Supply the private provider configuration and a small live evaluation scope for Priority 1. The remaining items are engineering work; they do not require the owner to implement code or prepare a presentation. Current access-key sign-in remains the product access mechanism.
