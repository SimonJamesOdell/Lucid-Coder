## 0.5.8 (2026-02-10)
- Add synchronous cleanup retry/delete responses so the UI can await cleanup results and surface failures.
- Require user approval for suggested .gitignore fixes during clone/setup and provide apply/skip flows with setup continuation.
- Add retry cleanup actions and cleanup-log visibility to the project delete flow for clearer recovery guidance.
- Expand backend/frontend coverage for git ignore handling, cleanup retries, and clone/setup edge cases to keep 100% gates green.
- Add clone-project flow handling and git URL helpers to support connect-existing-repo creation, including credential stripping and remote/branch persistence.
- Extend backend clone/scaffolding coverage for fallback branches, progress piping, and skip-scaffolding clone settings.
- Update Create Project connect flow to pass git parameters on create and align tests with the new clone-backed path.

## 0.5.7 (2026-02-10)
- Harden git fetch/pull/status routes to auto-seed the `origin` remote from saved settings when it is missing locally (`ensureRemoteOrigin`), with `remote add` → `set-url` fallback.
- Show the project path in the Files tab explorer header and remove the static "Explorer" label.
- Make proxy placeholder pages (503 "starting" / 502 "error" / 409 "unavailable") fully invisible so the frontend's own loading overlay is the only user-facing feedback during preview startup.
- Restore preview proxy auto-retry scripting and harden PreviewTab placeholder handling, auto-recovery cleanup, and loading transitions.
- Add Git sync status indicators (dirty/current/ahead/behind) plus stash/discard actions and stash/discard-aware pulls to keep local and remote states aligned.
- Add guided Git sync copy with recommended actions and collapse advanced controls to reduce button overload.
- Add comprehensive backend tests for the new remote-origin recovery paths (status, fetch, pull) including error and fallback branches.
- Expand git utilities/routes and PreviewTab coverage to keep strict coverage gates green.
- Add frontend test for project-path display in the file tree header.

## 0.5.6 (2026-02-09)
- Return 503 "Preview is starting" responses (with Retry-After) when the preview proxy cannot reach a frontend still booting, instead of a generic 502.
- Persist the detected LLM endpoint path at configuration time and reuse it at runtime to skip fallback delays for non-chat models.
- Expose stored LLM endpoint metadata in safe config responses and expand LLM route/client tests to keep coverage strict.
- Remove unreachable fallback-branch guards in LLM endpoint routing to keep branch coverage accurate.
- Batch uncovered-line coverage goals per file (max 20 lines each) instead of emitting one goal per line, reducing automation noise.
- Deduplicate coverage retries across autofix rounds so already-targeted lines are not re-attempted.
- Add a circuit breaker to the test autofix loop that halts when the same failure fingerprint repeats consecutively.
- Add React Router duplication guidance to the LLM system prompt to prevent double-`<BrowserRouter>` crashes.

## 0.5.5 (2026-02-09)
- Add OpenAI Responses API support for codex-family models: auto-detect codex models, route to `/v1/responses`, convert payloads (system/developer to `instructions`, omit temperature/top_p for reasoning models), and apply 120s timeouts.
- Cache discovered endpoint paths after fallback probing so subsequent LLM requests skip the retry chain.
- Reorder fallback logic to try `/responses` before `/completions`, and skip legacy `/completions` entirely for codex-only models.
- Route codex models to `/v1/responses` in endpoint URL resolution.
- Add a circuit breaker to goal processing that halts after consecutive failures to prevent runaway automation on a broken project.
- Add transient LLM error detection and automatic retry with backoff during tests and implementation stages of goal processing.
- Fix ChatPanel clarification prompt to preserve the original user prompt instead of the resolved prompt.
- Hide the "Assistant is thinking" indicator when the assistant is paused (autopilot or auto-fix).
- Treat HTTP 400 as a missing-file response and skip directory-like paths when building relevant-files context.
- Add soft reloads for the Preview iframe to avoid blank flashes, with debounced reload coalescing and safer timeout/error handling.
- Smooth Preview iframe loading-state transitions with an opacity fade.
- Extend coverage-focused tests across LLM client (responses API, endpoint caching, fallback routing), goal automation (circuit breaker, transient retries), ChatPanel, PreviewTab, and automation utilities to keep strict coverage gates green.

## 0.5.4 (2026-02-08)
- Move clarification questions into a modal with per-question inputs, pause/resume/cancel controls, and answer submission back into the agent.
- Integrate the Runs view into the LLM Usage page via Usage/Runs tabs while keeping the usage summary intact.
- Refresh Goals immediately after creation and tighten goal automation handling around clarification/goal updates.
- Make OpenAI-compatible fallback timeouts configurable for /completions and /responses endpoints.
- Refine clarification prompting behavior to avoid default acceptance-criteria questions unless required.
- Extend coverage-focused tests across ChatPanel, LLM usage, LLM client, and goal metadata flows to keep strict gates green.

## 0.5.3 (2026-02-08)
- Introduce the Clean Up tool end-to-end: backend foreground cleanup runner with strict coverage gates, SSE streaming endpoint, and a full UI modal flow (progress logs, cancellation, and branch cleanup decisions).
- Add cleanup resume coordination + request storage so automation can reopen and resume cleanup after passing test runs.
- Extend goals APIs with cleanup streaming support and richer meta-goal payloads (child metadata + parent overrides).
- Add a draggable file explorer divider with clamped widths and per-project persistence.
- Add TestTab log font size controls (zoom in/out) to improve test output readability.
- Enforce 100% coverage thresholds and line references in automation/test workflows, including frontend Vitest thresholds and autopilot/test route coverage enforcement.
- Harden version bump tooling for CRLF/no-op runs and add guard tests for cleanup/coverage utilities, goal automation, ChatPanel/TestTab flows, and branch state edge cases.

## 0.5.2 (2026-02-04)
- Split Create New Project into a two-step wizard (Project Details → Git Setup) with Next/Back navigation, while preserving local/global/custom git workflows and remote create/connect options.
- Fix Preview tab blank page regressions by making backend-origin resolution SSR-safe, adding `VITE_API_TARGET` support, and proxying `/preview` to the backend in Vite dev.
- Fix targeted backend restarts so they don’t inadvertently terminate the frontend dev server (port-cleanup regression), with added backend route coverage.
- Harden Branch tab test runs so branch overview state does not regress when refresh data is missing.
- Improve ChatPanel error messages by surfacing backend LLM readiness errors (including “LLM is not configured” reason) and standardizing client-side fallbacks.
- Enhance the configured LLM banner to show provider/model details when available.
- Make Playwright E2E runs safer and more isolated (dedicated ports/DB, opt-in server reuse, backend diagnostics guard), and add a script to purge accidentally-created E2E projects.

## 0.5.1 (2026-02-04)
- Require selecting a Git workflow when creating a new project, with support for local-only or cloud workflows (use global settings or a custom provider + PAT).
- Add optional cloud remote setup on creation: create a new repository or connect an existing repository URL.
- Ensure backend remote creation can use the stored global token without persisting it into per-project settings unless the client explicitly supplies a token.
- Update Playwright E2E coverage for the new required Git workflow selection in create-project flows.
- Improve E2E ergonomics/stability by defaulting to dedicated ports (3100/5100), reusing existing E2E servers in local dev, and making Vite proxy targets configurable.
- Add placeholder “Tools” modals (Clean Up / Refactor / Add Tests / Audit Security) to replace alert-based stubs.
- Simplify the LLM usage summary UI and align unit tests and responsive layout.

## 0.5.0 (2026-02-03)
- Add `e2e:flake-check` scripts for quickly detecting Playwright flakes via repeated clean runs.
- Add backend settings API contract tests (Supertest) to lock down response/error shapes.
- Harden frontend settings fetch helpers for network failures and non-JSON responses, with new negative-network unit coverage.
- Expand Playwright E2E coverage across project lifecycle, Files tab, Git tab, Import wizard, Packages tab, Processes, Runs, and error/retry flows.
- Add a faster local loop via `npm run test:quick` and shardable backend test scripts.

## 0.4.9 (2026-02-03)
- Add shared SettingsModal and unify settings UX across Git, LLM, and port configuration dialogs.
- Refresh Create/Import project layouts and buttons for a consistent modal-style flow, with updated navigation handling.
- Skip backend-only automation when projects lack backend capability and adjust test copy accordingly.
- Add preview bridge pointer messaging to close dropdowns on iframe interaction.
- Auto-push main after cloud merges when remote settings are configured, with backend coverage and fallback handling.
- Expand frontend/backend test coverage and update version metadata across the repo.

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
