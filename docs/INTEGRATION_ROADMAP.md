# Integration Roadmap: Wiring Failure Prevention Into Goal Automation

## Overview

This document provides **concrete implementation steps** to integrate the three failure prevention mechanisms into the existing agent goal automation pipeline. The improvements directly address the real-world failures observed.

## Current State

✅ **Built & Tested:**
- `tools/framework-orchestrator.mjs` - Coordinates preflight + decision
- `frontend/src/utils/ClarificationTracker.js` - Deduplicates clarifications
- `frontend/src/components/ApprovalModal.jsx` - Approval gating UI
- `tools/failure-prevention-diagnostics.mjs` - Validates all three mechanisms

⚠️ **Not Yet Integrated:**
- No connection to goal automation pipeline
- ClarificationTracker not used in ChatPanel
- ApprovalModal not triggered by decision confidence
- Orchestrator not called before code generation

---

## Integration Task 1: Wire Orchestrator Into processGoal

**File:** [frontend/src/services/goalAutomation/processGoal.js](frontend/src/services/goalAutomation/processGoal.js)

**What to Change:**
Early in the goal processing, call the framework analysis and inject results into the LLM prompt.

**Before (Current):**
```javascript
export async function processGoal(goalDetails) {
  // Immediately builds prompt without project context
  const editPrompt = buildEditsPrompt(goalDetails);
  const edits = await generateEdits(editPrompt);
  return edits;
}
```

**After (With Framework Analysis):**
```javascript
import * as orchestrator from '../../../tools/framework-orchestrator.mjs';

export async function processGoal(goalDetails) {
  // 1. EARLY: Analyze project framework and routing setup
  const analysis = await orchestrator.analyzeProject(goalDetails.description);
  
  if (!analysis.success) {
    console.warn('[processGoal] preflight analysis failed:', analysis.error);
    // Continue with safe defaults
  } else {
    console.log('[processGoal] Analysis:', {
      framework: analysis.profile?.detected?.framework,
      hasRouter: analysis.profile?.detected?.routerDependency,
      decision: analysis.decision?.decision,
      confidence: analysis.decision?.normalized
    });
  }

  // 2. BUILD: Include framework context in prompt
  const editPrompt = buildEditsPrompt(goalDetails, {
    projectProfile: analysis?.profile,
    decision: analysis?.decision,
    safeguards: orchestrator.validateGenerationSafety(
      analysis?.profile, 
      analysis?.decision
    )
  });
  
  // 3. GATE: If medium confidence, require approval before generation
  if (orchestrator.requiresApproval(analysis?.decision)) {
    const userApproved = await showApprovalGate(analysis?.decision);
    if (!userApproved) {
      // Use safe fallback
      return generateFallbackEdits(goalDetails);
    }
  }
  
  // 4. GENERATE: With framework context injected
  const edits = await generateEdits(editPrompt);
  return edits;
}
```

**buildEditsPrompt Enhancement:**
```javascript
function buildEditsPrompt(goalDetails, frameworkContext = {}) {
  const basePrompt = `Generate edits for: ${goalDetails.description}`;
  
  // Inject framework constraints into system message
  if (frameworkContext.projectProfile) {
    const profile = frameworkContext.projectProfile;
    const addition = `
## Project Framework Context

Framework: ${profile.detected.framework}
Router available: ${profile.detected.routerDependency}
Router imports found in codebase: ${profile.detected.routerImportsFound}

### Framework API Recommendations:
${profile.detected.framework === 'react' && profile.detected.routerDependency
  ? '- ✅ PREFER: react-router-dom Link for internal navigation'
  : '- ⚠️ AVOID: react-router-dom API (dependency not installed)'
}
- ✅ SAFE: Plain <a href> for all navigation

### Routing Decision:
Decision: ${frameworkContext.decision?.decision}
Confidence: ${(frameworkContext.decision?.normalized * 100).toFixed(0)}%
Rationale: ${frameworkContext.decision?.rationale}
    `.trim();
    
    return basePrompt + '\n' + addition + '\n' + basePrompt;
  }
  
  return basePrompt;
}
```

**Integration Checkpoint:**
- [ ] Add orchestrator import
- [ ] Call `analyzeProject()` with goal description
- [ ] Log analysis to console for debugging
- [ ] Pass framework context to `buildEditsPrompt()`
- [ ] Test with `npm run test:coverage` to ensure nothing breaks

---

## Integration Task 2: Activate ClarificationTracker in ChatPanel

**File:** [frontend/src/components/ChatPanel.jsx](frontend/src/components/ChatPanel.jsx)

**What to Change:**
When a goal requires clarification, check ClarificationTracker before showing duplicate question.

**Before (Current):**
```javascript
const handleClarificationSubmit = async (answers) => {
  // Directly processes clarification without deduplication
  const expandedGoal = expandGoalWithClarification(goal, answers);
  await processGoal(expandedGoal);
};
```

**After (With Deduplication):**
```javascript
import { ClarificationTracker } from '../utils/ClarificationTracker.js';

// Create tracker per branch/goal
const clarificationTracker = useRef(new ClarificationTracker());

const handleClarificationNeeded = (question) => {
  const intent = question; // or extract intent from question
  const category = 'features'; // categorize based on goal type
  
  // Check if we've already asked this question
  if (clarificationTracker.current.hasAsked(category, intent)) {
    // Use cached answer
    const cachedAnswer = clarificationTracker.current.getAnswer(category, intent);
    console.log('[Clarification] Using cached answer for:', intent);
    return cachedAnswer;
  }
  
  // First time asking - show modal
  console.log('[Clarification] Asking new question:', intent);
  showClarificationModal(question);
};

const handleClarificationSubmit = async (answers) => {
  const category = 'features';
  
  // Record the answer in tracker
  for (const [intent, answer] of Object.entries(answers)) {
    clarificationTracker.current.record(
      category, 
      intent, 
      intent, // question
      answer
    );
  }
  
  // Now expand goal with clarified answers
  const expandedGoal = expandGoalWithClarification(goal, answers);
  await processGoal(expandedGoal);
};

// Export tracker state for persistence (optional)
const exportTrackerState = () => {
  return clarificationTracker.current.export();
};
```

**Integration Checkpoint:**
- [ ] Import ClarificationTracker
- [ ] Create useRef for tracker instance
- [ ] Check `hasAsked()` before showing modal
- [ ] Call `record()` on clarification submission
- [ ] Test by asking similar questions (verify second is skipped)

---

## Integration Task 3: Show ApprovalModal for Medium-Confidence Decisions

**File:** [frontend/src/App.jsx](frontend/src/App.jsx)

**What to Change:**
Wire ApprovalModal to show when decision confidence is medium (0.4-0.69).

**Before (Current):**
```javascript
// ApprovalModal imported but not triggered by decision
<ApprovalModal 
  isVisible={false}
  decision={null}
/>
```

**After (With Confidence Gating):**
```javascript
import { ApprovalModal } from './components/ApprovalModal.jsx';
import * as orchestrator from '../tools/framework-orchestrator.mjs';

export function App() {
  const [decision, setDecision] = useState(null);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  
  // Listen for decision from goal automation
  useEffect(() => {
    const handleDecision = (event) => {
      const dec = event.detail;
      setDecision(dec);
      
      // Show approval modal ONLY for medium-confidence decisions
      if (orchestrator.requiresApproval(dec)) {
        setShowApprovalModal(true);
      } else if (orchestrator.canAutoApply(dec)) {
        console.log('[App] High confidence decision, proceeding automatically');
        setShowApprovalModal(false);
      } else {
        console.log('[App] Low confidence decision, using fallback');
        setShowApprovalModal(false);
      }
    };
    
    window.addEventListener('framework:decision', handleDecision);
    return () => window.removeEventListener('framework:decision', handleDecision);
  }, []);
  
  const handleApprovalSubmit = async (approved) => {
    if (approved) {
      // Emit approval event - goal automation will proceed with router
      window.dispatchEvent(new CustomEvent('framework:approval', {
        detail: { approved: true, decision }
      }));
    } else {
      // Use fallback - goal automation will use safe HTML
      window.dispatchEvent(new CustomEvent('framework:approval', {
        detail: { approved: false, fallback: 'html', decision }
      }));
    }
    setShowApprovalModal(false);
  };
  
  return (
    <div className="app">
      <ChatPanel />
      
      <ApprovalModal
        isVisible={showApprovalModal}
        decision={decision}
        onApprove={() => handleApprovalSubmit(true)}
        onDismiss={() => handleApprovalSubmit(false)}
      />
    </div>
  );
}
```

**Event Flow Diagram:**
```
[processGoal]  → analyzeProject() → decision.json
                                         ↓
                    window.dispatchEvent('framework:decision')
                                         ↓
[App.jsx]  (listens) → Check confidence → Show ApprovalModal?
                                         ↓
            [User clicks Approve]  → window.dispatchEvent('framework:approval')
                                         ↓
[processGoal]  (listens) → Continue with generation
```

**Integration Checkpoint:**
- [ ] Wire decision event listener
- [ ] Check `requiresApproval()` to gate modal
- [ ] Emit approval event on user action
- [ ] Log modal visibility for debugging
- [ ] Test with medium-confidence project

---

## Integration Task 4: Add Diagnostic Logging

**File:** [frontend/src/services/goalAutomation/telemetry.js](frontend/src/services/goalAutomation/telemetry.js) (new)

**What to Add:**
Log decision metrics and user overrides for analysis.

```javascript
/**
 * Decision Telemetry
 * Logs framework decisions, confidences, and user overrides for analysis
 */

export class DecisionTelemetry {
  constructor() {
    this.entries = [];
  }

  logDecision(decision, context = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      framework: context.framework,
      decision: decision.decision,
      confidence: decision.normalized,
      rationale: decision.rationale,
      userApproved: context.userApproved,
      testOutcome: context.testOutcome,
      context
    };
    this.entries.push(entry);
    console.log('[Telemetry]', entry);
  }

  export() {
    return this.entries;
  }

  clear() {
    this.entries = [];
  }
}

export const telemetry = new DecisionTelemetry();
```

**Usage in processGoal:**
```javascript
import { telemetry } from './telemetry.js';

export async function processGoal(goalDetails) {
  const analysis = await orchestrator.analyzeProject(goalDetails.description);
  
  // Log initial decision
  telemetry.logDecision(analysis.decision, {
    framework: analysis.profile?.detected?.framework,
    goal: goalDetails.description
  });
  
  // ... generate edits ...
  
  // Log with outcome
  telemetry.logDecision(analysis.decision, {
    framework: analysis.profile?.detected?.framework,
    goal: goalDetails.description,
    userApproved: userApprovedIfAsked,
    testOutcome: 'passed' // or 'failed'
  });
}
```

**Integration Checkpoint:**
- [ ] Create telemetry module
- [ ] Log decisions during processing
- [ ] Store telemetry to localStorage or backend
- [ ] Analyze logs to refine confidence thresholds

---

## Integration Task 5: Update Prompt Engineering

**File:** [frontend/src/services/buildEditsPrompt.js](frontend/src/services/buildEditsPrompt.js)

**Key Additions:**
Inject framework profile into system message.

```javascript
export function buildEditsPrompt(goal, frameworkContext = {}) {
  const {
    projectProfile,
    decision,
    safeguards
  } = frameworkContext;

  const systemMessage = `
## Your Task
${goal.description}

## Project Context
${projectProfile ? `
Framework: ${projectProfile.detected.framework}
Router Library Available: ${projectProfile.detected.routerDependency ? '✅ YES' : '❌ NO (would break)'}
Router Imports Present: ${projectProfile.detected.routerImportsFound ? 'Yes' : 'No'}
` : 'No framework context available'}

## Generation Safeguards
${safeguards ? `
- Safe to use router API: ${safeguards.safeToGenerate.withRouter}
- Must use HTML fallback if: Missing router dependency
- Recommendation: ${safeguards.safeToGenerate.recommendation}
` : 'Use standard HTML navigation'}

## Api Constraints
${projectProfile?.detected?.routerDependency
  ? '✅ You MAY use react-router-dom Link components for internal navigation'
  : '❌ You MUST NOT use react-router-dom (dependency not installed)'
}

Always use standard HTML <a href> tags as a safe fallback.
  `.trim();

  return systemMessage;
}
```

**Integration Checkpoint:**
- [ ] Inject framework profile into system message
- [ ] Include safeguards recommendations
- [ ] Test LLM follows constraints
- [ ] Compare code quality with/without hints

---

## Testing Integration

### Unit Tests

```bash
# Test orchestrator
npm run test -- tools/framework-orchestrator.mjs

# Test ClarificationTracker deduplication
npm run test -- frontend/src/utils/ClarificationTracker.js

# Test ApprovalModal renders
npm run test -- frontend/src/components/ApprovalModal.test.jsx
```

### Integration Tests

```bash
# Run with diagnostics
node ./tools/failure-prevention-diagnostics.mjs

# Expected output:
#   ✅ Duplicate question PREVENTED
#   ✅ Dependency confusion PREVENTED
#   ✅ Cascading tests PREVENTED
```

### Manual Testing Checklist

- [ ] Create new project (no react-router-dom installed)
- [ ] Generate navbar via chat
- [ ] Verify: ApprovalModal shows (not auto-generated)
- [ ] Verify: Second similar question skipped (ClarificationTracker)
- [ ] Choose "Install router" → shows npm install command
- [ ] Choose "Use HTML fallback" → generates <a> tags
- [ ] Verify tests pass with generated code

---

## Deployment Checklist

- [ ] All imports are correct (no broken paths)
- [ ] No console.warn in production
- [ ] Telemetry is stored (localStorage or backend)
- [ ] ApprovalModal styling matches existing UI
- [ ] Event system is tested end-to-end
- [ ] README updated with new capabilities
- [ ] All tests pass: `npm run test:coverage`

---

## Success Metrics

After integration, the system should exhibit:

| Metric | Before | After |
|--------|--------|-------|
| Duplicate clarifications | Frequent | Never |
| Router API generated without dependency | Yes (broken) | Never (fallback used) |
| Test loops on new projects | 8+ failures | 0 (approval gates) |
| Time to resolve issue | Manual intervention | Auto-prevented |
| User satisfaction | Low (repeated questions) | High (one question) |

---

## Rollback Plan

If issues arise after integration:

1. **Graceful Degradation:** All three components have fallbacks
   - If orchestrator fails: Continue with safe defaults
   - If ClarificationTracker fails: Show question again (safe, just redundant)
   - If ApprovalModal fails: Fall back to automatic code generation

2. **Disable Specific Features:**
   ```javascript
   // Temporarily disable approval modal
   if (orchestrator.requiresApproval(decision)) {
     // Comment out: setShowApprovalModal(true);
     console.warn('[DEBUG] Approval modal disabled');
   }
   ```

3. **Revert Commits:**
   ```bash
   git revert HEAD~5 # Revert last 5 integration commits
   ```

---

## Next Steps

1. **Complete Task 1:** Wire orchestrator into processGoal.js (highest impact)
2. **Complete Task 2:** Activate ClarificationTracker in ChatPanel
3. **Complete Task 3:** Show ApprovalModal for medium-confidence
4. **Test End-to-End:** Run failure prevention diagnostics
5. **Monitor Real Usage:** Collect telemetry data for threshold refinement

---

## Resources

- [FAILURE_PREVENTION_ANALYSIS.md](FAILURE_PREVENTION_ANALYSIS.md) - Detailed failure mechanism analysis
- [FRAMEWORK_DECISION_ENGINE_INTEGRATION.md](FRAMEWORK_DECISION_ENGINE_INTEGRATION.md) - Architecture overview
- [failure-prevention-diagnostics.mjs](tools/failure-prevention-diagnostics.mjs) - Running diagnostics
- [framework-orchestrator.mjs](tools/framework-orchestrator.mjs) - Orchestrator API reference
- [ClarificationTracker.js](frontend/src/utils/ClarificationTracker.js) - Deduplication reference
