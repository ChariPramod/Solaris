# Solaris on Vercel

Updated October 2, 2026.

The public repository is [ChariPramod/Solaris](https://github.com/ChariPramod/Solaris). The production address is **[solaris-gauntlet.vercel.app](https://solaris-gauntlet.vercel.app)**. This document describes the current implementation and distinguishes local verification from historical production acceptance. The October 2 agency increment passed local checks and production HTTP acceptance against source `32193db`; the repository GitHub cloud integration also passed. The September 22 acceptance against source commit `c443612` remains recorded below and does not verify these new features.

The previous hosted preview is not the production backend. This application runs the Python harness, stores real evidence, and returns actual verifier decisions. A dry run intentionally uses a static agent and produces expected task failures. No live Solari/model benchmark has been verified.

## Deployment layout

| Component | Configuration and responsibility |
|---|---|
| Public source | `ChariPramod/Solaris`, with generated evidence, credentials and local deployment files excluded |
| Vercel project | `solaris-gauntlet`, GitHub-linked, Next.js, root directory `web`, Node 22 |
| Web/API | Next.js application with owner sessions, separately scoped machine tokens and canonical-origin checks |
| Persistent storage | Private Vercel Blob store `solaris-evidence`, region `iad1` |
| Execution | Detached Vercel Sandbox running Python 3.13, checking out a pinned source commit |
| Assessment | Separate short-lived Python sandbox for compatible comparison and regression gates |
| Local fallback | Existing loopback workspace, Python CLI, saved artifacts and offline reports |

GitHub Pages is unsuitable for these server APIs and workers. Making the repository public does not make saved evidence public. The workspace requires owner authentication; the machine API requires a scoped integration token. Worker callbacks use a separate per-job credential and validate the assigned execution plan. Client projects organize evidence within the owner workspace; they do not create separate tenants or client access boundaries.

The sandbox Git checkout is `/vercel/sandbox`. This was confirmed with an actual sandbox probe; do not add a `Solaris` subdirectory to its working directory.

## Environment

Configure the following as server-only Vercel environment variables for the production deployment. Redeploy after changing configuration. Never prefix secrets with `NEXT_PUBLIC_`.

| Variable | Required value or purpose |
|---|---|
| `GAUNTLET_STORAGE` | `vercel` |
| `GAUNTLET_PUBLIC_ORIGIN` | `https://solaris-gauntlet.vercel.app`, with no trailing slash/path |
| `GAUNTLET_ADMIN_KEY` | A private random owner access key, at least 32 characters |
| `BLOB_READ_WRITE_TOKEN` | The token supplied when connecting the private `solaris-evidence` store |
| `GAUNTLET_SOURCE_REVISION` | Optional explicit 40-character published Git commit SHA; otherwise `VERCEL_GIT_COMMIT_SHA` is used |
| `GAUNTLET_MAX_ACTIVE_JOBS` | Optional workspace evaluation-job limit, integer `1`–`8`; defaults to `2` |
| `SOLARI_API_KEY` | Required for live desktops only |
| `ANTHROPIC_API_KEY` | Required for Claude live execution only |
| `OPENAI_API_KEY` | Required for OpenAI live execution only; the setup must also select an explicit model ID |

A CLI deployment without `VERCEL_GIT_COMMIT_SHA` needs `GAUNTLET_SOURCE_REVISION`. Push that commit to the public repository before using it: both run and assessment workers must be able to fetch the exact source. Using a branch name instead of a full SHA is rejected. An explicit revision override stays pinned across later deployments until changed or removed.

The private owner key for this local setup is in ignored `tmp/solaris-access-key.txt`. Read it privately when signing in; do not commit the file, paste its contents into issues, or include it in logs/screenshots. The application does not store the key in browser local storage. Do not confuse it with the provider API keys, Blob token, or Vercel deployment credentials.

Vercel Sandbox must be enabled for the project/team and able to authenticate through the deployment's Vercel identity. A working web deployment alone does not prove worker allocation is available. Missing storage, source revision or live credentials should produce an actionable failure instead of a fabricated result.

Preview deployment URLs are not alternate production origins. The API deliberately accepts the configured canonical host and same-origin writes. To operate a separate staging deployment, configure its own canonical origin, owner key and private storage; do not mix worker callbacks between environments.

## Build and publish

For the configured project, Vercel builds the application from `web/package.json`. Keep the root directory `web`, Next.js framework preset and Node 22. The repository contains the Python package at its root; worker checkouts need that full repository, not only the frontend subtree.

Before publishing code changes:

```sh
make check PYTHON=.venv/bin/python
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
npm --prefix web run test:integration
npm --prefix web run test:export
```

The integration command exercises an isolated local production server. It does not replace cloud acceptance. Commit and push reviewed source, deploy through the linked Vercel project, and verify that the worker revision is the intended published commit. Keep `.env*`, `.vercel/`, `tmp/`, local evidence and workspace metadata out of source control.

## Product workflow

1. Open the canonical address and sign in with the owner access key. The server sets a signed 12-hour `Secure`, `HttpOnly`, `SameSite=Strict` cookie. Logging out clears the cookie; rotating the key invalidates sessions signed with the old key.
2. Open **New evaluation**, choose T01/T02 with one repeat and concurrency one, and select **Dry run**. Atomic admission reserves workspace capacity, then creates a durable job before provisioning a worker. The browser retains an idempotency key for retrying the same plan. A durable job receives at most one harness launch.
3. Watch **Execution jobs**. The page polls every ten seconds; closing the browser does not stop the worker. Job completion means execution finished, not that tasks passed. **Stop evaluation** requests cooperative cancellation; wait for acknowledgment and inspect saved cleanup evidence. After a disconnected launch, retry with the original request identity or inspect the job before making an intentional new attempt.
4. Open saved evidence as uploads arrive. Inspect the trial matrix, screenshots/actions, original verifier outcome and saved audit. Early or interrupted jobs can have missing evidence; absence remains visible.
5. Save a review or preset, refresh the page, and confirm it persists. Human annotations remain separate from the original machine verdict. Revision conflicts must be resolved explicitly; a stale save does not silently overwrite newer work.
6. Launch another independent run or linked attempt, then compare compatible evidence. Gates use the same Python logic as the CLI. Live-required policies correctly fail dry evidence; missing coverage, infrastructure/cleanup errors and unknown configured costs cannot become passing evidence.
7. Configure live keys on the server before using **Live evaluation**. Start with the small smoke scope and review desktop cleanup. Provider compatibility and actual task reliability still require this live validation.

Provider credentials are never returned to the browser. Dry workers omit all three provider keys; live workers receive only Solari plus the selected model-provider key. Diagnostic workers and comparison workers may still incur Vercel infrastructure usage. There is no hard spending cap.

The agency increment adds client projects, workflow templates, evidence insights, portable evidence downloads and scoped automation access. See [agency capabilities and owner prerequisites](AGENCY_RELEASE.md), [GitHub Actions, n8n and Zapier integration setup](INTEGRATIONS.md), and [the evidence bundle format](EVIDENCE_BUNDLES.md). Integration recipes require configuration in the external account; their presence in the product does not mean an account has been connected.

Machine requests use `/api/automation/v1` with a bearer token created through the owner-only **Integrations** panel. Tokens are shown once, hashed at rest, expiring and revocable. `read`, `execute`, `live:execute` and `assess` scopes separate access; a live launch requires both execution scopes and configured provider credentials. Owner cookies do not authenticate machine routes. A machine job POST requires an `Idempotency-Key`, namespaced to its integration credential. Reuse the same key and plan for retries; changed plans return 409. Rotating the credential changes that namespace, so inspect outstanding jobs before retrying with a replacement key.

## Persistence and limits

Private storage separates execution records, artifact indexes/content, reviews, presets, attempt links, client projects, integration-token metadata and the admission ledger. New manifest ingests also store a digest-bound summary in their index; older summaries fall back to verified manifests. Exact duplicate uploads skip writes. Detailed reads and exports still verify content hashes. [Architecture diagrams and read/write contracts](QUERY_RESPONSE.md) explain pagination, concurrent-read sharing and rollback compatibility. Artifact contents are hash-checked on reads. Metadata uses conditional writes against the stored revision, so conflicting edits fail instead of overwriting newer revisions. A broken object or index is reported; it is not silently reset.

- Cloud run listings use continuation pages of 1–200 indexes, default 50; the UI can load further pages. Listings are not a point-in-time snapshot or guaranteed globally newest first. Search/totals describe loaded records. Job listings and the local filesystem library remain bounded to 200; the jobs panel shows twelve returned jobs.
- Each uploaded artifact is limited to 2 MiB. Screenshots, action logs or manifests over that limit can leave incomplete cloud evidence; the worker records a persistence failure instead of claiming complete storage.
- Cloud uploads include `results.json`, the saved audit, task/result files, per-trial `baseline.json` snapshots, lifecycle journals, action logs and accepted screenshots. Older cloud runs may lack baseline snapshots because previous workers did not upload them; export cannot reconstruct missing originals. Generated local HTML reports and arbitrary local files are not automatically uploaded.
- **Download evidence bundle** produces a streamed `.tar.gz` containing all captured indexed artifacts, checksums, run-specific review histories, direct attempt context, available nonsecret provenance and a facts-only handoff summary. The same endpoint supports local runs. It permits up to 5,000 evidence files and 64 MiB of evidence/annotation bytes, with a 16 MiB per-file limit; ingestion limits still apply. Active jobs, corrupt or missing indexed files, concurrent edits and oversized exports fail explicitly. The separate manifest download remains only `results.json`. Neither download is whole-workspace backup or restore; see [bundle limitations](EVIDENCE_BUNDLES.md).
- A single Blob conditional-write admission ledger enforces the evaluation-job cap across server instances. Initial migration examines at most 1,000 existing jobs and fails closed on a truncated or invalid listing. Subsequent admission reads the ledger's reserved job identities directly; a truncated library listing cannot free a slot. A 429 capacity rejection creates no job and consumes no key, so retry the same key once capacity is available. Completed/cancelled or authoritatively failed execution releases capacity. Ambiguous allocations retain it until the provider confirms the worker stopped; missing records and provider errors do not count as confirmation. Assessment workers and remote Solari desktop inventory are not included in this cap.
- Each execution sandbox has a 45-minute maximum lifetime. The worker uses a 40-minute harness execution deadline, sends SIGINT, then uses a bounded forced-stop fallback. Dependency installation and final persistence also need time within the sandbox lifetime.
- Comparison/gate workers have a 210-second sandbox lifetime, a 180-second request signal, bounded install/CLI timeouts, 128 MiB combined evidence and 2 MiB output limits. The UI allows up to 240 seconds for assessment and job-start requests.
- Reviews/presets retain bounded revision histories. Local mode retains its filesystem locking; cloud mode uses storage revisions. Neither mode edits the original result when saving a human assessment.
- The owner session is a single-workspace authentication mechanism. There are no separate user accounts, role permissions, workspace tenants or per-review author authentication.

Retrying a launch request with the same idempotency key returns its durable job rather than replaying execution. If storage failed before any job existed, the same key can safely finish creating that reserved job. A durable job is never automatically re-executed; an ambiguous launch may still finish and report back. The worker receives one harness invocation, while uploads may retry. Expired unfinished jobs become visibly interrupted, but expiry alone does not release uncertain capacity or establish remote desktop cleanup. A new attempt needs a new identity and does not fill missing slots in an old run.

## Recovery and operations

### Sign-in or origin errors

Use the canonical production address. Verify `GAUNTLET_PUBLIC_ORIGIN` exactly matches it and `GAUNTLET_ADMIN_KEY` is present with sufficient length, then redeploy. A missing/incorrect environment variable does not justify disabling authentication. For a compromised key, rotate it in Vercel, update the private local copy, redeploy and sign in again. Do not publish the old or replacement value.

### A launch request disconnected

Retain the original idempotency key and job ID, when returned. Retry the same request with that key or check **Execution jobs**; a failed network response can occur after the worker started. The browser keeps pending launch identity through dialog closure and same-tab reload. Machine clients must persist their own key. Same-key retries do not start another execution; changing the key or integration credential can create a new experiment. A different plan under the same key returns 409 and requires an intentional new identity. An ambiguous job may still report completion later. If the request identity was lost, inspect job state/evidence before creating a replacement.

For HTTP 429, no job was created and the key remains reusable after capacity clears. For unavailable or uncertain storage, preserve the key: a reservation may exist even if the job is not yet visible. Do not delete the admission ledger or manually free slots merely because the library is empty or truncated.

### A worker failed or stopped reporting

Inspect the job error, saved manifest, lifecycle records and audit. Dependency or provisioning failures can occur before a manifest exists. Supported workers offer cooperative cancellation through **Stop evaluation**, with bounded finalization and a forced-stop fallback; see [cooperative cancellation](#cooperative-cancellation). Once the job's maximum lifetime expires it is reconciled to interrupted; that status is not proof of remote desktop cleanup. Provider-side resource inventory and automatic orphan-desktop reconciliation remain unfinished.

For live jobs, use recorded desktop identifiers to inspect the Solari account and confirm cleanup of resources belonging to this run. A lost allocation response may lack an ID and require provider-side investigation. Do not destroy unrelated desktops. Preserve evidence before starting a replacement attempt.

### Some evidence was not persisted

Leave existing Blob objects and indexes in place. An oversized artifact, failed upload or checksum mismatch is evidence of an incomplete run. Review the saved subset and job error. Do not change recorded coverage or mark the job successful to hide missing artifacts. Worker files are ephemeral; once the sandbox is gone, bytes that never reached durable storage may be unavailable.

### A review or preset save returned a conflict

Keep the unsaved text, reload the current revision, inspect the newer data, and then save an intentional revision. Do not overwrite the Blob object's revision manually to bypass conflict handling. Browser review drafts survive ordinary navigation only in bounded memory; copy important unsaved notes elsewhere before reload or logout.

### Assessment is unavailable

Keep browsing original evidence. Missing source revisions, worker setup failures, malformed output and timeouts return explicit errors and do not modify the run. Export a terminal run's evidence bundle, verify its checksums, and use its `evidence/` directory with `python -m gauntlet compare` or `python -m gauntlet gate` where the required original evidence is present. Export preserves incomplete runs honestly and cannot supply missing artifacts. A manifest-only download is insufficient for the complete validation these commands perform.

### Deployment rollback and backups

Retain the last known-good source SHA and Vercel deployment. Roll back the frontend/API and its explicit worker revision consistently. Existing saved run fingerprints must remain unchanged. Do not delete private storage to resolve a deployment failure.

Back up the complete private store through an authorized storage operation, including artifact indexes, referenced content, jobs, admission state and workspace metadata. Per-run evidence bundles support inspection and handoff but exclude unrelated workspace records and credentials. They do not replace complete cloud backup or restore. There is not yet an in-product whole-workspace export, restore wizard or retention/garbage-collection policy. In local mode, back up both `results/` and `.gauntlet-workspace/`.

## Verification and production acceptance

### October 2 agency increment — production acceptance passed

The agency-release suite passed **426 Python tests and 173 TypeScript tests**; the subsequent architecture/storage iteration passes **426 Python tests and 195 TypeScript tests** plus both HTTP integration checks. Python lint/format checks also pass. Coverage includes concurrent launch admission, same-key retries, scope restrictions, credential hashing/revocation, client project conflicts, evidence archive extraction and independent checksum verification, partial/corrupt exports, and the CI client's real gate-result contract. These local checks do not establish current production acceptance, external n8n/Zapier account connectivity, live model performance or live desktop cleanup.

Production acceptance verified project persistence/conflicts, token creation/revocation and scope restrictions, same-key launch reuse, changed-plan rejection, checksum-verified cloud bundles with baseline artifacts, and the actual Python quality gate. The manually dispatched GitHub workflow also passed using a restricted diagnostic key. See [the agency release record](AGENCY_RELEASE.md) for exact job IDs, CI links, key expiry and browser verification scope. Capacity races are covered by automated tests; production saturation and live desktop cleanup were not exercised.

### Historical acceptance — September 22, 2026

The earlier suite passed **414 Python tests and 117 TypeScript tests**, with green GitHub CI on Python 3.11/3.12/3.13 and Node 22. Against source commit `c443612`, the production HTTP acceptance script verified:

- Anonymous access rejected with 401, owner sign-in and authenticated session retrieval; logout cleared the session and protected access returned 401 again.
- Two actual cloud dry T01/T02 jobs completing with persisted manifests/trial evidence, a healthy saved audit and a parent/child attempt link.
- Python comparison with zero inconclusive transitions; the default live-required gate failing and an explicit diagnostic gate passing.
- Review save/reload and stale revision rejection with 409, preset save and manifest export.
- Cross-origin requests rejected with 403; public job responses exclude callback credentials. The owner access key was absent from all eleven inspected deployed public JavaScript assets.
- Production readiness accepted storage/source configuration and reported only missing desktop/model-provider credentials. Its nonsecret output is retained locally in ignored `tmp/cloud-preflight.json`.

Accepted production jobs are `cloud_636d9a1609324b11c94790f4210f5b38` and `cloud_b49459f6a10ff76561db523f1987b332`. An earlier failed run is retained honestly: it exposed weak ETags on compressed Blob responses. The adapter now requests identity encoding, regression tests cover it, and real Blob conditional writes were verified. Both diagnostic sandboxes were confirmed `stopped` through the provider SDK after completion; this verifies those cloud workers ended, not cleanup of live Solari desktops.

Subsequent recorded browser checks covered the public overview, sign-in, guided diagnostic launch, saved trial/review, comparison, expected gate rejection and live-setup blockers. See [the historical browser release notes](PRESENTATION.md). Those checks predate the current agency increment; they do not verify its new UI or APIs. A complete authenticated browser interaction suite, broad mobile cloud QA and exercised deployment rollback remain follow-up work. No live desktop/model evaluation has been verified.

### Repeat the remote acceptance check

Set `GAUNTLET_ADMIN_KEY` privately in the terminal environment; do not paste its value into the command, documentation or shell history. Then run from the repository root:

```sh
cd web
GAUNTLET_PUBLIC_ORIGIN=https://solaris-gauntlet.vercel.app npx tsx scripts/cloud-smoke.ts
```

This is a manual remote acceptance operation, not a read-only health check. It creates two actual diagnostic workers and durable review/preset records, and runs real assessment workers. It uses no model/desktop credentials but can incur Vercel usage. If it fails after launch, inspect the printed job ID before repeating it; do not delete failed evidence to make the acceptance history look clean.

The owner still needs to configure Solari and one provider key for live evaluation, choose an available model/template and accept the intended paid scope. The first recommended scope is T01/T02, one trial each, concurrency one; T08/T11 follow after basic provisioning is reviewed. Live keys are currently absent, so live execution and benchmark reliability must remain described as unverified.

Remaining engineering includes verified external cleanup and provider inventory reconciliation after hard worker loss, whole-workspace cloud backup/restore, archive pagination, retention controls, multi-user identity/permissions if needed, custom task authoring, prepared desktop snapshots through a supported provider API, and live-validated cost accounting. Cooperative cancellation, per-run evidence export and scoped automation access are implemented; they do not establish those remaining capabilities. See [product readiness](PRODUCT_READINESS.md) and [agency release limits](AGENCY_RELEASE.md).

## Cooperative cancellation

New jobs offer **Stop evaluation** in Execution jobs. `POST /api/jobs/:id/cancel` requires the owner session and a same-origin empty JSON body. It stores the request without directly killing a potentially finalizing worker. The per-job authenticated worker control check shares `/api/cloud/ingest`; it exposes only a cancellation flag, never owner credentials or evidence.

The worker checks before launch and independently during execution, interrupts the harness once and allows 150 seconds for finalization. The UI distinguishes requested cancellation from acknowledgment. Saved lifecycle evidence is required to establish external desktop cleanup. Forced termination, expired callbacks and missing manifests remain explicit. Source revision overrides must support worker control version 1; older existing jobs refuse cancellation. Dependency installation can delay acknowledgment by up to its four-minute bound.

See [product readiness](PRODUCT_READINESS.md) for provider reconciliation, complete cloud backup/restore and the remaining operational work.
