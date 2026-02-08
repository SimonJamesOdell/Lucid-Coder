import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import * as automationUtils from '../../services/goalAutomation/automationUtils.js';
import { createApplyEditsModule } from '../../services/goalAutomation/automationUtils/applyEdits.js';

const projectId = 99;
const targetPath = 'frontend/src/App.jsx';

const buildModifyEdit = () => ({
  type: 'modify',
  path: targetPath,
  replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
});

describe('applyEdits modify fallbacks', () => {
  let deps;
  let restoreDeps;

  beforeEach(() => {
    vi.restoreAllMocks();
    axios.get.mockReset();
    deps = {
      readProjectFile: vi.fn().mockResolvedValue('const value = 1;'),
      applyReplacements: vi.fn().mockReturnValue('const value = 2;'),
      tryRepairModifyEdit: vi.fn(),
      tryRewriteFileWithLLM: vi.fn(),
      upsertProjectFile: vi.fn().mockResolvedValue({}),
      stageProjectFile: vi.fn().mockResolvedValue({}),
      deleteProjectPath: vi.fn().mockResolvedValue({})
    };
    restoreDeps = automationUtils.__setApplyEditsTestDeps(deps);
  });

  afterEach(() => {
    restoreDeps?.();
  });

  test('repairs modify edits via tryRepairModifyEdit when replacements fail', async () => {
    deps.applyReplacements.mockImplementationOnce(() => {
      throw new Error('Replacement search text not found');
    });
    deps.tryRepairModifyEdit.mockResolvedValue({ type: 'modify', replacements: [{ search: '1', replace: '2' }] });

    const onFileApplied = vi.fn();

    const result = await automationUtils.applyEdits({
      projectId,
      edits: [buildModifyEdit()],
      goalPrompt: 'Fix value',
      stage: 'implementation',
      onFileApplied
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(deps.tryRepairModifyEdit).toHaveBeenCalled();
    expect(deps.tryRewriteFileWithLLM).not.toHaveBeenCalled();
    expect(deps.upsertProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, filePath: targetPath, content: 'const value = 2;' })
    );
    expect(deps.stageProjectFile).toHaveBeenCalled();
    expect(onFileApplied).toHaveBeenCalledWith(targetPath, { type: 'modify' });
  });

  test('accepts upsert repairs when modify fallback cannot be produced', async () => {
    deps.applyReplacements.mockImplementationOnce(() => {
      throw new Error('Replacement search text not found');
    });
    deps.tryRepairModifyEdit.mockResolvedValue({ type: 'upsert', content: 'const value = 3;' });

    const result = await automationUtils.applyEdits({
      projectId,
      edits: [buildModifyEdit()],
      goalPrompt: 'Fix value',
      stage: 'implementation'
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(deps.applyReplacements).toHaveBeenCalledTimes(1);
    expect(deps.upsertProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'const value = 3;' })
    );
    expect(deps.tryRewriteFileWithLLM).not.toHaveBeenCalled();
  });

  test('skips modify edits that do not change file contents', async () => {
    deps.applyReplacements.mockReturnValue('const value = 1;');

    const result = await automationUtils.applyEdits({
      projectId,
      edits: [buildModifyEdit()],
      goalPrompt: 'Fix value',
      stage: 'implementation'
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(deps.upsertProjectFile).not.toHaveBeenCalled();
  });

  test('skips package.json modify edits that only duplicate existing deps', async () => {
    const originalPackageJson = '{"name":"demo","devDependencies":{"morgan":"^1.10.0"}}';
    const duplicatePackageJson =
      '{"name":"demo","devDependencies":{"morgan":"^1.10.0","morgan":"^1.10.0"}}';

    deps.readProjectFile.mockResolvedValue(originalPackageJson);
    deps.applyReplacements.mockReturnValue(duplicatePackageJson);

    const result = await automationUtils.applyEdits({
      projectId,
      edits: [
        {
          type: 'modify',
          path: 'backend/package.json',
          replacements: [{ search: '"morgan"', replace: '"morgan"' }]
        }
      ],
      goalPrompt: 'Fix deps',
      stage: 'implementation'
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(deps.upsertProjectFile).not.toHaveBeenCalled();
  });

  test('throws a file-op failure when modify targets a missing file', async () => {
    deps.readProjectFile.mockResolvedValueOnce(null);

    await expect(
      automationUtils.applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({
        path: targetPath,
        status: 404,
        operation: 'read'
      })
    });
  });

  test('builds file-op failures when createApplyEditsModule reads missing files', async () => {
    const { applyEdits } = createApplyEditsModule({
      readProjectFile: vi.fn().mockResolvedValue(null),
      applyReplacements: vi.fn(),
      tryRepairModifyEdit: vi.fn(),
      tryRewriteFileWithLLM: vi.fn(),
      upsertProjectFile: vi.fn(),
      deleteProjectPath: vi.fn(),
      stageProjectFile: vi.fn(),
      automationLog: vi.fn(),
      normalizeRepoPath: (value) => value,
      isReplacementResolutionError: vi.fn()
    });

    await expect(
      applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({
        path: targetPath,
        status: 404,
        operation: 'read'
      })
    });
  });

  test('buildFileOpFailure populates default fields', () => {
    const { __testHooks } = createApplyEditsModule({
      readProjectFile: vi.fn(),
      applyReplacements: vi.fn(),
      tryRepairModifyEdit: vi.fn(),
      tryRewriteFileWithLLM: vi.fn(),
      upsertProjectFile: vi.fn(),
      deleteProjectPath: vi.fn(),
      stageProjectFile: vi.fn(),
      automationLog: vi.fn(),
      normalizeRepoPath: (value) => value,
      isReplacementResolutionError: vi.fn()
    });

    const error = __testHooks.buildFileOpFailure({ path: 'frontend/src/App.jsx' });

    expect(error.__lucidcoderFileOpFailure).toEqual({
      path: 'frontend/src/App.jsx',
      status: null,
      message: 'File operation failed',
      operation: null
    });
  });

  test('builds file-op failures for upsert edits with status 400', async () => {
    const { applyEdits } = createApplyEditsModule({
      readProjectFile: vi.fn(),
      applyReplacements: vi.fn(),
      tryRepairModifyEdit: vi.fn(),
      tryRewriteFileWithLLM: vi.fn(),
      upsertProjectFile: vi.fn().mockRejectedValue({ response: { status: 400 } }),
      deleteProjectPath: vi.fn(),
      stageProjectFile: vi.fn(),
      automationLog: vi.fn(),
      normalizeRepoPath: (value) => value,
      isReplacementResolutionError: vi.fn()
    });

    await expect(
      applyEdits({
        projectId,
        edits: [{ type: 'upsert', path: targetPath, content: 'ok' }],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({
        path: targetPath,
        status: 400,
        operation: 'upsert'
      })
    });
  });

  test('builds file-op failures for modify upserts with status 404', async () => {
    const { applyEdits } = createApplyEditsModule({
      readProjectFile: vi.fn().mockResolvedValue('const value = 1;'),
      applyReplacements: vi.fn().mockReturnValue('const value = 2;'),
      tryRepairModifyEdit: vi.fn(),
      tryRewriteFileWithLLM: vi.fn(),
      upsertProjectFile: vi.fn().mockRejectedValue({ response: { status: 404 } }),
      deleteProjectPath: vi.fn(),
      stageProjectFile: vi.fn(),
      automationLog: vi.fn(),
      normalizeRepoPath: (value) => value,
      isReplacementResolutionError: vi.fn()
    });

    await expect(
      applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({
        path: targetPath,
        status: 404,
        operation: 'upsert'
      })
    });
  });

  test('builds file-op failures with fallback messages for read errors', async () => {
    const { applyEdits } = createApplyEditsModule({
      readProjectFile: vi.fn().mockResolvedValue(null),
      applyReplacements: vi.fn(),
      tryRepairModifyEdit: vi.fn(),
      tryRewriteFileWithLLM: vi.fn(),
      upsertProjectFile: vi.fn(),
      deleteProjectPath: vi.fn(),
      stageProjectFile: vi.fn(),
      automationLog: vi.fn(),
      normalizeRepoPath: (value) => value,
      isReplacementResolutionError: vi.fn()
    });

    await expect(
      applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({
        path: targetPath,
        status: 404,
        operation: 'read'
      })
    });
  });

  test('builds file-op failures with explicit messages', async () => {
    const { applyEdits } = createApplyEditsModule({
      readProjectFile: vi.fn().mockResolvedValue('const value = 1;'),
      applyReplacements: vi.fn().mockReturnValue('const value = 2;'),
      tryRepairModifyEdit: vi.fn(),
      tryRewriteFileWithLLM: vi.fn(),
      upsertProjectFile: vi.fn().mockRejectedValue({ response: { status: 404 }, message: 'boom' }),
      deleteProjectPath: vi.fn(),
      stageProjectFile: vi.fn(),
      automationLog: vi.fn(),
      normalizeRepoPath: (value) => value,
      isReplacementResolutionError: vi.fn()
    });

    await expect(
      applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({
        path: targetPath,
        status: 404,
        operation: 'upsert'
      })
    });
  });

  test('builds file-op failures when upsert fails with a 404', async () => {
    const { applyEdits } = createApplyEditsModule({
      readProjectFile: vi.fn().mockResolvedValue('const value = 1;'),
      applyReplacements: vi.fn().mockReturnValue('const value = 2;'),
      tryRepairModifyEdit: vi.fn(),
      tryRewriteFileWithLLM: vi.fn(),
      upsertProjectFile: vi.fn().mockRejectedValue({ response: { status: 404 } }),
      deleteProjectPath: vi.fn(),
      stageProjectFile: vi.fn(),
      automationLog: vi.fn(),
      normalizeRepoPath: (value) => value,
      isReplacementResolutionError: vi.fn()
    });

    await expect(
      applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({
        path: targetPath,
        status: 404,
        operation: 'upsert'
      })
    });
  });

  test('rethrows upsert failures when status is missing', async () => {
    const { applyEdits } = createApplyEditsModule({
      readProjectFile: vi.fn().mockResolvedValue('const value = 1;'),
      applyReplacements: vi.fn().mockReturnValue('const value = 2;'),
      tryRepairModifyEdit: vi.fn(),
      tryRewriteFileWithLLM: vi.fn(),
      upsertProjectFile: vi.fn().mockRejectedValue({}),
      deleteProjectPath: vi.fn(),
      stageProjectFile: vi.fn(),
      automationLog: vi.fn(),
      normalizeRepoPath: (value) => value,
      isReplacementResolutionError: vi.fn()
    });

    await expect(
      applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toEqual({});
  });

  test('returns zero counts immediately when no edits are provided', async () => {
    const result = await automationUtils.applyEdits({
      projectId,
      edits: [],
      stage: 'tests'
    });

    expect(result).toEqual({ applied: 0, skipped: 0 });
    expect(deps.readProjectFile).not.toHaveBeenCalled();
  });

  test('returns zero counts when projectId is missing or edits are not an array', async () => {
    const resultMissingProject = await automationUtils.applyEdits({
      projectId: null,
      edits: [buildModifyEdit()],
      stage: 'tests'
    });

    const resultBadEdits = await automationUtils.applyEdits({
      projectId,
      edits: null,
      stage: 'tests'
    });

    expect(resultMissingProject).toEqual({ applied: 0, skipped: 0 });
    expect(resultBadEdits).toEqual({ applied: 0, skipped: 0 });
  });

  test('rethrows file-op failures while writing modify edits', async () => {
    const fileOpError = { __lucidcoderFileOpFailure: { status: 404 } };
    deps.upsertProjectFile.mockRejectedValueOnce(fileOpError);

    await expect(
      automationUtils.applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toBe(fileOpError);
  });

  test('rethrows file-op failures while writing upserts', async () => {
    const fileOpError = { __lucidcoderFileOpFailure: { status: 400 } };
    deps.upsertProjectFile.mockRejectedValueOnce(fileOpError);

    await expect(
      automationUtils.applyEdits({
        projectId,
        edits: [
          {
            type: 'upsert',
            path: 'frontend/src/New.jsx',
            content: 'export const value = 1;'
          }
        ],
        goalPrompt: 'Add file',
        stage: 'implementation'
      })
    ).rejects.toBe(fileOpError);
  });

  test('resolves backend/src paths against knownPathsSet', async () => {
    const result = await automationUtils.applyEdits({
      projectId,
      edits: [
        {
          type: 'modify',
          path: 'backend/src/server.js',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ],
      knownPathsSet: new Set(['backend/server.js']),
      goalPrompt: 'Fix value',
      stage: 'tests'
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(deps.readProjectFile).toHaveBeenCalledWith({ projectId, filePath: 'backend/server.js' });
    expect(deps.upsertProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, filePath: 'backend/server.js' })
    );
    expect(deps.stageProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, filePath: 'backend/server.js' })
    );
  });

  test('uses the known path when an exact match exists', async () => {
    await automationUtils.applyEdits({
      projectId,
      edits: [
        {
          type: 'modify',
          path: 'frontend/src/App.jsx',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ],
      knownPathsSet: new Set(['frontend/src/App.jsx']),
      goalPrompt: 'Fix value',
      stage: 'tests'
    });

    expect(deps.readProjectFile).toHaveBeenCalledWith({ projectId, filePath: 'frontend/src/App.jsx' });
  });

  test('ignores empty known path entries when resolving matches', async () => {
    await automationUtils.applyEdits({
      projectId,
      edits: [buildModifyEdit()],
      knownPathsSet: new Set(['', null, undefined, 'frontend/src/Other.jsx']),
      goalPrompt: 'Fix value',
      stage: 'tests'
    });

    expect(deps.readProjectFile).toHaveBeenCalledWith({ projectId, filePath: 'frontend/src/App.jsx' });
  });

  test('normalizes package.json upserts to remove duplicate keys', async () => {
    const duplicatePackageJson = '{"name":"demo","devDependencies":{"morgan":"^1.10.0","morgan":"^1.10.0"}}';

    const result = await automationUtils.applyEdits({
      projectId,
      edits: [
        {
          type: 'upsert',
          path: 'backend/package.json',
          content: duplicatePackageJson
        }
      ],
      goalPrompt: 'Fix deps',
      stage: 'implementation'
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    const upsertArgs = deps.upsertProjectFile.mock.calls[0][0];
    const matches = upsertArgs.content.match(/"morgan"/g) || [];
    expect(matches).toHaveLength(1);
  });

  test('keeps invalid package.json content unchanged when parsing fails', async () => {
    const invalidJson = '{ name: demo }';

    const result = await automationUtils.applyEdits({
      projectId,
      edits: [
        { type: 'upsert', path: 'backend/package.json', content: invalidJson }
      ],
      stage: 'tests'
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(deps.upsertProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ content: invalidJson })
    );
  });

  test('skips package.json edits when non-string content results in no changes', async () => {
    const packageJsonObject = { name: 'demo' };
    deps.readProjectFile.mockResolvedValue(packageJsonObject);
    deps.applyReplacements.mockReturnValue(packageJsonObject);

    const result = await automationUtils.applyEdits({
      projectId,
      edits: [
        {
          type: 'modify',
          path: 'backend/package.json',
          replacements: [{ search: 'name', replace: 'name' }]
        }
      ],
      stage: 'tests'
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
  });

  test('normalizes package.json modify edits before upserting', async () => {
    deps.readProjectFile.mockResolvedValue('{"name":"demo","dependencies":{"react":"^1.0.0"}}');
    deps.applyReplacements.mockReturnValue('{"name":"demo","dependencies":{"react":"^2.0.0"}}');

    const result = await automationUtils.applyEdits({
      projectId,
      edits: [
        {
          type: 'modify',
          path: 'frontend/package.json',
          replacements: [{ search: 'react', replace: 'react' }]
        }
      ],
      stage: 'implementation'
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(deps.upsertProjectFile).toHaveBeenCalled();
  });

  test('keeps ambiguous known paths unchanged when multiple matches exist', async () => {
    await automationUtils.applyEdits({
      projectId,
      edits: [
        {
          type: 'modify',
          path: 'App.jsx',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ],
      knownPathsSet: new Set(['frontend/src/App.jsx', 'src/App.jsx']),
      goalPrompt: 'Fix value',
      stage: 'tests'
    });

    expect(deps.readProjectFile).toHaveBeenCalledWith({ projectId, filePath: 'App.jsx' });
  });

  test('returns the original path when multiple known paths match a suffix', async () => {
    await automationUtils.applyEdits({
      projectId,
      edits: [
        {
          type: 'modify',
          path: 'App.jsx',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ],
      knownPathsSet: new Set(['one/App.jsx', 'two/App.jsx']),
      goalPrompt: 'Fix value',
      stage: 'tests'
    });

    expect(deps.readProjectFile).toHaveBeenCalledWith({ projectId, filePath: 'App.jsx' });
    expect(deps.upsertProjectFile).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, filePath: 'App.jsx' })
    );
  });

  test('skips edits with empty paths even when knownPathsSet is provided', async () => {
    const result = await automationUtils.applyEdits({
      projectId,
      edits: [
        {
          type: 'modify',
          path: '',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ],
      knownPathsSet: new Set(['frontend/src/App.jsx']),
      goalPrompt: 'Fix value',
      stage: 'tests'
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(deps.readProjectFile).not.toHaveBeenCalled();
  });

  test('resolves a suffix match to the known path when unambiguous', async () => {
    await automationUtils.applyEdits({
      projectId,
      edits: [
        {
          type: 'modify',
          path: 'App.jsx',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ],
      knownPathsSet: new Set(['frontend/src/App.jsx']),
      goalPrompt: 'Fix value',
      stage: 'tests'
    });

    expect(deps.readProjectFile).toHaveBeenCalledWith({ projectId, filePath: 'frontend/src/App.jsx' });
  });

  test('throws a file operation failure when upsert returns 404', async () => {
    deps.upsertProjectFile.mockRejectedValueOnce({ response: { status: 404 } });

    await expect(
      automationUtils.applyEdits({
        projectId,
        edits: [
          { type: 'upsert', path: 'frontend/src/New.jsx', content: 'export default 1;' }
        ],
        stage: 'tests'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({ status: 404, operation: 'upsert' })
    });
  });

  test('wraps modify upsert failures with file operation errors', async () => {
    deps.upsertProjectFile.mockRejectedValueOnce({ response: { status: 400 } });

    await expect(
      automationUtils.applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({ status: 400, operation: 'upsert' })
    });
  });

  test('wraps modify upsert failures for 404 responses', async () => {
    deps.upsertProjectFile.mockRejectedValueOnce({ response: { status: 404 } });

    await expect(
      automationUtils.applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({ status: 404, operation: 'upsert' })
    });
  });

  test('surfaces rewrite apply failures when rewrite replacements still fail', async () => {
    const replacementError = new Error('Replacement search text not found');
    replacementError.__lucidcoderReplacementFailure = { path: targetPath };

    deps.applyReplacements
      .mockImplementationOnce(() => {
        throw replacementError;
      })
      .mockImplementationOnce(() => {
        throw new Error('Rewrite failed');
      });
    deps.tryRepairModifyEdit.mockResolvedValue(null);
    deps.tryRewriteFileWithLLM.mockResolvedValue({
      type: 'modify',
      replacements: [{ search: '1', replace: '2' }]
    });

    await expect(
      automationUtils.applyEdits({
        projectId,
        edits: [buildModifyEdit()],
        goalPrompt: 'Fix value',
        stage: 'implementation'
      })
    ).rejects.toThrow('Replacement search text not found');
  });

  test('syncs branch overview when upsert writes return an overview payload', async () => {
    const syncBranchOverview = vi.fn();
    deps.stageProjectFile.mockResolvedValue({ overview: { workingBranches: [] } });

    const result = await automationUtils.applyEdits({
      projectId,
      edits: [
        { type: 'upsert', path: 'frontend/src/New.jsx', content: 'export default 1;' }
      ],
      syncBranchOverview,
      stage: 'tests'
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(syncBranchOverview).toHaveBeenCalledWith(projectId, expect.any(Object));
  });

  test('invokes onFileApplied for upsert edits', async () => {
    const onFileApplied = vi.fn();

    const result = await automationUtils.applyEdits({
      projectId,
      edits: [
        { type: 'upsert', path: 'frontend/src/New.jsx', content: 'export default 1;' }
      ],
      onFileApplied,
      stage: 'tests'
    });

    expect(result).toEqual({ applied: 1, skipped: 0 });
    expect(onFileApplied).toHaveBeenCalledWith('frontend/src/New.jsx', { type: 'upsert' });
  });
});

describe('buildRelevantFilesContext edge cases', () => {
  test('includes placeholders when referenced files are missing or empty', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('Missing.jsx')) {
        const error = new Error('not found');
        error.response = { status: 404 };
        return Promise.reject(error);
      }
      if (url.includes('Empty.jsx')) {
        return Promise.resolve({ data: { content: '   ' } });
      }
      return Promise.resolve({ data: { content: 'console.log("ok");' } });
    });

    const context = await automationUtils.buildRelevantFilesContext({
      projectId: 77,
      goalPrompt: '',
      fileTreePaths: ['frontend/src/components/Empty.jsx'],
      testFailureContext: null,
      testFailurePathsOverride: [
        'frontend/src/components/Missing.jsx',
        'frontend/src/components/Empty.jsx'
      ]
    });

    expect(context).toContain('frontend/src/components/Missing.jsx');
    expect(context).toContain('could not be loaded');
    expect(context).toContain('frontend/src/components/Empty.jsx');
    expect(context).toContain('file is empty');
  });

  test('ignores failure-context logs that do not include recognizable paths', async () => {
    const testFailureContext = {
      jobs: [
        {
          label: 'Frontend tests',
          recentLogs: ['Noise without mention'],
          testFailures: []
        }
      ]
    };

    const context = await automationUtils.buildRelevantFilesContext({
      projectId: 55,
      goalPrompt: '',
      fileTreePaths: ['frontend/src/components/Dummy.jsx'],
      testFailureContext
    });

    expect(context).toBe('');
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('ignores malformed failure mentions and log entries', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('frontend/package.json')) {
        return Promise.resolve({ data: { content: '{"name":"demo"}' } });
      }
      return Promise.reject(new Error(`Unexpected url ${url}`));
    });

    const testFailureContext = {
      jobs: [
        {
          testFailures: [null, 42, '   >should skip'],
          recentLogs: [null, '', 123]
        }
      ]
    };

    const context = await automationUtils.buildRelevantFilesContext({
      projectId: 88,
      goalPrompt: '',
      fileTreePaths: ['frontend/package.json'],
      testFailureContext
    });

    expect(context).toContain('frontend/package.json');
    expect(context).not.toContain('referenced in failure context');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});

describe('buildEditsPrompt', () => {
  test('appends scope reflection summaries to the prompt', () => {
    const prompt = automationUtils.buildEditsPrompt({
      projectInfo: 'Repo info',
      fileTreeContext: '\n\nTree',
      goalPrompt: 'Add nav',
      stage: 'tests',
      scopeReflection: {
        reasoning: 'Only touch NavBar.jsx',
        mustChange: ['frontend/src/components/NavBar.jsx'],
        mustAvoid: ['frontend/src/styles.css'],
        testsNeeded: false
      }
    });

    const userMessage = prompt.messages[1].content;
    expect(userMessage).toContain('Scope reflection:');
    expect(userMessage).toContain('Must change: frontend/src/components/NavBar.jsx');
    expect(userMessage).toContain('Avoid changing: frontend/src/styles.css');
    expect(userMessage).toContain('Tests required: No');
  });

  test('includes failure context details and scope retry reminders', () => {
    const prompt = automationUtils.buildEditsPrompt({
      projectInfo: 'Repo info',
      fileTreeContext: '',
      goalPrompt: 'Fix tests',
      stage: 'tests',
      retryContext: {
        path: 'frontend/src/App.jsx',
        message: 'Replacement mismatch',
        scopeWarning: 'Stay in App.jsx'
      },
      testFailureContext: {
        jobs: [
          {
            label: 'Frontend tests',
            status: 'failed',
            duration: '15s',
            command: 'npm test',
            args: ['--runInBand'],
            cwd: '/repo',
            testFailures: ['App.test.jsx > renders CTA'],
            error: 'AssertionError',
            coverage: { lines: 80 },
            recentLogs: ['FAIL App.test.jsx']
          }
        ]
      }
    });

    const userMessage = prompt.messages[1].content;
    expect(userMessage).toContain('Test failure context');
    expect(userMessage).toContain('Frontend tests');
    expect(userMessage).toContain('Scope reminder: Stay in App.jsx');
    expect(userMessage).toMatch(/Previous attempt failed while editing/);
  });
});

describe('formatTestFailureContext', () => {
  const hooks = automationUtils.__automationUtilsTestHooks;

  test('serializes rich job metadata including coverage summaries', () => {
    const context = {
      jobs: [
        {
          label: 'API tests',
          status: 'failed',
          duration: '10s',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/repo',
          testFailures: ['api.test.js > returns data'],
          error: 'TimeoutError',
          coverage: { lines: 90, functions: 85 },
          recentLogs: ['line 1', 'line 2']
        }
      ]
    };

    const block = hooks.formatTestFailureContext(context);
    expect(block).toContain('API tests');
    expect(block).toContain('Coverage summary');
    expect(block).toContain('Error: TimeoutError');
  });

  test('ignores unserializable coverage payloads without throwing', () => {
    const circular = {};
    circular.self = circular;
    const block = hooks.formatTestFailureContext({
      jobs: [{ label: 'Looping job', coverage: circular }]
    });

    expect(block).toContain('Looping job');
    expect(block).not.toContain('Coverage summary');
  });

  test('returns blank output when jobs array only contains invalid entries', () => {
    const block = hooks.formatTestFailureContext({ jobs: [null, undefined] });
    expect(block).toBe('');
  });
});
