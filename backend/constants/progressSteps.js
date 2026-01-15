export const PROJECT_CREATION_STEPS = [
  'Creating directories',
  'Generating files',
  'Initializing git repository',
  'Installing dependencies',
  'Starting development servers'
];

export const buildProgressSteps = (completedCount = 0) =>
  PROJECT_CREATION_STEPS.map((name, index) => ({
    name,
    completed: index < completedCount
  }));

export const calculateCompletion = (completedCount = 0) => {
  const totalSteps = PROJECT_CREATION_STEPS.length || 1;
  const normalized = Math.min(totalSteps, Math.max(0, completedCount));
  return Math.round((normalized / totalSteps) * 100);
};
