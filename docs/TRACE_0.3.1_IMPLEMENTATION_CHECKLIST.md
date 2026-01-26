# 0.3.1 Trace / Run Events – Implementation Checklist

Goal: Add a robust, future-proof run trace system as an append-only event stream. Implement as a `run_events` table (preferred) and adapt existing run persistence & APIs to use it.

Non-goals (for 0.3.1 unless explicitly added):
- Full OpenTelemetry compatibility
- Distributed tracing across multiple servers
- Long-term storage / blob store (can be stubbed with truncation + references)

---

## 0) Pre-flight
- [ ] Confirm branch is `0.3.1`.
- [ ] Ensure `backend` tests currently pass (`npm run test:coverage` in `backend`).
- [ ] Capture current DB schema for `runs` and any existing event/log mechanism.

## 1) Define the Trace Event Contract (do this before coding)
- [ ] Define event envelope fields:
  - [ ] `run_id`
  - [ ] `type` (string)
  - [ ] `created_at` (ISO or DB timestamp)
  - [ ] `payload` (JSON)
  - [ ] `correlation_id` (string/uuid) for pairing request/response etc.
  - [ ] `source` (optional): `jobRunner`, `agent`, `server`, `ui`, etc.
  - [ ] `level` (optional): `info|warn|error`
- [ ] Decide ordering strategy:
  - [ ] Prefer ordering by `(id)` (autoincrement) and secondarily `created_at`.
- [ ] Define MVP event types:
  - [ ] `llm_request`
  - [ ] `llm_response`
  - [ ] `tool_call`
  - [ ] `tool_result`
  - [ ] `patch_proposed`
  - [ ] `patch_applied`
  - [ ] `test_started`
  - [ ] `test_result`
  - [ ] `note`
  - [ ] Add `error/exception` type (recommended)

## 2) Data Model: Add `run_events` Table
- [ ] Add new table (SQLite) `run_events` with columns:
  - [ ] `id INTEGER PRIMARY KEY AUTOINCREMENT`
  - [ ] `run_id TEXT NOT NULL`
  - [ ] `type TEXT NOT NULL`
  - [ ] `created_at TEXT NOT NULL`
  - [ ] `correlation_id TEXT`
  - [ ] `source TEXT`
  - [ ] `level TEXT`
  - [ ] `payload_json TEXT NOT NULL` (stringified JSON)
- [ ] Add indexes:
  - [ ] `(run_id, id)`
  - [ ] `(run_id, type, id)`
  - [ ] `(correlation_id)` (optional)
- [ ] Migration strategy:
  - [ ] Add table creation in DB init path with `CREATE TABLE IF NOT EXISTS`.
  - [ ] (Optional) If legacy events exist on `runs`, decide whether to backfill.

## 3) Update Persistence Layer (`runStore`)
- [ ] Add API to append an event: `appendRunEvent(runId, event)`
  - [ ] Validate required fields.
  - [ ] Auto-fill `created_at` if missing.
  - [ ] Ensure `payload_json` is always valid JSON.
  - [ ] Enforce payload size limits (truncate large strings; store previews).
  - [ ] Redact obvious secrets (API keys, tokens) before persisting.
- [ ] Add API to list events: `listRunEvents(runId, { afterId, limit, types })`
  - [ ] Default `limit` and max cap.
  - [ ] Stable ordering by `id`.
- [ ] Ensure existing code paths that call `appendRunEvent` keep working.

## 4) API Surface
- [ ] Add (or extend) route to fetch run events:
  - [ ] `GET /api/runs/:runId/events?afterId=&limit=&types=`
  - [ ] Return `{ events, nextAfterId }`.
- [ ] Ensure existing run endpoints still return run metadata without huge traces.
- [ ] Decide whether to include a small summary (`latest_event_at`, counts) in runs list.

## 5) Instrumentation Points (where events are emitted)
- [ ] LLM client / request pipeline:
  - [ ] Emit `llm_request` (sanitized prompt metadata + model/provider settings)
  - [ ] Emit `llm_response` (token counts + truncated text)
- [ ] Tool execution pipeline:
  - [ ] Emit `tool_call` (name + args)
  - [ ] Emit `tool_result` (success/failure + truncated result)
- [ ] Patch flow:
  - [ ] Emit `patch_proposed` (files touched + diff stats + preview)
  - [ ] Emit `patch_applied` (success/failure)
- [ ] Test runner / coverage:
  - [ ] Emit `test_started`
  - [ ] Emit `test_result`
- [ ] Errors:
  - [ ] Emit `error` with normalized message + stack preview

## 6) Backward Compatibility / Safety
- [ ] Do not break existing run creation/updating.
- [ ] Event writes must be best-effort (never crash core flows on event persistence).
- [ ] Ensure all writes are safe if called with non-Error objects.

## 7) Testing + Coverage (keep 100%)
- [ ] Unit tests for `runStore`:
  - [ ] Appending event persists row
  - [ ] Listing events returns stable order
  - [ ] Filtering by `type`
  - [ ] Payload truncation/redaction behavior
- [ ] Route tests for `/runs/:id/events`.
- [ ] Add coverage tests for any best-effort `.catch(() => {})` branches.

## 8) Performance / Retention
- [ ] Decide initial limits:
  - [ ] max events per run (soft cap)
  - [ ] default pagination size (e.g. 100)
  - [ ] max payload size (e.g. 64KB/event)
- [ ] Add cleanup job or admin endpoint (optional for 0.3.1).

## 9) Docs
- [ ] Update docs to describe event types and API.
- [ ] Note redaction/truncation guarantees.

## 10) Versioning / Release prep
- [ ] Bump versions to `0.3.1`.
- [ ] Update `CHANGELOG.md` with trace feature.
- [ ] Push branch and open PR.
