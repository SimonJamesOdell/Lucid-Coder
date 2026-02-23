import { advanceGoalPhase, fetchGoals, planMetaGoal } from '../../utils/goalsApi';
import { ensureBranch } from './ensureBranch';
import { processGoal } from './processGoal';
import { notifyGoalsUpdated } from './automationUtils';

const GOAL_READY_PHASES = ['testing', 'implementing', 'verifying', 'ready'];

const updatePreviewPanelTab = (setPreviewPanelTab, tab, payload, options = {}) => {
  if (options?.preservePreviewTab) {
    return;
  }
  setPreviewPanelTab?.(tab, payload);
};

export async function processGoals(
  childGoals,
  projectId,
  project,
  setPreviewPanelTab,
  setGoalCount,
  createMessage,
  setMessages,
  options = {}
) {
  if (!Array.isArray(childGoals) || childGoals.length === 0) {
    return { success: true, processed: 0 };
  }

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

  const resolveChildren = (goal) => (Array.isArray(goal?.children) ? goal.children : []);
  const shouldProcessParent = Boolean(options.processParentGoals);

  const advanceGoalToReady = async (goalId) => {
    if (!goalId) {
      return false;
    }

    try {
      for (const phase of GOAL_READY_PHASES) {
        await advanceGoalPhase(goalId, phase);
      }
      return true;
    } catch {
      return false;
    }
  };

  const advanceGoalsTreeToReady = async (goals = []) => {
    let advancedCount = 0;
    for (const goal of goals) {
      if (!(await waitWhilePaused())) {
        break;
      }

      if (await advanceGoalToReady(goal?.id)) {
        advancedCount += 1;
      }

      const children = resolveChildren(goal);
      if (children.length > 0) {
        advancedCount += await advanceGoalsTreeToReady(children);
      }
    }
    return advancedCount;
  };

  const projectPath = project.path;
  const projectInfo = `Project: ${project.name}\nFramework: ${project.framework || 'unknown'}\nLanguage: ${
    project.language || 'javascript'
  }\nPath: ${projectPath}`;

  updatePreviewPanelTab(setPreviewPanelTab, 'goals', { source: 'automation' }, options);

  await new Promise((resolve) => setTimeout(resolve, 40));

  const processTree = async (goals, count = 0) => {
    let processed = count;
    for (let index = 0; index < goals.length; index += 1) {
      const goal = goals[index];
      if (!(await waitWhilePaused())) {
        return { success: false, processed, cancelled: true, styleShortcutChangeApplied: Boolean(options?.__styleShortcutChangeApplied) };
      }
      const children = resolveChildren(goal);
      if (children.length > 0) {
        const childResult = await processTree(children, processed);
        if (!childResult.success) {
          return childResult;
        }
        processed = childResult.processed;

        if (options?.preservePreviewTab && childResult.styleShortcutChangeApplied === true) {
          const remainingGoals = goals.slice(index + 1);
          processed += await advanceGoalsTreeToReady(remainingGoals);
          return { success: true, processed, styleShortcutChangeApplied: true };
        }

        if (!shouldProcessParent) {
          continue;
        }
      }

      const result = await processGoal(
        goal,
        projectId,
        projectPath,
        projectInfo,
        setPreviewPanelTab,
        setGoalCount,
        createMessage,
        setMessages,
        options
      );

      if (result?.skipped) {
        continue;
      }

      if (!result.success) {
        return { success: false, processed, styleShortcutChangeApplied: Boolean(options?.__styleShortcutChangeApplied) };
      }

      processed += 1;

      if (options?.preservePreviewTab && options?.__styleShortcutChangeApplied === true) {
        const remainingGoals = goals.slice(index + 1);
        processed += await advanceGoalsTreeToReady(remainingGoals);
        return { success: true, processed, styleShortcutChangeApplied: true };
      }
    }

    return { success: true, processed, styleShortcutChangeApplied: Boolean(options?.__styleShortcutChangeApplied) };
  };

  return processTree(childGoals);
}

export async function handlePlanOnlyFeature(
  projectId,
  project,
  prompt,
  setPreviewPanelTab,
  setGoalCount,
  createMessage,
  setMessages,
  options = {}
) {
  setMessages((prev) => [
    ...prev,
    createMessage('assistant', 'Planning goals (no tests for this style-only change)…', { variant: 'status' })
  ]);

  const planned = await planMetaGoal({ projectId, prompt });

  try {
    const goalsData = await fetchGoals(projectId);
    setGoalCount(Array.isArray(goalsData) ? goalsData.length : 0);
  } catch {
    setGoalCount(0);
  } finally {
    notifyGoalsUpdated(projectId);
  }

  updatePreviewPanelTab(setPreviewPanelTab, 'goals', { source: 'automation' }, options);

  setMessages((prev) => [
    ...prev,
    createMessage('assistant', 'Goals created.', { variant: 'status' })
  ]);

  setTimeout(async () => {
    await ensureBranch(projectId, prompt, setPreviewPanelTab, createMessage, setMessages, options);

    const clarifyingQuestions =
      planned?.questions || planned?.clarifyingQuestions || planned?.parent?.metadata?.clarifyingQuestions || [];
    if (Array.isArray(clarifyingQuestions) && clarifyingQuestions.length > 0) {
      setMessages((prev) => [
        ...prev,
        createMessage('assistant', 'I need clarification before proceeding:', { variant: 'status' }),
        ...clarifyingQuestions.map((question) =>
          createMessage('assistant', question, { variant: 'status' })
        )
      ]);
      return { success: true, processed: 0, needsClarification: true, clarifyingQuestions };
    }

    const childGoals = planned?.children || [];
    return processGoals(
      childGoals,
      projectId,
      project,
      setPreviewPanelTab,
      setGoalCount,
      createMessage,
      setMessages,
      options
    );
  }, 40);
}

export async function handleRegularFeature(
  projectId,
  project,
  prompt,
  result,
  setPreviewPanelTab,
  setGoalCount,
  createMessage,
  setMessages,
  options = {}
) {
  try {
    const goalsData = await fetchGoals(projectId);
    setGoalCount(Array.isArray(goalsData) ? goalsData.length : 0);
  } catch {
    setGoalCount(0);
  } finally {
    notifyGoalsUpdated(projectId);
  }

  updatePreviewPanelTab(setPreviewPanelTab, 'goals', { source: 'automation' }, options);

  setMessages((prev) => [
    ...prev,
    createMessage('assistant', 'Goals created.', { variant: 'status' })
  ]);

  await new Promise((resolve) => setTimeout(resolve, 40));

  await ensureBranch(projectId, prompt, setPreviewPanelTab, createMessage, setMessages, options);

  const clarifyingQuestions =
    result?.questions || result?.clarifyingQuestions || result?.parent?.metadata?.clarifyingQuestions || [];
  if (Array.isArray(clarifyingQuestions) && clarifyingQuestions.length > 0) {
    setMessages((prev) => [
      ...prev,
      createMessage('assistant', 'I need clarification before proceeding:', { variant: 'status' }),
      ...clarifyingQuestions.map((question) =>
        createMessage('assistant', question, { variant: 'status' })
      )
    ]);
    return { success: true, processed: 0, needsClarification: true, clarifyingQuestions };
  }

  const childGoals = result?.children || [];
  return processGoals(
    childGoals,
    projectId,
    project,
    setPreviewPanelTab,
    setGoalCount,
    createMessage,
    setMessages,
    options
  );
}
