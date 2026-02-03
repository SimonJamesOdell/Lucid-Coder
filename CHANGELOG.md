## 0.4.8 (2026-02-03)
- Split import flow into compatibility and git configuration steps, with tailored copy for local vs git imports.
- Prefill git remote URLs from git import inputs and refine git connection defaults and warnings.
- Expand ImportProject and ProjectSelector coverage to keep frontend coverage at 100%.

## 0.4.7 (2026-02-02)
- Add filesystem browsing + tech stack detection APIs, including compatibility scan support for import flows.
- Add compatibility helpers to normalize Vite/Next/CRA dev scripts and optional frontend structure fixes.
- Expand project import handling (local + git) with safer copy/link logic, clone URL handling, and setup job enqueueing.
- Add backend creation endpoint and refine process control flows for restarts and status refresh.
- Introduce a folder picker modal and richer import UX with tech detection and compatibility consent.
- Enhance Processes and Files views (status/actions polish, staged diff shortcut, and selection improvements).

## 0.4.6 (2026-02-01)
- Bump version metadata to 0.4.6 across packages and docs.
- Persist per-project Git settings client-side and avoid clearing remote URLs on partial updates.
- Ensure default branch updates include full project Git settings payload and expand Git settings tests.

## 0.4.5 (2026-02-01)
- Bump version metadata to 0.4.5 across packages and docs.
- Harden LLM configuration and requests by sanitizing API keys and adding tool-bridge fallback controls, with expanded LLM client/route tests.
- Update question tool agent behavior with `list_dir` support, simpler fallback handling, and plain-text answer acceptance; refine agent request classification heuristics.
- Skip autopilot test runs for CSS-only prompts with explicit status summaries.
- Refine ChatPanel streaming reconciliation, add debug diagnostics toggle, and polish UI controls (ChatPanel, StatusPanel, Dropdown, Getting Started).
- Expand backend/frontend tests for git settings recovery, agent repair paths, ChatPanel streaming, and goals API streaming.

## 0.4.4 (2026-01-31)
- Overhaul Git settings UX and data flow, including a richer Git tab UI, settings modal refinements, and improved navigation/preview integration.
- Add backend Git connection service and git scaffolding helpers, plus expanded routes/settings handling for git workflows.
- Expand app state settings persistence and Git settings normalization across frontend context helpers.
- Add comprehensive frontend/backend tests for Git settings, Git tab flows, persistence, and git utilities to keep strict coverage gates green.

## 0.4.3 (2026-01-29)
- Update version metadata across the repo and versioning documentation for the 0.4.3 release.
- Add OS keychain-backed encryption key storage (first-run generation) and initialize it at server start, with production enforcement.
- Enforce encryption key strength and placeholder checks; track encryption key status for safe encrypt/decrypt.
- Quiet repeated LLM API key decryption errors and improve reconfiguration guidance across client/routes/server readiness checks.
- Fail fast when Git token encryption is unavailable to prevent storing plaintext credentials.
- Add best-effort PAT scope verification warnings for GitHub/GitLab when creating remotes.
- Redact sensitive values in diagnostics bundles.
- Suppress preview proxy/409 noise in frontend tests and stabilize Runs tab test flows.
- Expand backend/frontend tests to cover the new encryption, LLM, Git token, and diagnostics paths.
- Tune backend coverage worker settings for faster coverage runs.

## 0.4.2 (2026-01-29)
- Make the preview proxy always route requests when the preview cookie is present to keep SPA navigation stable.
- Add back/forward navigation controls to the Preview URL bar with history tracking and disabled states.
- Allow manual URL edits after the port and navigate on Enter, including preview bridge support for parent-driven navigation.
- Move reload and open-in-new-tab actions into the Preview URL bar, styled to match navigation controls.
- Refine Preview URL bar button spacing, shading, and icon alignment for improved legibility.

## 0.4.1 (2026-01-29)
- Refactor backend orchestration and Branch workflow test gating into smaller helper modules to reduce file size and improve maintainability.
- Refactor App state and Chat panel logic into focused frontend helper modules while preserving existing behavior.
- Add targeted unit tests to keep the strict 100% coverage gate green.

## 0.4.0 (2026-01-29)
- Add targeted process restart support (restart frontend/backend independently) and propagate target selection through backend routes and frontend state.
- Improve Preview UX: more reliable “Open in new tab” behavior, error-state “Refresh + retry”, and auto-recovery controls/copy.
- Add a custom preview context menu backdrop + interaction handling, with expanded tests to keep the strict coverage gate green.

## 0.3.8 (2026-01-28)
- Add preview bridge v1 messages (READY/PING/PONG/GET_LOCATION) in the preview proxy injection to make iframe navigation detection more reliable.
- Harden PreviewTab iframe messaging by validating message source and expected origin, and exposing an `onPreviewNavigated` callback for lifecycle tooling.
- Add unit tests + documentation for the preview bridge contract.

## 0.3.7 (2026-01-28)
- Add backend diagnostics bundle export endpoint: `/api/diagnostics/bundle` (downloadable JSON).
- Add request correlation IDs (`X-Correlation-Id`) and structured request logging with in-memory redacted log buffering.
- Add performance sanity tests for core backend endpoints.
- Fix Windows `release:prep` gate invocation reliability.

## 0.3.6 (2026-01-27)
- Add a manual-only GitHub Actions workflow for `npm test` + Playwright E2E (kept local-first by default).
- Add `npm run release:check` (fails if git working tree is dirty), `npm run release:gate`, and `npm run release:prep -- <version>` for local release prep.
- Add `npm run e2e:clean-run` to reduce Playwright port-conflict flakes.
- Bump `baseline-browser-mapping` to reduce Playwright Baseline warnings.

## 0.3.5 (2026-01-27)
- Expanded Playwright E2E coverage with critical journeys (create/import/close/delete project) and more robust bootstrap assertions.
- Made E2E runs more deterministic (no implicit server reuse; stable selectors).
- Made E2E project creation fast and reliable via a non-production `E2E_SKIP_SCAFFOLDING` backend mode.

## 0.3.4 (2026-01-27)
- Added Playwright-based browser E2E smoke tests with backend+frontend orchestration.
- Added dedicated E2E SQLite DB reset for reliable clean runs.
- Added root npm scripts for running E2E (`npm run e2e*`) and documented usage in TESTING.md.

## 0.3.3 (2026-01-27)
- Consolidated frontend test mocking (axios + fetch) into the shared Vitest setup to reduce redundancy and brittleness.
- Hardened root npm scripts and testing docs so `npm test` consistently runs frontend + backend suites from repo root.
- Expanded Branch/Commits UI coverage (committed-files flow, merge gating) and added backend coverage for the branches changed-files endpoint.

## 0.3.1 (2026-01-26)
- Extended `run_events` with trace-oriented fields (`correlation_id`, `source`, `level`) and added supporting indexes.
- Added a paginated/filterable run events endpoint: `/api/projects/:projectId/runs/:runId/events`.
- Enhanced run event listing to support `afterId`, `types`, and `limit` options.

## 0.3.0 (2026-01-26)
- Added durable persisted Runs (SQLite `runs` + `run_events`) to capture job and autopilot execution history.
- Added backend Runs API under `/api/projects/:projectId/runs` (list runs + fetch a run with optional events).
- Mirrored job logs/status and autopilot session events into run timelines (best-effort, non-blocking persistence).
- Added a new Runs tab in the frontend to browse run history and timeline events.
- Changed default SQLite DB location to a per-user app data directory (with env overrides) and added best-effort migration from the legacy location.
- Fixed CSS-only staged changes from invalidating the last successful test run.
- Expanded frontend + backend tests to keep strict coverage gates green.

## 0.2.6 (2026-01-26)
- Added Current/Past goal views, with Past goals grouped and collapsible for easier scanning.
- Added Open/Past branch filtering in the sidebar with per-tab counts (Past = any non-open status, excluding `main`).
- Expanded frontend tests and closed remaining coverage gaps to keep the 100% coverage gate green.

## 0.2.5 (2026-01-25)
- Added best-effort preview auto-restart after repeated proxy connection failures (primarily iframe/HTML navigation).
- Improved preview proxy error placeholder UX and stabilized detection via consistent page title.
- Expanded backend tests around preview proxy auto-restart edge cases and tightened coverage mapping to keep the 100% coverage gate green.

## 0.2.4 (2026-01-25)
- Hardened preview proxy routing (dev assets + Vite HMR websockets) and expanded coverage for those paths.
- Improved branch workflow automation and scaffolding behavior with additional backend test coverage.
- Refined Branch/Commits/Preview UI flows and added frontend tests to keep coverage at 100%.

## 0.2.3 (2026-01-23)
- Increased AI assistant header height to align with address bar.
- Repositioned scroll-to-bottom button inside chat panel with downward arrow icon.
- Unified styling for chat header buttons (stop/position toggle).
- Replaced position toggle triangle with cleaner arrow icons.
- Optimized test execution to skip re-running tests that previously succeeded when no files have changed.

## 0.2.2 (2026-01-22)
- Streamlined commit gating with a single testing CTA that launches tests and returns to commits with an auto-populated message.
- Added queued test-run handling, return-to-commits flows, and related UI/state updates across Preview, Tests, and Commits.
- Expanded frontend test coverage for the new commit/test automation paths.
## 0.2.1 (2026-01-22)
- Expanded ChatPanel behavior and styling, plus broader test coverage.
- Added and refined goals API utilities with updated tests.
- Updated goal automation handlers and processing flow.
- Improved agent route handling and request flows, with additional backend tests.

## 0.2.0 (2026-01-21)
- Added nested goal planning with bounded depth/size, plus persistence of multi-level goal trees.
- Enhanced goal iteration to traverse nested goals, with clarification gating when requirements are underspecified.
- Updated Goals and Agent Goals panels to render nested goal trees and rolled progress across leaf goals.
- Extended tests to cover nested planning, clarification handling, and recursive processing.
- Kept PreviewTab mounted to prevent iframe reloads when switching tabs.
- Preview proxy now falls back to stored project ports for manually started frontends.
- Updated baseline-browser-mapping dev dependency.

## 0.1.3 (2026-01-20)
- Refactored backend autopilot and scaffolding modules into smaller helpers, plus modularized key frontend panels and hooks.
- Added targeted tests to close coverage gaps in ChatPanel, FilesTab tree rendering, and autopilot guidance cancellation.
- Ran backend and frontend test suites to keep coverage at 100%.

## 0.1.2 (2026-01-19)
- Added PreviewTab error grace-period coverage and test hooks to keep preview recovery tests green.
- Updated PreviewTab tests for localhost fallback actions and coverage stabilization.

## 0.1.1 (2026-01-19)
- Added same-origin preview proxying to keep the Preview URL bar synced with in-iframe navigation.
- “Open in new tab” now uses the current in-preview route.
- Improved preview startup UX after refresh and reduced transient proxy-error flashes.
- Added comprehensive tests and coverage for preview proxying and URL tracking.
