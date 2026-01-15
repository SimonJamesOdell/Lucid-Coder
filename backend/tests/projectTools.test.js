import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { readProjectFile, writeProjectFile, listProjectDirectory } from '../services/projectTools.js';
import { getProject } from '../database.js';
import { resolveProjectPath } from '../utils/projectPaths.js';

vi.mock('../database.js', () => ({
  getProject: vi.fn()
}));

vi.mock('../utils/projectPaths.js', () => ({
  resolveProjectPath: vi.fn()
}));

describe('projectTools', () => {
  let projectRoot;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-tools-'));
    getProject.mockResolvedValue({ id: 1, name: 'demo', path: projectRoot });
    resolveProjectPath.mockReturnValue(projectRoot);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('writeProjectFile persists content inside the project root', async () => {
    const relativePath = 'src/app.js';
    const absolutePath = path.join(projectRoot, relativePath);

    await writeProjectFile(1, relativePath, 'console.log("hi")');

    const content = await fs.readFile(absolutePath, 'utf-8');
    expect(content).toBe('console.log("hi")');
    const readBack = await readProjectFile(1, relativePath);
    expect(readBack).toBe('console.log("hi")');
  });

  it('defaults to an empty string when content is undefined', async () => {
    const relativePath = 'src/empty.txt';
    const absolutePath = path.join(projectRoot, relativePath);

    await writeProjectFile(1, relativePath);

    const persisted = await fs.readFile(absolutePath, 'utf-8');
    expect(persisted).toBe('');
  });

  it('writeProjectFile rejects paths that escape the project root', async () => {
    await expect(writeProjectFile(1, '../secrets.txt', 'nope')).rejects.toThrow(/invalid project file path/i);
  });

  it('readProjectFile requires a project id', async () => {
    await expect(readProjectFile(undefined, 'README.md')).rejects.toThrow(/projectid is required/i);
  });

  it('rejects empty relative paths', async () => {
    await expect(readProjectFile(1, '   ')).rejects.toThrow(/relativepath is required/i);
  });

  it('readProjectFile throws when project is missing', async () => {
    getProject.mockResolvedValueOnce(undefined);
    await expect(readProjectFile(42, 'README.md')).rejects.toThrow(/project 42 not found/i);
  });

  it('falls back to resolveProjectPath when project path is empty', async () => {
    const fallbackRoot = path.join(projectRoot, 'named-project');
    getProject.mockResolvedValueOnce({ id: 7, name: 'demo', path: '   ' });
    resolveProjectPath.mockReturnValueOnce(fallbackRoot);

    await writeProjectFile(7, 'README.md', 'hi');

    const stored = await fs.readFile(path.join(fallbackRoot, 'README.md'), 'utf-8');
    expect(stored).toBe('hi');
  });

  it('throws when project lacks an accessible path', async () => {
    getProject.mockResolvedValueOnce({ id: 8 });
    await expect(writeProjectFile(8, 'README.md', 'hi')).rejects.toThrow(/does not have an accessible path/i);
  });

  it('listProjectDirectory lists entries and maps directory/file types', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'README.md'), 'hello', 'utf-8');
    await fs.writeFile(path.join(projectRoot, 'src', 'index.js'), 'console.log(1)', 'utf-8');

    const rootEntries = await listProjectDirectory(1, '');
    expect(rootEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'src', type: 'dir' }),
        expect.objectContaining({ name: 'README.md', type: 'file' })
      ])
    );

    const srcEntries = await listProjectDirectory(1, 'src');
    expect(srcEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'index.js', type: 'file' })
      ])
    );
  });

  it('listProjectDirectory rejects paths that escape the project root', async () => {
    await expect(listProjectDirectory(1, '../secrets')).rejects.toThrow(/invalid project file path/i);
  });
});
