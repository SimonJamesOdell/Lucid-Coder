import axios from 'axios';
import { fetchGoals, advanceGoalPhase } from '../../utils/goalsApi';
import * as orchestrator from '../../utils/frameworkOrchestrator';
import {
  automationLog,
  resolveAttemptSequence,
  flattenFileTree,
  buildEditsPrompt,
  parseEditsFromLLM,
  buildRelevantFilesContext,
  applyEdits,
  buildReplacementRetryContext,
  isReplacementResolutionError,
  notifyGoalsUpdated,
  normalizeRepoPath,
  buildScopeReflectionPrompt,
  parseScopeReflectionResponse,
  validateEditsAgainstReflection
} from './automationUtils';

const buildScopeViolationError = (violation) => {
  const error = new Error(violation?.message || 'Proposed edits exceeded the requested scope.');
  error.__lucidcoderScopeViolation = violation;
  return error;
};

const isScopeViolationError = (error) => Boolean(error?.__lucidcoderScopeViolation);

const classifyInstructionOnlyGoal = (prompt) => {
  if (typeof prompt !== 'string') {
    return null;
  }
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes('create a branch') || normalized.includes('create new branch')) {
    return 'branch-only';
  }
  if (normalized.startsWith('stage ') || normalized.includes('stage the updated')) {
    return 'stage-only';
  }
  if (
    normalized.includes('verify visual integration') ||
    normalized.includes('manually verify') ||
    normalized.includes('visual verification') ||
    /^run\s+(?:the\s+)?(?:frontend|backend)\s+(?:dev\s+server|server)\b/.test(normalized)
  ) {
    return 'verification-only';
  }
  return null;
};

const describeInstructionOnlyOutcome = (type) => {
  if (type === 'branch-only') {
    return 'Branch setup handled automatically';
  }
  if (type === 'stage-only') {
    return 'Files are already staged after edits';
  }
  if (type === 'verification-only') {
    return 'Manual verification step acknowledged';
  }
  return 'No edits required';
};

const buildEmptyEditsError = (stage) => {
  const stageLabel = stage === 'tests' ? 'tests' : 'implementation';
  const error = new Error(`LLM returned no edits for the ${stageLabel} stage.`);
  error.__lucidcoderEmptyEditsStage = stageLabel;
  return error;
};

const isEmptyEditsError = (error) => Boolean(error?.__lucidcoderEmptyEditsStage);

const isGoalNotFoundError = (error) => (
  error?.response?.status === 404 || /Goal not found/i.test(error?.message || '')
);

const isFileOpFailure = (error) => Boolean(error?.__lucidcoderFileOpFailure);

const buildFileOpRetryContext = (error, knownPathsSet) => {
  const failure = error?.__lucidcoderFileOpFailure || {};
  const path = typeof failure.path === 'string' ? failure.path : null;
  const status = typeof failure.status === 'number' ? failure.status : null;
  const message = failure.message || error?.message || 'File operation failed.';
  const suggestions = (() => {
    if (!path || !(knownPathsSet instanceof Set) || knownPathsSet.size === 0) {
      return [];
    }
    const parts = path.split('/').filter(Boolean);
    const baseName = parts[parts.length - 1] || '';
    if (!baseName) {
      return [];
    }
    const matches = [];
    for (const candidate of knownPathsSet) {
      if (typeof candidate !== 'string') {
        continue;
      }
      if (candidate.endsWith(`/${baseName}`) || candidate === baseName) {
        matches.push(candidate);
      }
      if (matches.length >= 4) {
        break;
      }
    }
    return matches;
  })();

  return {
    path,
    message: status ? `${message} (status ${status})` : message,
    scopeWarning: path
      ? `Use an existing path or directory for ${path}. If creating a new file, pick a folder that exists in the repo tree.`
      : 'Use existing paths and directories from the repo tree.',
    suggestedPaths: suggestions
  };
};

const isTestFilePath = (path) => /__tests__\//.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path);

const buildCoverageScope = (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  const workspacePrefixes = new Set();
  entries.forEach((entry) => {
    const workspace = typeof entry?.workspace === 'string' ? entry.workspace.trim() : '';
    const file = typeof entry?.file === 'string' ? entry.file.trim() : '';
    normalizeRepoPath([workspace, file].filter(Boolean).join('/'));
    if (workspace) {
      workspacePrefixes.add(`${workspace}/`);
    }
  });
  return { workspacePrefixes, allowedFiles: new Set() };
};

const formatGoalLabel = (value) => {
  const raw = typeof value === 'string' ? value : '';
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  const findValueAfterPrefix = (prefix) => {
    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      const line = lines[idx];
      if (line.toLowerCase().startsWith(prefix.toLowerCase())) {
        return line.slice(prefix.length).trim();
      }
    }
    return '';
  };

  const contextual =
    findValueAfterPrefix('Current request:') ||
    findValueAfterPrefix('Original request:') ||
    findValueAfterPrefix('User answer:');

  const cleaned = (contextual || raw).replace(/\s+/g, ' ').trim();
  /* c8 ignore next */
  if (!cleaned) {
    /* c8 ignore next */
    return 'Goal';
  }
  /* v8 ignore next */
  return cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
};

const extractSelectedProjectAssets = (value) => {
  if (typeof value !== 'string') {
    return [];
  }

  const lines = value.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim().toLowerCase() === 'selected project assets:');
  if (headerIndex < 0) {
    return [];
  }

  const results = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      if (results.length > 0) {
        break;
      }
      continue;
    }

    if (!trimmed.startsWith('- ')) {
      if (results.length > 0) {
        break;
      }
      continue;
    }

    const assetPath = trimmed.slice(2).trim();
    if (assetPath) {
      results.push(assetPath);
    }
  }

  return Array.from(new Set(results));
};

const markTouchTrackerForPath = (touchTracker, filePath) => {
  if (!touchTracker || typeof touchTracker !== 'object' || typeof filePath !== 'string') {
    return;
  }

  const normalizedPath = normalizeRepoPath(filePath);
  if (!normalizedPath) {
    return;
  }

  if (normalizedPath.startsWith('frontend/')) {
    touchTracker.frontend = true;
    touchTracker.__observed = true;
    return;
  }

  if (normalizedPath.startsWith('backend/')) {
    touchTracker.backend = true;
    touchTracker.__observed = true;
    return;
  }

  if (normalizedPath.startsWith('shared/')) {
    touchTracker.frontend = true;
    touchTracker.backend = true;
    touchTracker.__observed = true;
  }
};

export async function processGoal(
  goal,
  projectId,
  projectPath,
  projectInfo,
  setPreviewPanelTab,
  setGoalCount,
  createMessage,
  setMessages,
  options = {}
) {
  let cleanupApprovalListener = null;
  try {
    const scopeReflectionGloballyDisabled =
      typeof globalThis !== 'undefined' && globalThis.__LUCIDCODER_DISABLE_SCOPE_REFLECTION === true;
    const allowEmptyStageEdits =
      typeof globalThis !== 'undefined' && globalThis.__LUCIDCODER_ALLOW_EMPTY_STAGE === true;

    const shouldPause = typeof options?.shouldPause === 'function' ? options.shouldPause : () => false;
    const shouldCancel = typeof options?.shouldCancel === 'function' ? options.shouldCancel : () => false;
    const waitWhilePaused = async () => {
      while (shouldPause()) {
        if (shouldCancel()) {
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return !shouldCancel();
    };

    automationLog('processGoal:start', {
      projectId,
      goalId: goal?.id,
      prompt: String(goal?.prompt || '').slice(0, 240)
    });

    // [FAILURE PREVENTION: Framework Analysis]
    // Early project profiling to prevent dependency confusion and inform code generation
    let frameworkAnalysis = null;
    try {
      frameworkAnalysis = await orchestrator.analyzeProject(goal?.prompt || '');
      if (frameworkAnalysis.success) {
        automationLog('processGoal:framework', {
          projectId,
          goalId: goal?.id,
          framework: frameworkAnalysis.profile?.detected?.framework,
          hasRouter: frameworkAnalysis.profile?.detected?.routerDependency,
          decision: frameworkAnalysis.decision?.decision,
          confidence: frameworkAnalysis.decision?.normalized
        });
      } else {
        automationLog('processGoal:framework:failed', {
          projectId,
          goalId: goal?.id,
          error: frameworkAnalysis.error
        });
      }
    } catch (error) {
      console.warn('[processGoal] Framework analysis error:', error?.message);
      automationLog('processGoal:framework:exception', {
        projectId,
        goalId: goal?.id,
        message: error?.message
      });
    }

    // [FAILURE PREVENTION] Emit framework decision to UI for approval gating
    if (frameworkAnalysis?.success && frameworkAnalysis?.decision) {
      try {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('processGoal:decision', {
            detail: frameworkAnalysis.decision
          }));
          console.log('[processGoal] Emitted decision event:', frameworkAnalysis.decision.decision);
        }
      } catch (error) {
        console.warn('[processGoal] Failed to emit decision event:', error?.message);
      }
    }

    // [FAILURE PREVENTION] Setup approval decision handler
    let approvalDecision = null;
    const handleApprovalDecision = (event) => {
      approvalDecision = event.detail?.approved;
      console.log('[processGoal] User approval decision:', approvalDecision);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('approval:decision', handleApprovalDecision);
    }

    // Cleanup handler for when processGoal completes
    cleanupApprovalListener = () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('approval:decision', handleApprovalDecision);
      }
    };

    const requestEditorFocus = typeof options?.requestEditorFocus === 'function' ? options.requestEditorFocus : null;
    const syncBranchOverview = typeof options?.syncBranchOverview === 'function' ? options.syncBranchOverview : null;
    const touchTracker = options?.touchTracker && typeof options.touchTracker === 'object'
      ? options.touchTracker
      : null;
    const testFailureContext = options?.testFailureContext || goal?.metadata?.testFailureContext || null;
    const testsAttemptSequence = resolveAttemptSequence(options?.testsAttemptSequence);
    const implementationAttemptSequence = resolveAttemptSequence(options?.implementationAttemptSequence);

    const safeAdvanceGoalPhase = async (phase) => {
      try {
        await advanceGoalPhase(goal.id, phase);
        notifyGoalsUpdated(projectId);
        automationLog('processGoal:phase', { goalId: goal?.id, phase });
        return true;
      } catch (error) {
        if (isGoalNotFoundError(error)) {
          automationLog('processGoal:goalMissing', { goalId: goal?.id, phase });
          try {
            const refreshedGoals = await fetchGoals(projectId);
            setGoalCount(Array.isArray(refreshedGoals) ? refreshedGoals.length : 0);
            notifyGoalsUpdated(projectId);
          } catch (refreshError) {
            automationLog('processGoal:goalMissing:refreshError', { message: refreshError?.message });
          }
          return false;
        }
        throw error;
      }
    };

    const ensurePhasesAdvanced = async (phases) => {
      for (const phase of phases) {
        const advanced = await safeAdvanceGoalPhase(phase);
        if (!advanced) {
          return false;
        }
      }
      return true;
    };

    const completeInstructionOnlyGoal = async (type) => {
      automationLog('processGoal:instructionOnly:skip', {
        goalId: goal?.id,
        type,
        prompt: goal?.prompt
      });

      await ensurePhasesAdvanced(['testing', 'implementing', 'verifying', 'ready']);

      const outcomeNote = describeInstructionOnlyOutcome(type);

      setPreviewPanelTab?.('goals', { source: 'automation' });

      const finalGoals = await fetchGoals(projectId);
      setGoalCount(Array.isArray(finalGoals) ? finalGoals.length : 0);
      notifyGoalsUpdated(projectId);

      /* c8 ignore next */
      const completionLabel = formatGoalLabel(goal?.title || goal?.prompt || 'Goal');
      setMessages((prev) => [
        ...prev,
        createMessage('assistant', `Completed (${outcomeNote}): ${completionLabel}`, { variant: 'status' })
      ]);

      return { success: true, skippedReason: type };
    };

    const instructionOnlyType = classifyInstructionOnlyGoal(goal?.prompt);
    if (instructionOnlyType) {
      return completeInstructionOnlyGoal(instructionOnlyType);
    }

    const coverageEntries = Array.isArray(goal?.metadata?.uncoveredLines)
      ? goal.metadata.uncoveredLines.filter(Boolean)
      : [];
    const isCoverageGoal = coverageEntries.length > 0;
    const coverageScope = isCoverageGoal ? buildCoverageScope(coverageEntries) : null;

    const validateCoverageScope = (edits) => {
      if (!coverageScope || !Array.isArray(edits)) {
        return null;
      }
      const { workspacePrefixes } = coverageScope;
      const allowedTestPrefixes = [];
      if (workspacePrefixes.has('frontend/')) {
        allowedTestPrefixes.push(
          'frontend/src/test/',
          'frontend/src/__tests__/',
          'frontend/src/components/__tests__/',
          'frontend/src/services/__tests__/',
          'frontend/src/utils/__tests__/'
        );
      }
      if (workspacePrefixes.has('backend/')) {
        allowedTestPrefixes.push(
          'backend/tests/',
          'backend/test/',
          'backend/__tests__/'
        );
      }
      const normalizedAllowedPrefixes = allowedTestPrefixes
        .map((prefix) => normalizeRepoPath(prefix))
        .filter(Boolean);
      const existingTestDirs = (() => {
        if (!knownDirsSet || knownDirsSet.size === 0 || normalizedAllowedPrefixes.length === 0) {
          return [];
        }
        const matches = [];
        for (const dir of knownDirsSet) {
          if (normalizedAllowedPrefixes.some((prefix) => dir.startsWith(prefix))) {
            matches.push(dir);
          }
          if (matches.length >= 6) {
            break;
          }
        }
        return matches;
      })();
      for (const edit of edits) {
        const normalizedPath = normalizeRepoPath(edit?.path);
        if (!normalizedPath) {
          continue;
        }
        if (!isTestFilePath(normalizedPath)) {
          return {
            type: 'coverage-scope',
            path: normalizedPath,
            rule: 'coverage-scope',
            message: 'Coverage fixes are limited to test files only.'
          };
        }

        if (normalizedAllowedPrefixes.length > 0) {
          const matchesAllowed = normalizedAllowedPrefixes.some((prefix) => normalizedPath.startsWith(prefix));
          if (matchesAllowed) {
            if (edit?.type === 'upsert' && knownDirsSet && knownDirsSet.size > 0) {
              const parentDir = normalizedPath.slice(0, Math.max(0, normalizedPath.lastIndexOf('/')));
              if (parentDir && !knownDirsSet.has(parentDir)) {
                const suggestionText = existingTestDirs.length > 0
                  ? ` Suggested test folders: ${existingTestDirs.join(', ')}.`
                  : '';
                return {
                  type: 'coverage-scope',
                  path: normalizedPath,
                  rule: 'coverage-scope',
                  message: `Coverage tests must be placed in existing test directories.${suggestionText}`
                };
              }
            }
            continue;
          }
        } else if (workspacePrefixes.size > 0) {
          const matchesWorkspace = Array.from(workspacePrefixes).some((prefix) => normalizedPath.startsWith(prefix));
          if (matchesWorkspace) {
            continue;
          }
        } else {
          continue;
        }
        return {
          type: 'coverage-scope',
          path: normalizedPath,
          rule: 'coverage-scope',
          message: 'Coverage fixes must stay within dedicated test folders for the target workspace.'
        };
      }
      return null;
    };

    const scopeReflectionEnabled =
      typeof options?.enableScopeReflection === 'boolean'
        ? options.enableScopeReflection
        : !scopeReflectionGloballyDisabled;
    let scopeReflection = null;
    const cloneScopeReflection = (reflection) => {
      if (!reflection || typeof reflection !== 'object') {
        return reflection;
      }
      return {
        ...reflection,
        mustChange: Array.isArray(reflection.mustChange) ? [...reflection.mustChange] : reflection.mustChange,
        mustAvoid: Array.isArray(reflection.mustAvoid) ? [...reflection.mustAvoid] : reflection.mustAvoid
      };
    };
    if (scopeReflectionEnabled) {
      try {
        const reflectionResponse = await axios.post(
          '/api/llm/generate',
          buildScopeReflectionPrompt({ projectInfo, goalPrompt: goal?.prompt })
        );
        scopeReflection = cloneScopeReflection(parseScopeReflectionResponse(reflectionResponse));
        const selectedAssetPaths = extractSelectedProjectAssets(goal?.prompt);
        if (scopeReflection && selectedAssetPaths.length > 0) {
          scopeReflection.requiredAssetPaths = selectedAssetPaths;
        }
        const normalizedPrompt = typeof goal?.prompt === 'string' ? goal.prompt.toLowerCase() : '';
        const isTestFixGoal = /fix\s+failing\s+test|failing\s+test|test\s+failure/.test(normalizedPrompt);
        if (scopeReflection && (testFailureContext || isTestFixGoal)) {
          scopeReflection.testsNeeded = true;
        }
        automationLog('processGoal:scopeReflection', {
          goalId: goal?.id,
          testsNeeded: scopeReflection?.testsNeeded !== false,
          mustChange: scopeReflection?.mustChange,
          mustAvoid: scopeReflection?.mustAvoid,
          requiredAssetPaths: scopeReflection?.requiredAssetPaths
        });
      } catch (error) {
        automationLog('processGoal:scopeReflection:error', { message: error?.message });
      }
    }

    const testsStageEnabled = scopeReflection?.testsNeeded !== false;
    const requiredAssetPaths = Array.isArray(scopeReflection?.requiredAssetPaths)
      ? scopeReflection.requiredAssetPaths
          .map((path) => (typeof path === 'string' ? path.trim() : ''))
          .filter(Boolean)
      : [];
    const hasRequiredAssetPaths = requiredAssetPaths.length > 0;

    if (!(await waitWhilePaused())) {
      return { success: false, cancelled: true };
    }

    if (!(await ensurePhasesAdvanced(['testing']))) {
      return { success: false, skipped: true };
    }

    const updatedGoals = await fetchGoals(projectId);
    setGoalCount(Array.isArray(updatedGoals) ? updatedGoals.length : 0);
    notifyGoalsUpdated(projectId);

    setPreviewPanelTab?.('files', { source: 'automation' });

    let lastFocusedPath = '';
    const onFileApplied = async (filePath) => {
      markTouchTrackerForPath(touchTracker, filePath);
      if (!requestEditorFocus || !filePath || filePath === lastFocusedPath) {
        return;
      }
      lastFocusedPath = filePath;
      requestEditorFocus(projectId, filePath, { source: 'automation', highlight: 'editor' });
    };

    let fileTreeContext = '';
    let relevantFilesContext = '';
    let knownPathsSet = new Set();
    let knownDirsSet = new Set();

    const mergeKnownPathsFromTree = (paths) => {
      if (!Array.isArray(paths) || paths.length === 0) {
        return;
      }
      const normalizedPaths = paths.map((p) => normalizeRepoPath(p)).filter(Boolean);
      for (const normalized of normalizedPaths) {
        knownPathsSet.add(normalized);
      }
    };

    const mergeKnownDirsFromTree = (paths) => {
      if (!Array.isArray(paths) || paths.length === 0) {
        return;
      }
      const normalizedPaths = paths.map((p) => normalizeRepoPath(p)).filter(Boolean);
      for (const normalized of normalizedPaths) {
        let current = normalized;
        while (current.includes('/')) {
          current = current.slice(0, current.lastIndexOf('/'));
          if (!current) {
            break;
          }
          knownDirsSet.add(current);
        }
      }
    };

    const refreshRepoContext = async () => {
      if (!projectId) {
        fileTreeContext = '';
        relevantFilesContext = '';
        return;
      }

      let fileTreePaths = [];
      try {
        const treeResponse = await axios.get(`/api/projects/${projectId}/files`);
        const fileTree = treeResponse.data?.files;
        const paths = flattenFileTree(fileTree);
        const unique = Array.from(new Set(paths)).sort();
        fileTreePaths = unique;
        const limited = unique.slice(0, 400);
        fileTreeContext = limited.length
          ? `\n\nRepo file tree (top ${limited.length} paths):\n\n${limited.join('\n')}`
          : '';

        automationLog('processGoal:fileTree', {
          totalPaths: unique.length,
          includedPaths: limited.length
        });
      } catch (error) {
        console.warn('Failed to fetch project file tree:', error);
        automationLog('processGoal:fileTree:error', { message: error?.message, status: error?.response?.status });
      }

      relevantFilesContext = await buildRelevantFilesContext({
        projectId,
        goalPrompt: goal?.prompt,
        fileTreePaths,
        testFailureContext
      });

      mergeKnownPathsFromTree(fileTreePaths);
      mergeKnownDirsFromTree(fileTreePaths);
    };

    if (!(await waitWhilePaused())) {
      return { success: false, cancelled: true };
    }
    await refreshRepoContext();

    let totalEditsReceived = 0;
    let totalEditsApplied = 0;
    let testsAttemptSucceeded = !testsStageEnabled;
    let testsRetryContext = null;

    if (testsStageEnabled) {
      const lastTestsAttempt = testsAttemptSequence[testsAttemptSequence.length - 1];
      for (const attempt of testsAttemptSequence) {
        if (!(await waitWhilePaused())) {
          return { success: false, cancelled: true };
        }
        const llmTestsResponse = await axios.post(
          '/api/llm/generate',
          buildEditsPrompt({
            projectInfo,
            fileTreeContext: `${fileTreeContext}${relevantFilesContext}`,
            goalPrompt: goal.prompt,
            stage: 'tests',
            attempt,
            retryContext: testsRetryContext,
            testFailureContext,
            scopeReflection,
            // [FAILURE PREVENTION] Inject framework context to inform LLM
            frameworkProfile: frameworkAnalysis?.profile,
            frameworkDecision: frameworkAnalysis?.decision,
            frameworkSafeguards: frameworkAnalysis?.success 
              ? orchestrator.validateGenerationSafety(frameworkAnalysis.profile, frameworkAnalysis.decision)
              : null
          })
        );
        automationLog('processGoal:llm:tests:response', {
          attempt,
          hasResponse: Boolean(llmTestsResponse),
          keys: llmTestsResponse?.data ? Object.keys(llmTestsResponse.data) : []
        });

        try {
          const edits = parseEditsFromLLM(llmTestsResponse);
          totalEditsReceived += edits.length;
          automationLog('processGoal:llm:tests:parsedEdits', {
            attempt,
            count: edits.length,
            sample: edits.slice(0, 5).map((edit) => ({ type: edit?.type, path: edit?.path }))
          });

          if (edits.length === 0) {
            const raw = llmTestsResponse?.data?.response || llmTestsResponse?.data?.content || '';
            automationLog('processGoal:llm:tests:emptyEdits', {
              attempt,
              responseType: typeof raw,
              preview: typeof raw === 'string' ? raw.slice(0, 500) : ''
            });
            if (allowEmptyStageEdits) {
              testsAttemptSucceeded = true;
              testsRetryContext = null;
              break;
            }
            throw buildEmptyEditsError('tests');
          }

          const coverageViolation = validateCoverageScope(edits);
          if (coverageViolation) {
            throw buildScopeViolationError(coverageViolation);
          }

          const scopeViolation = validateEditsAgainstReflection(edits, scopeReflection);
          if (scopeViolation) {
            throw buildScopeViolationError(scopeViolation);
          }

          if (!(await waitWhilePaused())) {
            return { success: false, cancelled: true };
          }
          const appliedSummary = await applyEdits({
            projectId,
            edits,
            source: 'ai',
            knownPathsSet,
            goalPrompt: goal?.prompt,
            stage: 'tests',
            onFileApplied,
            syncBranchOverview
          });
          totalEditsApplied += appliedSummary?.applied || 0;
          automationLog('processGoal:llm:tests:applySummary', { ...appliedSummary, attempt });
          testsAttemptSucceeded = true;
          testsRetryContext = null;
          break;
        } catch (error) {
          if (error instanceof SyntaxError) {
            console.error('Failed to parse LLM response:', error);
            automationLog('processGoal:llm:tests:parseError', { attempt, message: error?.message });
            if (attempt === lastTestsAttempt) {
              throw error;
            }
            continue;
          }

          if (isReplacementResolutionError(error) && attempt < lastTestsAttempt) {
            const retryContext = buildReplacementRetryContext(error);
            automationLog('processGoal:llm:tests:replacementRetry', {
              attempt,
              path: retryContext.path || null,
              message: retryContext.message
            });
            await refreshRepoContext();
            testsRetryContext = retryContext;
            continue;
          }

          if (isFileOpFailure(error) && attempt < lastTestsAttempt) {
            const retryContext = buildFileOpRetryContext(error, knownPathsSet);
            automationLog('processGoal:llm:tests:fileOpRetry', {
              attempt,
              path: retryContext.path || null,
              message: retryContext.message
            });
            await refreshRepoContext();
            testsRetryContext = retryContext;
            continue;
          }

          if (isScopeViolationError(error)) {
            automationLog('processGoal:llm:tests:scopeViolation', {
              attempt,
              message: error?.message,
              rule: error.__lucidcoderScopeViolation?.rule || null,
              path: error.__lucidcoderScopeViolation?.path || null
            });
            if (attempt === lastTestsAttempt) {
              throw error;
            }
            testsRetryContext = {
              message: error.__lucidcoderScopeViolation?.message,
              path: error.__lucidcoderScopeViolation?.path || null,
              scopeWarning: error.__lucidcoderScopeViolation?.message
            };
            continue;
          }

          if (isEmptyEditsError(error)) {
            automationLog('processGoal:llm:tests:emptyEditsError', {
              attempt,
              message: error?.message
            });
            if (attempt === lastTestsAttempt) {
              throw error;
            }
            testsRetryContext = {
              message:
                'Previous attempt returned zero edits. Provide at least one edit that adds or updates the required test files.',
              path: testsRetryContext?.path || null,
              scopeWarning: testsRetryContext?.scopeWarning || null
            };
            continue;
          }

          throw error;
        }
      }

      if (!testsAttemptSucceeded) {
        automationLog('processGoal:llm:tests:abort', { message: 'Unable to parse edits after retries' });
      }
    } else {
      automationLog('processGoal:llm:tests:skipped', {
        goalId: goal?.id,
        reason: 'scope-reflection',
        note: 'Reflection determined tests are unnecessary'
      });
    }

    if (!(await waitWhilePaused())) {
      return { success: false, cancelled: true };
    }
    await refreshRepoContext();

    if (!(await waitWhilePaused())) {
      return { success: false, cancelled: true };
    }
    if (!(await safeAdvanceGoalPhase('implementing'))) {
      return { success: false, skipped: true };
    }

    const skipImplementationStage = isCoverageGoal && !options?.__forceImplementationStage;
    if (skipImplementationStage) {
      automationLog('processGoal:impl:skipped', { goalId: goal?.id, reason: 'coverage-goal' });
    }

    let implAttemptSucceeded = skipImplementationStage;
    let implRetryContext = null;
    const lastImplAttempt = implementationAttemptSequence[implementationAttemptSequence.length - 1];
    for (const attempt of implementationAttemptSequence) {
      if (skipImplementationStage) {
        break;
      }
      if (!(await waitWhilePaused())) {
        return { success: false, cancelled: true };
      }
      const llmImplResponse = await axios.post(
        '/api/llm/generate',
        buildEditsPrompt({
          projectInfo,
          fileTreeContext: `${fileTreeContext}${relevantFilesContext}`,
          goalPrompt: goal.prompt,
          stage: 'implementation',
          attempt,
          retryContext: implRetryContext,
          testFailureContext,
          scopeReflection,
          // [FAILURE PREVENTION] Inject framework context to inform LLM
          frameworkProfile: frameworkAnalysis?.profile,
          frameworkDecision: frameworkAnalysis?.decision,
          frameworkSafeguards: frameworkAnalysis?.success 
            ? orchestrator.validateGenerationSafety(frameworkAnalysis.profile, frameworkAnalysis.decision)
            : null
        })
      );
      automationLog('processGoal:llm:impl:response', {
        attempt,
        hasResponse: Boolean(llmImplResponse),
        keys: llmImplResponse?.data ? Object.keys(llmImplResponse.data) : []
      });

      try {
        const edits = parseEditsFromLLM(llmImplResponse);
        totalEditsReceived += edits.length;
        automationLog('processGoal:llm:impl:parsedEdits', {
          attempt,
          count: edits.length,
          sample: edits.slice(0, 5).map((edit) => ({ type: edit?.type, path: edit?.path }))
        });

        if (edits.length === 0) {
          const raw = llmImplResponse?.data?.response || llmImplResponse?.data?.content || '';
          automationLog('processGoal:llm:impl:emptyEdits', {
            attempt,
            responseType: typeof raw,
            preview: typeof raw === 'string' ? raw.slice(0, 500) : ''
          });
          const mustChange = Array.isArray(scopeReflection?.mustChange) ? scopeReflection.mustChange : [];
          if (allowEmptyStageEdits || (attempt === lastImplAttempt && mustChange.length === 0 && !hasRequiredAssetPaths)) {
            implAttemptSucceeded = true;
            implRetryContext = null;
            setMessages((prev) => [
              ...prev,
              createMessage('assistant', `No code changes required for: ${goal?.prompt}`, { variant: 'status' })
            ]);
            break;
          }
          throw buildEmptyEditsError('implementation');
        }

        const coverageViolation = validateCoverageScope(edits);
        if (coverageViolation) {
          throw buildScopeViolationError(coverageViolation);
        }

        const scopeViolation = validateEditsAgainstReflection(edits, scopeReflection);
        if (scopeViolation) {
          throw buildScopeViolationError(scopeViolation);
        }

        if (!(await waitWhilePaused())) {
          return { success: false, cancelled: true };
        }
        const appliedSummary = await applyEdits({
          projectId,
          edits,
          source: 'ai',
          knownPathsSet,
          goalPrompt: goal?.prompt,
          stage: 'implementation',
          onFileApplied,
          syncBranchOverview
        });
        totalEditsApplied += appliedSummary?.applied || 0;
        automationLog('processGoal:llm:impl:applySummary', { ...appliedSummary, attempt });
        implAttemptSucceeded = true;
        implRetryContext = null;
        break;
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.error('Failed to parse LLM response:', error);
          automationLog('processGoal:llm:impl:parseError', { attempt, message: error?.message });
          if (attempt === lastImplAttempt) {
            throw error;
          }
          continue;
        }

        if (isReplacementResolutionError(error) && attempt < lastImplAttempt) {
          const retryContext = buildReplacementRetryContext(error);
          automationLog('processGoal:llm:impl:replacementRetry', {
            attempt,
            path: retryContext.path || null,
            message: retryContext.message
          });
          await refreshRepoContext();
          implRetryContext = retryContext;
          continue;
        }

        if (isFileOpFailure(error) && attempt < lastImplAttempt) {
          const retryContext = buildFileOpRetryContext(error, knownPathsSet);
          automationLog('processGoal:llm:impl:fileOpRetry', {
            attempt,
            path: retryContext.path || null,
            message: retryContext.message
          });
          await refreshRepoContext();
          implRetryContext = retryContext;
          continue;
        }

        if (isScopeViolationError(error)) {
          automationLog('processGoal:llm:impl:scopeViolation', {
            attempt,
            message: error?.message,
            rule: error.__lucidcoderScopeViolation?.rule || null,
            path: error.__lucidcoderScopeViolation?.path || null
          });
          if (attempt === lastImplAttempt) {
            throw error;
          }
          implRetryContext = {
            message: error.__lucidcoderScopeViolation?.message,
            path: error.__lucidcoderScopeViolation?.path || null,
            scopeWarning: error.__lucidcoderScopeViolation?.message
          };
          continue;
        }

        if (isEmptyEditsError(error)) {
          automationLog('processGoal:llm:impl:emptyEditsError', {
            attempt,
            message: error?.message
          });
          if (attempt === lastImplAttempt) {
            throw error;
          }
          implRetryContext = {
            message: hasRequiredAssetPaths
              ? `Previous attempt returned zero edits. Provide at least one implementation edit that references one of the selected asset paths: ${requiredAssetPaths.join(', ')} (for example /uploads/<filename>).`
              : 'Previous attempt returned zero edits. Provide the exact modifications needed to complete the feature request.',
            path: implRetryContext?.path || null,
            scopeWarning: implRetryContext?.scopeWarning || null
          };
          continue;
        }

        throw error;
      }
    }

    if (!implAttemptSucceeded) {
      automationLog('processGoal:llm:impl:abort', { message: 'Unable to parse edits after retries' });
    }

    automationLog('processGoal:edits:totals', {
      goalId: goal?.id,
      totalEditsReceived,
      totalEditsApplied
    });

    if (projectId && totalEditsApplied === 0) {
      if (hasRequiredAssetPaths) {
        throw new Error(
          `No repo edits were applied and none referenced the selected asset paths (${requiredAssetPaths.join(', ')}). Ensure implementation edits apply one of these assets in UI code/CSS (for example /uploads/<filename>).`
        );
      }
      throw new Error(
        'No repo edits were applied for this goal. The LLM likely returned no usable edits (or edits were skipped). Check the browser console for [automation] logs.'
      );
    }

    if (!(await waitWhilePaused())) {
      return { success: false, cancelled: true };
    }
    setPreviewPanelTab?.('goals', { source: 'automation' });

    if (!(await safeAdvanceGoalPhase('verifying'))) {
      return { success: false, skipped: true };
    }
    if (!(await safeAdvanceGoalPhase('ready'))) {
      return { success: false, skipped: true };
    }

    automationLog('processGoal:phase', { goalId: goal?.id, phase: 'ready' });

    const finalGoals = await fetchGoals(projectId);
    setGoalCount(Array.isArray(finalGoals) ? finalGoals.length : 0);
    notifyGoalsUpdated(projectId);

    const completionLabel = formatGoalLabel(goal?.title || goal?.prompt || 'Goal');
    setMessages((prev) => [
      ...prev,
      createMessage('assistant', `Completed: ${completionLabel}`, { variant: 'status' })
    ]);

    return { success: true };
  } catch (error) {
    const errorMsg = error.response?.data?.error || error.message || 'Unknown error';

    automationLog('processGoal:error', {
      projectId,
      goalId: goal?.id,
      message: errorMsg,
      status: error?.response?.status
    });

    if (isGoalNotFoundError(error)) {
      return { success: false, skipped: true, error: 'Goal not found' };
    }

    setMessages((prev) => [
      ...prev,
      createMessage('assistant', `Error processing goal: ${errorMsg}`, { variant: 'error' })
    ]);
    return { success: false, error: errorMsg };
    /* c8 ignore next */
  } finally {
    // [FAILURE PREVENTION] Cleanup approval listener
    cleanupApprovalListener?.();
  }
}

export const __processGoalTestHooks = {
  classifyInstructionOnlyGoal,
  describeInstructionOnlyOutcome,
  buildScopeViolationError,
  isScopeViolationError,
  buildEmptyEditsError,
  isEmptyEditsError,
  buildFileOpRetryContext,
  buildCoverageScope
};
