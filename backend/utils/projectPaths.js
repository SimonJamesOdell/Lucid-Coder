import path from 'path';

export const sanitizeProjectName = (name = '') =>
  name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');

export const getProjectsDir = () => {
  const overrideDir = process.env.PROJECTS_DIR;
  if (overrideDir && overrideDir.trim().length > 0) {
    return path.isAbsolute(overrideDir)
      ? overrideDir
      : path.join(process.cwd(), overrideDir);
  }
  return path.join(process.cwd(), '..', 'projects');
};

export const resolveProjectPath = (name) => {
  const sanitizedName = sanitizeProjectName(name || '');
  return path.join(getProjectsDir(), sanitizedName);
};
