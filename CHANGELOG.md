# Changelog

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
