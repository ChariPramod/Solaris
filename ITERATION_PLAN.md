# Iteration plan

Updated September 21, 2026. Build on twelve tasks, two adapters, explicit pricing, recovery exports and the interactive evaluation loop. The next milestone is a trustworthy first live experiment, followed by repeatable comparisons. See [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) for detailed completed work and user steps.

## Iteration 1: readiness and interrupted-run evidence — completed in v0.5

The highest-priority defect found in v0.4 was cancellation during cleanup: it could interrupt destruction and prevent result persistence. A hard process exit could also lose the allocated desktop ID because it was saved only at trial completion.

- Protect cleanup and result persistence against cancellation, including repeated task cancellation. Preserve cancellation to the caller after finalization completes. Repeated physical Ctrl-C and process termination remain force-stop cases requiring audit.
- Add a local-only preflight command to check selected tasks, model configuration, dependencies, credentials being present, pricing, fixture assets, and output destination before allocation. Aggregate failures; never print credentials or call services.
- Assign each suite a run ID, attach run/trial metadata to desktop creation, and flush lifecycle events to disk before allocation and immediately after a desktop ID is returned.
- Add a read-only audit command to identify incomplete attempts, finalized results missing from the manifest, inconsistent records, and desktops whose destruction was not recorded. Do not infer that a remote desktop is still alive from local evidence.
- Verify with cancellation fault injection, interrupted-artifact fixtures, CLI tests, a full dry run, and an installed-package smoke test.

Completion criteria: cooperative cancellation cannot skip owned finalization; a returned desktop ID is recorded before connection/provisioning; readiness and audit commands work without paid requests; old results remain readable; each CLI command has documented exit codes and limitations.

Delivered all items above, including negative destruction-acknowledgment handling and CLI JSON output. Verification covers cancellation at cleanup boundaries, journal-write failures, malformed/partial artifacts, legacy-run compatibility, a 36-trial dry run with a clean audit, and installation outside the source checkout. Live preflight identifies missing credentials; no paid evaluation was started.

## Iteration 2: first live proof

**Preparation delivered in v0.7:** `run` automatically checks local readiness before allocation; infrastructure timeouts are separated from task deadline expiry; execution failures carry a stage in results/reports; preparation and verification stages are journaled. Optional strict task-failure exits make scripted smoke tests meaningful while preserving artifacts. Local fault-injection tests and dry runs validate these changes; live proof remains pending account access.

Once credentials are configured, run T01/T02 with one trial and concurrency one. Review allocation, readiness, GUI interaction, verification, API usage, and destruction. Exercise T08/T11 separately to validate office/PDF provisioning. Fix issues evidenced by these runs before increasing coverage or concurrency.

**Outage handling delivered in v0.8:** an optional cumulative infrastructure/cleanup failure threshold stops queued allocations after a failed trial finalizes. Active trials finish normally; the saved stop reason and full original plan keep missing coverage explicit in reports, recovery, and comparisons. Use `--max-infra-failures 1` at concurrency one for the initial smoke test. This limits further attempts after a known failure, not total spending or an already active request.

Completion criteria: reviewed live traces and provider-confirmed cleanup, with actual costs reconciled against the configured rates. Unit tests and dry runs do not satisfy this milestone.

## Iteration 3: recoverable experiments

**Local recovery exports delivered in v0.6.** `recover` reconciles finalized results into a new folder, preserving source evidence and trial identity. Reports carry recovery provenance and cost coverage; incomplete attempts and uncertain cleanup remain explicit. Mutation checks, task validation, and staged publication protect the export. This work can be verified without live credentials while Iteration 2 remains pending.

Use the new lifecycle evidence to design explicit run-scoped cleanup and continuation. Verify provider inventory/metadata APIs first. Preserve original attempts, provenance, and failure denominators; do not overwrite failed trials or silently improve scores through retries. Refuse continuation if task/environment inputs changed.

Completion criteria: demonstrate an interrupted run, recovery without touching unrelated desktops, and continuation with an auditable attempt history. Snapshot reuse remains contingent on supported Solari APIs.

## Iteration 4: reviewed comparisons

Run both adapters on matching task and fixture inputs, review ambiguous failure labels, and compare reliability, coverage, API estimates, and desktop costs. Record protocol differences. Human review annotations, compatible independent-run comparisons and conservative acceptance gates are now implemented locally without changing verifier outcomes. Use them to validate these live comparisons.

Completion criteria: repeated live trials with visible coverage and reviewed failure evidence, followed by shareable reports. Publishing and headline performance claims follow validation.

## Iteration 5: interactive workspace — initial local release delivered

The separate v0.9 web app wraps the v0.8 Python harness. Delivered: real run library, search/filters, trial matrix and evidence, original manifest downloads, task selection, read-only readiness/audit, bounded credential-free dry runs and a live command builder. File and process boundaries have TypeScript regression tests; the real HTTP workflow and optimized production build pass. No scores are invented when artifacts are absent.

The evaluation loop increment below delivers richer comparisons and durable human review. Continue browser/mobile/zoom validation as the interface changes. Live web execution, authentication, hosting and persistent job control remain separate work; they are not implied by a successful local dry run.

## Iteration 6: evaluation loop — delivered locally

Delivered playback with recorded actions/screenshots; persistent human review and setup histories; explicit independent dry-rerun links; a shared CLI/web comparison and gate engine; optimistic revision conflicts; evidence-bound stale review handling; bounded atomic metadata storage; and graceful fallback when a dry run succeeds but attempt linkage fails. Required critical tasks must pass every planned repeat. Unknown costs and inconclusive comparisons cannot satisfy their configured limits.

Acceptance evidence: 399 Python tests and 45 TypeScript tests pass. Production integration exercises real API endpoints in an isolated credential-free project. Production build, HTTP integration (including failed-link fallback) and desktop/390-pixel Chrome interaction checks pass; details are maintained in [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md). Live validation remains Iteration 2's explicit unfinished milestone. The package version fields and older built wheels were not changed by this source iteration.

The next local work is to evaluate the complete run → inspect → review → compare → fix → new independent run loop against real traces. Keep original experiments immutable; back up `.gauntlet-workspace/` separately from `results/`. A linked dry rerun is a new experiment, not resumable continuation or a persistent background job.

## Future acceptance criteria

- **Custom workflows:** users can author a task, deterministic fixture and verifier with meaningful positive/negative validation. Selecting saved settings is not sufficient.
- **Resilience matrices:** controlled perturbations generate independent experiments with explicit provenance and complete/missing sample counts.
- **Cost/reliability analysis:** recorded estimates are reconciled with real usage and desktop charges before presenting optimization conclusions.
- **Durable jobs:** server/browser restarts retain owned execution state and safe cancellation; retries never overwrite earlier results.
- **Snapshots:** a supported provider interface produces isolated prepared environments and demonstrably reduces setup work.

These are planned extensions, not delivered claims. The live-validation milestone determines their priority.

## Work ownership

The primary agent owns integration, recovery export, documentation, and end-to-end validation. Subagents contribute bounded implementation and independent reviews: cancellation, preflight, audit, cost coverage, and recovery integrity. No subagent publishes or calls paid services.
