import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('axios', () => {
  const get = vi.fn();
  const post = vi.fn();
  return { default: { get, post } };
});

import axios from 'axios';
import * as automationUtils from '../../services/goalAutomation/automationUtils.js';

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

  test('returns zero counts immediately when no edits are provided', async () => {
    const result = await automationUtils.applyEdits({
      projectId,
      edits: [],
      stage: 'tests'
    });

    expect(result).toEqual({ applied: 0, skipped: 0 });
    expect(deps.readProjectFile).not.toHaveBeenCalled();
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
