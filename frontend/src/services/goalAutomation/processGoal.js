import axios from 'axios';
import { fetchGoals, advanceGoalPhase } from '../../utils/goalsApi';
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
  return null;
};

const describeInstructionOnlyOutcome = (type) => {
  if (type === 'branch-only') {
    return 'Branch setup handled automatically';
  }
  if (type === 'stage-only') {
    return 'Files are already staged after edits';
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
  try {
    const scopeReflectionGloballyDisabled =
      typeof globalThis !== 'undefined' && globalThis.__LUCIDCODER_DISABLE_SCOPE_REFLECTION === true;
    const allowEmptyStageEdits =
      typeof globalThis !== 'undefined' && globalThis.__LUCIDCODER_ALLOW_EMPTY_STAGE === true;

    automationLog('processGoal:start', {
      projectId,
      goalId: goal?.id,
      prompt: String(goal?.prompt || '').slice(0, 240)
    });

    const requestEditorFocus = typeof options?.requestEditorFocus === 'function' ? options.requestEditorFocus : null;
    const syncBranchOverview = typeof options?.syncBranchOverview === 'function' ? options.syncBranchOverview : null;
    const testFailureContext = options?.testFailureContext || null;
    const testsAttemptSequence = resolveAttemptSequence(options?.testsAttemptSequence);
    const implementationAttemptSequence = resolveAttemptSequence(options?.implementationAttemptSequence);

    const ensurePhasesAdvanced = async (phases) => {
      for (const phase of phases) {
        await advanceGoalPhase(goal.id, phase);
        notifyGoalsUpdated(projectId);
        automationLog('processGoal:phase', { goalId: goal?.id, phase });
      }
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

      setMessages((prev) => [
        ...prev,
        createMessage('assistant', `Completed (${outcomeNote}): ${goal.prompt}`, { variant: 'status' })
      ]);

      return { success: true, skippedReason: type };
    };

    const instructionOnlyType = classifyInstructionOnlyGoal(goal?.prompt);
    if (instructionOnlyType) {
      return completeInstructionOnlyGoal(instructionOnlyType);
    }

    const scopeReflectionEnabled =
      typeof options?.enableScopeReflection === 'boolean'
        ? options.enableScopeReflection
        : !scopeReflectionGloballyDisabled;
    let scopeReflection = null;
    if (scopeReflectionEnabled) {
      try {
        const reflectionResponse = await axios.post(
          '/api/llm/generate',
          buildScopeReflectionPrompt({ projectInfo, goalPrompt: goal?.prompt })
        );
        scopeReflection = parseScopeReflectionResponse(reflectionResponse);
        const normalizedPrompt = typeof goal?.prompt === 'string' ? goal.prompt.toLowerCase() : '';
        const isTestFixGoal = /fix\s+failing\s+test|failing\s+test|test\s+failure/.test(normalizedPrompt);
        if (scopeReflection && (testFailureContext || isTestFixGoal)) {
          scopeReflection.testsNeeded = true;
        }
        automationLog('processGoal:scopeReflection', {
          goalId: goal?.id,
          testsNeeded: scopeReflection?.testsNeeded !== false,
          mustChange: scopeReflection?.mustChange,
          mustAvoid: scopeReflection?.mustAvoid
        });
      } catch (error) {
        automationLog('processGoal:scopeReflection:error', { message: error?.message });
      }
    }

    const testsStageEnabled = scopeReflection?.testsNeeded !== false;

    await ensurePhasesAdvanced(['testing']);

    const updatedGoals = await fetchGoals(projectId);
    setGoalCount(Array.isArray(updatedGoals) ? updatedGoals.length : 0);
    notifyGoalsUpdated(projectId);

    await new Promise((resolve) => setTimeout(resolve, 100));

    setPreviewPanelTab?.('files', { source: 'automation' });

    let lastFocusedPath = '';
    const onFileApplied = async (filePath) => {
      if (!requestEditorFocus || !filePath || filePath === lastFocusedPath) {
        return;
      }
      lastFocusedPath = filePath;
      requestEditorFocus(projectId, filePath, { source: 'automation', highlight: 'editor' });
    };

    let fileTreeContext = '';
    let relevantFilesContext = '';
    let knownPathsSet = new Set();

    const mergeKnownPathsFromTree = (paths) => {
      if (!Array.isArray(paths) || paths.length === 0) {
        return;
      }
      const normalizedPaths = paths.map((p) => normalizeRepoPath(p)).filter(Boolean);
      for (const normalized of normalizedPaths) {
        knownPathsSet.add(normalized);
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
    };

    await refreshRepoContext();

    let totalEditsReceived = 0;
    let totalEditsApplied = 0;
    let testsAttemptSucceeded = !testsStageEnabled;
    let testsRetryContext = null;

    if (testsStageEnabled) {
      const lastTestsAttempt = testsAttemptSequence[testsAttemptSequence.length - 1];
      for (const attempt of testsAttemptSequence) {
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
            scopeReflection
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

          const scopeViolation = validateEditsAgainstReflection(edits, scopeReflection);
          if (scopeViolation) {
            throw buildScopeViolationError(scopeViolation);
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

    await refreshRepoContext();

    await advanceGoalPhase(goal.id, 'implementing');
    notifyGoalsUpdated(projectId);

    automationLog('processGoal:phase', { goalId: goal?.id, phase: 'implementing' });

    let implAttemptSucceeded = false;
    let implRetryContext = null;
    const lastImplAttempt = implementationAttemptSequence[implementationAttemptSequence.length - 1];
    for (const attempt of implementationAttemptSequence) {
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
          scopeReflection
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
          if (allowEmptyStageEdits || (attempt === lastImplAttempt && mustChange.length === 0)) {
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

        const scopeViolation = validateEditsAgainstReflection(edits, scopeReflection);
        if (scopeViolation) {
          throw buildScopeViolationError(scopeViolation);
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
            message:
              'Previous attempt returned zero edits. Provide the exact modifications needed to complete the feature request.',
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
      throw new Error(
        'No repo edits were applied for this goal. The LLM likely returned no usable edits (or edits were skipped). Check the browser console for [automation] logs.'
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 80));

    setPreviewPanelTab?.('goals', { source: 'automation' });

    await advanceGoalPhase(goal.id, 'verifying');
    notifyGoalsUpdated(projectId);
    await advanceGoalPhase(goal.id, 'ready');
    notifyGoalsUpdated(projectId);

    automationLog('processGoal:phase', { goalId: goal?.id, phase: 'ready' });

    const finalGoals = await fetchGoals(projectId);
    setGoalCount(Array.isArray(finalGoals) ? finalGoals.length : 0);
    notifyGoalsUpdated(projectId);

    await new Promise((resolve) => setTimeout(resolve, 80));

    setMessages((prev) => [
      ...prev,
      createMessage('assistant', `Completed: ${goal.prompt}`, { variant: 'status' })
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

    setMessages((prev) => [
      ...prev,
      createMessage('assistant', `Error processing goal: ${errorMsg}`, { variant: 'error' })
    ]);
    return { success: false, error: errorMsg };
  }
}

export const __processGoalTestHooks = {
  classifyInstructionOnlyGoal,
  describeInstructionOnlyOutcome,
  buildScopeViolationError,
  isScopeViolationError,
  buildEmptyEditsError,
  isEmptyEditsError
};
