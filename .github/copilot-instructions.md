# Release Versioning Policy

- ALWAYS use `npm run release -- <semver>` from the repository root for version bumps.
- NEVER manually edit `version` fields in `package.json` files or any other version artifacts.
- All version changes MUST go through the release script at `tools/bump-version.mjs`.
- If a task requests a version change, use the release script instead of manual edits.

# Input Classification Guardrails

- NEVER classify user intent or style scope using raw prompt string heuristics (regex/substring keyword checks) in automation/reflection pipelines.
- Use structured fields returned by planner/reflection contracts (e.g. `styleScope.mode`, `styleScope.targetLevel`, `targetHints`) as the source of truth.
- If structured fields are missing or invalid, fail closed (request clarification or use safe defaults); do not infer intent from free-text prompt wording.
- Any change to scope/classification logic MUST include regression tests proving prompt wording alone cannot override structured contract fields.
