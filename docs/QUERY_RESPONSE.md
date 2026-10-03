# Query and response architecture

Solaris queries are authenticated HTTP reads and writes against saved evaluation evidence and workspace metadata. Model requests occur inside evaluation workers during live trials; the workspace does not implement a retrieval-augmented chat or natural-language database layer. These diagrams describe the shipped REST request/response paths and their failure contracts.

The [overall architecture](ARCHITECTURE.md) shows deployment boundaries. [Integration setup](INTEGRATIONS.md) lists machine API paths and credential scopes.

## Authentication and saved-evidence reads

```mermaid
sequenceDiagram
    actor Client as Browser or API client
    participant Route as Next.js route
    participant Auth as Request guard
    participant Service as Evidence module
    participant Store as Private storage adapter
    participant Blob as Vercel Blob
    Client->>Route: GET run detail or trial
    Route->>Auth: Check canonical host and authentication
    alt Owner browser
        Auth->>Auth: Verify signed owner session
    else Automation API
        Auth->>Store: Read token metadata
        Store->>Blob: Read private credential document
        Blob-->>Store: Bytes and ETag
        Store-->>Auth: Validated document
        Auth->>Auth: Verify token hash, expiry, revocation and scope
    end
    Auth-->>Route: Authorized identity
    Route->>Service: Validated run or trial identifier
    Service->>Store: Read captured artifact index
    Store->>Blob: Private read
    Blob-->>Store: Index bytes and ETag
    Store-->>Service: Index snapshot
    Service->>Store: Read required immutable evidence
    Store->>Blob: Read content-addressed object
    Blob-->>Store: Original bytes
    Store-->>Service: Bounded bytes
    Service->>Service: Check digest, parse manifest and derive response
    Service-->>Route: Run or trial data and warnings
    Route-->>Client: 200 JSON, Cache-Control no-store
```

Owner sessions are 12-hour signed, `HttpOnly`, secure, same-site cookies created by `/api/session`. Owner writes also require the configured origin and JSON content type. Machine routes use a separate bearer token and verify its scope on each request; an owner cookie is not an automation credential. Invalid credentials return 401, disallowed origin or scope returns 403, and authorization completes before evidence reads.

Run detail parses checksum-verified manifest bytes directly in memory and validates task/trial identities. Trial detail captures one index and uses it for the manifest, action frames and available screenshot names. This prevents an index revision from being mixed in halfway through the same trial response. Screenshots are fetched separately through the authenticated artifact route. A missing or unreadable action log produces a warning while preserving the saved trial result. A failed checksum never produces a valid artifact response. Local requests use the same domain parsing after loopback and safe-file checks.

Sources: [owner auth](../web/lib/cloud-auth.ts), [automation auth](../web/lib/automation-auth.ts), [run routes](../web/app/api/runs/), [cloud artifacts](../web/lib/cloud-artifacts.ts), [local store](../web/lib/store.ts).

## Paged library queries

```mermaid
flowchart TD
    Request["Authorized GET runs<br/>limit and optional cursor"] --> Page["One Blob index page<br/>Default 50, maximum 200 entries"]
    Page --> Index["Read each index<br/>At most eight in parallel"]
    Index --> Check{"Valid summary bound<br/>to this manifest digest?"}
    Check -->|"Yes"| Summary["Use derived run card<br/>No manifest-body read"]
    Check -->|"No"| Manifest["Read and checksum manifest<br/>Parse and derive run card"]
    Manifest -->|"Unavailable or invalid"| Warning["Append run warning<br/>Continue other entries"]
    Summary --> Response["Runs, warnings and nextCursor<br/>Sort returned records by creation time"]
    Manifest -->|"Valid"| Response
    Warning --> Response
    Response --> Merge["UI merges by run ID<br/>Sorts loaded set; Load more continues"]
```

The owner and machine library endpoints share the cloud contract:

```text
GET /api/runs?limit=50
GET /api/automation/v1/runs?limit=50&cursor=<URL-encoded continuation>
```

The response remains `{ runs, warnings, source, scannedAt }` and adds `page: { nextCursor, limit, scanned }` for a cloud page. `nextCursor: null` means that provider listing reached its end. `scanned` counts index entries examined on that page, not successfully parsed runs or total workspace runs. A page can contain fewer usable runs than the requested limit because of missing or corrupt entries. Continue based on `nextCursor`, not array length. Duplicate parameters, invalid limits and malformed cursors return 400.

Treat the cursor as an opaque continuation value and URL-encode it when constructing the next request. It is not an authentication credential or a saved snapshot. New writes during traversal can change what the provider listing sees. The UI deduplicates run IDs across pages, retains previously loaded evidence when a page fails and restarts at page one on refresh. An API consumer should likewise deduplicate if it needs a combined list.

Provider order is not guaranteed chronological. Returned and loaded records are sorted locally, but the first page is not a promise to contain the globally newest evaluations. Library search, insights and project run-assignment choices apply to loaded records; the UI states when more pages are available. Local mode retains its bounded filesystem scan and does not expose a cloud continuation cursor.

The browser’s optional WebMCP `list_evaluations` tool also accepts `limit`/`cursor` and returns page metadata. `start_evaluation_inspection` verifies a requested run directly by ID rather than requiring it to appear on the first page.

The optional summary is published in the same index update as `results.json` and must match the current manifest SHA-256, run ID and validated card schema. Older runs and malformed summaries fall back to the full checksum-verified manifest without a read-time migration. The fast path is derived metadata, not a fresh body-integrity check. Gates, exports and detailed evidence reads continue checking the actual objects they consume.

At the storage boundary, simultaneous immutable artifact reads with the same key and read limit may share a pending request within one server instance. The adapter drops that request on completion or error and returns separate buffers. JSON metadata, index revisions and credential checks always perform fresh reads; there is no cross-request TTL cache.

Sources: [query validation](../web/lib/library-query.ts), [summary validation](../web/lib/cloud-run-summary.ts), [paged artifact listing](../web/lib/cloud-artifacts.ts), [storage page contract](../web/lib/cloud-storage.ts), [client loading](../web/components/workspace.tsx).

## Launch, poll and worker callback

```mermaid
sequenceDiagram
    actor Client as Browser or automation client
    participant API as Jobs API
    participant Admission as Admission and job modules
    participant Blob as Private Blob store
    participant Worker as Python execution sandbox
    participant Ingest as Callback API
    Client->>API: POST setup, mode and Idempotency-Key
    API->>API: Authenticate, validate setup and permission
    API->>Admission: Start logical evaluation
    Admission->>Blob: Read deterministic job identity
    alt Existing matching job
        Blob-->>Admission: Durable job
        Admission-->>API: Existing job, no new execution
    else New logical evaluation
        Admission->>Blob: CAS reserve capacity
        Admission->>Blob: Create-if-absent job with plan and callback token
        Admission->>Worker: Create from pinned Git source and launch once
        Worker-->>Admission: Worker and command identifiers
        Admission->>Blob: CAS save launch state
        Admission-->>API: Public durable job
    end
    API-->>Client: 202 job receipt
    par Execution and evidence upload
        Worker->>Worker: Run Python harness and preserve evidence
        loop Changed allowed artifacts
            Worker->>Ingest: Per-job token, artifact path and bytes
            Ingest->>Blob: Validate job, plan and callback window
            Ingest->>Blob: Create content object and CAS update index
            Ingest-->>Worker: Upload acknowledgment
        end
        Worker->>Ingest: Completion, exit code and cancellation state
        Ingest->>Blob: Verify readable manifest and save terminal job
        Ingest-->>Worker: Completion acknowledgment
    and Client polling
        loop Until terminal job state
            Client->>API: GET job status
            API->>Blob: Read durable job
            API-->>Client: Public state and error if present
        end
    end
    Client->>API: Read saved run or submit quality gate
```

The initial 202 acknowledges a durable job, not task success. A repeated key with the same plan returns that job; a different plan with the same key returns 409. Automation keys are namespaced to their credential. A full admission ledger returns 429 before job creation. The browser retains pending keys across reloads in its session, and the GitHub client reuses the workflow run's key on retries.

Only the create-if-absent job winner may provision the worker. Allocation and launch uncertainty are recorded instead of automatically replaying execution. Callback credentials authorize only that job's ingestion and control checks, never workspace reads. Artifact names, task membership, trial bounds, upload size and manifest plan are checked before publication. Upload retry does not rerun the evaluation. A terminal job refuses further artifact writes, and expired callbacks fail explicitly.

Cooperative cancellation is a separate owner request: `POST /api/jobs/{id}/cancel` records intent; the worker polls control, interrupts the harness once and allows bounded finalization. It can preserve partial results and lifecycle records. `cancelled` means execution acknowledged the request, not that external desktop deletion was verified.

Sources: [jobs route](../web/app/api/jobs/route.ts), [automation launch](../web/app/api/automation/v1/jobs/route.ts), [admission](../web/lib/cloud-admission.ts), [runner](../web/lib/cloud-runner.ts), [callback validation](../web/lib/cloud-ingest.ts), [Python worker](../gauntlet/cloud_worker.py), [CI client](../scripts/solaris-ci.mjs).

## Current jobs and paged history

```mermaid
flowchart TD
    UI["Browser or read-scoped automation client"] --> Auth["Authenticate request"]
    Auth -->|"view=reserved"| Ledger["Read validated admission reservations"]
    Auth -->|"limit and optional cursor"| Page["List one jobs provider page"]
    Ledger --> Current["Read reserved job IDs<br/>At most eight concurrent reads"]
    Page --> History["Read page job IDs<br/>Isolate unavailable records"]
    Current --> Tracking["Jobs, warnings and tracking-known flag<br/>No free-capacity claim"]
    History --> Archive["Jobs, warnings and next cursor<br/>Provider order, locally sorted results"]
    Tracking --> Merge["Browser retains freshest observations<br/>Keeps actionable jobs first"]
    Archive --> Merge
    Merge -->|"Previously active ID no longer tracked"| Direct["GET job by ID<br/>Retain last state if unavailable"]
    Direct --> Merge
```

Owner `/api/jobs` and machine `/api/automation/v1/jobs` support history pages (default 50, limit 1–200) and a separate `?view=reserved` query. The reserved view does not accept a limit/cursor. `reservations.known: false` means current execution tracking could not be established; loaded history cannot establish idle state. Completed reservations may remain until the next admission. Reservation count is neither running count nor free capacity.

Current status polling is independent of history pagination: 10 seconds while active/uncertain, 60 seconds when tracking establishes idle, with hidden-tab pause. Previously observed active jobs that disappear from reservations are reread directly. Errors retain previous observations and never imply success or stopped resources. History loads 25 entries at a time in the browser; refresh restarts its cursor. Failed or superseded page requests cannot replace the retained history. All actionable jobs remain visible ahead of a progressively revealed history; the control states how many loaded jobs remain.

These reads do not initialize/prune admission state, allocate a sandbox or query provider inventory. Existing job-expiry reconciliation can persist an `interrupted` state; it does not prove worker or desktop cleanup. Normal admission continues to enforce capacity using the independent conditional ledger.

Sources: [job listing](../web/lib/cloud-job-list.ts), [reservation read](../web/lib/cloud-admission.ts), [job query](../web/lib/job-query.ts), [browser reconciliation](../web/lib/job-pagination.ts), [UI](../web/components/cloud-jobs.tsx).

## Conditional workspace writes

```mermaid
sequenceDiagram
    actor Owner as Agency owner
    participant API as Projects or review API
    participant Domain as Workspace module
    participant Blob as Private Blob store
    Owner->>API: Save draft with expected revision
    API->>API: Verify session, origin, content type and body
    API->>Domain: Validated edit
    Domain->>Blob: Read document and ETag together
    Blob-->>Domain: Saved content plus storage revision
    Domain->>Domain: Validate schema and expected record revision
    Domain->>Domain: Check referenced evidence and construct next document
    Domain->>Blob: Conditional write using captured ETag
    alt No competing write
        Blob-->>Domain: New ETag
        Domain-->>API: Saved record with incremented revision
        API-->>Owner: 200 saved record
    else Document changed
        Blob-->>Domain: Precondition conflict
        Domain-->>API: Conflict, no overwrite
        API-->>Owner: 409, reload before saving draft
    end
```

The record revision catches an old editor draft; the Blob ETag catches a race after the read. Both matter because multiple project or review records can share one document. User edits are not blindly retried against newer content. Internal job/index operations may reread and apply bounded retries to an intentional update function; that policy does not make user edits last-write-wins.

A client project validates only newly assigned run references, in bounded parallel batches. Existing references survive a temporary evidence outage and can be removed without rewriting evidence. Manual `active`, `review`, `delivered` and `archived` states and delivery notes belong to project metadata; they never change run results or gate verdicts. Missing fields in older records receive backward-compatible defaults.

Reviews bind to the preserved trial evidence and retain revision history. Cloud review/preset/attempt operations reconstruct an ephemeral local project to reuse the same validation and update rules, then commit the resulting metadata document conditionally. The temporary files are removed after the operation. Corrupt saved documents cause an error before a write; an empty workspace is used only when the document is absent.

Sources: [client projects](../web/lib/client-projects.ts), [cloud workspace adapter](../web/lib/cloud-workspace-data.ts), [local workspace rules](../web/lib/workspace-data.ts), [storage conditional writes](../web/lib/cloud-storage.ts).

## Authoritative gate and comparison response

```mermaid
sequenceDiagram
    actor Client as Owner or CI client
    participant API as Gate or comparison API
    participant Evidence as Evidence module
    participant Worker as Isolated assessment sandbox
    participant Python as Python assessment rules
    Client->>API: Run identity, policy and optional baseline
    API->>API: Authenticate and validate policy
    API->>Evidence: Capture required manifests and verifier evidence
    Evidence-->>API: Checksum-verified bounded inputs
    API->>Worker: Create pinned-source worker without model credentials
    API->>Worker: Write evidence and policy as data
    API->>Worker: Run gauntlet gate or compare with JSON output
    Worker->>Python: Audit, recompute metrics and evaluate checks
    Python-->>Worker: Verdict or comparison, warnings and exit status
    Worker-->>API: Bounded command output
    API->>API: Validate schema and verdict against exit code
    API->>Worker: Stop worker in finalization
    API-->>Client: 200 structured result, passed true or false
```

A failed policy is an ordinary, valid response with `passed: false`; HTTP success means the assessment completed. The Python gate exits 0 for pass and 1 for failure, and the server rejects any mismatch between that exit status and the JSON verdict. Invalid or incompatible saved evidence returns an error, not a fabricated verdict. Local mode executes the same Python commands in the checkout instead of allocating a cloud sandbox.

Assessment consumes manifests, task snapshots, final records and lifecycle evidence. Screenshots and full action logs are not uploaded to the assessment sandbox because those files are not inputs to the implemented audit/comparison rules. Required inputs are validated before allocation; a baseline is required when a regression limit is set. Missing cost or coverage cannot become a passing strict gate by omission. This is deterministic policy evaluation, not an LLM-generated assessment.

A cloud assessment may incur sandbox usage even when invoked through a GET comparison endpoint. It has bounded install, command, output and cleanup time. The UI and CI do not automatically replay a gate after an ambiguous transport failure. If provider stop is not acknowledged, the successful result includes a cleanup warning and the worker's configured lifetime still applies.

Sources: [cloud assessment](../web/lib/cloud-assessment.ts), [local bridge and schemas](../web/lib/assessment.ts), [Python assessment](../gauntlet/harness/assessment.py).

## Evidence download response

`GET /api/runs/{id}/bundle` authenticates the owner, captures an artifact/annotation snapshot and rejects active runs. It reads every captured file, verifies size and digest, then takes a second snapshot to detect changed evidence or run-specific metadata before opening a gzip stream. The response contains original evidence, scoped review/attempt history, safe provenance, a factual handoff summary and independently verifiable checksums.

The response is streamed without a `Content-Length`; the browser offers a file only after a complete successful response. Missing, corrupt, changing or oversize evidence fails the whole export. A completed archive is not a release approval. See [the bundle contract](EVIDENCE_BUNDLES.md) and [implementation](../web/lib/evidence-export.ts).

## Project handoff response

```mermaid
sequenceDiagram
    actor Owner
    participant API as Project handoff route
    participant Projects as Project metadata
    participant Evidence as Manifest reader
    participant Blob as Private storage
    Owner->>API: GET project ID, saved revision, format
    API->>API: Authenticate and validate query
    API->>Projects: Read project and require matching revision
    loop Assigned IDs in batches of six
        API->>Evidence: Capture saved manifest by ID
        Evidence->>Blob: Read index and manifest object
        Evidence->>Evidence: Validate size, SHA-256 and manifest
        Evidence->>Blob: Reread manifest pointer
        Evidence-->>API: Captured summary and digest, or unavailable
    end
    API->>Projects: Recheck project revision
    alt Project changed
        API-->>Owner: 409 before download
    else Same project revision
        API-->>Owner: Markdown or JSON attachment with explicit gaps
    end
```

All assigned IDs are included regardless of loaded library pages. Each manifest is independently captured; a project-wide atomic evidence snapshot is not claimed. Unavailable/changing evidence becomes an explicit unavailable entry, while a changed project revision fails the whole download. Fields are whitelisted: private notes, prompts, screenshots, review text, credentials and raw provider exceptions do not enter this summary. The export does not run a gate, aggregate unlike success rates, write storage or start workers. See [handoff contract](PROJECT_HANDOFF_EXPORTS.md).

## Shared error contract

JSON API errors use `{ "error": "user-readable message" }` with `Cache-Control: no-store`; raw SDK errors and credentials are not relayed. Callers must inspect both HTTP status and operation-specific fields such as `job.status`, `passed`, coverage and warnings.

| HTTP status | Meaning in these flows | Caller action |
| --- | --- | --- |
| 400 / 415 | Invalid identifiers, setup, policy, body or content type | Correct the request |
| 401 / 403 | Missing/expired credential, insufficient scope or origin rejection | Reauthenticate or correct credential/origin |
| 404 | Job, run or specific saved artifact unavailable | Inspect job status and available evidence |
| 409 | Edit conflict, mismatched idempotency plan, active/changing export | Reload the relevant state; retain the intended draft/key |
| 410 | Expired worker upload window | Inspect retained job/evidence; do not replay a paid run automatically |
| 413 | Explicit request, evidence or storage bound exceeded | Reduce scope or use storage-level archival |
| 422 | Assessment cannot use the preserved evidence or baseline | Inspect evidence and compatibility |
| 429 | Evaluation admission full | Retry the same logical launch key after capacity is available |
| 503 | Storage, worker, configuration or integrity cannot be verified | Preserve evidence; investigate before a new execution |

The generic failure handler returns 500 for unexpected errors. A single unavailable run should produce a listing warning while other readable runs remain usable. The browser JSON helper rejects unreadable bodies even with HTTP 200, preserves cancellation causes, and never automatically retries an ambiguous write. Bounded response handling and explicit partial-state reporting avoid apparently complete results when data could not be verified.
