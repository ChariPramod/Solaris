# Agency product increment

This iteration targets agencies delivering computer-use AI automations. It adds practical delivery tooling around the existing evaluation harness. It does not add a native integration marketplace, payment processing, client accounts or arbitrary custom-workflow execution.

## What is implemented

- **Client projects:** Create a named project/client, assign real saved evaluations, open their evidence, and update assignments with conflict protection. Project drafts survive refresh conflicts. Up to 100 projects and 200 references per project.
- **Workflow templates:** Four shipped task bundles for smoke checks, repeated reliability, office workflows and safety. Review before launch; no task outcomes are prefilled.
- **Insights:** Separate live and diagnostic results; filter by model; inspect coverage, failures, incomplete runs and known-cost coverage. These are loaded-library aggregates, not a provider billing ledger or proof of commercial readiness.
- **Evidence bundles:** Streamed tar.gz archives up to 64 MiB with all indexed evidence, screenshots, logs, checksums, review histories, direct attempt context and a handoff summary. Active/changing/corrupt exports fail explicitly. Whole-workspace restore is not implemented.
- **Automation API:** Scoped expiring credentials, one-time secret display, hashed storage and revocation. Launch/poll/read/compare/gate endpoints for GitHub Actions, n8n, Zapier and HTTP clients. Separate live-execution permission.
- **CI runner:** Dependency-free Node client and manual GitHub workflow; stable retry identity, no automatic paid replay, actual gate verdict propagated as process exit code.
- **Admission controls:** Atomic workspace evaluation capacity (default two), durable duplicate-request protection, fail-closed handling of ambiguous workers and safe retries after capacity rejection. Browser pending launch identity survives dialog closure and same-tab reload.

## What the owner still needs before a paid client engagement

1. Privately configure Solari and one model provider. Validate the real live path and resource cleanup on a small scope. Diagnostic checks do not establish model reliability.
2. Use a separate deployment/storage/owner credential for each client requiring data isolation. Projects and integration keys belong to a single owner workspace; there is no tenant permission system.
3. Set an explicit evaluation scope and provider budget. Concurrency limits do not impose a monetary cap; assessments also consume cloud resources.
4. Configure each client's chosen integration account. GitHub uses a repository secret; n8n/Zapier use their credential stores. They are not magically connected by the product's setup cards.
5. Review the evidence bundle before delivering it. Screenshots, prompts and review notes can contain client data.
6. Keep the offering within implemented computer-use tasks. The 12 shipped fixture tasks and two adapters do not validate every kind of client automation. Custom task/workflow authoring, actual model performance, full restore, billing and client account management remain future work.

The next useful engineering increment is custom evaluation task authoring with validated fixtures/verifiers, plus live provider acceptance. Full cloud restore and resource reconciliation after hard worker loss remain operational priorities. Current records are preserved during outages; missing evidence is not replaced with invented successful results.

## Validation

Local release checks passed: 426 Python tests, 173 TypeScript tests, lint/format, typecheck, optimized build, existing production HTTP integration and evidence export HTTP integration (6,296,251 bytes streamed and checksum-verified). Current production acceptance is pending deployment. The manual `web/scripts/agency-smoke.ts` check creates a diagnostic job and client project, verifies stable retry identity, scope enforcement, the actual Python gate, persistent project revisions and extracted bundle checksums, then revokes its temporary API keys.
