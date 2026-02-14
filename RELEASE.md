# Release Process

## Version bump rule

All version bumps must use:

`npm run release -- <semver>`

## Prohibited actions

- Manual edits to any `version` field are prohibited.
- Do not directly edit version values in `package.json`, `VERSION`, `shared/version.mjs`, or lockfiles.

## Why this is required

The release tool (`tools/bump-version.mjs`) updates all version artifacts together to keep release metadata consistent across the repository.
