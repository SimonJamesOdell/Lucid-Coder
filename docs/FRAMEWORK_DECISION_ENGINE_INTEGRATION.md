# Framework Decision Engine Integration Guide

## Overview
The preflight/decision engine system improves code generation by detecting project frameworks and routing libraries, making intelligent decisions about which APIs to recommend, and asking for clarification only when needed.

## Problem It Solves
**Real-world failure observed:**
- User asked for "a navigation bar with home, about, contact links"
- System repeatedly asked the same clarification question twice, differently worded
- System then attempted to use `react-router-dom` without checking if it was installed
- This caused a cascade of 8+ test failures and repeated retry loops

**Solution:**
- Run preflight detection early to know project state (framework, router deps, imports)
- Make a calibrated decision (auto-apply / suggest / fallback) based on evidence
- Avoid asking about clarifications the system already answered
- Gate code generation on whether dependencies exist

## Architecture

```
User Intent
   ↓
[Preflight Detector] → project_profile.json
   ↓
[Decision Engine] → decision.json (action + confidence + rationale)
   ↓
      ├─ auto_apply_router_api → proceed to generation (high confidence)
      │
      ├─ suggest_router_with_approval → show approval modal (medium confidence)
      │    ↓
      │  User Approves → run codemod + tests
      │
      └─ fallback_safe → generate safe version ask (low confidence)
```

## Key Files

| File | Purpose |
|------|---------|
| `tools/preflight-detector.mjs` | Scans project, writes `frontend/project_profile.json` |
| `tools/decision-engine.mjs` | Reads profile, writes `frontend/decision.json` with recommended action |
| `tools/codemod-react-ast.mjs` | AST-based codemod to convert `<a href>` → `<Link to>` (dry-run) |
| `tools/approval-apply.mjs` | Generates proposed NavBar, applies with `--apply` flag |
| `frontend/src/components/ApprovalModal.jsx` | UI to show medium-confidence suggestions |

## Integration Points

### 1. **Early Preflight (Agent Initialization)**

When a user creates a new project or starts a goal, run the preflight detector:

```javascript
// In goalHandlers.js or processTree before code generation
import { execSync } from 'child_process';

async function runPreflightDetection(projectPath) {
  try {
    execSync(`node ./tools/preflight-detector.mjs`, { cwd: projectPath });
    const profile = JSON.parse(fs.readFileSync(`${projectPath}/frontend/project_profile.json`, 'utf8'));
    return profile;
  } catch (e) {
    console.error('Preflight detection failed:', e);
    return null;
  }
}
```

### 2. **Decision Engine (Intent Analysis)**

Before generating code, run the decision engine to determine whether to auto-proceed, ask for approval, or use a safe fallback:

```javascript
// After preflight, call decision engine with user intent
async function runDecisionEngine(projectPath, userIntent) {
  try {
    // Pass intent as CLI arg to decision-engine.mjs
    execSync(`node ./tools/decision-engine.mjs "${userIntent}"`, { cwd: projectPath });
    const decision = JSON.parse(fs.readFileSync(`${projectPath}/frontend/decision.json`, 'utf8'));
    return decision;
  } catch (e) {
    console.error('Decision engine failed:', e);
    return null;
  }
}
```

### 3. **Prompt Injection (Code Generation)**

Inject the project profile and decision guidance into the LLM prompt **before** calling the code generator:

```javascript
// In buildEditsPrompt or at call site
function buildEditsPromptWithProfile(inputs) {
  const { projectProfile, decision, ... } = inputs;

  const profileContext = projectProfile ? `
## Project Profile
- Framework: ${projectProfile.detected.framework}
- Router Dependency: ${projectProfile.detected.routerDependency ? 'YES' : 'NO'}
- Router Imports Found: ${projectProfile.detected.routerImportsFound ? 'YES' : 'NO'}

## Framework-Specific Guidance
${projectProfile.detected.framework === 'react' ? `
  For React:
  - Prefer react-router-dom Link components for SPA navigation (if installed)
  - Use <a href> only for external links or downloads
  - Never wrap components in <BrowserRouter> twice
` : ''}
` : '';

  const decisionContext = decision ? `
## Recommended Approach
- Decision: ${decision.decision}
- Confidence: ${(decision.normalized * 100).toFixed(0)}%
- Recommendation: ${decision.recommendation}
- Rationale: ${decision.rationale}
` : '';

  // Inject into existing prompt structure
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + profileContext + decisionContext },
    ...existing_messages
  ];

  return { messages, ... };
}
```

### 4. **Approval Gating (Medium-Confidence)**

When decision is `suggest_router_with_approval`, surface an approval modal before proceeding:

```javascript
// In ChatPanel or goal handler
if (decision?.decision === 'suggest_router_with_approval') {
  // Show approval modal (already implemented in ApprovalModal.jsx)
  // Wait for user approval
  return new Promise(resolve => {
    window.addEventListener('lucidcoder:apply-recommendation', ({ detail }) => {
      // Run codemod + tests
      applyAndTest(detail);
      resolve();
    });
  });
}
```

### 5. **Deduplication (Clarification Questions)**

Track asked clarifications per branch to avoid repeating them:

```javascript
// In goal automation service
const askedClarifications = new Set();

async function askClarification(question) {
  // Hash based on question content or intent category
  const questionHash = hashClarification(question);
  if (askedClarifications.has(questionHash)) {
    return getCachedAnswer(questionHash); // Return prior answer
  }

  // Ask user only once
  const answer = await getUserClarification(question);
  askedClarifications.add(questionHash);
  storeCachedAnswer(questionHash, answer);
  return answer;
}
```

## Example Workflow

### Step 1: User Input
```
User: "Give me a navigation bar with Home, About, Contact links styled black with white text"
```

### Step 2: Preflight Detection
```bash
node tools/preflight-detector.mjs
# Writes: frontend/project_profile.json
# {
#   "detected": { "framework": "react", "routerDependency": false, "routerImportsFound": true },
#   ...
# }
```

### Step 3: Decision Engine
```bash
node tools/decision-engine.mjs "Add NavBar with links"
# Writes: frontend/decision.json
# {
#   "decision": "suggest_router_with_approval",
#   "normalized": 0.42,
#   "recommendation": "Propose installing react-router-dom and applying Link component codemod upon approval",
#   "commands": [{"title": "Install react-router-dom", "cmd": "npm --prefix frontend install react-router-dom"}]
# }
```

### Step 4: Approval Modal
Modal appears to user: **"I recommend using react-router-dom for navigation. Should I install it and proceed?"**
- User clicks "Approve"
- System installs dependency
- System generates NavBar using Link components
- System runs tests
- System commits or opens PR

## Running the Tools Standalone (Testing)

```bash
cd <repo-root>

# Generate project profile
node ./tools/preflight-detector.mjs

# Run decision engine with sample intent
node ./tools/decision-engine.mjs "Add a navbar with links"

# Run AST-based codemod (dry-run)
node ./tools/codemod-react-ast.mjs

# Generate proposed NavBar files
node ./tools/approval-apply.mjs

# Apply changes
node ./tools/approval-apply.mjs --apply
```

## Key Benefits

| Benefit | How It Works |
|---------|-------------|
| **No duplicate clarifications** | Track answered questions per branch; reuse prior answers |
| **Safer code generation** | Preflight confirms dependencies exist before using them |
| **Intentional decisions** | Calibrated confidence scoring prevents brittle auto-changes |
| **User control** | Medium-confidence decisions ask for approval, not auto-apply |
| **Extensible** | Add new framework rules to the mapping table without changing core logic |
| **Auditable** | Decision rationale + confidence logs appear in output |

## Next Steps for Full Integration

1. **Call preflight early** in goal initialization (before any generation attempt).
2. **Inject decision output** into the buildEditsPrompt as context for the LLM.
3. **Implement approval gating** to pause generation when medium-confidence (already UI is ready).
4. **Add deduplication** for clarification questions (simple Set + hash).
5. **Add CI checks** that run preflight + decision and report on coverage.
6. **Collect telemetry** (decisions made, user approvals/overrides) to refine thresholds over time.

## Testing

- Run `npm --prefix frontend run test -- src/test/NavBar.test.jsx` to verify NavBar + Link components work.
- Run preflight + decision tools manually to see profile and recommendations.
- Simulate approval workflow by updating `frontend/decision.json` manually and checking if ApprovalModal renders.
