const normalize = (value) => (typeof value === 'string' ? value.trim() : '');

const buildStageHeader = (stage) => `Stage: ${stage}`;

const buildGoalSection = (goalPrompt) => {
  const goal = normalize(goalPrompt);
  return goal ? `Goal Details:\n${goal}` : 'Goal Details:\nFollow the previously described requirement.';
};

const buildTestSummarySection = (testSummary) => {
  const summary = normalize(testSummary);
  if (!summary) {
    return 'Latest Test Context:\n(No additional test output was provided.)';
  }
  return `Latest Test Context:\n${summary}`;
};

const buildGuidanceSection = (guidance) => {
  const text = normalize(guidance);
  if (!text) {
    return '';
  }
  return `User Guidance:\n${text}`;
};

export const buildFailingTestsPrompt = (goalPrompt) => [
  buildStageHeader('Write failing tests'),
  'Add or update automated tests that will fail until the implementation fulfills the requirement. Focus on high-signal assertions and avoid implementing the feature itself in this stage.',
  'Cover both the core success path and at least one edge case. Tests should clearly communicate the expected behaviour and reference the relevant files.',
  buildGoalSection(goalPrompt)
].join('\n\n');

export const buildImplementationPrompt = (goalPrompt, testSummary) => [
  buildStageHeader('Implement feature'),
  'All required failing tests have been written. Update the production code to satisfy them without weakening the assertions. Keep the edits scoped to the described goal.',
  buildTestSummarySection(testSummary),
  buildGoalSection(goalPrompt)
].join('\n\n');

export const buildVerificationFixPrompt = (goalPrompt, testSummary, attempt, maxAttempts) => [
  buildStageHeader(`Stabilize verification run (${attempt}/${maxAttempts})`),
  'Tests or coverage gates are still failing. Investigate the reported issues and adjust the implementation without deleting or ignoring the failing checks.',
  buildTestSummarySection(testSummary),
  buildGoalSection(goalPrompt)
].join('\n\n');

export const buildUserGuidanceFixPrompt = (goalPrompt, testSummary, guidance) => [
  buildStageHeader('Apply user guidance'),
  'Incorporate the additional instructions while keeping all earlier tests and expectations intact.',
  buildGuidanceSection(guidance),
  buildTestSummarySection(testSummary),
  buildGoalSection(goalPrompt)
].join('\n\n');

export default {
  buildFailingTestsPrompt,
  buildImplementationPrompt,
  buildUserGuidanceFixPrompt,
  buildVerificationFixPrompt
};
