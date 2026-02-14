# Preview Bridge Contract (v1)

LucidCoder uses a same-origin preview proxy (`/preview/:projectId/...`) to load a project's dev server inside an iframe.
Because the iframe origin differs from the LucidCoder UI origin, coordination is done via `postMessage`.

This document describes the minimal bridge contract introduced in **0.3.8**, which remains the baseline for preview iframe coordination.

## Messages (iframe → parent)

All messages include:

- `type` (string)
- `prefix` (string): the `/preview/:projectId` prefix used by the proxy
- `bridgeVersion` (number): currently `1`

### `LUCIDCODER_PREVIEW_BRIDGE_READY`

Sent when the injected bridge initializes.

Payload:

- `href` (string, optional)

### `LUCIDCODER_PREVIEW_NAV`

Sent whenever the iframe detects a navigation (history, hashchange, popstate, or polling fallback).

Payload:

- `href` (string)
- `title` (string, optional)

## Preview helper

The preview helper is injected into the proxied preview HTML and is a mainstream feature.

### `LUCIDCODER_PREVIEW_HELPER_READY` (iframe → parent)

Sent when the helper initializes.

Payload:

- `href` (string, optional)

### `LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU` (iframe → parent)

Sent when the user right-clicks inside the preview iframe. Holding **Shift** bypasses the helper and shows the browser’s default context menu.

Payload:

- `href` (string)
- `clientX` (number)
- `clientY` (number)
- `tagName` (string, optional)
- `id` (string, optional)
- `className` (string, optional)

## Messages (parent → iframe)

### `LUCIDCODER_PREVIEW_BRIDGE_PING`

Used to (re)sync after parent/iframe load races.

Payload:

- `nonce` (string, optional)

### `LUCIDCODER_PREVIEW_BRIDGE_PONG` (iframe → parent)

Response to a ping.

Payload:

- `nonce` (string|null)

### `LUCIDCODER_PREVIEW_BRIDGE_GET_LOCATION`

Requests that the iframe emit its current `LUCIDCODER_PREVIEW_NAV`.

## Security / validation

The parent should validate:

- `event.source` matches the current preview iframe `contentWindow`
- `event.origin` matches the expected preview proxy origin when available

## Navigation lifecycle

The UI layer should treat `LUCIDCODER_PREVIEW_NAV` (and READY) as the canonical place to:

- update the displayed preview URL
- clear dev-only overlays on navigation/reload
- trigger helper state resets
