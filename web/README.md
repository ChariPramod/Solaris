# Gauntlet workspace

A local testing and investigation interface for the Python evaluation harness, including the evaluation loop iteration. It reads the project's real `results/` folder. Empty workspaces stay empty; no sample benchmark scores are substituted.

## Start

From the Solaris project root, with Node 22.17+ and the existing Python environment:

```sh
npm --prefix web ci
npm --prefix web run dev
```

Open **http://127.0.0.1:3000**. To use an optimized production build locally:

```sh
npm --prefix web run build
npm --prefix web start
```

Stop the development server before starting production on the same port. Both scripts bind to loopback. This app is intended for one trusted local user; it has no account authentication and must not be exposed through a public tunnel or shared host. The Next.js server needs this checkout and Python environment; it is not a static export or a standalone hosted service.

By default, `web/`'s parent is the project root and `.venv/bin/python` is the interpreter. Optional server-only overrides are `GAUNTLET_PROJECT_ROOT` and `GAUNTLET_PYTHON`; see [.env.example](.env.example). Next.js loads `web/.env.local`; the Python CLI still does not load the root `.env`. Do not put credentials in `NEXT_PUBLIC_*` variables. Fonts are bundled locally, and package scripts disable Next.js telemetry.

## Workflows

- **Evaluations:** search by folder/model/status; filter dry, live, or review-needed runs. Refresh reads current saved artifacts. A failed refresh keeps the last successful in-memory library with a visible error.
- **Run inspector:** full planned trial matrix, explicit missing slots, stop/recovery notices, screenshots, raw actions/responses, task instructions, verification evidence, and cleanup errors. A saved `running` status is not a process heartbeat.
- **Playback:** step through recorded screenshots/actions with click markers and raw response access. Missing screenshots and malformed logs remain explicit; frame playback does not synthesize a continuous desktop recording.
- **Human review:** save a separate verdict, cause category, reviewer and note for a finalized trial. Revisions and original evidence digests detect concurrent edits or changed evidence. Verifier outcomes and benchmark scores are unchanged.
- **Saved setups:** save task/provider/model settings and restore them when creating an evaluation. Presets retain edit history; they are not immutable environment snapshots.
- **Independent dry rerun:** create a new credential-free experiment linked to its parent. Both original attempts stay visible. A successful run remains available even if saving its parent link fails.
- **Compare:** choose an independent baseline with matching tasks, repeat counts, mode, fixture/verifier hashes and desktop template. Same-model experiments are supported. Missing, infrastructure-failed and cleanup-failed slots are inconclusive; recovered aliases cannot count as independent baselines. Differences are observations rather than statistical significance claims.
- **Regression gate:** require complete evidence, clean audit, no infrastructure/cleanup failures, no protected-file damage and a minimum observed pass rate. Selected critical workflows must pass every planned repeat regardless of the overall rate. Optional time, API-cost and regression limits fail when required evidence is unknown or inconclusive. Live evidence is required by default; disabling it creates a diagnostic policy.
- **Artifact audit:** runs the Python read-only audit. Exit 1 is presented as findings, not an API failure. No provider inventory query or remote cleanup occurs.
- **Download manifest:** downloads the original `results.json` bytes. This is not an artifact bundle or recovery export; use the Python `recover` command to preserve a complete evidence snapshot.
- **Task suite:** select any of T01–T12 as the starting selection for a new evaluation.
- **New evaluation → Dry run:** launches the real harness with forced `--dry-run`, selected tasks, 1–3 trials, concurrency 1–2, and failure threshold 1–3. Server-generated output names prevent overwrites. Provider keys are removed from the child environment. Task failures are expected.
- **New evaluation → Live command:** builds a shell-quoted terminal command. It does not execute paid work. Configure accounts, model/template and cost assumptions using the project handoff before running it.
- **Readiness:** checks the local environment for the selected provider and model. Keys remain in the server environment; the client receives only presence-check results. Passing preflight does not validate account access or provider compatibility.

## Fallbacks and limits

- Missing results folder → empty library; malformed or unsafe run → warning while valid runs remain accessible.
- Missing or partially written action history → saved verdict remains visible; good action lines are retained.
- Missing/corrupt screenshot → explicit placeholder; no replacement evidence is fabricated.
- Missing Python → existing runs and file-backed reviews/presets remain accessible; operations requiring the harness show actionable errors.
- Unreadable/incompatible comparison or gate evidence → explicit error instead of a fabricated result. Python JSON responses are validated before the interface renders them.
- Review conflict or changed source evidence → refuse stale writes and ask for deliberate reconciliation. Unsaved notes remain in the editor; up to 32 trial drafts are retained in browser memory while navigating, but reload/close/eviction can discard them. Copy important drafts before reloading.
- Failed attempt-link save after a successful dry run → return the new run ID and a visible warning; browse that result before deciding whether another run is necessary.
- One dry-run request can execute per server process. Duplicate concurrent requests return 409. This is not a cross-process queue.
- Subprocesses use fixed argument arrays, no shell interpolation, and bounded output. Readiness/audit/comparison/gate have a 30-second deadline; dry runs have 90 seconds. A timeout sends SIGINT, then SIGKILL after five seconds if required. Any readable saved run is returned for inspection. After a browser disconnect, refresh before retrying: the server may have completed the request.
- All run/artifact paths are confined to the results root and reject symlinks. Reads reject special files and oversize artifacts. These checks are not a transactional filesystem snapshot; use a trusted local filesystem and avoid concurrently replacing directories.
- Library scan: 200 folders. Manifest: 16 MiB. Action log: 4 MiB / 1,000 lines. JPEG: 10 MiB / 100 per-trial image names. The matrix shows the first 100 slots per task. Limits show warnings or explicit errors.
- Same-origin JSON requests are required for operations; foreign hosts/origins are rejected. Only validated JPEG screenshots are served, never arbitrary recorded HTML on the app origin.
- Motion respects reduced-motion preferences. Dialogs, tabs, selects, focus handling and buttons use shadcn/ui primitives.
- Optional WebMCP tools list evaluations and open the inspector when supported; unsupported browsers continue normally. Contract tests use a mock registry. A live browser WebMCP runtime has not been verified.

## Workspace metadata and backups

Reviews, saved setups and parent/child attempt links are stored in `PROJECT_ROOT/.gauntlet-workspace/`, separate from original `results/` artifacts. GET requests do not create metadata folders. Directory-based review identities distinguish a recovered export from its source, even when they share a run UUID. New attempt links require distinct directories and run identities; cycles and conflicting parentage are refused.

Writes retain versioned JSON revision histories, use temporary files plus atomic replacement and file/directory synchronization, and hold a bounded filesystem lock across the short update. Revision conflicts return 409; corruption, linked/special files and oversized storage are refused without resetting history. Limits: 8,000 note characters, 120 reviewer characters, 80 preset-name characters, 100 revisions per review/preset, 100 presets, 1,000 links and 16 MiB per metadata file. Reviewer attribution is free text, not authenticated identity.

Back up `.gauntlet-workspace/` and `results/` together when both review context and evidence matter. Manifest downloads and Python recovery exports do not include workspace metadata automatically. If the server stopped while `.write.lock` was held, stop and inspect **all writers** before manually removing that lock. The application never steals old locks. Restore malformed metadata from a known-good backup after preserving the bad file for diagnosis. Neither operation requires editing trial results.

## CLI and automation

The source checkout adds `compare` and `gate` to the Python CLI. Existing older wheels in `dist/` do not include this source iteration; use the editable installation described in [PROJECT_HANDOFF.md](../PROJECT_HANDOFF.md).

```sh
.venv/bin/python -m gauntlet compare results/CANDIDATE --baseline results/BASELINE --json
.venv/bin/python -m gauntlet gate results/CANDIDATE --policy examples/gate-policy.json --baseline results/BASELINE --json
```

Run these from the project root and replace directory placeholders. `compare` exits 0 for valid evidence even if regressions exist; `gate` exits 0 for acceptance and 1 for unmet requirements. Invalid policy/evidence or incompatible comparison exits 2 with structured errors when `--json` is selected. The example live policy requires a baseline because it limits regressions. Recorded API cost excludes desktop/service charges and is not a runtime spending cap.

## Stack and attribution

Next.js App Router + TypeScript, Tailwind CSS v4, shadcn/ui, Lucide icons, and Motion. The single animated readiness-panel border uses Magic UI's Shine Border; the rest of the working surface stays quiet. Dependencies are locked in `package-lock.json`.

Official references used: [Next.js](https://nextjs.org/docs), [Tailwind CSS with Next.js](https://tailwindcss.com/docs/installation/framework-guides/nextjs), [shadcn/ui](https://ui.shadcn.com/docs/installation), [Magic UI Shine Border](https://magicui.design/docs/components/shine-border). Vendored UI sources retain their upstream conventions; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Verification

```sh
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
npm --prefix web run test:integration
make check PYTHON=.venv/bin/python
```

The current local suites contain **45 TypeScript tests and 399 Python tests**. They cover containment, malformed/partial evidence, coverage, origin/input checks, subprocess failures, review conflicts/stale digests, metadata corruption/locking, history limits, presets, attempt links, draft retention, comparison/gate validation and existing runner/verifier behavior.

`test:integration` requires a completed production build and an editable Python installation. It starts its own loopback production server on a temporary port with an isolated project root, strips provider credentials, and exercises real dry-run, review, preset, comparison/gate and failure-fallback routes. It cleans up its temporary data/server. The integration script includes a simulated abandoned metadata lock to verify that a successful child run remains accessible when linkage fails. It performs no live model or Solari requests.

Production build and isolated HTTP integration pass, including the forced-lock attempt-link failure. Chrome desktop and 390-pixel mobile interaction checks verified playback, review/draft handling, presets, independent dry rerun/history, comparison and a correctly failing live-required gate. These were session-based browser checks, not a persistent browser CI suite. Details are in [PROJECT_HANDOFF.md](../PROJECT_HANDOFF.md). Browser WebMCP runtime support remains unverified.

Custom workflow authoring, systematic resilience experiment matrices, cost/reliability frontier analysis, persistent jobs, live web execution, authenticated sharing and prepared-desktop snapshots remain future work, dependent on reviewed live validation.
