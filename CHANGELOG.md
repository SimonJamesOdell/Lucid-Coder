## 0.7.9 (2026-02-21)
- Close coverage gaps: add tests for `AssetsTab`, `ChatPanel`, `FilesTab`, `reflection` utilities, `agentOrchestrator`, `promptHeuristics`, and `questionToolAgent` (frontend and backend unit/integration suites).
- Frontend: refine `AssetsTab` (assistant asset-context persistence, image zoom/pan, upload name sanitization, rename/optimize modal flows, and live asset-update handling), `ChatPanel` (improved thinking/automation topic indicator, better suite-selection heuristics for reruns, clarification/tracking fixes), and `FilesTab` (rendering and repository-path handling fixes). Tests added to cover the UI edge branches.
- Backend: tighten goal orchestration in `agentOrchestrator` (metadata merging, clarification task creation, planning snapshot helpers) and harden `promptHeuristics` (more robust `extractLatestRequest`, `isStyleOnlyPrompt`, `extractSelectedProjectAssets`, and color extraction). Targeted unit tests close remaining edge branches.



## 0.7.8 (2026-02-20)
- Add preview element-target context end-to-end: right-click capture in the injected preview bridge, unique element-path derivation, preview menu action (`Add element to context`), per-project element-context storage, and ChatPanel context indicator + prompt injection so targeted requests like “turn this blue” can resolve to a specific element.
- Fix a preview bridge script escaping regression that prevented custom iframe context-menu handlers from attaching (restoring LucidCoder preview right-click behavior instead of the native browser menu).
- Improve `Open preview in new tab` behavior for LAN/non-loopback access by preferring the proxy/displayed preview URL when the app is served from network hosts, while preserving direct dev-server preference for localhost/loopback workflows.
- Expand focused frontend coverage for the new context and preview behavior: add `assistantElementContext` utility tests, extend ChatPanel prompt/event coverage for element context, and extend PreviewPanel coverage for loopback/LAN open-tab branching.
- Expand TestTab coverage-effects scenarios around partial-suite automation completion handling and modal/circuit-breaker edge behavior to keep strict coverage gates green.

## 0.7.7 (2026-02-19)
- Harden preview upload path handling in the backend preview proxy (`parseUploadForwardPath`) and expose focused test hooks used to validate edge-path behavior without changing runtime routing semantics.
- Expand `previewProxy` coverage with targeted upload-serving/parse/error-path tests (including malformed encoding, root uploads guards, missing logger branches, and headers-sent serving), closing remaining line-level gaps.
- Extend ChatPanel suite helper and auto-fix rerun coverage for path-classification, staged-diff normalization, backend-only status messaging, and user-origin no-rerun commit routing paths.
- Expand goal-automation coverage around reflection asset matching and process-goal retry/touch-tracker edge branches, including required-asset retry guidance normalization and helper-level matcher guards.

## 0.7.6 (2026-02-18)
- Add an approval-and-framework decision flow in the frontend, including `ApprovalPanel`, generated navbar wiring, project decision/profile artifacts, and orchestration utilities for clarification + framework planning.
- Strengthen ChatPanel and goal-automation flows with clarification deduplication/tracking, additional automation guard paths, and expanded framework/preflight diagnostics integration.
- Expand asset and chat coverage significantly (including upload/rename/clarification edge branches) and add focused coverage suites for approval flow, framework orchestrator, and ClarificationTracker utilities.
- Introduce new repo tools for approval application, decision orchestration, diagnostics/preflight checks, and codemod support, with accompanying docs for roadmap/integration/verification and improvement analysis.
- Update release/version metadata to `0.7.6` across root/frontend/backend package manifests, lockfiles, shared version exports, and versioning docs.

## 0.7.5 (2026-02-17)
- Add a dedicated asset rename modal flow and integrate it into Assets tab interactions, including validation, submission guards, and improved rename error handling.
- Harden assistant asset-context behavior across Assets and Chat panels, including context remapping/cleanup when assets are renamed or optimized and clearer context-change synchronization.
- Improve branch workflow and planning heuristics by tightening merge/changelog edge-path handling, expanding prompt heuristic extraction behavior, and covering additional agent-orchestrator goal metadata branches.
- Expand backend and frontend coverage suites for branch workflow failures, project file routes, goal automation edit paths, TestTab helper fingerprints, and Assets/Chat runtime guard branches to keep strict coverage gates green.

## 0.7.4 (2026-02-17)
- Replace direct CSS-only planning/edit-write gating with LLM-driven goal planning and reflection-guided style scoping, including optional `styleScope` parsing in automation reflection.
- Improve branch workflow merge resilience by aborting failed merges and returning explicit `409` conflict errors with clearer merge-failure messages.
- Add assistant asset context persistence and UI integration: asset selection in Assets tab, prompt/context injection in ChatPanel, and cross-component context-change event handling.
- Improve branch naming prompt extraction by deriving branch context from nested `Current request` / `User answer` segments instead of full conversation noise.
- Expand frontend/backend coverage suites for automation utilities, assistant asset context behavior, merge error paths, and planner behavior changes; bump version metadata to `0.7.4` across manifests, lockfiles, shared version exports, and docs.

## 0.7.3 (2026-02-16)
- Add a full Assets management flow with image/video/audio/file previews, wheel zoom + pan, optimize controls, and a dedicated optimize modal.
- Expand backend assets route coverage with a comprehensive `routes.files` assets test suite and close remaining edge branches.
- Expand frontend coverage for PreviewPanel, ChatPanel, AssetOptimizeModal, and AssetsTab (including fallback/error/guard paths) to keep strict 100% gates green.
- Tune frontend coverage-report performance by making Vitest cache/coverage directories deterministic per-frontend workspace and setting `coverage.processingConcurrency` based on local profiling.
- Bump version metadata to `0.7.3` across root/backend/frontend package manifests + lockfiles, shared version exports, and versioning docs.

## 0.7.2 (2026-02-16)
- Stabilize Preview startup UX by keeping the loading overlay visible until the preview is actually ready, adding smoother overlay/iframe crossfade behavior, and preventing early-hide flicker during manual starts.
- Improve Preview not-running/error handling with clearer copy and actions (including explicit not-running messaging), while removing redundant loading-overlay URL/new-tab text.
- Fix Branch tab merge gating reliability by clearing `mergeWarning` only on explicit branch selection updates, preventing race-driven warning resets during test-and-merge flows.
- Bump version metadata to `0.7.2` across root/backend/frontend package manifests + lockfiles, shared version exports, and versioning docs.

## 0.7.1 (2026-02-16)
- Scope autopilot verification retries to the affected workspace (`frontend` or `backend`) when edits stay contained, reducing unnecessary cross-workspace reruns while preserving full-coverage enforcement.
- Harden targeted styling flows by enforcing style-scope contracts in backend edit writes and frontend goal-automation reflection (reject global-selector/app-wide stylesheet edits unless the request is explicitly global).
- Improve prompt classification to avoid treating element-scoped UI/style requests (for example navbar/header/button-specific changes) as generic style-only prompts.
- Update ChatPanel thinking feedback to show `Thinking about: <prompt>` while requests are in flight.
- Add a clear staged changes action in Commits (with in-flight guard rails and branch-overview sync) so users can quickly reset staged files before committing.
- Expand backend/frontend test coverage around autopilot workspace scoping, style-scope validation, commit action handling, and reflection utilities to keep release gates green.

## 0.7.0 (2026-02-15)
- Stabilize frontend coverage runs on Windows by using the Vitest `threads` pool when `--coverage` is enabled, avoiding fork-worker coverage temp-file races.
- Restore normal frontend test throughput by removing forced single-worker coverage settings so Vitest can manage worker concurrency safely.
- Keep frontend test execution defaults unchanged for non-coverage runs while preserving strict coverage gate behavior.

## 0.6.9 (2026-02-15)
- No source-code delta from 0.6.8; this release finalized the merge/tag step for the 0.6.8 changeset.

## 0.6.8 (2026-02-15)
- Finalize backend coverage closure across project import/git helpers and branch/workflow edge cases, including clone conflict handling, fallback defaults, and normalization guards.
- Harden autopilot failure extraction/fingerprinting by improving failure parsing, dedupe behavior, and default normalization for workspace/test identifiers.
- Expand backend coverage tests for retry/fingerprint behavior, testing-settings fallback targets, coverage-provider resolution fallbacks, and cancellation error branches.
- Refine backend build/install command coverage behavior by skipping Gradle test execution in install-job command generation (`gradle build -x test`).
- Tune frontend Vitest coverage stability by detecting coverage mode and forcing deterministic single-worker execution for coverage runs.

## 0.6.7 (2026-02-14)
- Add an autopilot verification retry circuit breaker that stops auto-fix retries when consecutive runs produce the same failure fingerprint, reducing non-interactive retry loops.
- Expand autopilot failure extraction with structured Vitest/Pytest log parsing and deduped failure aggregation to improve verification prompts and retry diagnostics.
- Add stable failure-fingerprint helper coverage and autopilot retry-stop regression tests across service and coverage suites.
- Stabilize backend Vitest execution defaults by running unit/parallel suites with `forks` and a deterministic non-Windows worker fallback.
- Refine backend coverage tests for job cancellation error paths by spying on `process.kill` directly in cancellation branches.

## 0.6.6 (2026-02-14)
- Fix Linux backend coverage execution by selecting a Node-version-aware Vitest coverage provider (`istanbul` on older runtimes, `v8` on newer runtimes), and add focused resolver coverage tests.
- Restore missing backend project-route modules (`helpers.js`, `fileOps.js`, `installJobs.js`, `routes.testing.js`) and keep route/test imports aligned so Linux and Windows execute the same route surface.
- Add `@vitest/coverage-istanbul` to backend dev dependencies to support cross-platform coverage runs where `node:inspector/promises` is unavailable.
- Update `.gitignore` to allow committed backend route modules under `backend/routes/projects` while keeping user workspace `projects/` ignored.

## 0.6.5 (2026-02-14)
- Refactor large frontend components (`CreateProject`, `PreviewTab`, `ImportProject`, `ChatPanel`, `FilesTab`) by extracting focused utility modules and presentational subcomponents to reduce file size while preserving behavior.
- Refactor backend project import/install route internals in `backend/routes/projects.js` into dedicated helper modules (`helpers.js`, `fileOps.js`, `installJobs.js`) and keep route exports/test hooks compatible.
- Extract goal-automation JSON parsing and scope-reflection logic from `automationUtils.js` into `automationUtils/jsonParsing.js` and `automationUtils/reflection.js`, including compatibility wrappers and focused reflection normalization improvements.
- Add/expand frontend and backend tests for extracted modules and edge cases (create-project helpers/sections/hooks, preview overlays/origin utils, chat-panel agent utils, files/import/app-state utilities, and backend project route helper/file-op/install-job coverage).
- Keep the strict coverage gate green after refactors via targeted suite updates and additional regression coverage.

## 0.6.4 (2026-02-13)
- Add an automatic dependency-install step in branch workflow test gating for Node workspaces when dependency manifests change, preventing missing-module failures during coverage/test runs.
- Harden branch workflow dependency-install trigger logic across workspace/root manifest changes and remove unreachable guard paths in the tests API decision flow.
- Expand branch workflow regression coverage for pre-test dependency installation ordering and dependency-trigger edge cases.
- Refine backend/frontend coverage-threshold handling and merged coverage evaluation so custom threshold runs and config-file exclusions stay deterministic.
- Expand TestTab behavior and helper coverage for modal suppression, autofix flow controls, payload selection, and log rendering/scroll handling to restore full suite coverage.
- Bump version metadata to 0.6.4 across root/frontend/backend packages, lockfiles, shared version module, and versioning docs.

## 0.6.3 (2026-02-13)
- Add persisted testing coverage settings end-to-end (database table + settings routes + frontend app-state wiring), including global and per-project threshold derivation for frontend/backend test jobs.
- Add a new Settings → Configure Testing modal and navigation entry, including slider-based threshold controls, save/cancel behavior, and local persistence hydration.
- Harden branch-workflow threshold handling and tests API behavior for workspace-specific coverage targets, custom/global mode fallbacks, and defensive error paths.
- Expand jobs and project route coverage for testing-settings edge cases (missing/invalid payloads, fallback reads, and rejected settings lookups) to keep policy-driven test thresholds deterministic.
- Refine PreviewTab/TestTab and related app-state flows with additional guard-path handling and comprehensive coverage tests across navigation, persistence, and settings reducers.

## 0.6.2 (2026-02-13)
- Refine PreviewTab error/empty-state behavior and environment guards to keep runtime behavior consistent while preserving strict coverage expectations.
- Expand PreviewTab tests for URL/origin resolution, modal lifecycle cleanup, reload fallbacks, and not-running/error-path handling.
- Add focused process manager coverage for reserved-port cleanup behavior.

## 0.6.1 (2026-02-12)
- Auto-detect tech stack for git clone imports and lock the tech selectors on the details step.
- Add git tech detection endpoint and coverage for clone-based imports.
- Refine clone setup layout spacing, grid alignment, and clone options copy.
- Expand Create Project coverage for git setup, tech detection, and setup-job display fallbacks.

## 0.6.0 (2026-02-12)
- Merge the create and import project flows into a single optimized flow.
- Update the Projects navigation menu to link to the new flow.
- Add coverage for the projects import handler fallback when request bodies are missing.
- Adjust Create Project tests to cover local import mode toggles and add-project flows.

## 0.5.9 (2026-02-11)
- Add manual cleanup-target support for project cleanup (explicit targets, empty-target guard, and forced port cleanup on delete).
- Extend process cleanup helpers with PID/port retry utilities and test-only hooks to keep shutdown logic deterministic in coverage runs.
- Update Create Project and Project Selector flows to align with the git-first wizard, progress steps, and cleanup retry UI.
- Expand backend and frontend tests to keep the 100% coverage gate green.

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
