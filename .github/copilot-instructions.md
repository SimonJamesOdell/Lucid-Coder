# Release Versioning Policy

- ALWAYS use `npm run release -- <semver>` from the repository root for version bumps.
- NEVER manually edit `version` fields in `package.json` files or any other version artifacts.
- All version changes MUST go through the release script at `tools/bump-version.mjs`.
- If a task requests a version change, use the release script instead of manual edits.
