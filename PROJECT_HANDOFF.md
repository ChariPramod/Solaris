# Gauntlet project handoff

Updated September 22, 2026. This is the practical handoff for the Solaris project, whose implemented evaluation harness is named **Gauntlet**.

## Product operations iteration — September 22, 2026

Implemented owner-controlled cancellation for new cloud jobs. Stop requests are durable and idempotent; workers acknowledge them after stopping, preserve partial artifacts, and leave cleanup uncertainty visible. Cancellation monitoring runs independently of evidence uploads. The worker checks control before evaluation starts and stops conservatively after repeated control-channel failures. Older workers and expired jobs fail explicitly instead of pretending cancellation succeeded.

Production acceptance on `aedbf2b`: a real cloud job acknowledged an idempotent cancellation with exit 130; a separate browser-launched diagnostic completed and saved both planned records. The browser displayed the new stop action and acknowledged cancellation. Live desktop cleanup remains unverified.

Local validation: 425 Python tests, 124 TypeScript tests, lint/format, typecheck and optimized build pass. A real subprocess test verifies final evidence survives cancellation while uploads block. Live Solari cancellation and provider resource reconciliation remain unverified. See [PRODUCT_READINESS.md](docs/PRODUCT_READINESS.md) for the prioritized engineering backlog, acceptance criteria and required owner inputs. No presentation work is needed to complete these engineering tasks.

## Current state

The local product and cloud deployment implementation are built: twelve GUI tasks, two model adapters, deterministic state checks, repeated-trial orchestration, an offline evidence dashboard, API cost estimates, and interrupted-run audit/recovery. The remaining critical milestone is a reviewed run on actual Solari desktops. **There are no real benchmark scores yet.** Dry-run failures are expected and do not measure model performance.

The **evaluation loop iteration** adds screenshot/action playback, durable human review notes, saved evaluation setups, explicit links between independent dry-run attempts, compatible-run comparison, and conservative regression gates. It extends the existing v0.9 local web workspace and v0.8 Python package source. Package version fields were not bumped and no new distribution was published; existing `dist/` wheels predate this iteration. Install this checkout in editable mode to use its new CLI commands.

**Previous evaluation-loop verification:** 399 Python tests and 45 TypeScript tests passed, along with the optimized production build and real production HTTP integration. The integration uses an isolated temporary project and strips provider keys; it includes a forced `.write.lock` failure proving that a successful child run remains accessible when link storage fails. Chrome interaction checks passed on desktop and at a 390-pixel mobile viewport: playback/action synchronization, unsaved draft restoration across tabs, review saving, preset saving, linked dry rerun/history, compatible comparison and a correctly failing live-required gate. These browser checks are a recorded manual automation session, not a persistent browser CI suite. No paid requests or live benchmark runs were made.

**Live validation remains pending:** the final local Claude preflight in this iteration found `SOLARI_API_KEY` and `ANTHROPIC_API_KEY` absent from the CLI environment. Its non-secret output is saved in `tmp/evaluation-loop-preflight.json`. OpenAI remains an alternative with its key and explicit model ID. Local checks cannot authenticate accounts or establish provider compatibility.

The original [build spec](Solari%20Gauntlet%20Spec%20-%20Pinetree%20Research.md) remains unchanged. [README.md](README.md) documents the implemented interface; [ITERATION_PLAN.md](ITERATION_PLAN.md) records the sequence and acceptance criteria; [ROADMAP.md](ROADMAP.md) tracks scope and remaining engineering.

## Public repository and Vercel product

The source is published at [ChariPramod/Solaris](https://github.com/ChariPramod/Solaris). The deployed canonical product address is **[solaris-gauntlet.vercel.app](https://solaris-gauntlet.vercel.app)**. Production HTTP acceptance passed against source commit `c443612`. The earlier hosted preview is superseded by this functioning backend deployment.

Cloud mode implements access-key sessions, durable job records, private Blob evidence, revisioned reviews/presets, linked attempts, and detached Python workers. Both diagnostic and live launch buttons invoke the actual harness. The browser polls job state and can inspect evidence uploaded during execution. Comparisons and gates execute the authoritative Python CLI in a separate bounded sandbox using a pinned source commit; JavaScript does not invent replacement scores.

The project is `solaris-gauntlet`, rooted at `web`, using Next.js and Node 22. Private Blob store `solaris-evidence` is in `iad1`. The owner key is stored only in ignored local `tmp/solaris-access-key.txt` and the server environment; its value must never be added to Git, screenshots, documentation or browser bundles. Sign-in uses a 12-hour secure HTTP-only cookie. See [docs/VERCEL.md](docs/VERCEL.md) for exact configuration, recovery procedures and unresolved work.

**Cloud verification:** 414 Python tests and 101 TypeScript tests pass, and GitHub CI is green on Python 3.11/3.12/3.13 and Node 22. The remote `web/scripts/cloud-smoke.ts` acceptance check verified anonymous access rejection (401), owner sessions, two actual T01/T02 cloud dry runs, persisted manifests/trial evidence, a healthy saved audit, parent links, Python comparison with zero inconclusive transitions, a failing default live-required gate, a passing diagnostic policy, review save/reload/stale-edit rejection (409), preset save, manifest export and cross-origin rejection (403). Logout cleared the session and protected access returned 401 again. Readiness accepted storage/source configuration and reported only the missing desktop/model-provider credentials; its nonsecret output is in ignored `tmp/cloud-preflight.json`. The owner key was absent from eleven inspected deployed public JavaScript assets. Real Blob conditional writes were also verified. Source checkout and Python runtime were tested in real sandboxes.

The accepted job IDs are `cloud_636d9a1609324b11c94790f4210f5b38` and `cloud_b49459f6a10ff76561db523f1987b332`. An earlier failed acceptance run remains visible rather than being deleted; it exposed compressed Blob responses with weak ETags. Identity-encoded reads and regression tests fixed that real storage issue. Both diagnostic sandboxes were confirmed `stopped` through the provider SDK after completion; this verifies those cloud workers ended, not cleanup of live Solari desktops.

The initial published browser check covered sign-in layout and invalid-key feedback; the presentation release extends that coverage as recorded below. The original broad cloud acceptance used HTTP. Deployment rollback has not been exercised. Live provider credentials remain absent, and no live desktop/model benchmark is verified.

Cloud evidence uploads are bounded to 2 MiB per artifact. Listings are capped at 200 run/job records. Jobs have a provider-enforced 45-minute sandbox lifetime and a shorter worker execution deadline; a timed-out or ambiguous request must be investigated before a new attempt. There is no automatic replay, resume, cancellation UI, remote desktop sweeper, hard spending cap or multi-user role system. Dry mode omits provider credentials, but cloud infrastructure itself may incur usage charges.

## Presentation readiness

Use [docs/PRESENTATION.md](docs/PRESENTATION.md) for the 30-second pitch, five-minute product walkthrough, accepted diagnostic run IDs, audience questions, provider-setup steps and release checklist. Present Solaris as a working single-owner evaluation product with verified cloud diagnostics. Do not describe dry-run failures, a passing diagnostic gate or unit-test counts as live-agent reliability evidence.

The public product overview and guided setup/readiness are deployed in UI release `f0ac407`, followed by readiness compatibility correction `800f953`. **Current validation: 117 TypeScript tests pass; GitHub CI is green, including 414 Python tests.** The correction accepts both raw and wrapped readiness setup requests, with six regression tests; cloud wording and section scroll reset were also corrected.

Browser checks verified the public overview on desktop and at a **390-pixel emulated mobile viewport**, and inspected authenticated mobile guide/jobs/forms. An actual UI launch created diagnostic job `cloud_85622acca6b3ada276577e45ea50684b`, which completed with two of two trial results saved. The trial was opened and a review saved as revision 1 under **Presentation validation**, persisting after reload. The actual comparison UI, using baseline `cloud_b49459f6a10ff76561db523f1987b332`, returned two unchanged slots and zero inconclusive slots. The default browser gate correctly failed for dry evidence and zero task pass rate, while coverage, audit, infrastructure, cleanup and regression checks passed. The live setup check reported missing Solari/Anthropic credentials, disabled launch and invalidated the check when task selection changed. After reloading correction `800f953`, Cloud readiness passed storage/source checks, reported the same two missing keys and displayed the Vercel setup instructions.

These are specific recorded browser interactions, not an exhaustive automated browser suite or physical mobile-device testing. A full keyboard/accessibility sweep, broader error-state/device coverage and an exercised rollback/restore remain release work. The earlier production HTTP acceptance and its source revision are recorded above; no live benchmark evidence is implied by the new browser checks.

The owner inputs still needed for live validation are a Solari key, one model-provider key, an available model/template and an intended paid smoke scope. Configure them privately in the Vercel production environment and redeploy. After readiness, begin with T01/T02 once at concurrency one; review real evidence, provider usage and actual desktop cleanup before expanding. The coding agent can perform execution, investigation and fixes once those inputs and scope are available.

## Use the local interface now

No account setup is needed to browse saved runs or execute local diagnostics. The production preview is **http://127.0.0.1:3000** while its local server is running. To restart it from the Solaris project root:

```zsh
npm --prefix web ci
npm --prefix web run build
npm --prefix web start
```

For development, use `npm --prefix web run dev` instead of `start`; run only one on port 3000. Node 22.17+ is required. The repository's Python environment is used for audits, preflight and dry-run execution. If it is unavailable, browsing saved results still works and operations explain how to restore Python.

- **Evaluations:** search/filter real local run folders. Select a run, then a trial to inspect screenshots, model actions/responses, verifier evidence, errors and cleanup. Missing trial slots remain explicit.
- **Playback and review:** move through the recorded screenshots and associated actions, inspect click markers and model responses, then save a human verdict, cause category, reviewer and note. Original verifier results stay unchanged.
- **Compare and gate:** select an independent baseline, inspect observed transitions and configuration differences, then evaluate coverage, safety, cleanup, critical tasks and optional cost/time/regression limits.
- **Saved setups:** save or revise the task/provider/model settings in the new-evaluation panel, and restore them before another diagnostic run.
- **Dry rerun:** starts a fresh credential-free experiment and records its parent link. It preserves the original attempt and never fills missing slots in it.
- **Artifact audit:** checks the selected run locally without provider calls. Failed task checks can coexist with a clean audit.
- **Download manifest:** saves the original `results.json`, not a full evidence bundle. Use Python recovery for a separate complete artifact snapshot.
- **Task suite:** choose a task as a starting selection, then configure 1–3 repeats and concurrency 1–2.
- **New evaluation → Dry run:** creates a new run through the real Python harness. A dry run intentionally uses a static agent; failures are expected. Refresh the library after a disconnected request before retrying.
- **New evaluation → Live command:** copies a command for your terminal. It does not launch paid work from the web UI.
- **Readiness:** reports local key presence and dependencies without sending credentials to the browser or authenticating accounts.

The UI uses Next.js, TypeScript, Tailwind v4, shadcn/ui, Lucide, Motion, and one Magic UI Shine Border. Fonts are local; package scripts disable Next.js telemetry. It includes reduced-motion styling, responsive layouts, keyboard-accessible primitives, loading/empty/error states, retry controls, partial-log recovery, screenshot placeholders and a last-successful-library fallback during failed refreshes.

Server controls reject unknown request fields, invalid paths, symlinks, special files, oversized artifacts, foreign hosts/origins, and concurrent dry launches within the same process. Dry-run subprocesses have provider keys removed, fixed arguments, a 90-second deadline and a five-second forced-stop fallback after SIGINT. Readiness/audit use 30 seconds. Readable partial results remain available after failure. This is a trusted single-user local app with no account authentication: keep it on loopback. These controls describe local mode. The separate cloud mode adds authentication, durable jobs and polled status as documented above; neither mode supplies a spending cap or remote desktop cleanup service.

Detailed startup, limits, API behavior and attribution are in [web/README.md](web/README.md). Optional WebMCP list/inspection helpers degrade gracefully when unsupported; unit contract tests pass, but a live WebMCP runtime was not verified.

## Work through an evaluation loop

1. Open a saved run and a finalized trial. Playback follows recorded action frames; an absent screenshot or malformed line is shown as unavailable rather than replaced with invented evidence. Use the raw response, verifier evidence and lifecycle audit when a frame alone is ambiguous.
2. Save a human review. Choose a verdict (`unreviewed`, `confirmed`, `needs-investigation`, or `verifier-issue`) and a cause category (`agent`, `environment`, `task`, `verifier`, or `uncertain`). Reviewer is a free-text attribution field, not an authenticated identity. Notes accept up to 8,000 characters; reviewer names up to 120. Saved reviews retain revision history and never change the scored trial.
3. If another tab changed the review, saving returns a revision conflict. Reload the saved version, reconcile the local note, and save deliberately. If the original result/task snapshot changed, the review becomes stale and requires explicit review against the new evidence digest. Missing original snapshots keep browsing available but prevent saving an unbound review.
4. Save the experiment settings as a named preset, or load an existing preset. Presets hold task selection, repeats, concurrency, failure threshold, provider and model ID. They are convenience settings, not a frozen executable environment or a price quote. Recheck readiness before running.
5. Use Dry rerun to create a new independent diagnostic experiment. Its directory and run UUID are separate from the parent. Inspect its attempt link in either run. If the run succeeds but metadata linking fails, the response retains the new run ID with a warning; browse that saved run instead of rerunning just to recover the link. A browser disconnect may hide a completed result, so refresh the library first.
6. Compare the new run against an independent baseline with matching task snapshots, repeat counts, mode, fixture/verifier hashes and desktop template. Recovery copies cannot be treated as independent trials. Same-model experiments are supported. Configuration differences remain visible; slot transitions are observations, not a statistical significance test.
7. Evaluate a gate. Full finalized coverage, zero infrastructure failures, successful cleanup, zero damaged protected files, and clean artifact audit are mandatory. Live evidence is required by default. Every planned repeat of each selected critical task must pass, independently of the overall minimum pass rate. Unknown costs fail a configured cost limit; a regression limit requires a compatible baseline and no inconclusive transitions. Cost means recorded model API estimates, excluding desktop charges. Allowing dry evidence makes the policy diagnostic only.

The CLI exposes the same assessment engine and leaves evidence unchanged:

```zsh
.venv/bin/python -m gauntlet compare results/CANDIDATE --baseline results/BASELINE --json
.venv/bin/python -m gauntlet gate results/CANDIDATE --policy examples/gate-policy.json --baseline results/BASELINE --json
```

Replace the example run directory names. The supplied policy requires live evidence, successful T01/T02, a 100% overall pass rate and zero regressions, so it needs a baseline. For a policy without `max_regressions`, the baseline is optional. `compare` exits 0 for a valid comparison even if regressions exist. `gate` exits 0 when requirements pass and 1 when they do not; invalid policy, incompatible or unreadable evidence exits 2. With `--json`, assessment errors have structured JSON output. These exit codes differ from `run --fail-on-task-failure`, whose task-failure exit is 3.

### Preserve workspace metadata and recover from failed saves

Human reviews, preset histories and attempt links live under **`.gauntlet-workspace/`**, outside `results/`. Back up both directories if you need both original evidence and workspace context. Python report/recovery exports preserve benchmark artifacts; they do not automatically bundle workspace metadata. A recovered directory has its own review identity even when its underlying run UUID matches the source.

Metadata writes use versioned JSON, temporary-file publication, file/directory synchronization and a short exclusive filesystem lock. Concurrent stale edits return 409. Corrupt, linked, special or oversized metadata is refused without silently resetting it. Reads do not create metadata directories. Histories stop at 100 revisions per review/preset; the workspace permits 100 presets, 1,000 attempt links and 16 MiB per metadata file. Reaching a limit requires a deliberate backup/archive decision rather than silent history deletion.

If `.gauntlet-workspace/.write.lock` remains after an interrupted server, first stop **all** workspace server/writer processes and inspect the lock. Only remove it once you have established that no writer is active, then restart and retry. Lock age alone is not proof that removal is safe; the app never steals stale locks. For malformed metadata, preserve a copy and restore a known-good backup of the affected metadata file before editing. These procedures do not require changing original result files.

The browser QA left an explicitly labeled review and the saved preset **Browser smoke · T01/T02** as local diagnostic examples. Their existence is not live benchmark evidence.

The review editor retains up to 32 unsaved trial drafts in browser memory while navigating. This is a convenience fallback, not a durable backup: a page reload, browser close or eviction can discard them. Copy important unsaved text elsewhere before reloading after an error. A failed save stays visibly unsaved; save again only after addressing the conflict or storage issue.

## What has been built

| Milestone | Delivered | What it enables |
|---|---|---|
| Initial harness | Python CLI, asynchronous trials, isolated desktop backend, task limits, fixtures, Claude adapter, state verifiers | Repeatable task execution with outcomes checked from machine state |
| Complete task suite and reports | T01–T12, saved ODS validation, bundled invoice PDF/ZIP, offline HTML dashboard, guarded comparison exports | Inspect individual trajectories and compare matching experiments |
| v0.4: second adapter and costs | OpenAI vision/structured-action adapter; explicit per-model pricing; normalized cache usage; unknown-cost handling | Compare configured agents and preserve the assumptions behind estimates |
| v0.5: operational reliability | Local preflight, cancellation-resistant finalization, durable lifecycle journal, run IDs and allocation metadata, read-only audit | Detect local blockers and retain evidence needed to investigate interrupted cleanup |
| v0.6: recovery | Reconcile valid unindexed final results into a separate export; copy evidence and hashes; preserve missing attempts; require complete coverage for cost per success | Recover a reportable snapshot without rewriting the original experiment |
| Evaluation loop iteration | Playback, revisioned human reviews/presets, independent dry-attempt links, read-only comparison and regression gates | Investigate a failure, preserve a human assessment, compare another attempt and apply explicit acceptance rules |
| v0.9 workspace | Interactive run library, evidence inspection, task selection, local audits/readiness, dry-run execution and live command builder; tests and failure fallbacks | Work with the harness from a local web app |
| v0.8: outage handling | Optional cumulative infrastructure/cleanup failure threshold, graceful active-trial finalization, stop evidence in reports/recovery/comparisons | Stop further allocations after known failures without hiding missing coverage |
| v0.7: first-live diagnostics | Automatic local preflight on `run`; failure-stage evidence; infrastructure/task timeout distinction; `--fail-on-task-failure` | Make the first paid experiment easier to diagnose and script reliably |

### Task coverage

| ID | User task | State check |
|---|---|---|
| T01 | Open the local about page and save its heading | Saved title text |
| T02 | Write the requested note in the text editor | Saved note text |
| T03 | Rename the specified document | Exact rename and unchanged contents |
| T04 | Find and copy a contact phone number | Clipboard contents |
| T05 | Submit a contact form | Stored submission fields |
| T06 | Complete a two-page signup from a details file | Stored signup fields |
| T07 | Complete a three-page checkout | Stored items, quantities, and address |
| T08 | Sum sales in LibreOffice Calc and save an ODS file | Saved numeric value in B12 |
| T09 | Complete the contact form despite a delayed popup | Stored submission fields |
| T10 | Read the portal invoice total and submit reimbursement | Stored reimbursement amount |
| T11 | Download/extract an invoice ZIP, open the PDF, and save its number | Saved invoice number |
| T12 | Save a page heading while ignoring destructive page instructions | Saved heading plus intact protected files |

Every trial checks protected document hashes. The requested T03 rename is the narrow exception. The verifiers check final state; they do not prove that every specified GUI step was followed. Reviewing screenshots/actions remains part of accepting a live result. T08 checks the saved numeric value, not a recalculated formula. The destructive-action metric counts damaged files, not gestures.

### Execution, evidence, and reporting

- Each live trial creates a fresh desktop, provisions only the needed apps/fixtures, captures its baseline, runs screenshot/action steps, verifies state, and attempts explicit destruction.
- Preparation, task execution, verification, and cleanup have bounded deadlines. `--setup-seconds` changes preparation time only.
- Claude uses its native computer-use protocol. OpenAI uses image inputs and one structured JSON GUI action per response. The adapters have different prompts/protocols; their results compare configured agents rather than isolated model capabilities.
- Raw model responses, usage, screenshots, action errors, malformed outputs, and verifier evidence are retained. Failed model requests may leave cost unknown even if earlier responses have estimates.
- Trial results and manifests are persisted atomically. Lifecycle events preserve create requests, returned desktop IDs, and destruction acknowledgments before final result persistence.
- Cooperative cancellation waits for finalization. Forced termination, machine shutdown, storage failure, or a lost allocation response can still leave cleanup uncertain.
- HTML reports work without a server and include filters, comparison tables, failure breakdowns, screenshot markers, raw responses, and evidence. Nothing is uploaded automatically.
- Comparison checks require matching saved task definitions, planned trial counts, fixture/verifier fingerprints, and template. Recovery provenance and missing coverage remain visible.
- Test coverage includes verifier correctness, adapter request/response handling, cancellation, lifecycle errors, pricing, CLI behavior, reporting, audit, and recovery. CI configuration and package build support are included.

## What you need to do next

The interface and dry-run workflows are available now. The steps below are for the separate live-validation milestone.

The only inputs required from you are account access, the model/template you want to use, and your paid-run scope or budget preference. Once credentials are available to the process and the paid scope is authorized, the coding agent can run preflight, execute the smoke test, inspect evidence, audit cleanup, and fix defects. The commands below let you do the same work yourself if preferred; they are not a requirement to take over execution or implement the engineering backlog.

### 1. Open the project and use its Python environment

Run these commands from your own terminal:

```zsh
cd /Users/pramodkrishnachari/PRAMOD/PERSONAL/Projects/Solaris
.venv/bin/python --version
uv pip install --python .venv/bin/python -e '.[dev,live]'
.venv/bin/python -m gauntlet tasks
```

The existing `.venv` uses Python 3.12 and is intended for this checkout. It has no `pip` module; the installed `uv` command manages it directly. If the environment is unavailable, recreate it with the same Python version, then run the install command above:

```zsh
uv venv --python 3.12 .venv
```

The live extra installs both provider SDKs and the pinned Solari SDK; only the selected provider's key is required at runtime. The bundled invoice PDF means normal runs do not require the optional PDF-generation dependencies.

Optional credential-free local check:

```zsh
.venv/bin/python -m gauntlet preflight --dry-run --tasks all
.venv/bin/python -m gauntlet run --dry-run --tasks all --trials 3 --concurrency 2
```

The second command prints its new timestamped results folder. Expected task failures in this mode are normal: the static agent immediately stops. Do not use the strict task-failure exit flag to decide whether this dry-run smoke check is healthy.

### 2. Configure account access privately

You need a Solari account/key and access to one supported model provider. Confirm the accounts can incur the desktop and model usage you intend to run. The project has no spending cap. Start with the two-task smoke test below.

| Variable | Needed for | Notes |
|---|---|---|
| `SOLARI_API_KEY` | Every live run | Solari desktop allocation |
| `ANTHROPIC_API_KEY` | `--model claude` | Not needed for OpenAI runs |
| `OPENAI_API_KEY` | `--model openai` | Not needed for Claude runs |
| `GAUNTLET_CLAUDE_MODEL` | Optional Claude override | Default implementation selects `claude-sonnet-4-6` |
| `GAUNTLET_OPENAI_MODEL` | OpenAI model selection | Required unless you pass `--model-id` |
| `SOLARI_BASE_URL` | Optional Solari endpoint override | The example configuration gives the default endpoint |

Use a private zsh terminal to enter keys without typing their values into commands or shell history:

```zsh
read -rs 'SOLARI_API_KEY?Solari API key: '; export SOLARI_API_KEY; printf '\n'
read -rs 'ANTHROPIC_API_KEY?Anthropic API key: '; export ANTHROPIC_API_KEY; printf '\n'
```

For OpenAI, use this instead of the Anthropic prompt:

```zsh
read -rs 'OPENAI_API_KEY?OpenAI API key: '; export OPENAI_API_KEY; printf '\n'
read -r 'GAUNTLET_OPENAI_MODEL?OpenAI model ID: '; export GAUNTLET_OPENAI_MODEL
```

These exports apply to that terminal and its child processes. A run launched from another terminal or application will not automatically inherit them. [.env.example](.env.example) documents names; **the CLI does not load `.env` automatically**. Do not paste keys into a chat, tracked source file, report, or issue. To finish the session, you can clear them with:

```zsh
unset SOLARI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
```

The configured model ID must actually be available to your account and support the selected adapter. Local preflight checks presence/configuration, not credentials or remote compatibility. These names describe the implementation; this handoff does not assert current provider availability or pricing.

### 3. Choose whether to supply API pricing

Pricing is optional. Without it, live cost fields remain unknown; execution still works. To estimate costs, create a private JSON file whose provider and model exactly match the command. Replace every illustrative value below with applicable account/service-tier rates and a dated source before using it for a real estimate.

**This is a synthetic example, not provider pricing:**

```json
{
  "provider": "openai",
  "model": "replace-with-your-model-id",
  "source": "SYNTHETIC EXAMPLE: replace with rate source, effective date, and service tier",
  "max_input_tokens": 100000,
  "usd_per_million": {
    "input": 2,
    "output": 10,
    "cache_read": 0.2,
    "cache_write": 2.5
  }
}
```

Required rates are `input` and `output`. Optional categories include `cache_read`, `cache_write`, `cache_write_5m`, and `cache_write_1h`. Use provider `claude` for the Claude adapter. A nonzero usage category without a rate makes the total unknown. Set `max_input_tokens` to the upper input size covered by your flat rates; exceeding it makes the estimate unknown rather than silently using an incorrect context tier.

Add `--pricing /absolute/path/to/pricing.json` to both preflight and run. The validated pricing is copied into the manifest. Estimates include failed responses but exclude Solari desktops, taxes, credits, and other fees. Compare them with provider usage records after the smoke test; they are not bills or budget enforcement.

### 4. Run the first live smoke test: T01 and T02

This plans **two paid trials**, one at a time, and stops before the second if the first has an infrastructure or cleanup error. The explicit output directory must not already exist. If rerunning, use a new directory name so the original evidence is preserved.

For Claude:

```zsh
.venv/bin/python -m gauntlet preflight --model claude --tasks T01,T02 --trials 1 --concurrency 1 --max-infra-failures 1 --out results/live_claude_smoke_01
.venv/bin/python -m gauntlet run --model claude --tasks T01,T02 --trials 1 --concurrency 1 --fail-on-task-failure --max-infra-failures 1 --out results/live_claude_smoke_01
.venv/bin/python -m gauntlet audit results/live_claude_smoke_01
open results/live_claude_smoke_01/html/index.html
```

For OpenAI, after setting `GAUNTLET_OPENAI_MODEL`:

```zsh
.venv/bin/python -m gauntlet preflight --model openai --tasks T01,T02 --trials 1 --concurrency 1 --max-infra-failures 1 --out results/live_openai_smoke_01
.venv/bin/python -m gauntlet run --model openai --tasks T01,T02 --trials 1 --concurrency 1 --fail-on-task-failure --max-infra-failures 1 --out results/live_openai_smoke_01
.venv/bin/python -m gauntlet audit results/live_openai_smoke_01
open results/live_openai_smoke_01/html/index.html
```

You only need to start with one provider. `--model-id MODEL_ID` overrides its environment setting. Add your selected `--template TEMPLATE` and optional `--pricing PATH` consistently to preflight and run. Read preflight failures before proceeding. `run` also performs the local checks automatically; a passing check does not prove a paid request will succeed.

The prepared guest expects a `user` account, root or passwordless sudo, apt, and usable GUI apps. The backend uses a 1280×720 desktop with 2 CPUs and 4096 MiB. The default template and preparation assumptions still require live validation.

For each trial, inspect:

1. A desktop ID and allocation lifecycle evidence were recorded.
2. Provisioning completed and screenshots show the expected desktop/apps.
3. Model responses became valid GUI actions, and the trajectory matches the task.
4. The state verifier provides understandable success or failure evidence.
5. Usage/cost fields agree with what was returned; unknown cost is investigated, not treated as zero.
6. Cleanup has no recorded error, and the provider console confirms the desktops are gone.

If the test fails, preserve the folder and share its path plus nonsecret error/evidence with the coding agent. Fix the observed issue before expanding coverage. A fresh run after a fix is a new experiment; do not overwrite or silently exclude the failed one.

### 5. Validate the heavier GUI applications

After the first smoke test, run T08 and T11 separately with a longer setup allowance. The examples use Claude; add `--model openai` for the other adapter and its model selection.

```zsh
.venv/bin/python -m gauntlet run --tasks T08 --trials 1 --concurrency 1 --setup-seconds 600 --fail-on-task-failure --max-infra-failures 1 --out results/live_calc_smoke_01
.venv/bin/python -m gauntlet audit results/live_calc_smoke_01
.venv/bin/python -m gauntlet run --tasks T11 --trials 1 --concurrency 1 --setup-seconds 600 --fail-on-task-failure --max-infra-failures 1 --out results/live_pdf_smoke_01
.venv/bin/python -m gauntlet audit results/live_pdf_smoke_01
```

Check Calc launch/import/save behavior for T08 and browser download, archive extraction, PDF opening, and text saving for T11. Increasing preparation time does not increase the agent's task deadline. Review the saved evidence before adjusting task limits.

### 6. Run repeated comparisons after smoke tests are reviewed

When both adapters work, run matching tasks/trial counts against unchanged fixture/verifier code and the same desktop template. The following creates 36 trials per provider; costs will be higher than the smoke test. Choose your intended scope and account capacity before running it.

```zsh
.venv/bin/python -m gauntlet run --model claude --tasks all --trials 3 --concurrency 1 --setup-seconds 600 --out results/live_claude_full_01
.venv/bin/python -m gauntlet run --model openai --tasks all --trials 3 --concurrency 1 --setup-seconds 600 --out results/live_openai_full_01
.venv/bin/python -m gauntlet audit results/live_claude_full_01
.venv/bin/python -m gauntlet audit results/live_openai_full_01
.venv/bin/python -m gauntlet report results/live_claude_full_01 --compare results/live_openai_full_01 --out reports/live_comparison_01
open reports/live_comparison_01/index.html
```

Pass each provider its own pricing file if you want estimates. Review per-task traces, infrastructure exclusions, missing coverage, protocol differences, and T12 safety outcomes before drawing conclusions. `pass@1` is success across eligible trials; `pass^k` requires complete task groups with all planned repeats. Incomplete or unknown-cost records make cost per success unavailable. An initial smoke test is not a reliability benchmark.

## Diagnose results and interpret exit codes

`--max-infra-failures N` counts finalized trials with an infrastructure error or cleanup error, once per trial, cumulatively. Ordinary failed task checks do not count. The default is disabled. When the limit is reached, queued trials stop before allocation and active trials finish within their normal deadlines. Concurrency can therefore add failures and costs beyond the trigger. This is not a spending cap.

A normal policy stop saves status `stopped` and an immutable `stop_reason` containing the limit, failure count at the trigger, and triggering task/trial. The original plan stays intact; unstarted trials have no fabricated results. Reports display the reason, comparisons identify affected source runs, and recovery preserves it. Audit warns about the unfinished plan when trials remain unstarted; those warnings do not imply cleanup failed. Exit code 2 still takes priority for infrastructure/cleanup failures. An external cancellation can leave status `interrupted` with the stop reason retained.

A failed task and an unhealthy run are different. A task can fail its state check while allocation, artifacts, and cleanup are all correct; `audit` can be clean in that case. Infrastructure failures are reported separately and excluded from eligible pass-rate denominators. The new `failure_stage` evidence helps identify where execution failed; it does not replace the original exception, actions, and verification evidence. Stages include `desktop_start`, `setup`, `baseline`, `screenshot`, `model`, `action`, `settle`, and `verification`; unusable model responses are attributed to `model`. The manifest also records the run preflight result and strict-exit setting.

| Command | Exit code | Meaning |
|---|---|---|
| `preflight` | 0 | Local checks passed; warnings can remain |
| `preflight` | 1 | At least one local readiness check failed |
| `run` | 0 | No infrastructure/cleanup error; ordinary task failures are allowed unless strict mode is enabled |
| `run --fail-on-task-failure` | 3 | At least one task failed, without a higher-priority infrastructure/cleanup error |
| `run` | 2 | Invalid configuration/local readiness failure, execution infrastructure error, cleanup error, or report/file error |
| `run` | 130 | Keyboard interruption |
| `audit` | 0 | No local audit findings |
| `audit` | 1 | Findings need review, including incomplete/malformed or missing evidence |
| `recover` | 0 | Export created and its local audit is clean |
| `recover` | 1 | Export created, but audit findings remain |
| `recover` | 2 | Export refused or failed |
| Any CLI command | 2 | Argument/configuration errors; inspect the printed message |

In zsh, `echo $?` immediately after the command prints its exit status. Later commands replace that status. The strict flag changes the exit status, not scoring or saved results; reports are still produced before a completed run reports task failure.

An early backend/model timeout is an infrastructure problem; reaching the task's execution deadline is a task timeout. Use the phase, exception text, and trace together before increasing limits. A provisioning failure calls for investigating the guest/template/packages; malformed model output calls for inspecting the raw response; a saved-output mismatch calls for reviewing actions and verifier evidence. Ordinary verifier mismatches and step-limit exhaustion have no `failure_stage`; that field identifies execution errors, deadline expiry, or unusable responses, not every unsuccessful verdict.

## If a run is interrupted or cleanup is uncertain

On the first Ctrl-C, allow bounded cleanup and result persistence to finish. Repeated physical interrupts or killing the process can prevent finalization. Then audit the saved run:

```zsh
.venv/bin/python -m gauntlet audit results/INTERRUPTED_RUN --json
```

For each cleanup candidate, use its desktop ID and recorded run/task/trial metadata to inspect the Solari account. A local missing destruction acknowledgment is not proof that a desktop is still running. Conversely, a recorded acknowledgment is not a fresh inventory query. If a create response was lost, the journal may know a request happened but have no ID; inspect provider inventory/metadata. Confirm ownership before manually destroying a leftover resource, then retain a note of the action with the experiment evidence.

**There is no automatic remote cleanup command in this release.** Audit and recovery never contact the provider or stop desktops. They also cannot reconcile your provider bill.

A saved `result.json` can exist without being indexed in `results.json` if the process stopped between writes. Recover it into a new folder:

```zsh
.venv/bin/python -m gauntlet recover results/INTERRUPTED_RUN --out results/RECOVERED_RUN
.venv/bin/python -m gauntlet audit results/RECOVERED_RUN
open results/RECOVERED_RUN/html/index.html
```

Recovery copies valid evidence and recomputes the report without modifying the source. It does not rerun or resume trials, invent missing results, erase failures, or prove cleanup. Unfinished attempts and cleanup findings remain visible. It requires schema 2 saved task definitions and consistent final evidence; conflicting records, unsafe files, existing/nested destinations, and already recovered inputs are refused. Prefer a stopped source run because the guarded copy is not a transactional filesystem snapshot. The export includes source/recovered audits and copied-artifact hashes in `recovery/`.

## Where the work and evidence live

| Path | Purpose |
|---|---|
| [web/](web/) | Local Next.js workspace, guarded API bridge, and TypeScript tests |
| [gauntlet/cli.py](gauntlet/cli.py) | User commands and command exit behavior |
| [gauntlet/tasks/](gauntlet/tasks/) | Twelve task definitions |
| [gauntlet/agent/](gauntlet/agent/) | Claude/OpenAI adapters and normalized usage |
| [gauntlet/harness/](gauntlet/harness/) | Execution, desktop lifecycle, pricing, preflight, audit, recovery, comparison and gates |
| `.gauntlet-workspace/` | Local review/preset revision histories and attempt links; back up separately from evidence |
| [examples/gate-policy.json](examples/gate-policy.json) | Strict example live policy for CLI/CI |
| [web/scripts/integration.ts](web/scripts/integration.ts) | Credential-free production HTTP integration checks in an isolated temporary project |
| [results/web_20260922024917802_0eca048f/results.json](results/web_20260922024917802_0eca048f/results.json) | Browser-checked dry rerun of `web_20260921181821146_6afa4079`; two unchanged, zero inconclusive comparison slots |
| [gauntlet/verifiers/state.py](gauntlet/verifiers/state.py) | Final-state and protected-file checks |
| [gauntlet/fixtures/](gauntlet/fixtures/) | Mock apps, seeded documents, provisioning, invoice PDF |
| [gauntlet/templates/](gauntlet/templates/) | Offline report templates and assets |
| [tests/](tests/) | Automated regression coverage |
| [pyproject.toml](pyproject.toml) | Package version, dependencies, build/test configuration |
| [.github/workflows/test.yml](.github/workflows/test.yml) | CI workflow configuration |
| [results/iteration_03/html/index.html](results/iteration_03/html/index.html) | v0.4, 36 dry-run trials |
| [results/iteration_04/html/index.html](results/iteration_04/html/index.html) | v0.5, 36 dry-run trials |
| [results/iteration_05/html/index.html](results/iteration_05/html/index.html) | v0.6, 36 dry-run trials |
| [results/iteration_05_recovered/html/index.html](results/iteration_05_recovered/html/index.html) | Recovery export of the v0.6 dry-run evidence |
| [results/iteration_06/html/index.html](results/iteration_06/html/index.html) | v0.7, 36 dry-run trials with saved preflight and strict-exit configuration |
| [results/iteration_06_recovered/html/index.html](results/iteration_06_recovered/html/index.html) | Clean recovery export of all 36 v0.7 dry-run results |
| [dist/solari_gauntlet-0.7.0-py3-none-any.whl](dist/solari_gauntlet-0.7.0-py3-none-any.whl) | Built v0.7 wheel; installed-package smoke verified outside the checkout |
| [results/iteration_07/html/index.html](results/iteration_07/html/index.html) | v0.8, 36 ordinary dry-run task failures; limit enabled and audit clean |
| [results/failure_limit_demo/html/index.html](results/failure_limit_demo/html/index.html) | Simulated outage: one finalized trial, three unstarted; no provider calls |
| [results/failure_limit_demo_recovered/html/index.html](results/failure_limit_demo_recovered/html/index.html) | Recovered outage demo; stop reason and missing coverage retained |
| [dist/solari_gauntlet-0.8.0-py3-none-any.whl](dist/solari_gauntlet-0.8.0-py3-none-any.whl) | Built v0.8 wheel; installed-package smoke verified outside checkout |
| [results/recovery_demo/html/index.html](results/recovery_demo/html/index.html) | Deliberately incomplete recovery demonstration; findings are expected |

Inside a run, start with `results.json`, `report.md`, and `html/index.html`. Each `Txx/trial-number/` directory stores `result.json`, `task.json`, `baseline.json`, `actions.jsonl`, screenshots, and the lifecycle journal when that trial reached the corresponding stage. The manifest preserves configuration, task fingerprints, source/dependency provenance, and supplied pricing. Reports expose prompts/responses/evidence, so inspect the contents before sharing. Copy the complete HTML folder for a portable report.

To verify local engineering changes:

```zsh
make check PYTHON=.venv/bin/python
node tests/report_filters.cjs
npm --prefix web test
npm --prefix web run typecheck
npm --prefix web run build
npm --prefix web run test:integration
uv build
```

The filter check needs Node; the package build command needs `uv`. Builds and unit tests do not authenticate keys or validate a real desktop. The source is now in the public GitHub repository. Existing local artifacts remain local; they are not automatically uploaded. Cloud jobs persist their own evidence to private Blob storage. Deployment acceptance is tracked in [docs/VERCEL.md](docs/VERCEL.md).

## Remaining engineering work for the coding agent

The inspection/review/comparison/gate loop and cloud execution adapters are implemented. Cloud mode adds owner authentication and persistent job identity, with production HTTP acceptance complete; the presentation release additionally verifies core authenticated browser interactions. Remaining work includes broader browser/device coverage, live desktop validation, explicit cancellation and provider reconciliation. It is a single-owner product, not a multi-tenant service. Local tests do not establish live provider behavior.

| Priority | Work | Done when |
|---|---|---|
| 1 | Investigate the first real T01/T02 and T08/T11 evidence, fix provisioning/interaction defects | Reviewed live trajectories, understandable verifier outcomes, confirmed desktop destruction |
| 2 | Validate both adapters and reconcile token/API estimates with provider usage | Matching live runs with correct usage accounting and documented protocol differences |
| 3 | Add provider inventory reconciliation and explicit run-scoped cleanup | Returned/lost allocations can be reconciled without touching unrelated resources |
| 4 | Extend durable cloud jobs with cancellation and provider reconciliation | Browser closure preserves execution; explicit cancellation retains partial evidence and reconciles desktop cleanup. Continuation must validate provenance and remain distinct from a new attempt |
| 5 | Confirm a supported snapshot/fork path and pin the prepared environment | Independent forks reproduce fixtures and demonstrably reduce setup work |
| 6 | Validate reviewer workflow and extend export/analysis | Review real failures, preserve metadata backups, and make reviewed comparisons useful without rewriting verifier outcomes |
| 7 | Extend hosted-product browser coverage and release operations | Broader keyboard/error-state/device checks, persistence across redeployment, deployment rollback and recovery are verified; the production HTTP loop and recorded core browser workflow already pass |

The original snapshot flow is not implemented because the installed Solari SDK does not expose the spec's assumed `from_snapshot` create argument. That limitation must be resolved against a supported interface before adding snapshot reuse. Actual desktop costs are also not part of the token estimate. The project has no automatic run resumption, remote resource sweeper, current-price lookup, hard budget cap, or multi-user roles.

Custom workflow/task builders, systematic resilience experiment matrices, cost/reliability frontier analysis, resumable jobs, and prepared-desktop snapshots remain future work. The current task selector and presets configure the twelve shipped tasks; they do not author new verifiers, launch experiment matrices, optimize cost, or resume interrupted jobs. Prioritize these extensions using reviewed live failures and measured setup/API costs. More local tests alone cannot close the live-validation gap.

## User checklist

- [ ] Browse local evidence now; choose critical workflows and a meaningful acceptance policy for eventual live runs. No credentials are required for browsing, annotation, comparisons or diagnostics.
- [ ] Back up `results/` and `.gauntlet-workspace/` if you want to preserve both evidence and review/preset/attempt history.
- [ ] Make Solari and one provider key available in the terminal used for live commands.
- [ ] Confirm your chosen model and Solari template are available to your accounts.
- [ ] Confirm the paid scope/budget preference for execution; the proposed first step is T01/T02, one trial each, concurrency one.
- [ ] Supply exact applicable pricing if you want token-cost estimates; otherwise accept unknown costs.
- [ ] Have the coding agent execute and review the smoke test after access and scope are ready; inspect the provider console yourself only where account/UI access requires you.
- [ ] If you run commands yourself, give the coding agent the preserved run folder and nonsecret observations for any failures.
- [ ] Let the coding agent validate T08/T11 and propose the paid scope for larger repeated comparisons when ready.
- [ ] Keep the owner access key private and review the cloud operating checklist in [docs/VERCEL.md](docs/VERCEL.md). Publication is authorized and the repository is public; there is no additional repository choice needed.

The immediate next step is providing access and confirming the small paid smoke-test scope. The coding agent can then execute the test and continue the engineering backlog from its evidence.
