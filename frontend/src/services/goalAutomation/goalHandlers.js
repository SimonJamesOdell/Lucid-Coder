import { fetchGoals, planMetaGoal } from '../../utils/goalsApi';
import { ensureBranch } from './ensureBranch';
import { processGoal } from './processGoal';

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

  const projectPath = project.path;
  const projectInfo = `Project: ${project.name}\nFramework: ${project.framework || 'unknown'}\nLanguage: ${
    project.language || 'javascript'
  }\nPath: ${projectPath}`;

  setPreviewPanelTab?.('goals', { source: 'automation' });

  await new Promise((resolve) => setTimeout(resolve, 400));

  let processed = 0;
  for (const childGoal of childGoals) {
    const result = await processGoal(
      childGoal,
      projectId,
      projectPath,
      projectInfo,
      setPreviewPanelTab,
      setGoalCount,
      createMessage,
      setMessages,
      options
    );

    if (!result.success) {
      return { success: false, processed };
    }

    processed += 1;
  }

  return { success: true, processed };
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
  }

  setPreviewPanelTab?.('goals', { source: 'automation' });

  setMessages((prev) => [
    ...prev,
    createMessage('assistant', 'Goals created.', { variant: 'status' })
  ]);

  setTimeout(async () => {
    await ensureBranch(projectId, prompt, setPreviewPanelTab, createMessage, setMessages, options);

    const childGoals = planned?.children || [];
    await processGoals(
      childGoals,
      projectId,
      project,
      setPreviewPanelTab,
      setGoalCount,
      createMessage,
      setMessages,
      options
    );
  }, 400);
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
  }

  setPreviewPanelTab?.('goals', { source: 'automation' });

  setMessages((prev) => [
    ...prev,
    createMessage('assistant', 'Goals created.', { variant: 'status' })
  ]);

  await new Promise((resolve) => setTimeout(resolve, 400));

  await ensureBranch(projectId, prompt, setPreviewPanelTab, createMessage, setMessages, options);

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
