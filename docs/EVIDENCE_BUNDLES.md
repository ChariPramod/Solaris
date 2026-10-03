# Portable evaluation evidence

Open an evaluation and select **Download evidence bundle**. The authenticated `GET /api/runs/:id/bundle` endpoint creates a `.tar.gz` archive for one run in both cloud and local workspaces. The existing manifest-only download remains available.

This supports client handoff and independent inspection. It is not whole-workspace backup or an automatic restore feature.

## Format version 1

- `HANDOFF.md`: facts from the captured manifest, including planned/recorded trials, task-level pass and failure counts, incomplete work, diagnostic versus live mode, and review count. This is not a release approval or proof of remote cleanup.
- `evidence/`: every artifact in the captured cloud index, including the original `results.json`, task and `baseline.json` snapshots, individual results, action and lifecycle logs, screenshots, and saved audit when present. Local exports include the same allowed artifact paths. Files retain their original bytes. Older cloud runs may lack baseline snapshots because earlier workers did not upload them; export cannot reconstruct those missing originals.
- `workspace/review-<sha256>.json`: all saved review histories belonging to this run. Evidence digests and revision histories remain intact, including reviews that may have become stale.
- `workspace/attempts.json`: direct parent/child links involving this run. Other run evidence is not included; missing related runs are not manufactured.
- `provenance.json`: cloud job identity, execution mode, terminal status, source revision, timestamps and exit code when available. Local runs and cloud runs without a corresponding job omit this document.
- `inventory.json`: `format: "solaris-evidence"`, `version: 1`, run ID, export timestamp, snapshot digest, storage source, saved run status, trial coverage and a list of payload paths, byte counts and SHA-256 hashes.
- `checksums.sha256`: checksums for every payload and `inventory.json`. It does not checksum itself. The inventory excludes itself and this checksum file to avoid circular hashes.

Application credentials, job callback tokens, provider session identifiers, environment files, unrelated reviews and workspace presets are excluded. Original evidence and human notes are not automatically redacted; inspect screenshots, prompts and notes before sharing them with a client.

## Verify a download

Extract into a new directory, then verify every checksum:

```sh
mkdir extracted
tar -xzf RUN-evidence.tar.gz -C extracted
cd extracted
shasum -a 256 -c checksums.sha256
```

On Linux, `sha256sum -c checksums.sha256` is equivalent. The saved files under `evidence/` preserve the normal run directory layout. The download never changes existing run evidence or annotations, restarts a job, or restores into a workspace.

## Consistency and limits

All indexed bytes are fetched and checked against their stored sizes and SHA-256 hashes before an HTTP archive response is created. Local files are checked for symlinks, special files, read-time changes, and file identity/timestamp changes. A final snapshot check detects artifact additions, replacements and run-specific review or attempt edits. Cloud run parsing uses the exact captured manifest object, not a later index revision.

Active cloud jobs and local manifests still marked `running` return HTTP 409. Terminal cloud jobs with partial evidence can be exported and retain their actual incomplete status. Missing or corrupt indexed objects fail the whole export; no files are silently dropped. Metadata or evidence edits during collection return HTTP 409 and require retrying.

The export allows up to 5,000 evidence files and 64 MiB of combined evidence and run annotation bytes, with a 16 MiB per-file limit. Generated inventory, handoff and checksum files add a small amount of overhead. Existing cloud ingestion limits still apply. Oversized exports return HTTP 413 and require storage-level archival; they are not truncated. Expected-but-never-saved evidence cannot be reconstructed by export; use the run audit to assess completeness.

The archive is a real Node/Web stream without a `Content-Length` header. This follows [Vercel's documented streaming approach](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions) to avoid its buffered 4.5 MB response limit. The browser waits for a complete successful response before offering the file; a transport interruption produces an error rather than a success message. The endpoint permits up to 300 seconds, subject to the deployment's function-duration allowance.

Tests extract archives with the system tar reader, independently verify all hashes, include an incompressible archive larger than 4.5 MiB, and cover corrupt/missing objects, active jobs, concurrent edits, path safety, limits, local symlinks and authentication.
