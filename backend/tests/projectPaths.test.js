import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import {
  sanitizeProjectName,
  getProjectsDir,
  resolveProjectPath
} from '../utils/projectPaths.js';

const setProjectsDir = (value) => {
  if (value === undefined) {
    delete process.env.PROJECTS_DIR;
    return;
  }
  process.env.PROJECTS_DIR = value;
};

describe('projectPaths', () => {
  let cwdSpy;
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.PROJECTS_DIR;
    setProjectsDir(undefined);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(path.join(path.sep, 'repo'));
  });

  afterEach(() => {
    setProjectsDir(originalEnv);
    cwdSpy?.mockRestore();
  });

  describe('sanitizeProjectName', () => {
    it('lowercases and replaces invalid characters', () => {
      expect(sanitizeProjectName('  Mixed CASE 123 !! ')).toBe('mixed-case-123---');
    });

    it('returns empty string for missing names', () => {
      expect(sanitizeProjectName()).toBe('');
    });
  });

  describe('getProjectsDir', () => {
    it('falls back to ../projects when no override provided', () => {
      const expected = path.join(process.cwd(), '..', 'projects');
      expect(getProjectsDir()).toBe(expected);
    });

    it('resolves relative overrides against the working directory', () => {
      setProjectsDir('custom-projects');
      const expected = path.join(process.cwd(), 'custom-projects');
      expect(getProjectsDir()).toBe(expected);
    });

    it('accepts absolute overrides as-is', () => {
      const absoluteOverride = path.join(path.sep, 'var', 'projects');
      setProjectsDir(absoluteOverride);
      expect(getProjectsDir()).toBe(absoluteOverride);
    });
  });

  describe('resolveProjectPath', () => {
    it('joins the sanitized project name with the projects directory', () => {
      setProjectsDir('workspace/projects');
      const expectedBase = path.join(process.cwd(), 'workspace', 'projects');
      expect(resolveProjectPath('My Sample App!')).toBe(path.join(expectedBase, 'my-sample-app-'));
    });

    it('handles undefined project names by resolving to the base directory', () => {
      const expectedBase = path.join(process.cwd(), '..', 'projects');
      expect(resolveProjectPath()).toBe(expectedBase);
    });
  });
});
