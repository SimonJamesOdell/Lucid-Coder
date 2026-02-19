# Versioning

LucidCoder follows Semantic Versioning.

## Current version

0.7.7

See [../VERSION](../VERSION).
## Policy

- MAJOR: incompatible API or workflow changes.
- MINOR: backward-compatible features.
- PATCH: backward-compatible fixes and maintenance.

## Source of truth

- Canonical version in [../shared/version.mjs](../shared/version.mjs)
- Synced versions in [../package.json](../package.json), [../backend/package.json](../backend/package.json), and [../frontend/package.json](../frontend/package.json)
- Human-readable version in [../VERSION](../VERSION)

Use the version bumper to keep these in sync.

- `npm run release -- <semver>`

You can validate version consistency (and that the changelog has an entry) from the repo root:

- `npm run release:check`
