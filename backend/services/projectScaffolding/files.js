import fs from 'fs/promises';
import path from 'path';

export const sanitizeProjectName = (name) => {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
};

export const ensureDirectory = async (dirPath) => {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
};

export const writeFile = async (filePath, content) => {
  await ensureDirectory(path.dirname(filePath));

  // Handle different content types
  if (content === undefined || content === null) {
    throw new Error(`Content is undefined for file: ${filePath}`);
  }

  let normalizedContent = content;
  if (typeof normalizedContent === 'object') {
    normalizedContent = JSON.stringify(normalizedContent, null, 2);
  } else if (typeof normalizedContent !== 'string') {
    normalizedContent = String(normalizedContent);
  }

  await fs.writeFile(filePath, normalizedContent);
};

export const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};
