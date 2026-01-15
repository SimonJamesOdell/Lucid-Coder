import fs from 'fs/promises';
import path from 'path';
import { getProject } from '../database.js';
import { resolveProjectPath } from '../utils/projectPaths.js';

const normalizeRelativePath = (value = '') => value.replace(/^\/+/, '').trim();

export const getProjectRoot = async (projectId) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }

  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  if (project.path && project.path.trim().length > 0) {
    return path.resolve(project.path);
  }

  if (project.name) {
    return path.resolve(resolveProjectPath(project.name));
  }

  throw new Error(`Project ${projectId} does not have an accessible path`);
};

const ensureProjectRoot = getProjectRoot;

const resolveProjectRelativePath = async (projectId, relativePath) => {
  const targetPath = normalizeRelativePath(relativePath);
  if (!targetPath) {
    throw new Error('relativePath is required');
  }

  const projectRoot = path.resolve(await ensureProjectRoot(projectId));
  const absolutePath = path.resolve(projectRoot, targetPath);

  if (!(absolutePath === projectRoot || absolutePath.startsWith(`${projectRoot}${path.sep}`))) {
    throw new Error('Invalid project file path');
  }

  return { projectRoot, absolutePath };
};

export const listProjectDirectory = async (projectId, relativePath = '') => {
  const targetPath = normalizeRelativePath(relativePath);
  const root = await ensureProjectRoot(projectId);
  const absolutePath = targetPath ? path.resolve(root, targetPath) : path.resolve(root);

  if (!(absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`))) {
    throw new Error('Invalid project file path');
  }

  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? 'dir' : 'file'
  }));
};

export const readProjectFile = async (projectId, relativePath) => {
  const { absolutePath } = await resolveProjectRelativePath(projectId, relativePath);
  const content = await fs.readFile(absolutePath, 'utf-8');
  return content;
};

export const writeProjectFile = async (projectId, relativePath, content) => {
  const { absolutePath } = await resolveProjectRelativePath(projectId, relativePath);
  const dir = path.dirname(absolutePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(absolutePath, content ?? '', 'utf-8');
  return absolutePath;
};

export default {
  readProjectFile,
  writeProjectFile,
  getProjectRoot,
  listProjectDirectory
};
