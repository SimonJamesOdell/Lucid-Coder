# LucidCoder 0.3.x Roadmap (0.3.5–0.3.7)

Date created: 2026-01-27
Owner: Simon
Scope intent: **0.3.x is hardening + confidence** (tests, CI, reliability, diagnostics). **0.4.x is Preview Tab enhancements**, so avoid feature creep into preview UX beyond tiny stability fixes.

---

## Guiding principles

- Prefer **small, merged increments** over big-bang refactors.
- Every release should improve **confidence**: fewer regressions, faster triage, more deterministic behavior.
- Add only the minimum UX needed to support reliability (e.g., clearer errors), not new Preview functionality.

## Release cadence

- 0.3.5: expand E2E coverage + stability improvements
- 0.3.6: CI automation + release hygiene + flake-proofing
- 0.3.7: diagnostics/telemetry + performance guardrails

If time is tight, do 0.3.5 + 0.3.6 and treat 0.3.7 as optional.

---

## Baseline checks (run before cutting any release)

- `npm test`
- `npm run e2e`
- Ensure version bump + changelog + tag conventions are followed
- Confirm repo is clean: `git status`

---

## 0.3.5 — E2E critical journeys (primary) + stability

### Goals

- Catch the kinds of regressions that slip through unit/integration tests.
- Make E2E runs repeatable and low-flake.

### Deliverables

1) **E2E “critical journey” tests** (add 2–4 tests max)
- Journey A: open app → create new project → confirm it appears in list
- Journey B: import/select project → confirm navigation/state works
- Journey C: configure LLM via UI (or API bootstrap) → confirm health/ready state
- Journey D (optional): basic websocket/preview-proxy smoke (only if stable)

2) **Better readiness + assertions**
- Replace brittle text-only checks with role-based selectors where possible
- Add explicit backend readiness check(s) if required

3) **Test DB lifecycle**
- Keep using a dedicated E2E DB
- Ensure it is reset deterministically (already in global setup)

### Acceptance criteria

- `npm run e2e` passes locally twice in a row.
- At least **one** test covers “create/select project” end-to-end.
- Any added selectors are stable (no reliance on timing hacks beyond Playwright defaults).

### Notes / guardrails

- Keep each test under ~60s.
- Prefer API bootstrap (like `/api/llm/configure`) only where UI setup is too slow/flaky.

---

## 0.3.6 — CI + release hygiene + flake-proofing

### Goals

- Regressions get caught before merge.
- Releases are repeatable and low-effort.

### Deliverables

1) **GitHub Actions CI** (recommended)
- Jobs:
  - Install dependencies (with caching)
  - Run `npm test`
  - Install Playwright browser(s)
  - Run `npm run e2e`
- Artifacts on failure:
  - `playwright-report/`
  - `test-results/`

2) **Release checks**
- Add a simple `npm run release:check` script that validates:
  - `VERSION` matches root `package.json` version
  - `shared/version.mjs` matches
  - backend/frontend package versions match
  - changelog has an entry for the target version

3) **Flake-proofing improvements**
- Ensure ports are fixed and strict (already done for frontend; keep consistent)
- If backend startup sometimes races, add a slightly longer health timeout and/or retry logic in Playwright webServer (prefer config over sleeps)

### Acceptance criteria

- CI is green on a PR.
- If E2E fails, the report is uploaded and easy to read.
- `npm run release:check` fails fast with clear messaging when versions diverge.

---

## 0.3.7 — Diagnostics + performance guardrails (optional but high value)

### Goals

- When something breaks, you can diagnose it quickly.
- Prevent slow regressions from sneaking in.

### Deliverables

1) **Support bundle / diagnostics export**
- A server endpoint or CLI command that exports:
  - app version
  - environment info
  - recent run events
  - recent server logs (redacted)
  - basic DB stats (counts only)

2) **Structured logging improvements**
- Ensure API keys/secrets are never logged
- Add correlation IDs on key flows where helpful

3) **Performance sanity checks**
- Add a small “budget test” (unit/integration) for key endpoints:
  - `/api/health`
  - project list endpoint
- Keep thresholds generous and focused on catching “suddenly 10x slower”

### Acceptance criteria

- You can generate a diagnostics bundle in < 30 seconds.
- Secrets are redacted by default.
- A basic performance regression test exists and is stable.

---

## Tracking checklist

### 0.3.5 checklist
- [ ] Add 2–4 E2E critical journey tests
- [ ] Stabilize selectors and readiness
- [ ] Verify `npm run e2e` repeatability (2 runs)
- [ ] Release: bump version, changelog, tag, push, merge

### 0.3.6 checklist
- [ ] Add GitHub Actions CI for unit + E2E
- [ ] Upload Playwright report artifacts on failure
- [ ] Add `release:check` script
- [ ] Release: bump version, changelog, tag, push, merge

### 0.3.7 checklist
- [ ] Add diagnostics export (bundle)
- [ ] Add correlation IDs / structured logs (redacted)
- [ ] Add performance sanity test(s)
- [ ] Release: bump version, changelog, tag, push, merge

---

## Scratchpad / decisions

- Version tags: numeric only (e.g., `0.3.6`)
- E2E standard command: `npm run e2e`
- Primary E2E browser: Chromium
