# Changelog

## 0.1.2 (2026-01-19)
- Added PreviewTab error grace-period coverage and test hooks to keep preview recovery tests green.
- Updated PreviewTab tests for localhost fallback actions and coverage stabilization.

## 0.1.1 (2026-01-19)
- Added same-origin preview proxying to keep the Preview URL bar synced with in-iframe navigation.
- “Open in new tab” now uses the current in-preview route.
- Improved preview startup UX after refresh and reduced transient proxy-error flashes.
- Added comprehensive tests and coverage for preview proxying and URL tracking.
