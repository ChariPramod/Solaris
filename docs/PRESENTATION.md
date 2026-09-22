# Presenting Solaris

Updated September 22, 2026. This guide describes the verified cloud diagnostic product. It does not claim live agent benchmark results. The public overview and guided setup are deployed and browser-checked. The verified UI release is `f0ac407`, with readiness compatibility correction `800f953` deployed afterward.

Product: **[solaris-gauntlet.vercel.app](https://solaris-gauntlet.vercel.app)** · Source: **[ChariPramod/Solaris](https://github.com/ChariPramod/Solaris)**

## The 30-second pitch

> Solaris is a testing workspace for agents that use computers. Select repeatable workflows, run evaluations, and inspect the evidence behind each result. Reviews, comparisons and regression gates help teams understand failures and measure changes. The deployed product runs real diagnostic jobs with persistent private storage. Our next milestone is validating the same loop on live desktops and model APIs; we are not publishing performance scores yet.

The intended audience is a developer or team building computer-use agents. The central question is: **“Can we trust this agent on our workflows, and what changed when we updated it?”**

## What the presentation can demonstrate today

| Capability | Evidence available | Limit to state clearly |
|---|---|---|
| Deployed product and public source | Vercel product and GitHub repository | Workspace access requires the owner's private key; source visibility does not expose saved evidence |
| Actual cloud execution | Two accepted T01/T02 diagnostic jobs, durable job records and saved trial results | Dry runs use a static agent; expected task failures do not measure a model |
| Evidence inspection | Trial records, verifier outcomes, artifact audit, original manifest download | Dry-run images/actions do not establish real desktop interaction or useful agent trajectories |
| Human review | Saved notes, revision history and stale-edit rejection | Reviewer notes do not replace machine results; reviewer names are not separate authenticated accounts |
| Repeatable setup and attempts | Saved presets and a recorded parent/child relationship | An attempt is an independent experiment; it does not resume its parent |
| Comparison and gates | Python comparison accepted the two diagnostic runs with no inconclusive transitions; strict live gate failed; explicit diagnostic gate passed | A diagnostic gate tests the evaluation pipeline, not production readiness of an agent |
| Private storage and access control | Production HTTP checks for sign-in, protected data, cross-origin rejection and persistence | Single-owner workspace; no multi-user roles, tenant isolation or formal security audit |

The original production HTTP acceptance was recorded against `c443612`. The presentation release adds deployed UI commit `f0ac407` and readiness correction `800f953`: 117 TypeScript tests pass, and GitHub CI is green with 414 Python tests. Browser checks covered the public overview on desktop and at a 390-pixel emulated mobile viewport, authenticated mobile guide/jobs/forms, actual job launch, trial inspection, review saving and comparison. These are recorded interaction checks, not an exhaustive automated browser suite or testing on physical mobile devices. See [the deployment guide](VERCEL.md) for the earlier HTTP verification scope.

The browser-launched diagnostic job `cloud_85622acca6b3ada276577e45ea50684b` completed with two of two planned trial results saved. Its T01 review was saved as revision 1 under reviewer **Presentation validation** and persisted after reload. Comparing it with `cloud_b49459f6a10ff76561db523f1987b332` through the UI returned two unchanged slots and zero inconclusive slots. The live setup check displayed the absent Solari/Anthropic credentials, disabled live launch, and was invalidated when the selected tasks changed. The default gate correctly failed on dry evidence and the zero pass rate, while coverage, audit, infrastructure, cleanup and regression checks passed. After reloading `800f953`, **Cloud readiness** reported storage/source checks passing and the two missing provider keys, with Vercel setup instructions. No live-provider execution occurred.

## Prepare before presenting

1. Open the canonical product address. Sign in privately before screen sharing. The owner key is in the ignored local file `tmp/solaris-access-key.txt`; do not put it on a slide, in chat, in the repository or in a recorded terminal command.
2. Locate the accepted baseline `cloud_b49459f6a10ff76561db523f1987b332` and browser-launched candidate `cloud_85622acca6b3ada276577e45ea50684b` in the evaluation library. Both ran T01/T02 once. The baseline has a recorded parent link to earlier run `cloud_636d9a1609324b11c94790f4210f5b38`; do not imply the newer candidate was launched as its linked child. Use the full IDs when searching so an earlier failed acceptance job is not mistaken for the accepted pair.
3. Inspect both saved manifests and the baseline's **Artifact audit**. Confirm the product still loads them. Keep the earlier failed job visible in the history: it records a real storage bug that was subsequently fixed.
4. Prepare one browser tab with the baseline's T01 trial and another with the candidate's **Compare & gate** panel. Choose the baseline above and run **Compare with this run** before the talk. Assessment starts a real Python worker and can take time; do not promise that cold startup fits a five-minute slot.
5. In a separate prepared tab, run the default gate with **Require live evidence** enabled. Keep its actual failure visible. If showing a passing diagnostic gate too, use a separate tab: disable **Require live evidence**, set **Minimum pass rate (%)** to `0`, select the accepted baseline and set maximum regressions and recorded API cost to `0`. Leave critical-task requirements empty. Label that result a diagnostic policy.
6. Use a stable connection and hide unrelated browser tabs. Keep the public repository and this guide open as useful fallbacks. Do not replace an unavailable live product with invented results.

Opening saved evidence is read-only. Launching runs or evaluating comparisons/gates can allocate billable Vercel workers, even in dry mode. Saving a note or preset updates the private workspace. Make intentional edits and use an identifiable presentation note rather than overwriting someone else's draft.

## Five-minute product walkthrough

| Time | Action | Suggested narration |
|---|---|---|
| 0:00–0:30 | Show the public product overview, then the signed-in guided setup, and deliver the pitch. | “This is the deployed evaluation workspace. Today I am showing real diagnostic execution, not model benchmark results.” |
| 0:30–1:15 | Open **Execution jobs**, then the accepted baseline. Point to its two recorded trials and dry-run label. | “A durable job launches the Python harness in an isolated worker. Completion means the execution finished; individual tasks can still fail. These diagnostic failures are expected.” |
| 1:15–2:00 | Open T01 in **Trial matrix**, inspect verifier evidence and the saved **Artifact audit**. Briefly point to the playback controls without implying a live trajectory exists here. | “The score is tied to recorded state and evidence. The diagnostic agent stops immediately. With live runs, this same inspection surface shows the agent's screenshots and actions.” |
| 2:00–2:45 | Show the saved **Presentation validation** review on the candidate, then **Attempt history** on the baseline to see its earlier parent. Optionally save a clearly named presentation note and reload it. | “A reviewer can record an interpretation without changing the original verifier outcome. A rerun has its own identity, and the earlier attempt remains available.” |
| 2:45–3:45 | Switch to the prepared comparison and strict-gate tabs. Show actual transitions and the live-required failure. | “Comparisons require compatible task and environment evidence. The default gate refuses to treat a dry diagnostic as a validated live result.” |
| 3:45–4:30 | Open **New evaluation**, show T01/T02 with one trial and concurrency one, then show the available saved setup. Close the form without starting another job unless a new execution is part of the session. | “The configuration is reusable. New execution is real work with a visible job and saved evidence, not an animation.” |
| 4:30–5:00 | Show **Readiness** and explain the remaining provider setup. Close with the next milestone. | “The hosted application and diagnostic path work. We still need Solari and one model provider configured, then reviewed live trials before reporting agent reliability.” |

If a new execution must be shown, start one diagnostic job before the timed walkthrough and return to its job state at the end. Use the accepted saved pair for inspection while it runs. Do not press start repeatedly when a launch response is slow or disconnected; check **Execution jobs** first.

If an assessment times out, keep browsing its original saved evidence and explain that assessment is temporarily unavailable. An unavailable assessment is not a passing or failing benchmark decision. A downloaded manifest contains useful source data but is not a complete evidence backup or enough for all offline validation.

## Questions to expect

**Is this a demo UI or a functioning backend?**

The deployed app invokes the actual Python harness in isolated workers and persists job state, evidence and review metadata in private storage. Production acceptance exercised two complete diagnostic runs, comparison and gates. The unresolved live-provider milestone is separate from that working execution path.

**Why do the displayed tasks fail?**

The dry-run agent intentionally stops without doing the task. That mode checks orchestration, verification, saving, review and assessment without using Solari desktops or model APIs. It is expected to fail task checks. It does not indicate that Claude or OpenAI failed those tasks.

**What makes an evaluation result trustworthy?**

The harness checks recorded final state, preserves task/source fingerprints and links results to original evidence. Missing trials, infrastructure errors, cleanup uncertainty and unknown costs remain explicit. Human review is still needed to judge whether the intended GUI steps were followed; final-state checks alone do not prove that.

**Can you say one model is better or cheaper?**

Not yet. That requires repeated compatible live runs, review of ambiguous outcomes and provider-validated usage. The two adapters use different action protocols, so future comparisons describe configured agents. Recorded API estimates are not a complete desktop-plus-worker bill or a hard spending cap.

**Can a visitor run evaluations or view private results?**

The repository is public, but this deployment is a private single-owner workspace. The owner signs in with an access key; visitors do not receive that key or provider credentials. A public landing page can explain the product without granting workspace access. Separate user accounts and role permissions are not implemented.

**Can we add our own workflows?**

The code can be extended with tasks, fixtures and verifiers. The UI currently selects from twelve shipped tasks; its saved presets do not author new workflows. A validated custom-workflow builder remains planned.

**What happens when a job or provider fails?**

Jobs retain their status and any saved evidence. A timeout or missing cleanup acknowledgment stays visible; a new attempt preserves its predecessor. There is no automatic paid replay, resume, cancellation UI or provider-wide cleanup sweeper. Inspect the saved job and provider resources before creating a replacement live attempt.

**Is this ready for a broad public launch?**

It is ready to present as a working, single-owner evaluation product with verified diagnostic execution. Broad live use still needs provider validation, broader browser/device coverage, exercised rollback/restore, and operational work around cancellation, evidence export, retention and access roles as required by the audience.

## What the owner still needs to provide

1. In the Vercel project's production environment, configure `SOLARI_API_KEY` and either `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Keep them server-only and out of `NEXT_PUBLIC_*`, Git and presentation materials. For OpenAI, choose an explicit model ID available to that account. Confirm access to the intended desktop template and billing scope.
2. Redeploy so the server environment contains those settings. Keep the canonical origin, private Blob connection, owner authentication and worker source revision configured as described in [VERCEL.md](VERCEL.md). Keys in a local terminal do not automatically reach the hosted workers.
3. Run readiness for the selected provider/model. A passing presence/configuration check is not proof that the keys authenticate or that desktop provisioning works.
4. Authorize a small paid smoke scope: T01/T02, one trial each, concurrency one. There is no enforced spending cap. Once the inputs and scope are available, the coding agent can execute the run, inspect failures and fix implementation issues; the owner does not need to take over the engineering work.
5. Review the screenshots/actions, final-state verification, saved audit, provider usage and actual Solari resource cleanup. Then validate T08 and T11 individually. Preserve failed attempts and unknown costs.
6. Run repeated compatible trials and review coverage before making model success-rate, safety or cost-comparison claims. Decide the published methodology and sample count before collecting headline results.

## Release and presentation checklist

Recorded completed checks:

- [x] Public GitHub repository and canonical Vercel deployment exist.
- [x] Owner authentication, protected API access and same-origin writes passed production HTTP acceptance.
- [x] Two real cloud diagnostic jobs persisted evidence and independent attempt history.
- [x] Comparison, strict gate rejection, diagnostic gate acceptance, review conflicts and preset persistence passed remote acceptance.
- [x] Both accepted diagnostic worker sandboxes were confirmed stopped; this does not certify live desktop cleanup.
- [x] Published sign-in layout and invalid-key feedback were checked in a browser.

Before presenting the next release:

- [x] Deploy and browser-check the public overview and guided setup (`f0ac407`, followed by readiness fix `800f953`).
- [x] Check the public overview at desktop and 390-pixel emulated mobile widths, and inspect authenticated mobile guide/jobs/forms.
- [x] Launch T01/T02 from the actual UI, inspect its saved trial, save a review and compare against the accepted baseline.
- [x] Verify missing live credentials disable launch, changed task selection invalidates the readiness result, and Cloud readiness returns storage/source success plus the two missing keys.
- [x] Run the default gate through the browser and verify it rejects dry evidence and zero task pass rate while coverage/audit/infrastructure/cleanup/regression checks pass.
- [x] Confirm the saved presentation review persists after reload.
- [ ] Complete a full keyboard/accessibility sweep and extend loading/error, cross-browser and physical-device checks beyond the recorded interaction paths.
- [ ] Reopen the accepted evidence pair and prepare actual comparison/gate panels; confirm labels still distinguish diagnostics from benchmarks.
- [ ] Confirm no owner/provider keys, private environment files or unrelated user data appear in shared screens, bundles or presentation artifacts.
- [x] Record the deployed release/correction SHAs and 117 TypeScript / 414 Python test checkpoint in the release handoff.

Before claiming a validated live-agent product:

- [ ] Configure provider credentials and complete the reviewed live smoke scope.
- [ ] Confirm live desktop destruction and reconcile provider usage for every smoke trial.
- [ ] Validate spreadsheet/PDF workflows and both configured adapters on compatible inputs.
- [ ] Exercise deployment rollback and a complete private-storage backup/restore procedure.
- [ ] Settle the operating limits for cancellation, incomplete uploads, retention and user access; describe remaining limits accurately.
- [ ] Publish reliability claims only with reviewed repeated live evidence and explicit coverage/cost assumptions.
