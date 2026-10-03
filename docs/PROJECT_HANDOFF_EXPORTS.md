# Project handoff downloads

Client projects can export a readable Markdown handoff or structured JSON. Open **Client projects**, edit a saved project, choose a download format, and select **Download project handoff**. The download uses the saved project revision, even if the editor contains unsaved changes.

The handoff includes the client and project name, manually assigned delivery status, and a summary of every assigned evaluation. It resolves saved run IDs directly; a run does not have to appear in the browser's loaded library pages. Private project notes, review text, prompts, screenshots, callback credentials and integration tokens are excluded. The owner decides whether to share the downloaded file; Solaris sends no client message.

## What the summary establishes

Each readable manifest is checked against its stored byte count and SHA-256 digest. The manifest pointer is checked again after reading. Each summary records its capture time and digest, mode, model, saved status, planned and recorded trials, passed trials, infrastructure failures, cleanup errors and estimated model cost. Unknown costs or incomplete planned coverage produce an unknown total. Diagnostics remain explicitly separate from live evidence.

An unavailable or changing run appears as an unavailable entry with a fixed, sanitized reason. It is never omitted, treated as zero cost or counted as passing. A successful HTTP response may contain unavailable runs; inspect `unavailableRuns`, each run's `availability`, each unavailable run's `reason`, and the report's limitations. Empty projects are valid and say that no evaluations are assigned.

These are independently captured manifest summaries, not an atomic snapshot of all evidence. Collection does not run an audit or quality gate. Delivery status is manual and does not certify an approval. No success percentage is combined across different evaluations. Model cost estimates exclude desktop charges and provider billing reconciliation.

The report contains owner-authenticated relative paths to individual evidence bundles. Those paths belong to the original Solaris deployment and do not grant a client access. Later bundle downloads can reflect evidence changed since this report's manifest digest. Download and verify each bundle separately when the client needs the actual evidence. A handoff is neither an evidence archive nor a workspace backup.

## Owner API

```text
GET /api/projects/{project_id}/handoff?revision=4
GET /api/projects/{project_id}/handoff?revision=4&format=json
```

This endpoint uses the owner session and cloud origin checks. Automation credentials do not grant project access. `revision` is required; `format` is `markdown` (default) or `json`. Unknown or repeated parameters are rejected. An old revision or a project edited during collection returns 409 before a download starts. The export performs no storage writes.

JSON uses `format: "solaris-project-handoff"`, `version: 1`, an explicit scope and a whitelisted project record. It contains `assignedRuns`, `availableRuns`, `unavailableRuns` and the complete assigned `runs` array. Available entries include `manifestSha256`; unavailable entries use `missing`, `changed` or `unavailable`. The response also sets `X-Solaris-Project-Revision`, `X-Solaris-Unavailable-Runs`, `Cache-Control: no-store, no-transform`, and an attachment filename.

Project membership is bounded to 200 evaluations. Reads run in batches of six; the route has a 120-second bound and the browser cancels after 110 seconds. Switching saved project/revision or leaving the view aborts the browser request. A timeout or invalid response produces an error without downloading a partial file. Retry the same read after checking any reported conflict; no evaluation is restarted.

Sources: [collection and rendering](../web/lib/project-handoff.ts), [route](../web/app/api/projects/[id]/handoff/route.ts), [manifest snapshot](../web/lib/cloud-artifacts.ts), [download UI](../web/components/project-handoff.tsx), [evidence bundles](EVIDENCE_BUNDLES.md).
