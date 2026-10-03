# Connect agency delivery tools to Solaris

Solaris provides a versioned cloud API for starting evaluations, polling durable jobs, reading evidence, comparing runs and enforcing quality gates. GitHub Actions has a dependency-free Node runner; n8n and Zapier use their authenticated HTTP request actions. These are API integrations, not native marketplace installations. External account configuration is required; a card in Solaris does not mean an external account is connected.

## Create a scoped key

In the signed-in cloud workspace, open **Integrations → API credentials**. Create a named key and copy it once into the destination tool's credential store. Solaris persists its SHA-256 hash, prefix, scopes and expiry, never the raw secret. Keys expire after 1–90 days and can be revoked. Owner sign-in keys and integration keys are separate.

| Scope | Permission |
| --- | --- |
| `read` | Read the saved run library, run manifests and job states |
| `execute` | Start diagnostic evaluations |
| `live:execute` | Additionally permits live launch; requires `execute` and configured provider keys |
| `assess` | Run authoritative Python comparisons and release gates |

A typical diagnostic CI key needs `read`, `execute`, `assess`. Live execution must be deliberately granted. Executions and assessments can incur Vercel usage; these permissions are not spending caps. Keys cover the owner's whole workspace. Client projects organize records; they do not enforce client data isolation. Deploy separate workspaces for clients requiring isolation. Never paste tokens into repository files or query parameters.

## API contract

Use the configured HTTPS origin, for example `https://solaris-gauntlet.vercel.app`. Supply `Authorization: Bearer <scoped-token>`. JSON writes also require `Content-Type: application/json`. Browser owner cookies do not authenticate the automation API. Redirects should not be followed when sending credentials.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/automation/v1/runs` | Loaded run library, warnings and listing limits |
| POST | `/api/automation/v1/jobs` | Durable job; HTTP 202 does not mean tasks passed |
| GET | `/api/automation/v1/jobs/{id}` | Current job state, no callback credential |
| GET | `/api/automation/v1/runs/{id}` | Saved manifest and trial records |
| POST | `/api/automation/v1/runs/{id}/gate` | Actual policy verdict, checks and warnings |
| GET | `/api/automation/v1/compare?candidate={id}&baseline={id}` | Comparison of compatible preserved evidence |

Job request:

```json
{
  "mode": "dry-run",
  "setup": {
    "tasks": ["T01", "T02"],
    "trials": 1,
    "concurrency": 1,
    "maxInfraFailures": 1,
    "provider": "claude",
    "modelId": ""
  }
}
```

Job creation requires an `Idempotency-Key`: 16–128 letters, numbers, dots, colons, underscores or hyphens. Keep it stable for a logical evaluation, including retries after lost responses. The same key and plan returns the same job; a different plan with that key returns 409. Keys are namespaced to the integration credential. A new intentional experiment needs a new key. Rotating the integration credential changes that namespace; inspect outstanding jobs before retrying with a replacement credential.

The workspace permits two concurrent evaluations by default (`GAUNTLET_MAX_ACTIVE_JOBS`, integer 1–8). A 429 capacity rejection creates no job and consumes no key; retry the same key after capacity becomes available. A durable job is never automatically re-executed. Unconfirmed workers retain capacity until the provider confirms they stopped. Assessment workers are separately bounded and are not included in this evaluation-job cap. Expiry is not proof of remote desktop cleanup.

Poll jobs until `complete`, `failed`, `cancelled`, or `interrupted`. A completed diagnostic intentionally contains static-agent task failures. Do not translate `complete` into a client approval. Fetch the evidence and evaluate the gate. Infrastructure, unknown costs and missing trial coverage remain explicit. Gate POST requests may allocate assessment workers; the client does not automatically replay them after transport failures.

## GitHub Actions

The repository includes [.github/workflows/solaris-cloud.yml](../.github/workflows/solaris-cloud.yml), manually dispatched only, and [scripts/solaris-ci.mjs](../scripts/solaris-ci.mjs). It runs a credential-free model diagnostic in the real cloud harness and applies an explicitly diagnostic policy. No automatic schedule or pull-request live spending is enabled.

1. Store the scoped integration key as the repository secret `SOLARIS_API_TOKEN`.
2. Copy the workflow and runner into the target repository; set `SOLARIS_URL` to the client's deployment.
3. Dispatch the workflow. The console retains the job ID and prints the actual gate result.
4. For live validation, configure provider keys in the Solaris server, grant `live:execute`, set `SOLARIS_MODE=live`, select a model if needed, and use a strict live policy. The default runner policy requires live evidence and full pass rate.

The workflow's idempotency key uses repository ID plus workflow run ID. Re-running that workflow run inspects/reuses the same evaluation; a fresh dispatch creates a new experiment. Exit 0 means the configured gate passed, exit 1 means it failed, and exit 2 means setup/execution/transport validation did not finish. A passing diagnostic gate is not live performance evidence.

Optional runner environment: `SOLARIS_TASKS` (comma-separated T01–T12), `SOLARIS_TRIALS` (1–3), `SOLARIS_PROVIDER` (`claude` or `openai`), `SOLARIS_MODEL`, `SOLARIS_BASELINE`, `SOLARIS_GATE_POLICY` (JSON), and `SOLARIS_IDEMPOTENCY_KEY`. Do not put untrusted pull-request text into shell commands. See [GitHub's secrets guide](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) for repository configuration.

## n8n

Use an HTTP Request node with **Generic Credential Type → Header Auth**. Store the header name `Authorization` and value `Bearer <token>` in an n8n credential. Set POST URL to the jobs endpoint, JSON body to the example, and add a stable event-derived `Idempotency-Key`. Persist the returned job ID, use a Wait/poll loop to read its job endpoint, and only evaluate the gate after completion. Route failed/interrupted/cancelled outcomes to a review path; do not create a replacement job automatically.

This uses n8n's supported [HTTP Request credential](https://docs.n8n.io/integrations/builtin/credentials/httprequest/). No n8n account credentials are stored by Solaris. Workflow import and a live n8n account connection have not been automatically performed.

## Zapier

Use **API by Zapier → API Request** with an API-key connection that supplies `Authorization: Bearer <token>`. POST the jobs endpoint with the example JSON and a stable logical delivery ID in `Idempotency-Key`. Save the response job ID and poll it in subsequent steps before applying a gate. Do not equate a successful POST action with a successful agent task. Availability depends on the user's Zapier plan and workflow design.

Zapier documents secure connection-based authentication in its [API Request guide](https://help.zapier.com/hc/en-us/articles/44391650357005-Send-API-requests-in-Zap-workflows). Configure credentials in that connection rather than a plain-text custom header shared with editors. No Zapier account connection or outbound client message is created by Solaris automatically.

## Evidence handoff

Open an evaluation and select **Download evidence bundle**. The portable archive contains all saved indexed artifacts, checksums, scoped review histories, attempt context and a facts-only handoff summary. [Bundle format and limitations](EVIDENCE_BUNDLES.md) explain partial runs, size limits and verification. Delivery to clients is a separate deliberate action; Solaris does not automatically email or post private evidence.
