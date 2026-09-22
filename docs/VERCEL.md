# Solaris on Vercel

Updated September 22, 2026.

The public repository is [ChariPramod/Solaris](https://github.com/ChariPramod/Solaris). The deployed production address is **[solaris-gauntlet.vercel.app](https://solaris-gauntlet.vercel.app)**. Production HTTP acceptance passed against source commit `c443612` on September 22, 2026. This document records the deployed system, verification scope and remaining operational work.

The previous hosted preview is not the production backend. This application runs the Python harness, stores real evidence, and returns actual verifier decisions. A dry run intentionally uses a static agent and produces expected task failures. No live Solari/model benchmark has been verified.

## Deployment layout

| Component | Configuration and responsibility |
|---|---|
| Public source | `ChariPramod/Solaris`, with generated evidence, credentials and local deployment files excluded |
| Vercel project | `solaris-gauntlet`, GitHub-linked, Next.js, root directory `web`, Node 22 |
| Web/API | Next.js application with owner session authentication and canonical-origin checks |
| Persistent storage | Private Vercel Blob store `solaris-evidence`, region `iad1` |
| Execution | Detached Vercel Sandbox running Python 3.13, checking out a pinned source commit |
| Assessment | Separate short-lived Python sandbox for compatible comparison and regression gates |
| Local fallback | Existing loopback workspace, Python CLI, saved artifacts and offline reports |

GitHub Pages is unsuitable for these server APIs and workers. Making the repository public does not make saved evidence public. The UI and API serve private Blob objects only after workspace authentication. Worker callbacks use a separate per-job credential and validate the assigned execution plan.

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
```

The integration command exercises an isolated local production server. It does not replace cloud acceptance. Commit and push reviewed source, deploy through the linked Vercel project, and verify that the worker revision is the intended published commit. Keep `.env*`, `.vercel/`, `tmp/`, local evidence and workspace metadata out of source control.

## Product workflow

1. Open the canonical address and sign in with the owner access key. The server sets a signed 12-hour `Secure`, `HttpOnly`, `SameSite=Strict` cookie. Logging out clears the cookie; rotating the key invalidates sessions signed with the old key.
2. Open **New evaluation**, choose T01/T02 with one repeat and concurrency one, and select **Dry run**. The cloud request creates a durable job before provisioning a worker. It starts the actual Python harness once.
3. Watch **Execution jobs**. The page polls every ten seconds; closing the browser does not stop the worker. Job completion means execution finished, not that tasks passed. Refresh status before creating another job after a disconnected request.
4. Open saved evidence as uploads arrive. Inspect the trial matrix, screenshots/actions, original verifier outcome and saved audit. Early or interrupted jobs can have missing evidence; absence remains visible.
5. Save a review or preset, refresh the page, and confirm it persists. Human annotations remain separate from the original machine verdict. Revision conflicts must be resolved explicitly; a stale save does not silently overwrite newer work.
6. Launch another independent run or linked attempt, then compare compatible evidence. Gates use the same Python logic as the CLI. Live-required policies correctly fail dry evidence; missing coverage, infrastructure/cleanup errors and unknown configured costs cannot become passing evidence.
7. Configure live keys on the server before using **Live evaluation**. Start with the small smoke scope and review desktop cleanup. Provider compatibility and actual task reliability still require this live validation.

Provider credentials are never returned to the browser. Dry workers omit all three provider keys; live workers receive only Solari plus the selected model-provider key. Diagnostic workers and comparison workers may still incur Vercel infrastructure usage. There is no hard spending cap.

## Persistence and limits

Private storage separates execution records, artifact indexes/content, reviews, presets and attempt links. Artifact contents are hash-checked on reads. Metadata uses conditional writes against the stored revision, so conflicting edits fail instead of overwriting newer revisions. A broken object or index is reported; it is not silently reset.

- Run/job listings are bounded to 200 entries. The jobs panel shows up to twelve returned jobs. This is a bounded first-page implementation, not full archive pagination.
- Each uploaded artifact is limited to 2 MiB. Screenshots, action logs or manifests over that limit can leave incomplete cloud evidence; the worker records a persistence failure instead of claiming complete storage.
- Cloud uploads include `results.json`, the saved audit, task/result files, lifecycle journals, action logs and accepted screenshots. The cloud manifest download is only `results.json`; it is not a complete evidence/metadata backup. Generated local HTML reports and all other local files are not automatically uploaded.
- Each execution sandbox has a 45-minute maximum lifetime. The worker uses a 40-minute harness execution deadline, sends SIGINT, then uses a bounded forced-stop fallback. Dependency installation and final persistence also need time within the sandbox lifetime.
- Comparison/gate workers have a 210-second sandbox lifetime, a 180-second request signal, bounded install/CLI timeouts, 128 MiB combined evidence and 2 MiB output limits. The UI allows up to 240 seconds for assessment and job-start requests.
- Reviews/presets retain bounded revision histories. Local mode retains its filesystem locking; cloud mode uses storage revisions. Neither mode edits the original result when saving a human assessment.
- The owner session is a single-workspace authentication mechanism. There are no separate user accounts, role permissions, workspace tenants or per-review author authentication.

Jobs are not automatically replayed or resumed after an ambiguous response. The worker receives one harness invocation, while uploads may retry. Expired unfinished jobs become visibly interrupted. A new attempt is a new experiment with a new identity; it does not fill missing slots in an old run.

## Recovery and operations

### Sign-in or origin errors

Use the canonical production address. Verify `GAUNTLET_PUBLIC_ORIGIN` exactly matches it and `GAUNTLET_ADMIN_KEY` is present with sufficient length, then redeploy. A missing/incorrect environment variable does not justify disabling authentication. For a compromised key, rotate it in Vercel, update the private local copy, redeploy and sign in again. Do not publish the old or replacement value.

### A launch request disconnected

Check **Execution jobs** before pressing start again. A failed network response can occur after the worker started. Retain the job ID and inspect its state/evidence. An ambiguous job may still report completion later. Do not automatically retry a launch: it could duplicate paid execution.

### A worker failed or stopped reporting

Inspect the job error, saved manifest, lifecycle records and audit. Dependency or provisioning failures can occur before a manifest exists. Once the job's maximum lifetime expires it is reconciled to interrupted; that status is not proof of remote desktop cleanup. There is no cancellation button or remote inventory sweeper in this iteration.

For live jobs, use recorded desktop identifiers to inspect the Solari account and confirm cleanup of resources belonging to this run. A lost allocation response may lack an ID and require provider-side investigation. Do not destroy unrelated desktops. Preserve evidence before starting a replacement attempt.

### Some evidence was not persisted

Leave existing Blob objects and indexes in place. An oversized artifact, failed upload or checksum mismatch is evidence of an incomplete run. Review the saved subset and job error. Do not change recorded coverage or mark the job successful to hide missing artifacts. Worker files are ephemeral; once the sandbox is gone, bytes that never reached durable storage may be unavailable.

### A review or preset save returned a conflict

Keep the unsaved text, reload the current revision, inspect the newer data, and then save an intentional revision. Do not overwrite the Blob object's revision manually to bypass conflict handling. Browser review drafts survive ordinary navigation only in bounded memory; copy important unsaved notes elsewhere before reload or logout.

### Assessment is unavailable

Keep browsing original evidence. Missing source revisions, worker setup failures, malformed output and timeouts return explicit errors and do not modify the run. Where a full local evidence copy is available, use `python -m gauntlet compare` or `python -m gauntlet gate`. A manifest-only download is insufficient for the complete validation these commands perform.

### Deployment rollback and backups

Retain the last known-good source SHA and Vercel deployment. Roll back the frontend/API and its explicit worker revision consistently. Existing saved run fingerprints must remain unchanged. Do not delete private storage to resolve a deployment failure.

Back up the complete private store through an authorized storage operation, including artifact indexes, referenced content, jobs and workspace metadata. A manifest download alone is not a backup. There is not yet an in-product complete cloud export, restore wizard or retention/garbage-collection policy. In local mode, back up both `results/` and `.gauntlet-workspace/`.

## Acceptance and remaining work

The current suite passes **414 Python tests and 117 TypeScript tests**. GitHub CI is green on Python 3.11/3.12/3.13 and Node 22. The real production HTTP acceptance script verified:

- Anonymous access rejected with 401, owner sign-in and authenticated session retrieval; logout cleared the session and protected access returned 401 again.
- Two actual cloud dry T01/T02 jobs completing with persisted manifests/trial evidence, a healthy saved audit and a parent/child attempt link.
- Python comparison with zero inconclusive transitions; the default live-required gate failing and an explicit diagnostic gate passing.
- Review save/reload and stale revision rejection with 409, preset save and manifest export.
- Cross-origin requests rejected with 403; public job responses exclude callback credentials. The owner access key was absent from all eleven inspected deployed public JavaScript assets.
- Production readiness accepted storage/source configuration and reported only missing desktop/model-provider credentials. Its nonsecret output is retained locally in ignored `tmp/cloud-preflight.json`.

Accepted production jobs are `cloud_636d9a1609324b11c94790f4210f5b38` and `cloud_b49459f6a10ff76561db523f1987b332`. An earlier failed run is retained honestly: it exposed weak ETags on compressed Blob responses. The adapter now requests identity encoding, regression tests cover it, and real Blob conditional writes were verified. Both diagnostic sandboxes were confirmed `stopped` through the provider SDK after completion; this verifies those cloud workers ended, not cleanup of live Solari desktops.

Published browser checks now cover the public overview, sign-in, guided diagnostic launch, saved trial/review, comparison, expected gate rejection and live-setup blockers. The full acceptance flow above was also verified through HTTP. See [the presentation guide](PRESENTATION.md) for the recorded browser release checks. A complete authenticated browser interaction suite, mobile cloud QA and deployment rollback remain separate follow-up checks. Previous mobile QA applied to the local app. No live desktop/model evaluation has been verified.

### Repeat the remote acceptance check

Set `GAUNTLET_ADMIN_KEY` privately in the terminal environment; do not paste its value into the command, documentation or shell history. Then run from the repository root:

```sh
cd web
GAUNTLET_PUBLIC_ORIGIN=https://solaris-gauntlet.vercel.app npx tsx scripts/cloud-smoke.ts
```

This is a manual remote acceptance operation, not a read-only health check. It creates two actual diagnostic workers and durable review/preset records, and runs real assessment workers. It uses no model/desktop credentials but can incur Vercel usage. If it fails after launch, inspect the printed job ID before repeating it; do not delete failed evidence to make the acceptance history look clean.

The owner still needs to configure Solari and one provider key for live evaluation, choose an available model/template and accept the intended paid scope. The first recommended scope is T01/T02, one trial each, concurrency one; T08/T11 follow after basic provisioning is reviewed. Live keys are currently absent, so live execution and benchmark reliability must remain described as unverified.

Remaining engineering includes cancellation with verified cleanup, provider inventory reconciliation, full cloud export/restore, archive pagination, retention controls, stronger multi-user identity/permissions if needed, prepared desktop snapshots through a supported provider API, and live-validated cost accounting. None is replaced by a demo workspace or fabricated results.
