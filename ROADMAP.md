# Scope review

The original spec describes an evaluation system, not just a computer-use agent. Its strongest promise is an auditable comparison of reliability across repeated real GUI trials. The implementation covers all twelve task definitions and the essential orchestration. A public repository and authenticated Vercel product now run real cloud diagnostics with durable evidence, jobs, reviews, comparisons and gates. Live desktop/model performance remains unverified.

Updated September 22, 2026. The presentation guide is [docs/PRESENTATION.md](docs/PRESENTATION.md); deployment configuration and acceptance evidence are in [docs/VERCEL.md](docs/VERCEL.md).

## Current coverage

| Area | Implemented | Remaining |
|---|---|---|
| Task suite | T01–T12 definitions, fixtures, verifiers, positive/negative tests | Validate action budgets and GUI usability on Solari |
| Execution | Concurrency bound, step/time caps, cancellation-resistant finalization, durable allocation/cleanup journal; detached cloud workers with durable jobs and interrupted-state reconciliation | Live lifecycle testing; owned cancellation and provider reconciliation after process kill/lost create response |
| Verification | Disk, JSON, clipboard, rename, ODS value; protected-file checks | Human trajectory review for required GUI steps |
| Agent | Claude native computer use and OpenAI structured GUI actions; raw responses and usage preserved | Live validation of both protocols |
| Reproducibility | Local apps, deterministic invoice archive, task/source hashes, pinned cloud worker checkout, saved setups and explicit independent attempt links | Prepared snapshots, stronger environment pinning and provenance-checked continuation |
| Metrics | pass@1, pass^k with coverage, safety, timing, normalized token usage, explicit API estimates | Check costs against provider usage, failure review, actual benchmark runs |
| Review experience | Offline reports plus local/cloud playback, revisioned human reviews, compatible-run comparison and regression gates | Validate with real trajectories; complete cloud evidence/annotation export and restore |
| Distribution | CLI, public GitHub repository, authenticated Vercel product, private Blob storage; green Python/Node CI and production HTTP acceptance | Full authenticated cloud browser/mobile acceptance, next-release presentation checks and rollback exercise |
| Operations | Read-only preflight/audit; durable run/trial ownership; reconciled recovery exports with source hashes; owner sessions and bounded cloud workers | Provider inventory reconciliation, full storage backup/restore, pagination/retention and multi-user roles if required |

## Current iteration: presentation readiness

The product is available at [solaris-gauntlet.vercel.app](https://solaris-gauntlet.vercel.app), with public source at [ChariPramod/Solaris](https://github.com/ChariPramod/Solaris). Production HTTP acceptance against `c443612` verified two actual cloud diagnostic jobs, evidence persistence, reviews/presets, linked attempts, authoritative Python comparisons and gates. The recorded checkpoint is 414 Python tests and 101 TypeScript tests; it does not certify newer work automatically.

- [docs/PRESENTATION.md](docs/PRESENTATION.md) supplies a short pitch, five-minute walkthrough using actual accepted evidence, audience questions, remaining setup steps and release checks.
- Improve first-visit product explanation and guided setup/readiness. These UI changes are in progress; deployment and browser acceptance must be recorded before claiming completion.
- Rehearse the complete authenticated cloud workflow on desktop and mobile. Earlier production browser checks covered sign-in only; the full cloud loop was verified through HTTP.
- Keep diagnostic labels, incomplete evidence and missing provider credentials visible. No live benchmark numbers exist yet.

## Completed iteration: public cloud product

- Published the repository and deployed the full Next.js API with owner access-key sessions, canonical-origin checks and private persistent Blob storage.
- Added durable job creation, detached Python workers from a pinned public source commit, callbacks, incremental evidence uploads and bounded execution. Closing the browser does not cancel a job. Interrupted jobs are not automatically replayed or resumed.
- Connected evidence, reviews, presets and attempts to cloud storage with conditional writes and integrity checks. Real production acceptance exposed compressed Blob reads with weak ETags; identity-encoded reads and regression tests fixed the issue.
- Ran comparisons/gates through the authoritative Python CLI in separate bounded sandboxes. Verified failed live-required gates and passing explicitly diagnostic policies without making agent reliability claims.
- Preserved the local workspace, CLI and offline reports. Cloud-only storage is not a complete offline backup until all referenced evidence is exported; manifest download alone is insufficient.

## Previous iteration: evaluation loop

- Add synchronized screenshot/action playback, click markers and partial-evidence fallbacks.
- Store human reviews separately from verifier results, with evidence digests, stale-review detection, conflict checks and complete bounded revision histories. Retain up to 32 unsaved drafts in browser memory during navigation.
- Add saved evaluation setups and explicit parent/child links for new independent dry runs. If link storage fails, preserve the successful new run and return its ID with a warning.
- Add read-only `compare` and `gate` CLI commands and interface panels using the same validated assessment engine. Reject incompatible or contradictory evidence; require every selected critical workflow repeat to pass. Expose missing coverage, unknown costs and inconclusive transitions.
- Harden metadata writes with bounded filesystem locking, atomic publication and explicit corruption/limit failures; add production HTTP integration tests.
- Verification: 399 Python tests and 45 TypeScript tests pass. Production build, real isolated HTTP integration and desktop/390-pixel Chrome interaction checks pass; details are in [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md). No new version was published and no paid services were called.

## Previous iteration: initial interactive workspace

- Added the local Next.js/TypeScript workspace with Tailwind v4, shadcn/ui, Lucide, Motion and a selective Magic UI accent.
- Read real artifacts with search, filtering, planned coverage, evidence inspection and original manifest downloads.
- Integrated read-only audit/preflight and credential-free dry runs, plus terminal live-command generation.
- Added the initial 20 TypeScript tests and fallbacks for corrupt runs, partial logs, absent images/Python, timeouts and failed refreshes.

## Previous iteration: outage handling

- Add optional `--max-infra-failures` to stop queued trials after cumulative infrastructure/cleanup failures while allowing active trials to finalize.
- Preserve the original plan, trigger evidence, and missing coverage in stopped runs, recovered exports, and comparison reports.
- Test scheduling, concurrent finalization, failure counting, CLI exit precedence, audit, and recovery without paid requests.

## Previous iteration: first-live diagnostics

- Run local preflight automatically before allocation and save its checks with run configuration.
- Distinguish early infrastructure timeouts from the task execution deadline; record failure stages in saved results, the console, and reports.
- Journal preparation and verification transitions to help diagnose interrupted trials.
- Add `--fail-on-task-failure` for scripting, preserving reports before exit 3 and prioritizing infrastructure/cleanup exit 2.
- Write the detailed [project handoff](PROJECT_HANDOFF.md), separating required user inputs from the engineering backlog.

## Previous iteration: recovery exports

- Added `recover RUN --out NEW` to reconcile valid saved results into a separate, reportable snapshot, preserving source bytes, run identity, tasks, provenance, and missing attempts.
- Preserve original and recovered audits, copied-artifact hashes, recovery identity, and source findings. Detect source changes before publishing an export.
- Reject conflicting records, invalid numeric evidence, mismatched task snapshots, unsafe artifacts, and existing/nested destinations.
- Label recovered reports and comparisons explicitly, preserving cleanup uncertainty without contacting providers.
- Require exact planned trial coverage for cost per success; show cost coverage in Markdown and HTML.

## Previous iteration: operational reliability

- Added a local-only `preflight` command that aggregates blockers before paid runs, with JSON output and no service calls or file writes.
- Fixed cancellation during finalization, including repeated task cancellation, so destruction, client closure, trial writes, and manifest writes remain awaited.
- Added run UUIDs and provider metadata, plus flushed lifecycle events that preserve allocation IDs before connection and provisioning.
- Require an affirmative provider destruction response; a negative acknowledgment is retried and retained as a cleanup failure.
- Added read-only `audit` for incomplete trials, inconsistent/unindexed results, and uncertain cleanup, without altering scores or remote desktops.
- Recorded the next four increments and their acceptance criteria in [ITERATION_PLAN.md](ITERATION_PLAN.md).

## Previous iteration: provider comparison and costs

- Added the OpenAI Responses vision adapter with strict single-action JSON, screenshot/history feedback, provider-specific credentials, and explicit model selection.
- Added per-response and per-trial API estimates from validated pricing files, with model/provider matching, source capture, context-tier ceilings, cache categories, and unknown-cost handling.
- Disabled model transport retries to avoid unreported retry charges; API errors/timeouts retain unknown totals and any earlier recorded step estimates.
- Added cost status and token breakdowns to the offline report, retaining compatibility with older runs.
- Added installed-SDK HTTP transport tests and pricing/runner tests without external model calls.

## Previously completed

- Completed T08 and T11, bringing the implementation from ten tasks to twelve.
- Added an ODS reader that checks saved numeric values, supports compressed row/column repetition, and treats malformed output as a failed task.
- Added a deterministic, visually checked invoice PDF and downloadable ZIP. Portal navigation now points to portal routes, and the login form masks its password field.
- Tightened task validation before allocation, including limits, verifier shapes, output paths, setup flags, and precise rename exemptions.
- Preserved task definitions, task hashes, protected-file baselines, implementation hashes, dependency versions, and run configuration.
- Fixed an integrity-check edge case where unreadable protected files could become infrastructure errors instead of damage.
- Added `--setup-seconds` to accommodate office application installation without extending the agent's time budget.
- Built the self-contained HTML report with trial dots, filters, comparison tables, failure breakdown, click overlays, raw response details, and verifier evidence.
- Added `report --compare` with task, trial-count, fixture/verifier, and template compatibility checks. Exports copy each input run's own screenshots.
- Preserved malformed model responses and their token usage as `invalid_response` outcomes instead of silently losing them or excluding them as infrastructure outages.
- Verified dashboard filtering, trial navigation, and response expansion in Chrome; added portable-export, escaping, traversal, partial-log, and filter tests.

## Next priorities

1. **Prove the live path.** With credentials configured, run T01/T02 once at concurrency 1. Confirm guest user permissions, apt provisioning, keyboard shortcuts, screenshots, and successful destruction. Then validate T08/T11 individually. Capture actual failure evidence before adjusting task budgets.
2. **Finish presentation and operational acceptance.** Deploy the first-visit/setup improvements, rehearse authenticated desktop/mobile use with actual saved evidence, and exercise rollback plus full private-store backup/restore. This is separate from passing backend HTTP checks.
3. **Validate model comparisons.** Run both implemented adapters on the same preserved task/fixture inputs and compare through the report command. Review their different action protocols and verify explicit cost estimates against provider usage.
4. **Optimize repeatability and cost.** Confirm snapshot fork support against the actual Solari API before implementing it. Pin the prepared environment and test independent forks before increasing concurrency.
5. **Review real outcomes.** Inspect failure traces, hand-label ambiguous behavior, and validate the current task limits. Publish headline numbers only after repeated live trials and coverage review.

Live validation is the largest unresolved risk. More unit tests cannot establish that the default Solari template launches the expected apps or that a model finishes these tasks within the current limits. No real performance claims should be made until repeated live trials have been reviewed.

## Later extensions, not yet implemented

- A custom workflow builder with fixture/verifier authoring and validation. Current presets only configure shipped tasks.
- Resilience experiment matrices for controlled perturbations, with explicit independent samples and failure denominators.
- Cost/reliability frontier analysis grounded in validated pricing, provider usage and desktop fees. Current gates can enforce recorded API-estimate limits but cannot predict or cap spending.
- Owned cancellation with verified desktop cleanup, provenance-checked execution resume and authenticated multi-user access. Durable cloud job records and owner authentication already exist; they do not provide these capabilities.
- Complete cloud evidence/annotation export and restore, archive pagination and retention/garbage-collection controls.
- Prepared-desktop snapshots or forks, contingent on a supported Solari interface and verified isolation.

Choose the order from reviewed live evidence. None of these future capabilities is implied by the implemented playback, review, comparison, durable jobs or independent-attempt features.
