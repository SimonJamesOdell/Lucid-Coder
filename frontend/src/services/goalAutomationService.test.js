import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { fetchGoals, advanceGoalPhase, planMetaGoal } from '../utils/goalsApi';
import {
  ensureBranch,
  processGoal,
  processGoals,
  handlePlanOnlyFeature,
  handleRegularFeature,
  __testOnly
} from './goalAutomationService';
import * as automationUtils from './goalAutomation/automationUtils';

vi.mock('../utils/goalsApi');

describe('goalAutomationService', () => {
  const mockProject = {
    id: 42,
    name: 'Test Project',
    path: '/test/path',
    framework: 'react',
    language: 'javascript'
  };

  const mockSetPreviewPanelTab = vi.fn();
  const mockSetMessages = vi.fn();
  const mockSetGoalCount = vi.fn();
  const mockCreateMessage = vi.fn((role, content, opts) => ({ role, content, ...opts }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    globalThis.__LUCIDCODER_DISABLE_SCOPE_REFLECTION = true;
    globalThis.__LUCIDCODER_ALLOW_EMPTY_STAGE = true;
  });

  afterEach(() => {
    delete globalThis.__LUCIDCODER_DISABLE_SCOPE_REFLECTION;
    delete globalThis.__LUCIDCODER_ALLOW_EMPTY_STAGE;
    vi.useRealTimers();
  });

  describe('ensureBranch', () => {
    test('creates branch when no working branch exists', async () => {
      axios.get.mockResolvedValue({
        data: { workingBranches: [] }
      });

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: 'added-new-feature' } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { branch: { name: 'added-new-feature' } } });
        }
      });

      const result = await ensureBranch(
        42,
        'Add new feature',
        mockSetPreviewPanelTab,
        mockCreateMessage,
        mockSetMessages
      );

      // Execute state updater to cover message construction
      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({ name: 'added-new-feature' });
      expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('branches', { source: 'automation' });
      expect(mockSetMessages).toHaveBeenCalledWith(expect.any(Function));
      expect(mockCreateMessage).toHaveBeenCalledWith('assistant', 'Branch added-new-feature created', { variant: 'status' });
    });

    test('skips branch creation when working branch exists', async () => {
      axios.get.mockResolvedValue({
        data: {
          workingBranches: [{ name: 'existing', stagedFiles: ['file.js'] }]
        }
      });

      const result = await ensureBranch(
        42,
        'Add feature',
        mockSetPreviewPanelTab,
        mockCreateMessage,
        mockSetMessages
      );

      expect(result).toEqual({ name: 'existing' });
      expect(axios.post).not.toHaveBeenCalled();
    });

    test('uses fallback branch name when LLM returns empty', async () => {
      axios.get.mockResolvedValue({
        data: { workingBranches: [] }
      });

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: '' } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { branch: { name: 'feature-123' } } });
        }
      });

      const result = await ensureBranch(
        42,
        'Test',
        mockSetPreviewPanelTab,
        mockCreateMessage,
        mockSetMessages
      );

      expect(result).toEqual({ name: 'feature-123' });
    });

    test('falls back when LLM branch response slugifies to empty', async () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123);

      axios.get.mockResolvedValue({
        data: { workingBranches: [] }
      });

      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: '!!!' } });
        }
        if (url === '/api/projects/42/branches') {
          expect(payload).toEqual(expect.objectContaining({ name: 'feature-123' }));
          return Promise.resolve({ data: { branch: { name: 'feature-123' } } });
        }
      });

      const result = await ensureBranch(
        42,
        'Test',
        mockSetPreviewPanelTab,
        mockCreateMessage,
        mockSetMessages
      );

      expect(result).toEqual({ name: 'feature-123' });

      nowSpy.mockRestore();
    });

    test('handles branch creation error gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      axios.get.mockRejectedValue(new Error('Network error'));

      const result = await ensureBranch(
        42,
        'Test',
        mockSetPreviewPanelTab,
        mockCreateMessage,
        mockSetMessages
      );

      expect(result).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to create branch:', expect.any(Error));
      
      consoleErrorSpy.mockRestore();
    });

    test('strips quotes from LLM branch name', async () => {
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: "'quoted-branch'" } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { branch: { name: 'quoted-branch' } } });
        }
      });

      const result = await ensureBranch(
        42,
        'Test',
        mockSetPreviewPanelTab,
        mockCreateMessage,
        mockSetMessages
      );

      expect(result).toEqual({ name: 'quoted-branch' });
    });

    test('falls back to feature-Date.now when LLM returns empty and branch response has no name', async () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(12345);
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: '' } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: {} });
        }
      });

      const result = await ensureBranch(42, 'Test', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toEqual({ name: 'feature-12345' });

      nowSpy.mockRestore();
    });

    test('extracts a kebab-case branch name from verbose LLM instructions', async () => {
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({
            data: {
              content: 'We need a short branch name like "add-top-navigation-bar". Count characters.'
            }
          });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { branch: { name: 'add-top-navigation-bar' } } });
        }
      });

      const result = await ensureBranch(
        42,
        "let's have a navigation bar at the top",
        undefined,
        mockCreateMessage,
        mockSetMessages
      );

      expect(result).toEqual({ name: 'add-top-navigation-bar' });
    });

    test('slugifies the LLM-provided branch phrase before creating branch', async () => {
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: 'Added navigation bar' } });
        }
        if (url === '/api/projects/42/branches') {
          // Return no name so ensureBranch uses the requested name.
          return Promise.resolve({ data: {} });
        }
      });

      const result = await ensureBranch(42, "let's have a navigation bar at the top", undefined, mockCreateMessage, mockSetMessages);

      const createBranchCall = axios.post.mock.calls.find((call) => call[0] === '/api/projects/42/branches');
      expect(createBranchCall).toBeTruthy();
      const createPayload = createBranchCall[1];
      expect(createPayload.name).toBe('added-navigation-bar');
      expect(result).toEqual({ name: 'added-navigation-bar' });
    });

    test('swallows console.log errors (automationLog catch)', async () => {
      axios.get.mockResolvedValue({
        data: {
          workingBranches: [{ name: 'existing', stagedFiles: ['file.js'] }]
        }
      });

      const originalConsoleLog = console.log;
      console.log = () => {
        throw new Error('console is restricted');
      };

      const result = await ensureBranch(42, 'Add feature', undefined, mockCreateMessage, mockSetMessages);

      // eslint-disable-next-line no-console
      console.log = originalConsoleLog;

      expect(result).toEqual({ name: 'existing' });
    });

    test('handles undefined prompt in automationLog context', async () => {
      axios.get.mockResolvedValue({
        data: {
          workingBranches: [{ name: 'existing', stagedFiles: ['file.js'] }]
        }
      });

      const result = await ensureBranch(42, undefined, undefined, mockCreateMessage, mockSetMessages);
      expect(result).toEqual({ name: 'existing' });
    });

    test('handles undefined thrown errors in catch optional chaining', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      axios.get.mockRejectedValueOnce(undefined);

      const result = await ensureBranch(42, 'Test', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toBeNull();

      consoleErrorSpy.mockRestore();
    });

    test('handles error.response.status in catch optional chaining', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      axios.get.mockRejectedValueOnce({ response: { status: 500 }, message: 'Branch list failed' });

      const result = await ensureBranch(42, 'Test', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toBeNull();

      consoleErrorSpy.mockRestore();
    });

    test('retries LLM branch generation and handles invalid JSON text', async () => {
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });

      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            // Starts with '{' but is not valid JSON -> parseBranchNameFromLLMText falls back to plain text.
            return Promise.resolve({ data: { content: '{branch}' } });
          }

          // Second attempt uses the stricter prompt.
          const systemPrompt = payload?.messages?.[0]?.content || '';
          expect(systemPrompt).toContain('Example: {"branch":"added-navigation-bar"}');
          return Promise.resolve({ data: { content: '{"branch":"added-navigation-bar"}' } });
        }

        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { branch: { name: 'added-navigation-bar' } } });
        }
      });

      const result = await ensureBranch(42, 'Add nav', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toEqual({ name: 'added-navigation-bar' });
      expect(llmCall).toBe(2);
    });

    test('uses fallback branch name when both LLM attempts produce invalid branch', async () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(999);
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });

      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          // Extracted branch becomes "kebab-case" which is explicitly rejected.
          return Promise.resolve({ data: { content: '"kebab-case"' } });
        }
        if (url === '/api/projects/42/branches') {
          expect(payload).toEqual(expect.objectContaining({ name: 'add-feature' }));
          // Return no name so ensureBranch uses generatedName.
          return Promise.resolve({ data: {} });
        }
      });

      const result = await ensureBranch(42, 'Add feature', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toEqual({ name: 'add-feature' });
      expect(llmCall).toBe(2);

      nowSpy.mockRestore();
    });

    test('falls back when LLM JSON branch field is not a string', async () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123);
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });

      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          // Valid JSON, but the branch value is not a string -> parseBranchNameFromLLMText returns ''
          // and requestBranchNameFromLLM should accept the fallback.
          return Promise.resolve({ data: { content: JSON.stringify({ branch: 123 }) } });
        }
        if (url === '/api/projects/42/branches') {
          expect(payload).toEqual(expect.objectContaining({ name: 'feature-123' }));
          // Return no name so ensureBranch uses generatedName.
          return Promise.resolve({ data: {} });
        }
      });

      const result = await ensureBranch(42, 'Test', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toEqual({ name: 'feature-123' });

      nowSpy.mockRestore();
    });

    test('accepts LLM JSON name field when branch is missing', async () => {
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: JSON.stringify({ name: 'added-navigation-bar' }) } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { branch: { name: 'added-navigation-bar' } } });
        }
      });

      const result = await ensureBranch(42, 'Add nav', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toEqual({ name: 'added-navigation-bar' });
    });

    test('reads LLM output from data.response when present', async () => {
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { response: 'added-navigation-bar' } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { branch: { name: 'added-navigation-bar' } } });
        }
      });

      const result = await ensureBranch(42, 'Add nav', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toEqual({ name: 'added-navigation-bar' });
    });

    test('treats non-string LLM response fields as empty text', async () => {
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123);

      axios.get.mockResolvedValue({ data: { workingBranches: [] } });

      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          // parseTextFromLLMResponse prefers `data.response` via ?? even when it's not a string.
          return Promise.resolve({ data: { response: { not: 'a string' }, content: 'added-navigation-bar' } });
        }
        if (url === '/api/projects/42/branches') {
          expect(payload).toEqual(expect.objectContaining({ name: 'feature-123' }));
          return Promise.resolve({ data: {} });
        }
      });

      const result = await ensureBranch(42, 'Test', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toEqual({ name: 'feature-123' });

      nowSpy.mockRestore();
    });

    test('retries when the extracted branch has too many hyphen parts', async () => {
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: 'a-b-c-d-e-f' } });
          }
          return Promise.resolve({ data: { content: 'added-navigation-bar' } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { branch: { name: 'added-navigation-bar' } } });
        }
      });

      const result = await ensureBranch(42, 'Test', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toEqual({ name: 'added-navigation-bar' });
      expect(llmCall).toBe(2);
    });

    test('slugifies plain text without kebab tokens into a valid branch', async () => {
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });

      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          // No hyphens in the raw text, so extractBranchName's token match returns null.
          return Promise.resolve({ data: { content: 'Just words' } });
        }
        if (url === '/api/projects/42/branches') {
          expect(payload).toEqual(expect.objectContaining({ name: 'just-words' }));
          return Promise.resolve({ data: { branch: { name: 'just-words' } } });
        }
      });

      const result = await ensureBranch(42, 'Test', undefined, mockCreateMessage, mockSetMessages);
      expect(result).toEqual({ name: 'just-words' });
    });

    test('syncBranchOverview receives refreshed branches payload when refresh returns data', async () => {
      const syncBranchOverview = vi.fn();
      let branchesFetchCount = 0;

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/branches') {
          branchesFetchCount += 1;
          if (branchesFetchCount === 1) {
            return Promise.resolve({ data: { workingBranches: [] } });
          }
          return Promise.resolve({ data: { refreshed: true, workingBranches: [] } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: 'feature-abc' } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { success: true, branch: { name: 'feature-abc' } } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      await ensureBranch(42, 'Test', undefined, mockCreateMessage, mockSetMessages, { syncBranchOverview });

      expect(syncBranchOverview).toHaveBeenCalledWith(42, expect.objectContaining({ refreshed: true }));
    });

    test('swallows branch overview refresh failures when syncBranchOverview is provided', async () => {
      const syncBranchOverview = vi.fn();
      let branchesFetchCount = 0;

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/branches') {
          branchesFetchCount += 1;
          if (branchesFetchCount === 1) {
            return Promise.resolve({ data: { workingBranches: [] } });
          }
          return Promise.reject(new Error('refresh failed'));
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: 'feature-abc' } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { success: true, branch: { name: 'feature-abc' } } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const result = await ensureBranch(42, 'Test', undefined, mockCreateMessage, mockSetMessages, { syncBranchOverview });
      expect(result).toEqual({ name: 'feature-abc' });
      expect(syncBranchOverview).not.toHaveBeenCalled();
    });
  });

  describe('__testOnly', () => {
    test('parseEditsFromLLM strips double braces via loose JSON parsing', () => {
      const edits = __testOnly.parseEditsFromLLM({
        data: {
          content: '{{"edits":[{"type":"upsert","path":"src/Loose.jsx","content":"export default 1;"}]}}'
        }
      });

      expect(edits).toEqual([
        {
          type: 'upsert',
          path: 'src/Loose.jsx',
          content: 'export default 1;'
        }
      ]);
    });

    test('parseEditsFromLLM falls back to loose JSON when strict parsing fails', () => {
      const edits = __testOnly.parseEditsFromLLM({
        data: {
          content: "{edits:[{type:'upsert',path:'src/Loose.js',content:'export default 1;'}]}"
        }
      });

      expect(edits).toEqual([
        {
          type: 'upsert',
          path: 'src/Loose.js',
          content: 'export default 1;'
        }
      ]);
    });

    test('parseEditsFromLLM returns loose JSON edits object when no JSON snippet is found', () => {
      const edits = __testOnly.parseEditsFromLLM({
        data: {
          content: 'edits: [{"type":"upsert","path":"src/Fallback.jsx","content":"export default 1;"}]'
        }
      });

      expect(edits).toEqual([
        {
          type: 'upsert',
          path: 'src/Fallback.jsx',
          content: 'export default 1;'
        }
      ]);
    });

    test('parseEditsFromLLM returns array responses from loose parsing', () => {
      const edits = __testOnly.parseEditsFromLLM({
        data: {
          content: "[{type:'upsert',path:'src/Array.jsx',content:'export default 1;'}]"
        }
      });

      expect(edits).toEqual([
        {
          type: 'upsert',
          path: 'src/Array.jsx',
          content: 'export default 1;'
        }
      ]);
    });

    test('parseEditsFromLLM recovers when strict JSON parsing fails', () => {
      const edits = __testOnly.parseEditsFromLLM({
        data: {
          content: '{"edits":[{type:"upsert",path:"src/Recover.jsx",content:"export default 1;"}]}'
        }
      });

      expect(edits).toEqual([
        {
          type: 'upsert',
          path: 'src/Recover.jsx',
          content: 'export default 1;'
        }
      ]);
    });

    test('applyEdits calls syncBranchOverview and onFileApplied when stage returns overview', async () => {
      axios.get.mockResolvedValue({ data: { content: 'const value = 1;\n' } });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      axios.post.mockImplementation((url) => {
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true, overview: { workingBranches: [] } } });
        }
        if (url === '/api/projects/42/files-ops/delete') {
          return Promise.resolve({ data: { success: true } });
        }
        if (url === '/api/projects/42/files-ops/create-file') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const syncBranchOverview = vi.fn();
      const onFileApplied = vi.fn();

      const result = await __testOnly.applyEdits({
        projectId: 42,
        source: 'automation',
        edits: [
          {
            type: 'modify',
            path: 'src/alpha.js',
            replacements: [{ search: '1', replace: '2' }]
          },
          {
            type: 'delete',
            path: 'src/remove.js',
            recursive: true
          },
          {
            type: 'upsert',
            path: 'src/beta.js',
            content: 'export default "beta";'
          }
        ],
        syncBranchOverview,
        onFileApplied
      });

      expect(result).toEqual({ applied: 3, skipped: 0 });
      expect(syncBranchOverview).toHaveBeenCalledTimes(3);
      expect(syncBranchOverview).toHaveBeenCalledWith(42, expect.objectContaining({ workingBranches: expect.any(Array) }));
      expect(onFileApplied).toHaveBeenCalledWith('src/alpha.js', { type: 'modify' });
      expect(onFileApplied).toHaveBeenCalledWith('src/beta.js', { type: 'upsert' });
    });

    test('buildEditsPrompt adds retry notice details and strict JSON warning', () => {
      const prompt = __testOnly.buildEditsPrompt({
        projectInfo: 'Project Foo',
        fileTreeContext: '\nTree',
        goalPrompt: 'Do work',
        stage: 'tests',
        attempt: 2,
        retryContext: {
          path: 'frontend/src/App.jsx',
          message: 'Replacement search text not found',
          searchSnippet: 'const App = () => null;'
        }
      });

      expect(prompt.messages[0].content).toContain('Previous response was not valid JSON');
      expect(prompt.messages[1].content).toContain('Previous attempt failed while editing frontend/src/App.jsx');
      expect(prompt.messages[1].content).toContain('Problematic search snippet: const App = () => null;');
    });

    test('buildEditsPrompt omits snippet note when retryContext lacks path and snippet text', () => {
      const prompt = __testOnly.buildEditsPrompt({
        projectInfo: 'Project Foo',
        fileTreeContext: '',
        goalPrompt: 'Feature',
        stage: 'implementation',
        attempt: 1,
        retryContext: {
          path: '',
          message: '',
          searchSnippet: '   '
        }
      });

      const userContent = prompt.messages[1].content;
      expect(userContent).toContain('Previous attempt failed while editing the target file');
      expect(userContent).not.toContain('Problematic search snippet');
    });

    test('buildEditsPrompt includes failure context details when provided', () => {
      const prompt = __testOnly.buildEditsPrompt({
        projectInfo: 'Project Foo',
        fileTreeContext: '',
        goalPrompt: 'Fix tests',
        stage: 'tests',
        testFailureContext: {
          jobs: [
            {
              label: 'Frontend tests',
              status: 'failed',
              recentLogs: ['FAIL src/App.test.jsx > App > renders']
            }
          ]
        }
      });

      expect(prompt.messages[1].content).toContain('Test failure context');
      expect(prompt.messages[1].content).toContain('FAIL src/App.test.jsx');
    });

    test('buildEditsPrompt includes suggested paths and uncovered line previews', () => {
      const prompt = __testOnly.buildEditsPrompt({
        projectInfo: 'Project Foo',
        fileTreeContext: '',
        goalPrompt: 'Fix tests',
        stage: 'tests',
        attempt: 2,
        retryContext: {
          suggestedPaths: ['frontend/src/test/App.test.jsx']
        },
        testFailureContext: {
          jobs: [
            {
              label: 'Frontend tests',
              status: 'failed',
              uncoveredLines: [
                {
                  workspace: 'frontend',
                  file: 'src/App.jsx',
                  lines: [1, 2, 3, 4, 5, 6, 7, 8, 9]
                }
              ]
            }
          ]
        }
      });

      const userContent = prompt.messages[1].content;
      expect(userContent).toContain('Existing paths with similar names: frontend/src/test/App.test.jsx');
      expect(userContent).toContain('Uncovered lines: frontend/src/App.jsx (1, 2, 3, 4, 5, 6, 7, 8, …)');
    });

    test('buildEditsPrompt skips invalid uncovered line entries and formats numeric previews', () => {
      const prompt = __testOnly.buildEditsPrompt({
        projectInfo: 'Project Foo',
        fileTreeContext: '',
        goalPrompt: 'Fix tests',
        stage: 'tests',
        testFailureContext: {
          jobs: [
            {
              label: 'Backend tests',
              status: 'failed',
              uncoveredLines: [
                null,
                { workspace: '', file: '', lines: [1] },
                { workspace: 'backend', file: 'server.js', lines: ['nope', 2] }
              ]
            }
          ]
        }
      });

      expect(prompt.messages[1].content).toContain('Uncovered lines: backend/server.js (2)');
    });

    test('applyEdits uses fallback rewrite error message when caught error loses its message', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'const msg = "hello";\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      const errorWithVanishingMessage = {
        forceBlank: false,
        get message() {
          if (this.forceBlank) {
            return undefined;
          }
          return 'Replacement search text not found';
        }
      };

      const rewritePayloads = [];
      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall <= 2) {
            if (llmCall === 2) {
              errorWithVanishingMessage.forceBlank = true;
            }
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          rewritePayloads.push(payload);
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'frontend/src/app.js',
                    replacements: [{ search: 'hello', replace: 'HELLO' }]
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      let firstAccess = true;
      const problematicReplacement = new Proxy(
        {},
        {
          get(_target, prop) {
            if ((prop === 'search' || prop === 'replace') && firstAccess) {
              firstAccess = false;
              throw errorWithVanishingMessage;
            }
            if (prop === 'search') {
              return 'hello';
            }
            if (prop === 'replace') {
              return 'HELLO';
            }
            return undefined;
          }
        }
      );

      const result = await __testOnly.applyEdits({
        projectId: 42,
        source: 'automation',
        goalPrompt: 'Fallback error message',
        stage: 'implementation',
        edits: [
          {
            type: 'modify',
            path: 'frontend/src/app.js',
            replacements: [problematicReplacement]
          }
        ]
      });

      expect(result).toEqual({ applied: 1, skipped: 0 });
      expect(llmCall).toBe(3);
      const rewriteUserContent = rewritePayloads[0]?.messages?.find((msg) => msg.role === 'user')?.content || '';
      expect(rewriteUserContent).toContain('Previous edit failed with: Replacement search text not found');
    });

    test('buildRewriteFilePrompt truncates long content and tightens instructions on second attempt', () => {
      const payload = __testOnly.buildRewriteFilePrompt({
        goalPrompt: 'Fix header spacing',
        stage: 'tests',
        filePath: 'frontend/src/app.js',
        fileContent: 'x'.repeat(9000),
        errorMessage: 'Replacement search text not found',
        attempt: 2
      });

      const systemMessage = payload.messages.find((msg) => msg.role === 'system')?.content || '';
      const userMessage = payload.messages.find((msg) => msg.role === 'user')?.content || '';

      expect(systemMessage).toContain('Schema: {"edits"');
      expect(userMessage).toContain('/* ...truncated... */');
      expect(userMessage).toContain('Previous edit failed with: Replacement search text not found');
    });

    test('tryRewriteFileWithLLM retries after SyntaxError and returns candidate from second attempt', async () => {
      const responses = [
        () => Promise.reject(new SyntaxError('bad json')),
        () =>
          Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'upsert',
                    path: 'frontend/src/app.js',
                    content: 'rewritten body'
                  }
                ]
              })
            }
          })
      ];

      axios.post.mockImplementation(() => responses.shift()());

      const result = await __testOnly.tryRewriteFileWithLLM({
        goalPrompt: 'Fix file content',
        stage: 'tests',
        filePath: 'frontend/src/app.js',
        originalContent: 'const value = 1;',
        errorMessage: 'Replacement search text not found'
      });

      expect(result).toEqual({
        type: 'upsert',
        path: 'frontend/src/app.js',
        content: 'rewritten body'
      });
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    test('tryRewriteFileWithLLM returns null when rewrite request fails with non-Syntax error', async () => {
      axios.post.mockRejectedValue(new Error('network down'));

      const result = await __testOnly.tryRewriteFileWithLLM({
        goalPrompt: 'Fix file content',
        stage: 'tests',
        filePath: 'frontend/src/app.js',
        originalContent: 'const value = 1;',
        errorMessage: 'Replacement search text not found'
      });

      expect(result).toBeNull();
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('tryRewriteFileWithLLM returns null when no rewrite candidate matches target path', async () => {
      axios.post
        .mockResolvedValueOnce({ data: { content: JSON.stringify({ edits: [] }) } })
        .mockResolvedValueOnce({ data: { content: JSON.stringify({ edits: [] }) } });

      const result = await __testOnly.tryRewriteFileWithLLM({
        goalPrompt: 'Fix file content',
        stage: 'tests',
        filePath: 'frontend/src/app.js',
        originalContent: 'const value = 1;',
        errorMessage: 'Replacement search text not found'
      });

      expect(result).toBeNull();
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    test('applyEdits assigns fallback text when a replacement error lacks a message', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'console.log("hi");\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put = vi.fn().mockResolvedValue({ data: { success: true } });
      axios.post.mockImplementation((url) => {
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        if (url === '/api/projects/42/files-ops/create-file') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let firstAccess = true;
      const replacement = {
        get search() {
          if (firstAccess) {
            firstAccess = false;
            throw new Error('');
          }
          return 'console.log("hi");';
        },
        replace: 'console.log("bye");'
      };

      await expect(
        __testOnly.applyEdits({
          projectId: 42,
          edits: [
            {
              type: 'modify',
              path: 'frontend/src/app.js',
              replacements: [replacement]
            }
          ],
          goalPrompt: '',
          stage: 'tests'
        })
      ).rejects.toThrow('Error');
    });

    test('applyEdits falls back to the default replacement failure copy when the thrown value is null', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'console.log("hi");\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put = vi.fn().mockResolvedValue({ data: { success: true } });

      const replacement = {
        search: 'console.log("hi");',
        get replace() {
          throw null;
        }
      };

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        __testOnly.applyEdits({
          projectId: 42,
          edits: [
            {
              type: 'modify',
              path: 'frontend/src/app.js',
              replacements: [replacement]
            }
          ],
          goalPrompt: '',
          stage: 'tests'
        })
      ).rejects.toThrow('Replacement failed');

      const replacementLog = logSpy.mock.calls.find(([label]) => label.includes('applyEdits:modify:replacementError'));
      expect(replacementLog?.[1]?.message).toBe('Replacement failed');
      logSpy.mockRestore();
    });

    test('applyEdits surfaces unknown replacement failures when rewrite fallback runs without an error message', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'console.log("hi");\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put = vi.fn().mockResolvedValue({ data: { success: true } });

      const replacementError = new Error('Replacement search text not found');
      let firstReplaceAccess = true;
      const replacement = {
        search: 'console.log("hi");',
        get replace() {
          if (firstReplaceAccess) {
            firstReplaceAccess = false;
            throw replacementError;
          }
          return 'console.log("bye");';
        }
      };

      const llmPayloads = [];
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmPayloads.push(payload);
          if (llmPayloads.length === 1) {
            return Promise.reject(new Error('repair down')).finally(() => {
              replacementError.message = '';
            });
          }
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { overview: { workingBranches: [] } } });
        }
        if (url === '/api/projects/42/files-ops/create-file') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      await expect(
        __testOnly.applyEdits({
          projectId: 42,
          edits: [
            {
              type: 'modify',
              path: 'frontend/src/app.js',
              replacements: [replacement]
            }
          ],
          goalPrompt: 'Fix the log output',
          stage: 'tests'
        })
      ).rejects.toThrow();
      const rewriteCall = llmPayloads.find((payload) =>
        payload?.messages?.[1]?.content?.includes('Unknown replacement failure')
      );
      expect(rewriteCall).toBeDefined();
      expect(rewriteCall.messages[1].content).toContain('Previous edit failed with: Unknown replacement failure');
    });

    test('buildRelevantFilesContext short-circuits without a project and prefixes mentioned src paths', async () => {
      const empty = await __testOnly.buildRelevantFilesContext({
        projectId: null,
        goalPrompt: 'anything',
        fileTreePaths: []
      });
      expect(empty).toBe('');

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/pages/App.jsx') {
          return Promise.resolve({ data: { content: 'export default function Page() { return null; }' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const context = await __testOnly.buildRelevantFilesContext({
        projectId: 42,
        goalPrompt: 'Touch src/pages/App.jsx please.',
        fileTreePaths: ['frontend/src/pages/App.jsx']
      });

      expect(context).toContain('Relevant file contents');
      expect(context).toContain('frontend/src/pages/App.jsx');
    });

    test('buildRelevantFilesContext surfaces router files when prompt references routing keywords', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/router/AppRouter.jsx') {
          return Promise.resolve({ data: { content: 'export const AppRouter = () => null;' } });
        }
        return Promise.resolve({ data: {} });
      });

      const context = await __testOnly.buildRelevantFilesContext({
        projectId: 42,
        goalPrompt: 'Update the routing logic inside the router component.',
        fileTreePaths: ['frontend/src/router/AppRouter.jsx']
      });

      expect(context).toContain('frontend/src/router/AppRouter.jsx');
      expect(context).toContain('Relevant file contents');
      expect(axios.get).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/router/AppRouter.jsx');
    });

    test('buildRelevantFilesContext limits routing matches to the first six files', async () => {
      const routingPaths = Array.from({ length: 7 }, (_, index) => `frontend/src/routes/Route${index + 1}.tsx`);

      axios.get.mockImplementation((url) => {
        if (url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { content: `export const marker = '${url}';` } });
        }
        return Promise.resolve({ data: {} });
      });

      await __testOnly.buildRelevantFilesContext({
        projectId: 42,
        goalPrompt: 'Clean up routes and routing transitions.',
        fileTreePaths: routingPaths
      });

      const requestedFiles = axios.get.mock.calls.map(([url]) => url);
      const expectedRequests = routingPaths.slice(0, 6).map((path) => `/api/projects/42/files/${path}`);

      expect(requestedFiles).toEqual(expect.arrayContaining(expectedRequests));
      expect(requestedFiles).not.toContain('/api/projects/42/files/frontend/src/routes/Route7.tsx');
      expect(requestedFiles).toHaveLength(6);
    });

    test('buildRelevantFilesContext prefers actual main/app variants from the file tree', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/main.tsx') {
          return Promise.resolve({ data: { content: 'export const main = null;' } });
        }
        if (url === '/api/projects/42/files/frontend/src/App.tsx') {
          return Promise.resolve({ data: { content: 'export const App = null;' } });
        }
        return Promise.resolve({ data: {} });
      });

      const context = await __testOnly.buildRelevantFilesContext({
        projectId: 42,
        goalPrompt: 'No special instructions',
        fileTreePaths: ['frontend/src/main.tsx', 'frontend/src/App.tsx']
      });

      expect(context).toContain('frontend/src/main.tsx');
      expect(context).toContain('frontend/src/App.tsx');
    });

    test('buildRelevantFilesContext includes css entry points when present in the tree', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/index.css') {
          return Promise.resolve({ data: { content: 'body { color: red; }' } });
        }
        if (url === '/api/projects/42/files/frontend/src/App.css') {
          return Promise.resolve({ data: { content: '.App { color: blue; }' } });
        }
        return Promise.resolve({ data: {} });
      });

      const context = await __testOnly.buildRelevantFilesContext({
        projectId: 42,
        goalPrompt: 'Style update',
        fileTreePaths: ['frontend/src/index.css', 'frontend/src/App.css']
      });

      expect(context).toContain('frontend/src/index.css');
      expect(context).toContain('frontend/src/App.css');
    });

    test('buildRelevantFilesContext skips mentions that normalize to empty paths', async () => {
      const originalExec = RegExp.prototype.exec;
      const execStub = vi.fn(function execWithBlankMatch(str) {
        const match = originalExec.call(this, str);
        if (match && match[0] === 'src/skip-me.jsx') {
          match[0] = '';
        }
        return match;
      });
      RegExp.prototype.exec = execStub;

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/keep.jsx') {
          return Promise.resolve({ data: { content: 'export default null;' } });
        }
        return Promise.resolve({ data: {} });
      });

      try {
        const context = await __testOnly.buildRelevantFilesContext({
          projectId: 42,
          goalPrompt: 'Please review src/skip-me.jsx and src/keep.jsx',
          fileTreePaths: ['frontend/src/keep.jsx']
        });

        expect(context).toContain('frontend/src/keep.jsx');
        expect(execStub).toHaveBeenCalled();
      } finally {
        RegExp.prototype.exec = originalExec;
      }
    });

    test('buildRelevantFilesContext includes files referenced in failure context logs', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/components/Broken.test.jsx') {
          return Promise.resolve({ data: { content: 'test contents' } });
        }
        return Promise.resolve({ data: {} });
      });

      const context = await __testOnly.buildRelevantFilesContext({
        projectId: 42,
        goalPrompt: 'Unrelated change',
        fileTreePaths: [],
        testFailureContext: {
          jobs: [
            {
              testFailures: ['src/components/Broken.test.jsx > suite > renders'],
              recentLogs: ['FAIL  src/components/Broken.test.jsx > suite > renders']
            }
          ]
        }
      });

      expect(context).toContain('frontend/src/components/Broken.test.jsx');
      expect(axios.get).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/components/Broken.test.jsx');
    });

    test('buildRelevantFilesContext relaxes per-file truncation for large files referenced by failures', async () => {
      const bigContent = 'a'.repeat(31000);
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/BigFile.jsx') {
          return Promise.resolve({ data: { content: bigContent } });
        }
        return Promise.resolve({ data: {} });
      });

      const context = await __testOnly.buildRelevantFilesContext({
        projectId: 42,
        goalPrompt: 'Any',
        fileTreePaths: [],
        testFailureContext: {
          jobs: [
            {
              testFailures: ['src/BigFile.jsx > suite > case']
            }
          ]
        }
      });

      expect(context).toContain('frontend/src/BigFile.jsx');
      expect(context).toContain('chars omitted');
      expect(context.length).toBeGreaterThan(6000);
    });

    test('buildReplacementRetryContext reuses structured failure payloads and falls back when missing', () => {
      const structured = {
        path: 'frontend/src/App.jsx',
        message: 'custom',
        searchSnippet: 'const App'
      };

      expect(
        __testOnly.buildReplacementRetryContext({ __lucidcoderReplacementFailure: structured })
      ).toBe(structured);

      const fallback = __testOnly.buildReplacementRetryContext({ message: '' });
      expect(fallback).toEqual({ path: null, message: 'Replacement search text not found' });
    });

    test('normalizeMentionPath prefixes non-frontend matches and ignores empty mentions', () => {
      expect(__testOnly.normalizeMentionPath('src/App.jsx')).toBe('frontend/src/App.jsx');
      expect(__testOnly.normalizeMentionPath('frontend/src/App.jsx')).toBe('frontend/src/App.jsx');
      expect(__testOnly.normalizeMentionPath('')).toBeNull();
    });
  });

  test('syncs branch overview after creating branch when callback provided', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { workingBranches: [] } })
      .mockResolvedValueOnce({ data: { current: 'feature-xyz', workingBranches: [{ name: 'feature-xyz', stagedFiles: [] }] } });
    axios.post.mockImplementation((url) => {
      if (url === '/api/llm/generate') {
        return Promise.resolve({ data: { content: 'feature-xyz' } });
      }
      if (url === '/api/projects/42/branches') {
        return Promise.resolve({ data: { success: true, branch: { name: 'feature-xyz' } } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    const syncBranchOverview = vi.fn();

    await ensureBranch(
      42,
      'Test',
      undefined,
      mockCreateMessage,
      mockSetMessages,
      { syncBranchOverview }
    );

    expect(syncBranchOverview).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ workingBranches: expect.any(Array) })
    );
  });

  describe('processGoal', () => {
    beforeEach(() => {
      // processGoal now scans the project file tree before calling the LLM.
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { success: true, content: '' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      // axios is mocked module-wide; ensure put exists for file writes.
      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });
    });

    test('processes goal through all phases successfully', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            // tests stage
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/Test.jsx', content: 'const Test = () => null;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Create test component' };
      const projectInfo = 'Project: Test\nFramework: react\nLanguage: javascript\nPath: /test';

      const promise = processGoal(
        goal,
        42,
        '/test',
        projectInfo,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      // Advance through all timeouts
      await vi.advanceTimersByTimeAsync(1000); // Initial wait
      await vi.advanceTimersByTimeAsync(800);  // Files tab wait
      await vi.advanceTimersByTimeAsync(800);  // Completion wait

      const result = await promise;

      // Execute state updater to cover completion message construction
      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({ success: true });
      expect(advanceGoalPhase).toHaveBeenCalledWith(1, 'testing');
      expect(advanceGoalPhase).toHaveBeenCalledWith(1, 'implementing');
      expect(advanceGoalPhase).toHaveBeenCalledWith(1, 'verifying');
      expect(advanceGoalPhase).toHaveBeenCalledWith(1, 'ready');
      expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('files', { source: 'automation' });
      expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('goals', { source: 'automation' });
      expect(mockCreateMessage).toHaveBeenCalledWith('assistant', 'Completed: Create test component', { variant: 'status' });
    });

    test('requests editor focus when an edit is applied and requestEditorFocus is provided', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      const requestEditorFocus = vi.fn();

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/Test.jsx', content: 'const Test = () => null;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Create test component' };
      const projectInfo = 'Project: Test\nFramework: react\nLanguage: javascript\nPath: /test';

      const promise = processGoal(
        goal,
        42,
        '/test',
        projectInfo,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages,
        { requestEditorFocus }
      );

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(800);

      await promise;

      expect(requestEditorFocus).toHaveBeenCalledWith(42, 'src/Test.jsx', {
        source: 'automation',
        highlight: 'editor'
      });
    });

    test('rejects non-test edits for coverage goals', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.post.mockResolvedValue({
        data: {
          content: JSON.stringify({
            edits: [
              {
                type: 'modify',
                path: 'frontend/src/App.jsx',
                replacements: [{ search: 'old', replace: 'new' }]
              }
            ]
          })
        }
      });

      const result = await processGoal(
        {
          id: 1,
          prompt: 'Fix coverage',
          metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [1] }] }
        },
        42,
        '/test',
        'Project: Test',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages,
        {
          enableScopeReflection: false,
          testsAttemptSequence: [1],
          implementationAttemptSequence: [1]
        }
      );

      expect(result).toEqual(
        expect.objectContaining({ success: false, error: 'Coverage fixes are limited to test files only.' })
      );
    });

    test('returns cancelled when pause guard fails early', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      const result = await processGoal(
        { id: 2, prompt: 'Short-circuit' },
        42,
        '/test',
        'Project: Test',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages,
        {
          enableScopeReflection: false,
          shouldPause: () => true,
          shouldCancel: () => true
        }
      );

      expect(result).toEqual({ success: false, cancelled: true });
    });

    test('retries implementation edits after file operation failures', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      const applyEditsSpy = vi.spyOn(automationUtils, 'applyEdits');
      applyEditsSpy
        .mockRejectedValueOnce({ __lucidcoderFileOpFailure: { path: 'frontend/src/App.jsx', status: 404 } })
        .mockResolvedValueOnce({ applied: 1, skipped: 0 });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'frontend/src/App.jsx', content: 'export default 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const promise = processGoal(
        { id: 1, prompt: 'Fix app' },
        42,
        '/test',
        'Project: Test',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages,
        {
          enableScopeReflection: false,
          testsAttemptSequence: [1],
          implementationAttemptSequence: [1, 2]
        }
      );

      await vi.runAllTimersAsync();
      await promise;

      expect(applyEditsSpy).toHaveBeenCalledTimes(2);
      applyEditsSpy.mockRestore();
    });

    test('returns a goal not found error when API responds with 404', async () => {
      fetchGoals.mockRejectedValueOnce({ response: { status: 404 }, message: 'Goal not found' });
      advanceGoalPhase.mockResolvedValue({});

      const result = await processGoal(
        { id: 55, prompt: 'Missing goal' },
        42,
        '/test',
        'Project: Test',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages,
        { enableScopeReflection: false }
      );

      expect(result).toEqual({ success: false, skipped: true, error: 'Goal not found' });
    });

    test('repairs modify edits by matching equivalent paths (prefix omitted)', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      // Ensure readProjectFile returns content that makes the initial replacement fail.
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'hello' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      // Stop after repair path by failing the write.
      axios.put.mockRejectedValueOnce({ response: { status: 500 }, message: 'write failed' });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'MISSING', replace: 'UPDATED' }]
                    }
                  ]
                })
              }
            });
          }

          // Repair response: omit the leading "frontend/" so pathsAreEquivalent must match via endsWith.
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/app.js',
                    replacements: [{ search: 'hello', replace: 'HELLO' }]
                  }
                ]
              })
            }
          });
        }
      });

      const goal = { id: 1, prompt: 'Fix failing replacement' };
      const projectInfo = 'info';

      const promise = processGoal(
        goal,
        42,
        '/test',
        projectInfo,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      // Execute state updater to cover error message construction.
      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({ success: false, error: 'write failed' });
      expect(llmCall).toBe(2);
    });

    test('retries replacement failures during tests and implementation phases and propagates retry context', async () => {
      fetchGoals.mockResolvedValue([{ id: 99, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { workingBranches: [] } });
        }
        if (url === '/api/projects/42/files') {
          return Promise.resolve({
            data: {
              files: [
                { path: 'frontend/src/tests-phase.js' },
                { path: 'frontend/src/impl-phase.js' }
              ]
            }
          });
        }
        if (url === '/api/projects/42/files/frontend/src/tests-phase.js') {
          return Promise.resolve({ data: { content: 'const stageValue = 0;' } });
        }
        if (url === '/api/projects/42/files/frontend/src/impl-phase.js') {
          return Promise.resolve({ data: { content: 'const implValue = 0;' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put.mockResolvedValue({ data: { success: true } });

      const llmPayloads = [];
      let testsAttempt = 0;
      let implAttempt = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmPayloads.push(payload);
          const stageContent = payload?.messages?.[1]?.content || '';
          const isTestsStage = stageContent.includes('Stage: tests');
          if (isTestsStage) {
            testsAttempt += 1;
            if (testsAttempt === 1) {
              return Promise.resolve({
                data: {
                  content: JSON.stringify({
                    edits: [
                      {
                        type: 'modify',
                        path: 'frontend/src/tests-phase.js',
                        replacements: [{ search: 'MISSING_SNIPPET', replace: 'value' }]
                      }
                    ]
                  })
                }
              });
            }
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/tests-phase.js',
                      content: 'const repaired = true;'
                    }
                  ]
                })
              }
            });
          }

          implAttempt += 1;
          if (implAttempt === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/impl-phase.js',
                      replacements: [{ search: 'MISSING_IMPL', replace: 'value' }]
                    }
                  ]
                })
              }
            });
          }
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 99, prompt: '' };
      const projectInfo = 'info';

      const promise = processGoal(
        goal,
        42,
        '/repo',
        projectInfo,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(800);
      await promise;

      expect(llmPayloads).toHaveLength(4);
      expect(llmPayloads[1].messages[1].content).toContain('Problematic search snippet: MISSING_SNIPPET');
      expect(llmPayloads[3].messages[1].content).toContain('Problematic search snippet: MISSING_IMPL');

      const testsRetryLog = logSpy.mock.calls.find(([label]) => label.includes('processGoal:llm:tests:replacementRetry'));
      const implRetryLog = logSpy.mock.calls.find(([label]) => label.includes('processGoal:llm:impl:replacementRetry'));
      expect(testsRetryLog?.[1]?.path).toBe('frontend/src/tests-phase.js');
      expect(implRetryLog?.[1]?.path).toBe('frontend/src/impl-phase.js');

      logSpy.mockRestore();
    });

    test('re-fetches repo context before retrying tests stage when replacements fail', async () => {
      fetchGoals.mockResolvedValue([{ id: 101, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockResolvedValue({ data: { success: true } });

      let treeFetches = 0;
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          treeFetches += 1;
          return Promise.resolve({
            data: { success: true, files: [{ path: 'frontend/src/tests-phase.js', type: 'file' }] }
          });
        }
        if (url === '/api/projects/42/files/frontend/src/tests-phase.js') {
          return Promise.resolve({ data: { content: 'const stageValue = 0;' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let testsAttempt = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          const stageContent = payload?.messages?.[1]?.content || '';
          if (stageContent.includes('Stage: tests')) {
            testsAttempt += 1;
            if (testsAttempt === 1) {
              return Promise.resolve({
                data: {
                  content: JSON.stringify({
                    edits: [
                      {
                        type: 'modify',
                        path: 'frontend/src/tests-phase.js',
                        replacements: [{ search: 'MISSING_TEST', replace: 'value' }]
                      }
                    ]
                  })
                }
              });
            }
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/tests-phase.js',
                      content: 'const repaired = true;'
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 101, prompt: '' };
      const promise = processGoal(
        goal,
        42,
        '/repo',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      await promise;

      expect(treeFetches).toBe(3);
    });

    test('re-fetches repo context before retrying implementation stage when replacements fail', async () => {
      fetchGoals.mockResolvedValue([{ id: 102, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockResolvedValue({ data: { success: true } });

      let treeFetches = 0;
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          treeFetches += 1;
          return Promise.resolve({
            data: {
              success: true,
              files: [
                { path: 'frontend/src/tests-phase.js', type: 'file' },
                { path: 'frontend/src/impl-phase.js', type: 'file' }
              ]
            }
          });
        }
        if (url === '/api/projects/42/files/frontend/src/tests-phase.js') {
          return Promise.resolve({ data: { content: 'const stageValue = 0;' } });
        }
        if (url === '/api/projects/42/files/frontend/src/impl-phase.js') {
          return Promise.resolve({ data: { content: 'const implValue = 0;' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let implAttempt = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          const stageContent = payload?.messages?.[1]?.content || '';
          if (stageContent.includes('Stage: tests')) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }

          implAttempt += 1;
          if (implAttempt === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/impl-phase.js',
                      replacements: [{ search: 'MISSING_IMPL', replace: 'value' }]
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'upsert',
                    path: 'frontend/src/impl-phase.js',
                    content: 'const ImplPhase = true;'
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 102, prompt: '' };
      const promise = processGoal(
        goal,
        42,
        '/repo',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      await promise;

      expect(treeFetches).toBe(3);
    });

    test('logs tests-stage replacement retry with null path when JSON parsing fails before replacements run', async () => {
      fetchGoals.mockResolvedValue([{ id: 103, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockResolvedValue({ data: { success: true } });
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({
            data: { success: true, files: [{ path: 'frontend/src/tests-phase.js', type: 'file' }] }
          });
        }
        if (url === '/api/projects/42/files/frontend/src/tests-phase.js') {
          return Promise.resolve({ data: { content: 'const testsBaseline = 0;' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const originalJsonParse = JSON.parse;
      const jsonParseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text, ...args) => {
        if (typeof text === 'string' && text.includes('tests-null-path-marker')) {
          throw new Error('Replacement search text not found');
        }
        return originalJsonParse(text, ...args);
      });

      let testsAttempt = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          const stageContent = payload?.messages?.[1]?.content || '';
          if (stageContent.includes('Stage: tests')) {
            testsAttempt += 1;
            if (testsAttempt === 1) {
              return Promise.resolve({
                data: { content: JSON.stringify({ __marker: 'tests-null-path-marker', edits: [] }) }
              });
            }
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/tests-phase.js',
                      content: 'export const repairedTests = true;'
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 103, prompt: 'null path tests retry' };
      const promise = processGoal(
        goal,
        42,
        '/repo',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      await promise;

      const testsRetryLog = logSpy.mock.calls.find(([label]) => label.includes('processGoal:llm:tests:replacementRetry'));
      expect(testsRetryLog?.[1]?.path).toBeNull();

      jsonParseSpy.mockRestore();
      logSpy.mockRestore();
    });

    test('logs implementation-stage replacement retry with null path when JSON parsing fails before replacements run', async () => {
      fetchGoals.mockResolvedValue([{ id: 104, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockResolvedValue({ data: { success: true } });
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({
            data: {
              success: true,
              files: [
                { path: 'frontend/src/tests-phase.js', type: 'file' },
                { path: 'frontend/src/impl-phase.js', type: 'file' }
              ]
            }
          });
        }
        if (url === '/api/projects/42/files/frontend/src/tests-phase.js') {
          return Promise.resolve({ data: { content: 'const stageValue = 0;' } });
        }
        if (url === '/api/projects/42/files/frontend/src/impl-phase.js') {
          return Promise.resolve({ data: { content: 'const implValue = 0;' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const originalJsonParse = JSON.parse;
      const jsonParseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text, ...args) => {
        if (typeof text === 'string' && text.includes('impl-null-path-marker')) {
          throw new Error('Replacement search text not found');
        }
        return originalJsonParse(text, ...args);
      });

      let implAttempt = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          const stageContent = payload?.messages?.[1]?.content || '';
          if (stageContent.includes('Stage: tests')) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }

          implAttempt += 1;
          if (implAttempt === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  __marker: 'impl-null-path-marker',
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/impl-phase.js',
                      replacements: [{ search: 'MISSING_IMPL', replace: 'value' }]
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'upsert',
                    path: 'frontend/src/impl-phase.js',
                    content: 'const ImplPhase = true;'
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 104, prompt: 'null path impl retry' };
      const promise = processGoal(
        goal,
        42,
        '/repo',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      await promise;

      const implRetryLog = logSpy.mock.calls.find(([label]) => label.includes('processGoal:llm:impl:replacementRetry'));
      expect(implRetryLog?.[1]?.path).toBeNull();

      jsonParseSpy.mockRestore();
      logSpy.mockRestore();
    });

    test('adds strict JSON warning after invalid LLM JSON', async () => {
      fetchGoals.mockResolvedValue([{ id: 7, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      const llmPayloads = [];
      let llmCall = 0;

      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmPayloads.push(payload);
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({ data: { content: '{"edits":[invalid]}' } });
          }
          if (llmCall === 2) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'upsert',
                    path: 'frontend/src/StrictJson.jsx',
                    content: 'export const StrictJson = true;'
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 7, prompt: 'Strict JSON coverage' };
      const promise = processGoal(
        goal,
        42,
        '/repo',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      await promise;

      expect(llmPayloads).toHaveLength(3);
      expect(llmPayloads[1]?.messages?.[0]?.content).toContain('Previous response was not valid JSON');
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/StrictJson.jsx', {
        content: 'export const StrictJson = true;'
      });
    });

    test('refreshes repo context when replacement retries trigger in tests and implementation phases', async () => {
      fetchGoals.mockResolvedValue([{ id: 77, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      let treeFetches = 0;
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          treeFetches += 1;
          return Promise.resolve({
            data: {
              success: true,
              files: [
                { path: 'frontend/src/tests-phase.js', type: 'file' },
                { path: 'frontend/src/impl-phase.js', type: 'file' }
              ]
            }
          });
        }

        if (url === '/api/projects/42/files/frontend/src/tests-phase.js') {
          return Promise.resolve({ data: { content: 'const testsValue = 0;' } });
        }

        if (url === '/api/projects/42/files/frontend/src/impl-phase.js') {
          return Promise.resolve({ data: { content: 'const implValue = 0;' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const llmPayloads = [];
      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmPayloads.push(payload);
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/tests-phase.js',
                      replacements: [{ search: 'MISSING_TESTS', replace: 'value' }]
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 2) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }

          if (llmCall === 3) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/impl-phase.js',
                      replacements: [{ search: 'MISSING_IMPL', replace: 'value' }]
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'upsert',
                    path: 'frontend/src/impl-phase.js',
                    content: 'export const ImplPhase = true;'
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 77, prompt: '' };
      const promise = processGoal(
        goal,
        42,
        '/repo',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      await promise;

      expect(treeFetches).toBe(4);
      expect(llmPayloads[1].messages[1].content).toContain('Previous attempt failed while editing frontend/src/tests-phase.js');
      expect(llmPayloads[1].messages[1].content).toContain('Problematic search snippet: MISSING_TESTS');
      expect(llmPayloads[3].messages[1].content).toContain('Previous attempt failed while editing frontend/src/impl-phase.js');
      expect(llmPayloads[3].messages[1].content).toContain('Problematic search snippet: MISSING_IMPL');
    });

    test('repairs modify edits with a single non-equivalent edit (last-resort selection)', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'hello' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      // Stop after we successfully repair+apply replacements but fail to write.
      axios.put.mockRejectedValueOnce({ response: { status: 500 }, message: 'write failed' });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'MISSING', replace: 'UPDATED' }]
                    }
                  ]
                })
              }
            });
          }

          // Repair response: exactly one valid edit, but path is NOT equivalent.
          // pickRepairEditForPath should pick it anyway as a last resort.
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/somewhere-else.js',
                    replacements: [{ search: 'hello', replace: 'HELLO' }]
                  }
                ]
              })
            }
          });
        }
      });

      const promise = processGoal(
        { id: 1, prompt: 'Force last-resort repair selection' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({ success: false, error: 'write failed' });
      expect(llmCall).toBe(2);
    });

    test('last-resort repair overwrites the path to the target file', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/alpha.js') {
          return Promise.resolve({ data: { content: 'hello' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put.mockRejectedValueOnce({ response: { status: 500 }, message: 'write failed' });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/alpha.js',
                      replacements: [{ search: 'MISSING', replace: 'UPDATED' }]
                    }
                  ]
                })
              }
            });
          }

          // Unrelated path (no suffix match) -> pickRepairEditForPath can only select via last-resort.
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'completely/different.js',
                    replacements: [{ search: 'hello', replace: 'HELLO' }]
                  }
                ]
              })
            }
          });
        }
      });

      const promise = processGoal(
        { id: 1, prompt: 'Force last-resort path overwrite' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({ success: false, error: 'write failed' });
      expect(llmCall).toBe(2);

      // The write target should be the original file path, not the unrelated repair path.
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/alpha.js', { content: 'HELLO' });
      expect(axios.put).not.toHaveBeenCalledWith('/api/projects/42/files/completely/different.js', expect.anything());
    });

    test('falls back to rewrite when repair attempts yield no usable candidate', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'hello' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'MISSING', replace: 'UPDATED' }]
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 2 || llmCall === 3) {
            // Repair call (attempt 1 and attempt 2): return edits that are all invalid (no usable path).
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: '',
                      replacements: [{ search: 'hello', replace: 'HELLO' }]
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 4) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/app.js',
                      content: 'rewritten file content'
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const promise = processGoal(
        { id: 1, prompt: 'Repair yields no candidate' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({ success: true });
      // 1 initial call + 2 repair attempts + 1 rewrite + 1 implementation stage call.
      expect(llmCall).toBe(5);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/app.js', {
        content: 'rewritten file content'
      });
    });

    test('retries edit generation when replacement failures persist and second attempt succeeds', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { files: [{ path: 'frontend/src/App.jsx', type: 'file' }] } });
        }

        if (url === '/api/projects/42/files/frontend/src/App.jsx') {
          return Promise.resolve({ data: { content: 'const App = () => null;' } });
        }

        return Promise.resolve({ data: {} });
      });

      axios.put.mockResolvedValue({ data: { success: true } });

      const llmResponses = [
        {
          edits: [
            {
              type: 'modify',
              path: 'frontend/src/App.jsx',
              replacements: [{ search: 'missing snippet', replace: 'updated snippet' }]
            }
          ]
        },
        { edits: [] },
        { edits: [] },
        { edits: [] },
        { edits: [] },
        {
          edits: [
            {
              type: 'upsert',
              path: 'frontend/src/App.jsx',
              content: 'const App = () => <div>NavBar</div>;' 
            }
          ]
        },
        { edits: [] }
      ];

      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          const response = llmResponses[llmCall] || { edits: [] };
          llmCall += 1;

          if (llmCall === 6) {
            const retryPrompt = payload?.messages?.[1]?.content || '';
            expect(retryPrompt).toContain('Previous attempt failed while editing frontend/src/App.jsx');
            expect(retryPrompt).toContain('Provide replacements that exactly match the latest file contents');
          }

          return Promise.resolve({ data: { content: JSON.stringify(response) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: {} });
        }

        return Promise.resolve({ data: {} });
      });

      const goal = { id: 1, prompt: 'Fix App component' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmCall).toBeGreaterThanOrEqual(6);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/App.jsx', {
        content: 'const App = () => <div>NavBar</div>;'
      });
    });

    test('uses rewrite fallback when repair LLM responds with empty edits', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'hello' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'MISSING', replace: 'UPDATED' }]
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 2 || llmCall === 3) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }

          if (llmCall === 4) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/app.js',
                      content: 'rewrite after empty edits'
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const promise = processGoal(
        { id: 1, prompt: 'Repair returns empty edits' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmCall).toBe(5);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/app.js', {
        content: 'rewrite after empty edits'
      });
    });

    test('falls back to rewrite when repair edits contain non-string type values', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'hello' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'MISSING', replace: 'UPDATED' }]
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 2 || llmCall === 3) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 123,
                      path: 'frontend/src/app.js',
                      content: 'ignored\n'
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 4) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/app.js',
                      content: 'rewrite after invalid type'
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const promise = processGoal(
        { id: 1, prompt: 'Repair returns invalid type' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmCall).toBe(5);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/app.js', {
        content: 'rewrite after invalid type'
      });
    });

    test('falls back to rewrite when repair helper stops after non-SyntaxError', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'hello' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'MISSING', replace: 'UPDATED' }]
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 2) {
            return Promise.reject(new Error('network'));
          }

          if (llmCall === 3) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/app.js',
                      content: 'rewrite after repair error'
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const promise = processGoal(
        { id: 1, prompt: 'Trigger repair error' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({ success: true });
      expect(llmCall).toBe(4);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/app.js', {
        content: 'rewrite after repair error'
      });
    });

    test('logs tests abort when attempt sequence is empty but implementation succeeds', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'upsert',
                    path: 'src/ImplOnly.js',
                    content: 'export const implOnly = true;'
                  }
                ]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        const promise = processGoal(
          { id: 1, prompt: 'Implementation only' },
          42,
          '/test',
          'info',
          mockSetPreviewPanelTab,
          mockSetGoalCount,
          mockCreateMessage,
          mockSetMessages,
          {
            testsAttemptSequence: [],
            implementationAttemptSequence: [1]
          }
        );

        await vi.runAllTimersAsync();
        const result = await promise;

        const labels = consoleSpy.mock.calls.map((call) => call[0]);
        expect(labels.some((label) => typeof label === 'string' && label.includes('processGoal:llm:tests:abort'))).toBe(true);
        expect(result).toEqual({ success: true });
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('logs implementation abort when attempt sequence is empty', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'upsert',
                    path: 'src/TestsOnly.js',
                    content: 'export const testsOnly = true;'
                  }
                ]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        const promise = processGoal(
          { id: 1, prompt: 'Skip implementation' },
          42,
          '/test',
          'info',
          mockSetPreviewPanelTab,
          mockSetGoalCount,
          mockCreateMessage,
          mockSetMessages,
          {
            testsAttemptSequence: [1],
            implementationAttemptSequence: []
          }
        );

        await vi.runAllTimersAsync();
        const result = await promise;

        const labels = consoleSpy.mock.calls.map((call) => call[0]);
        expect(labels.some((label) => typeof label === 'string' && label.includes('processGoal:llm:impl:abort'))).toBe(true);
        expect(result).toEqual({ success: true });
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('retries implementation edits after replacement failures', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/App.jsx',
                      replacements: [{ search: 'MISSING_SNIPPET', replace: 'updated snippet' }]
                    }
                  ]
                })
              }
            });
          }
          if (llmCall === 3) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/App.jsx',
                      content: 'const App = () => <div />;'
                    }
                  ]
                })
              }
            });
          }
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        const promise = processGoal(
          { id: 1, prompt: '' },
          42,
          '/test',
          'info',
          mockSetPreviewPanelTab,
          mockSetGoalCount,
          mockCreateMessage,
          mockSetMessages
        );

        await vi.runAllTimersAsync();
        const result = await promise;

        const labels = consoleSpy.mock.calls.map((call) => call[0]);
        expect(labels.some((label) => typeof label === 'string' && label.includes('processGoal:llm:impl:replacementRetry'))).toBe(true);
        expect(result).toEqual({ success: true });
        expect(llmCall).toBe(3);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('propagates syntax errors when implementation parsing fails twice', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({ data: { content: '{"edits":[oops]}' } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const promise = processGoal(
          { id: 1, prompt: 'Syntax failure' },
          42,
          '/test',
          'info',
          mockSetPreviewPanelTab,
          mockSetGoalCount,
          mockCreateMessage,
          mockSetMessages
        );

        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unexpected token');
        expect(llmCall).toBe(3);
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    test('propagates tests-stage syntax errors after exhausting retries', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: '{"edits":[oops]}' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'tests parse failure' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unexpected token');
    });

    test('records replacement retry context for both tests and implementation phases', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [{ path: 'frontend/src/App.jsx', type: 'file' }] } });
        }
        if (url === '/api/projects/42/files/frontend/src/App.jsx') {
          return Promise.resolve({ data: { content: 'const App = () => null;\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put = vi.fn().mockResolvedValue({ data: { success: true } });

      const llmResponses = [
        { edits: [{ type: 'modify', path: 'frontend/src/App.jsx', replacements: [{ search: 'MISSING_ONE', replace: 'ADD' }] }] },
        { edits: [{ type: 'upsert', path: 'frontend/src/App.jsx', content: 'export const First = 1;' }] },
        { edits: [{ type: 'modify', path: 'frontend/src/App.jsx', replacements: [{ search: 'MISSING_TWO', replace: 'ADD' }] }] },
        { edits: [{ type: 'upsert', path: 'frontend/src/App.jsx', content: 'export const Second = 2;' }] }
      ];

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          const next = llmResponses.shift();
          return Promise.resolve({ data: { content: JSON.stringify(next) } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { overview: { workingBranches: [] } } });
        }
        if (url === '/api/projects/42/files-ops/create-file') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: '' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ success: true });
      const llmCallCount = axios.post.mock.calls.filter(([url]) => url === '/api/llm/generate').length;
      expect(llmCallCount).toBe(4);
      expect(axios.put).toHaveBeenCalledTimes(2);
    });

    test('uses rewrite fallback modify replacements when rewrite provides modify edit', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'const msg = "hello";\n' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'MISSING', replace: 'HELLO' }]
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 2 || llmCall === 3) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }

          if (llmCall === 4) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'hello', replace: 'HELLO' }]
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 5) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'hello', replace: 'HELLO' }]
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const promise = processGoal(
        { id: 1, prompt: 'Rewrite returns modify candidate' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmCall).toBe(6);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/app.js', {
        content: 'const msg = "HELLO";\n'
      });
    });

    test('fails goal when rewrite modify replacements still cannot be applied', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'const msg = "hello";\n' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'MISSING', replace: 'HELLO' }]
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 2 || llmCall === 3) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }

          if (llmCall === 4) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'goodbye', replace: 'HELLO' }]
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const promise = processGoal(
        { id: 1, prompt: 'Rewrite modify still fails' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({
        success: false,
        error:
          'No repo edits were applied for this goal. The LLM likely returned no usable edits (or edits were skipped). Check the browser console for [automation] logs.'
      });
      expect(axios.put).not.toHaveBeenCalled();
      // Second implementation-stage attempt adds one more LLM call before exiting.
      expect(llmCall).toBe(7);
    });

    test('parses edits when LLM responds with data.response', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { response: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              response: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/Response.js', content: 'export const y = 2;' }]
              })
            }
          });
        }

            return Promise.resolve({ data: { success: true } });

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'No-op edits' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmCall).toBe(2);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/Response.js', {
        content: 'export const y = 2;'
      });
    });

    test('treats valid JSON with non-array edits as no edits', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockClear();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: {} }) } });
          }

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/NonArrayFallback.js', content: 'export const ok = true;' }]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Non-array edits should be ignored' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmCall).toBe(2);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/NonArrayFallback.js', {
        content: 'export const ok = true;'
      });
    });

    test('falls back to data.content when data.response is an empty string', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockClear();

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          return Promise.resolve({
            data: {
              response: '',
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/Fallback.js', content: 'export const x = 1;' }]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Use content when response is empty' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmCall).toBe(2);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/Fallback.js', {
        content: 'export const x = 1;'
      });
    });

    test('skips edits whose path is not a string', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockClear();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [{ type: 'upsert', path: 123, content: 'ignored' }]
                })
              }
            });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/ValidPath.js', content: 'export const ok = true;' }]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Skip invalid path edits' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/ValidPath.js', {
        content: 'export const ok = true;'
      });
    });

    test('treats non-string file content as empty string when reading', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { success: true, content: 123 } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put.mockClear();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [{ type: 'modify', path: 'src/SomeFile.js', replacements: [] }]
                })
              }
            });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/WriteAfterRead.js', content: 'export const wrote = true;' }]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'No-op modify with odd content type' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/WriteAfterRead.js', {
        content: 'export const wrote = true;'
      });
    });

    test('treats empty LLM content as no edits', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          return Promise.resolve({ data: { content: '' } });
        }
      });

      const goal = { id: 1, prompt: 'Empty edits response' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('No repo edits were applied');
      expect(llmCall).toBe(2);
    });

    test('treats undefined LLM responses as no edits', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          return Promise.resolve(undefined);
        }
      });

      const goal = { id: 1, prompt: 'Undefined responses' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('No repo edits were applied');
      expect(llmCall).toBe(2);
    });

    test('includes flattened repo file tree context in the LLM prompt', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      const treeResponse = {
        data: {
          success: true,
          files: [
            {
              name: 'src',
              type: 'folder',
              path: 'src',
              children: [
                { name: 'App.jsx', type: 'file', path: 'src/App.jsx' },
                { name: 'NoPath.jsx', type: 'file' }
              ]
            },
            { name: 'README.md', type: 'file', path: 'README.md' }
          ]
        }
      };
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve(treeResponse);
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          const userMessage = payload?.messages?.[1]?.content || '';
          expect(userMessage).toContain('Repo file tree');
          expect(userMessage).toContain('src');
          expect(userMessage).toContain('src/App.jsx');
          expect(userMessage).toContain('README.md');
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/RepoContext.jsx', content: 'export const RepoContext = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/files-ops/create-file') {
          return Promise.resolve({ data: { success: true } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Use repo context' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
    });

    test('passes syncBranchOverview through when provided in options', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      const syncBranchOverview = vi.fn();

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/SyncOverview.jsx', content: 'export default 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true, overview: { workingBranches: [] } } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      const goal = { id: 1, prompt: 'Create file and sync overview' };
      const projectInfo = 'Project: Test\nFramework: react\nLanguage: javascript\nPath: /test';

      const promise = processGoal(
        goal,
        42,
        '/test',
        projectInfo,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages,
        { syncBranchOverview }
      );

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(800);
      await vi.advanceTimersByTimeAsync(800);

      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(syncBranchOverview).toHaveBeenCalledWith(42, expect.objectContaining({ workingBranches: expect.any(Array) }));
    });

    test('ignores folder nodes with non-array children in the file tree', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      const treeResponse = {
        data: {
          success: true,
          files: [
            {
              name: 'frontend',
              type: 'folder',
              path: 'frontend',
              children: 'not-an-array'
            }
          ]
        }
      };
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve(treeResponse);
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({ edits: [{ type: 'upsert', path: 'src/TreeOk.js', content: 'export const ok = 1;' }] })
              }
            });
          }
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      const promise = processGoal(
        { id: 1, prompt: 'Tree with odd folder children' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;
      expect(result).toEqual({ success: true });
    });

    test('includes relevant file contents context and truncates long files', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      const longContent = 'x'.repeat(31000);

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          if (url.endsWith('/frontend/package.json')) {
            // Short non-empty content => covers the non-truncation branch.
            return Promise.resolve({ data: { success: true, content: '{"name":"demo"}' } });
          }
          if (url.endsWith('/frontend/src/App.jsx')) {
            return Promise.resolve({ data: { success: true, content: longContent } });
          }
          if (url.endsWith('/frontend/src/index.css')) {
            // Whitespace-only => trimmed empty branch.
            return Promise.resolve({ data: { success: true, content: '   ' } });
          }
          if (url.endsWith('/frontend/src/App.css')) {
            // 404 => readProjectFile returns null branch.
            return Promise.reject({ response: { status: 404 } });
          }
          if (url.endsWith('/frontend/src/main.jsx')) {
            // Non-404 error => readProjectFile throws; buildRelevantFilesContext catches and continues.
            return Promise.reject(new Error('boom'));
          }

          return Promise.resolve({ data: { success: true, content: '' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      // ensure put exists for file writes
      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      const llmPayloads = [];
      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmPayloads.push(payload);
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/components/NavBar.jsx',
                      content: 'export const NavBar = () => null;'
                    }
                  ]
                })
              }
            });
          }
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Add NavBar styling in css' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmPayloads.length).toBeGreaterThan(0);

      const firstPayload = llmPayloads[0];
      const userMessageContent = firstPayload?.messages?.find((m) => m.role === 'user')?.content || '';
      expect(userMessageContent).toContain('Relevant file contents');
      expect(userMessageContent).toContain('--- frontend/package.json ---');
      expect(userMessageContent).toContain('--- frontend/src/App.jsx ---');
      expect(userMessageContent).toContain('chars omitted');
    });

    test('includes routing-related files in relevant context when prompt mentions routing', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({
            data: {
              success: true,
              files: [
                {
                  path: 'frontend',
                  type: 'folder',
                  children: [
                    {
                      path: 'frontend/src',
                      type: 'folder',
                      children: [
                        {
                          path: 'frontend/src/router',
                          type: 'folder',
                          children: [{ path: 'frontend/src/router/index.jsx', type: 'file' }]
                        },
                        {
                          path: 'frontend/src/routes',
                          type: 'folder',
                          children: [{ path: 'frontend/src/routes/AppRoutes.jsx', type: 'file' }]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          });
        }

        if (url === '/api/projects/42/files/frontend/src/router/index.jsx') {
          return Promise.resolve({ data: { success: true, content: 'export const router = 1;\n' } });
        }
        if (url === '/api/projects/42/files/frontend/src/routes/AppRoutes.jsx') {
          return Promise.resolve({ data: { success: true, content: 'export const routes = 2;\n' } });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { success: true, content: '' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const llmPayloads = [];
      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmPayloads.push(payload);
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [{ type: 'upsert', path: 'src/RoutesTouched.js', content: 'export const ok = true;\n' }]
                })
              }
            });
          }
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Add a new route and update routing' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.get).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/router/index.jsx');
      expect(axios.get).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/routes/AppRoutes.jsx');

      const firstPayload = llmPayloads[0];
      const userMessageContent = firstPayload?.messages?.find((m) => m.role === 'user')?.content || '';
      expect(userMessageContent).toContain('Relevant file contents');
      expect(userMessageContent).toContain('--- frontend/src/router/index.jsx ---');
      expect(userMessageContent).toContain('--- frontend/src/routes/AppRoutes.jsx ---');
    });

    test('includes explicit file paths mentioned in the goal prompt', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({
            data: {
              success: true,
              files: [{ type: 'file', path: 'frontend/src/__tests__/App.test.jsx' }]
            }
          });
        }

        if (url === '/api/projects/42/files/frontend/src/__tests__/App.test.jsx') {
          return Promise.resolve({ data: { success: true, content: 'describe("App", () => {});' } });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { success: true, content: '' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      const llmPayloads = [];
      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmPayloads.push(payload);
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/PromptPathMention.js',
                      content: 'export const ok = true;\n'
                    }
                  ]
                })
              }
            });
          }
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Fix failing test: src/__tests__/App.test.jsx [ src/__tests__/App.test.jsx ]' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      const userMessageContent = llmPayloads[0].messages.find((m) => m.role === 'user')?.content || '';
      expect(userMessageContent).toContain('--- frontend/src/__tests__/App.test.jsx ---');
      expect(axios.get).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/__tests__/App.test.jsx');
    });

    test('retries edit generation once when parse errors occur and succeeds on second attempt', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/frontend/src/App.jsx') {
          return Promise.resolve({ data: { success: true, content: 'export default function App() { return null; }' } });
        }
        return Promise.resolve({ data: { success: true, content: '' } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      const llmResponses = [
        { data: { content: '{"edits": }' } },
        {
          data: {
            content: JSON.stringify({
              edits: [
                {
                  type: 'upsert',
                  path: 'frontend/src/App.jsx',
                  content: 'export default function App() { return <main />; }'
                }
              ]
            })
          }
        },
        { data: { content: JSON.stringify({ edits: [] }) } }
      ];

      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve(llmResponses.shift());
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Retry after parse error' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.post).toHaveBeenCalledWith('/api/llm/generate', expect.objectContaining({
        messages: expect.any(Array)
      }));
      expect(llmResponses.length).toBe(0);
    });

    test('prefers existing main/app variants from the file tree (existingPaths branch)', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      // Provide a file tree that includes main.js/App.js and css files (not the default jsx/tsx candidates).
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({
            data: {
              success: true,
              files: [
                { type: 'file', path: 'frontend/package.json' },
                { type: 'file', path: 'frontend/src/main.js' },
                { type: 'file', path: 'frontend/src/App.js' },
                { type: 'file', path: 'frontend/src/index.css' },
                { type: 'file', path: 'frontend/src/App.css' }
              ]
            }
          });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          if (url.endsWith('/frontend/package.json')) {
            return Promise.resolve({ data: { success: true, content: '{"name":"demo"}' } });
          }
          if (url.endsWith('/frontend/src/main.js')) {
            return Promise.resolve({ data: { success: true, content: 'console.log("main")' } });
          }
          if (url.endsWith('/frontend/src/App.js')) {
            return Promise.resolve({ data: { success: true, content: 'export default function App() { return null; }' } });
          }
          if (url.endsWith('/frontend/src/index.css')) {
            return Promise.resolve({ data: { success: true, content: 'body{margin:0}' } });
          }
          if (url.endsWith('/frontend/src/App.css')) {
            return Promise.resolve({ data: { success: true, content: '.app{}' } });
          }

          return Promise.resolve({ data: { success: true, content: '' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      const llmPayloads = [];
      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmPayloads.push(payload);
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'frontend/src/ExistingPaths.js', content: 'export const ok = true;' }]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      // goal.prompt is intentionally non-string to hit the typeof(goalPrompt) !== 'string' branch in buildRelevantFilesContext.
      const goal = { id: 1, prompt: { text: 'ignored' } };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmPayloads[0].messages[1].content).toContain('Relevant file contents (read-only context)');
      expect(llmPayloads[0].messages[1].content).toContain('--- frontend/src/main.js ---');
      expect(llmPayloads[0].messages[1].content).toContain('--- frontend/src/App.js ---');
      expect(llmPayloads[0].messages[1].content).toContain('--- frontend/src/index.css ---');
      expect(llmPayloads[0].messages[1].content).toContain('--- frontend/src/App.css ---');
    });

    test('does not attempt modify repair when goal prompt is blank', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'hello' } });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { content: '' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'frontend/src/app.js',
                    replacements: [{ search: 'MISSING', replace: 'UPDATED' }]
                  }
                ]
              })
            }
          });
        }
      });

      const promise = processGoal(
        { id: 1, prompt: '   ' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      // Only the stage-level retries should run (no repair-specific prompts because the goal prompt is blank).
      expect(llmCall).toBe(2);
      expect(result).toEqual({ success: false, error: 'Replacement search text not found' });
    });

    test('does not attempt modify repair when goal prompt is non-string', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'hello' } });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { content: '' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'frontend/src/app.js',
                    replacements: [{ search: 'MISSING', replace: 'UPDATED' }]
                  }
                ]
              })
            }
          });
        }
      });

      const promise = processGoal(
        { id: 1, prompt: { text: 'not a string' } },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(llmCall).toBe(2);
      expect(result).toEqual({ success: false, error: 'Replacement search text not found' });
    });

    test('does not attempt modify repair when replacement error is not resolution-related', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'hello' } });
        }
        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { content: '' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'frontend/src/app.js',
                    replacements: [{ search: 123, replace: 'UPDATED' }]
                  }
                ]
              })
            }
          });
        }
      });

      const promise = processGoal(
        { id: 1, prompt: 'Trigger invalid replacement entry' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(llmCall).toBe(1);
      expect(result).toEqual({ success: false, error: 'Invalid replacement entry' });
    });

    test('covers tryParseLooseJson JSON.parse failure (returns null)', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { content: '' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            // Balanced braces, but contains an unescaped newline inside a JSON string => JSON.parse throws.
            const badJson = `{"edits":[{"type":"upsert","path":"src/bad.js","content":"line1
line2"}]}`;
            return Promise.resolve({
              data: {
                content: badJson
              }
            });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({ edits: [{ type: 'upsert', path: 'src/LooseJsonOk.js', content: 'export const ok = 1;' }] })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const promise = processGoal(
        { id: 1, prompt: 'Trigger loose json parse failure' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;
      expect(result).toEqual({ success: true });
    });

    test('passes knownPathsSet through when applying modify edits with a populated file tree', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      // Non-empty file tree => processGoal builds a non-empty knownPathsSet => applyEdits useKnownPaths=true.
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({
            data: {
              success: true,
              files: [{ type: 'file', path: 'frontend/src/app.js' }]
            }
          });
        }

        if (url === '/api/projects/42/files/frontend/src/app.js') {
          return Promise.resolve({ data: { content: 'hello world' } });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { content: '' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/app.js',
                      replacements: [{ search: 'hello', replace: 'HELLO' }]
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const promise = processGoal(
        { id: 1, prompt: 'Apply modify edit with known paths' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/app.js', { content: 'HELLO world' });
    });

    test('treats unbalanced JSON in LLM content as no edits (extractJsonObject returns null)', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            // Has an opening '{' but never closes -> extractJsonObject scans and returns null.
            return Promise.resolve({ data: { content: 'here you go: {"edits":[' } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/UnbalancedOk.js', content: 'export const ok = 1;\n' }]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Handle broken JSON gracefully' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;
      expect(result).toEqual({ success: true });
    });

    test('extractJsonObject tolerates single-quoted strings that contain braces', () => {
      const raw =
        "note: {'edits':[{'type':'upsert','path':'src/x.js','content':'export const x = { a: 1 };\\n'}]} trailing";

      const extracted = __testOnly.extractJsonObject(raw);
      expect(typeof extracted).toBe('string');
      expect(extracted.startsWith('{')).toBe(true);
      expect(extracted.endsWith('}')).toBe(true);

      const parsed = __testOnly.tryParseLooseJson(extracted);
      expect(parsed).toBeTruthy();
      expect(Array.isArray(parsed.edits)).toBe(true);
      expect(parsed.edits[0]).toEqual(
        expect.objectContaining({
          type: 'upsert',
          path: 'src/x.js'
        })
      );
    });

    test('parseEditsFromLLM normalizes curly smart quotes returned by the model', () => {
      const leftQuote = '\\u201C';
      const rightQuote = '\\u201D';
      const withCurly = (text) => `${leftQuote}${text}${rightQuote}`;

      const responseWithCurlyQuotes = [
        '{',
        `  ${withCurly('edits')}: [`,
        '    {',
        `      ${withCurly('type')}: ${withCurly('modify')},`,
        `      ${withCurly('path')}: ${withCurly('src/NavBar.jsx')},`,
        `      ${withCurly('replacements')}: [`,
        '        {',
        `          ${withCurly('search')}: ${withCurly('export function NavBar() {')},`,
        `          ${withCurly('replace')}: ${withCurly('export function NavBar() {\n  return nav;\n}')}`,
        '        }',
        '      ]',
        '    }',
        '  ]',
        '}'
      ].join('\n');

      const edits = __testOnly.parseEditsFromLLM({
        data: { response: responseWithCurlyQuotes }
      });

      expect(edits).toHaveLength(1);
      expect(edits[0]).toEqual(
        expect.objectContaining({
          type: 'modify',
          path: 'src/NavBar.jsx'
        })
      );
    });

    test('applyEdits modify falls back to whitespace-insensitive replacement matching', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/components/NavBar.jsx') {
          return Promise.resolve({
            data: {
              content: 'export const NavBar = () => (\n  <div>hello</div>\n);\n'
            }
          });
        }
        return Promise.resolve({ data: { content: '' } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      axios.post.mockImplementation((url) => {
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const summary = await __testOnly.applyEdits({
        projectId: 42,
        edits: [
          {
            type: 'modify',
            path: 'frontend/src/components/NavBar.jsx',
            replacements: [
              {
                // Different whitespace than the file content.
                search: 'export const NavBar = () => ( <div>hello</div> );',
                replace: 'export const NavBar = () => (\n  <div>HELLO</div>\n);'
              }
            ]
          }
        ]
      });

      expect(summary).toEqual({ applied: 1, skipped: 0 });
      expect(axios.put).toHaveBeenCalledWith(
        '/api/projects/42/files/frontend/src/components/NavBar.jsx',
        expect.objectContaining({
          content: expect.stringContaining('HELLO')
        })
      );
    });

    test('includes NavBar candidates from the file tree when prompt mentions nav', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({
            data: {
              success: true,
              files: [
                {
                  path: 'frontend',
                  type: 'folder',
                  children: [
                    {
                      path: 'frontend/src',
                      type: 'folder',
                      children: [
                        {
                          path: 'frontend/src/components',
                          type: 'folder',
                          children: [
                            { path: 'frontend/src/components/NavBar.jsx', type: 'file' },
                            { path: 'frontend/src/components/NavBar.module.css', type: 'file' }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          });
        }

        if (url === '/api/projects/42/files/frontend/src/components/NavBar.jsx') {
          return Promise.resolve({ data: { success: true, content: 'export const NavBar = () => null;\n' } });
        }
        if (url === '/api/projects/42/files/frontend/src/components/NavBar.module.css') {
          return Promise.resolve({ data: { success: true, content: '.nav { color: red; }\n' } });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { success: true, content: '' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const llmPayloads = [];
      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmPayloads.push(payload);
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [{ type: 'upsert', path: 'src/NavTouched.js', content: 'export const ok = true;\n' }]
                })
              }
            });
          }
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Add navbar and update nav styles' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.get).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/components/NavBar.jsx');
      expect(axios.get).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/components/NavBar.module.css');

      const firstPayload = llmPayloads[0];
      const userMessageContent = firstPayload?.messages?.find((m) => m.role === 'user')?.content || '';
      expect(userMessageContent).toContain('--- frontend/src/components/NavBar.jsx ---');
      expect(userMessageContent).toContain('--- frontend/src/components/NavBar.module.css ---');
    });

    test('notifyGoalsUpdated swallows CustomEvent/dispatch errors', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      const originalCustomEvent = globalThis.CustomEvent;
      globalThis.CustomEvent = function CustomEvent() {
        throw new Error('CustomEvent blocked');
      };

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [{ type: 'upsert', path: 'src/NotifyTest.js', content: 'export const a = 1;\n' }]
                })
              }
            });
          }
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Notify goals updated' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;
      expect(result).toEqual({ success: true });

      globalThis.CustomEvent = originalCustomEvent;
    });

    test('omits relevant file contents context when no files have usable content', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { success: true, content: '' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      const llmPayloads = [];
      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmPayloads.push(payload);
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'upsert',
                      path: 'frontend/src/components/NoContext.jsx',
                      content: 'export const NoContext = 1;'
                    }
                  ]
                })
              }
            });
          }
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Update something unrelated' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmPayloads.length).toBeGreaterThan(0);

      const firstPayload = llmPayloads[0];
      const userMessageContent = firstPayload?.messages?.find((m) => m.role === 'user')?.content || '';
      expect(userMessageContent).not.toContain('Relevant file contents');
    });

    test('handles non-array file tree responses without crashing', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      const treeResponse = { data: { success: true, files: null } };
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve(treeResponse);
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          const userMessage = payload?.messages?.[1]?.content || '';
          expect(userMessage).not.toContain('Repo file tree');
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/NoTree.jsx', content: 'export const NoTree = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Non-array tree' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
    });

    test('normalizes backslash paths and strips leading slashes before writing and staging', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  { type: 'upsert', path: '\\src\\Win.jsx', content: 'export const Win = 1;' },
                  { type: 'upsert', path: '/src/Lead.jsx', content: 'export const Lead = 1;' }
                ]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Normalize paths' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/Win.jsx', {
        content: 'export const Win = 1;'
      });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/Lead.jsx', {
        content: 'export const Lead = 1;'
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/Win.jsx',
        source: 'ai'
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/Lead.jsx',
        source: 'ai'
      });
    });

    test('skips writing and staging when normalized file path is empty', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  { type: 'upsert', path: '/', content: 'ignored' },
                  { type: 'upsert', path: 'src/Ok.jsx', content: 'export const Ok = 1;' }
                ]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Skip empty path' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/Ok.jsx', {
        content: 'export const Ok = 1;'
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/Ok.jsx',
        source: 'ai'
      });
    });

    test('skips writing and staging when file path is not a string', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  { type: 'upsert', path: 123, content: 'ignored' },
                  { type: 'upsert', path: 'src/Valid.jsx', content: 'export const Valid = 1;' }
                ]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Skip non-string path' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/Valid.jsx', {
        content: 'export const Valid = 1;'
      });
    });

    test('fails the goal when saving a file errors with non-404 response', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockRejectedValueOnce({ response: { status: 500 } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/Bad.jsx', content: 'export const Bad = 1;' }]
              })
            }
          });
        }
      });

      const goal = { id: 1, prompt: 'Write failure' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({ success: false, error: 'Unknown error' });
      expect(mockCreateMessage).toHaveBeenCalledWith(
        'assistant',
        'Error processing goal: Unknown error',
        { variant: 'error' }
      );
    });

    test('does not dispatch goals-updated when projectId is missing', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});
      axios.post.mockResolvedValue({ data: { content: JSON.stringify({ edits: [] }) } });

      const originalWindow = globalThis.window;
      if (!originalWindow) {
        globalThis.window = { dispatchEvent: vi.fn() };
      }

      const dispatchSpy = vi.spyOn(globalThis.window, 'dispatchEvent');

      const goal = { id: 1, prompt: 'Missing project id notify guard' };
      const promise = processGoal(
        goal,
        undefined,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(dispatchSpy).not.toHaveBeenCalled();
      dispatchSpy.mockRestore();
      if (!originalWindow) {
        delete globalThis.window;
      } else {
        globalThis.window = originalWindow;
      }
    });

    test('does not dispatch goals-updated when window is unavailable', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});
      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/NoWindow.jsx', content: 'export const NoWindow = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const originalWindow = globalThis.window;
      // Simulate non-browser environment for notifyGoalsUpdated.
      // eslint-disable-next-line no-global-assign
      globalThis.window = undefined;

      const goal = { id: 1, prompt: 'No window notify guard' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });

      // eslint-disable-next-line no-global-assign
      globalThis.window = originalWindow;
    });

    test('ignores CustomEvent errors when dispatching goals-updated', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});
      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/NoCustomEvent.jsx', content: 'export const NoCustomEvent = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const originalCustomEvent = globalThis.CustomEvent;
      // Force the notifyGoalsUpdated try/catch path.
      // eslint-disable-next-line no-global-assign
      globalThis.CustomEvent = undefined;

      const goal = { id: 1, prompt: 'CustomEvent unavailable' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });

      // eslint-disable-next-line no-global-assign
      globalThis.CustomEvent = originalCustomEvent;
    });

    test('writes multiple files from LLM response', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  { type: 'upsert', path: 'src/A.jsx', content: 'const A = () => null;' },
                  { type: 'upsert', path: 'src/B.jsx', content: 'const B = () => null;' }
                ]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Create components' };
      
      const promise = processGoal(
        goal,
        42,
        '/test',
        'Project info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/A.jsx', {
        content: 'const A = () => null;'
      });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/B.jsx', {
        content: 'const B = () => null;'
      });

      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/A.jsx',
        source: 'ai'
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/B.jsx',
        source: 'ai'
      });
    });

    test('handles LLM parse error gracefully', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            // No JSON object in response => parseEditsFromLLM returns [] and goal continues.
            return Promise.resolve({
              data: { content: 'This is plain text with no JSON' }
            });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/FromParseError.jsx', content: 'export const FromParseError = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Test' };
      
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[automation] processGoal:start'),
        expect.any(Object)
      );
      
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test('parses near-JSON edits with unquoted keys and single quotes', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      const treeResponse = { data: { success: true, files: [] } };
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve(treeResponse);
        }
        return Promise.resolve({ data: { success: true } });
      });
      axios.put = axios.put || vi.fn();
      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: '{edits:[{type:\'upsert\',path:\'src/Loose.jsx\',content:\'export default 1;\'}]}' } });
          }
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Loose JSON' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/Loose.jsx', { content: 'export default 1;' });
    });

    test('logs JSON.parse errors and continues', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            // Matches the JSON extraction regex but is invalid JSON
            return Promise.resolve({ data: { content: '{not valid json}' } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/FromParseError2.jsx', content: 'export const FromParseError2 = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Test' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to parse LLM response:', expect.any(Error));
      consoleErrorSpy.mockRestore();
    });

    test('logs JSON.parse errors in implementation stage and continues', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            // Tests stage: apply a real edit so the goal can still succeed.
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [{ type: 'upsert', path: 'src/FromTestsStage.jsx', content: 'export const FromTestsStage = 1;' }]
                })
              }
            });
          }
          if (llmCall === 2) {
            // Implementation stage attempt 1: invalid JSON that matches the extraction regex.
            return Promise.resolve({ data: { content: '{not valid json}' } });
          }
          // Implementation stage attempt 2: valid edit so the goal can still succeed.
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/FromImplStage.jsx', content: 'export const FromImplStage = 2;' }]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Impl parse error' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to parse LLM response:', expect.any(Error));
      consoleErrorSpy.mockRestore();
    });

    test('logs empty edits in implementation stage and still succeeds when tests applied edits', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            // Tests stage: apply a real edit so the goal can succeed.
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [{ type: 'upsert', path: 'src/FromEmptyImpl.jsx', content: 'export const FromEmptyImpl = 1;' }]
                })
              }
            });
          }
          // Implementation stage: valid JSON but empty edits array.
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Impl empty edits' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[automation] processGoal:llm:impl:emptyEdits'),
        expect.any(Object)
      );

      consoleLogSpy.mockRestore();
    });

    test('handles non-string raw implementation LLM response when logging empty edits', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [{ type: 'upsert', path: 'src/FromNonStringImpl.jsx', content: 'export const FromNonStringImpl = 1;' }]
                })
              }
            });
          }

          // Implementation stage: response is a non-string truthy value.
          // parseEditsFromLLM should treat this as no edits; logging should not crash.
          return Promise.resolve({ data: { response: { note: 'not-a-string' } } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Impl empty edits non-string raw' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[automation] processGoal:llm:impl:emptyEdits'),
        expect.any(Object)
      );

      consoleLogSpy.mockRestore();
    });

    test('handles undefined goal prompt in automationLog context', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/NoPrompt.jsx', content: 'export const NoPrompt = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1 };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;
      expect(result).toEqual({ success: true });
    });

    test('handles undefined thrown errors in file tree scan catch optional chaining', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.reject(undefined);
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { success: true, content: '' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/FileTreeErrorOk.jsx', content: 'export const FileTreeErrorOk = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'File tree error optional chaining' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;
      expect(result).toEqual({ success: true });
    });

    test('handles file tree scan error response.status in catch optional chaining', async () => {
      fetchGoals.mockResolvedValue([{ id: 1, phase: 'ready' }]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.reject({ response: { status: 500 }, message: 'Tree failed' });
        }

        if (typeof url === 'string' && url.startsWith('/api/projects/42/files/')) {
          return Promise.resolve({ data: { success: true, content: '' } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/FileTreeErrorStatusOk.jsx', content: 'export const FileTreeErrorStatusOk = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'File tree error status optional chaining' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;
      expect(result).toEqual({ success: true });
    });

    test('accepts LLM response in data.response field', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              response: JSON.stringify({ edits: [{ type: 'upsert', path: 'src/X.jsx', content: 'export default 1;' }] })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Test' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/X.jsx', {
        content: 'export default 1;'
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/X.jsx',
        source: 'ai'
      });
    });

    test('skips file entries missing path or content', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  { type: 'upsert', path: 'src/Good.jsx', content: 'export const Good = 1;' },
                  { type: 'upsert', path: 'src/NoContent.jsx' },
                  { type: 'upsert', content: 'export const NoPath = 1;' }
                ]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Test' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(axios.put).toHaveBeenCalledTimes(1);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/Good.jsx', {
        content: 'export const Good = 1;'
      });

      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/Good.jsx',
        source: 'ai'
      });
    });

    test('applies fine-grained modify edits via unique search/replace then stages', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({
            data: {
              success: true,
              content: 'export const answer = 1;\n'
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: [
                      { search: 'export const answer = 1;\n', replace: 'export const answer = 2;\n' }
                    ]
                  }
                ]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Edit existing file' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/existing.js', {
        content: 'export const answer = 2;\n'
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/existing.js',
        source: 'ai'
      });
    });

    test('fails the goal when modify replacement search is not found', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({
            data: {
              success: true,
              content: 'export const answer = 1;\n'
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: [
                      { search: 'export const missing = 1;\n', replace: 'export const missing = 2;\n' }
                    ]
                  }
                ]
              })
            }
          });
        }
      });

      const goal = { id: 1, prompt: 'Bad replacement' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'Replacement search text not found' });
    });

    test('fails the goal when modify replacement search is ambiguous', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({
            data: {
              success: true,
              content: 'export const answer = 1;\nexport const answer = 1;\n'
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: [
                      { search: 'export const answer = 1;\n', replace: 'export const answer = 2;\n' }
                    ]
                  }
                ]
              })
            }
          });
        }
      });

      const goal = { id: 1, prompt: 'Ambiguous replacement' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'Replacement search text is ambiguous' });
    });

    test('repairs ambiguous modify replacements once using LLM and succeeds', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({
            data: {
              success: true,
              content: 'export const answer = 1;\nexport const answer = 1;\n'
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;

          // First stage (tests): no edits
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }

          // Implementation returns an ambiguous replacement
          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'src/existing.js',
                      replacements: [{ search: 'export const answer = 1;', replace: 'export const answer = 2;' }]
                    }
                  ]
                })
              }
            });
          }

          // Repair call: return a unique snippet with a newline so it matches once
          const user = payload?.messages?.find((m) => m.role === 'user')?.content || '';
          expect(user).toContain('File content');
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: [
                      {
                        search: 'export const answer = 1;\nexport const answer = 1;\n',
                        replace: 'export const answer = 2;\nexport const answer = 1;\n'
                      }
                    ]
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Fix ambiguous replace' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/existing.js', {
        content: 'export const answer = 2;\nexport const answer = 1;\n'
      });
    });

    test('includes truncated file content in the modify-repair prompt for long files', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      const longContent = `needle\n${'A'.repeat(9000)}`;

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/long.txt') {
          return Promise.resolve({ data: { success: true, content: longContent } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'src/long.txt',
                      replacements: [{ search: 'missing', replace: 'present' }]
                    }
                  ]
                })
              }
            });
          }

          const userPrompt = payload?.messages?.find((m) => m.role === 'user')?.content || '';
          expect(userPrompt).toContain('/* ...truncated... */');

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/long.txt',
                    replacements: [{ search: 'needle\n', replace: 'repaired\n' }]
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const promise = processGoal(
        { id: 1, prompt: 'Repair prompt should truncate long file content' },
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/long.txt', {
        content: `repaired\n${'A'.repeat(9000)}`
      });
    });

    test('accepts modify-repair edits that use a suffix-matching path', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/frontend/src/components/NavBar.jsx') {
          return Promise.resolve({
            data: {
              success: true,
              content: '<div>old</div>\n'
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/components/NavBar.jsx',
                      replacements: [{ search: 'missing', replace: 'present' }]
                    }
                  ]
                })
              }
            });
          }

          // Repair uses a shorter suffix path; service should treat it as equivalent.
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/components/NavBar.jsx',
                    replacements: [{ search: '<div>old</div>\n', replace: '<div>new</div>\n' }]
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Update NavBar' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/components/NavBar.jsx', {
        content: '<div>new</div>\n'
      });
    });

    test('retries modify repair on parse errors and uses the stricter attempt-2 prompt', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({
            data: {
              success: true,
              content: 'export const answer = 1;\nexport const answer = 1;\n'
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;

          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }

          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'src/existing.js',
                      replacements: [{ search: 'export const answer = 1;', replace: 'export const answer = 2;' }]
                    }
                  ]
                })
              }
            });
          }

          if (llmCall === 3) {
            // First repair attempt returns malformed JSON to trigger SyntaxError retry.
            return Promise.resolve({ data: { content: '{"edits":[}' } });
          }

          const system = payload?.messages?.find((m) => m.role === 'system')?.content || '';
          expect(system).toContain('Schema');
          expect(system).toContain('Return ONLY valid JSON');

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: [
                      {
                        search: 'export const answer = 1;\nexport const answer = 1;\n',
                        replace: 'export const answer = 2;\nexport const answer = 1;\n'
                      }
                    ]
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Retry repair parse errors' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(llmCall).toBe(4);
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/existing.js', {
        content: 'export const answer = 2;\nexport const answer = 1;\n'
      });
    });

    test('prefers exact-path repair edits when multiple equivalent edits exist', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/frontend/src/components/NavBar.jsx') {
          return Promise.resolve({ data: { success: true, content: '<div>old</div>\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/components/NavBar.jsx',
                      replacements: [{ search: 'missing', replace: 'present' }]
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'frontend/src/components/NavBar.jsx',
                    replacements: [{ search: '<div>old</div>\n', replace: '<div>exact</div>\n' }]
                  },
                  {
                    type: 'modify',
                    path: 'src/components/NavBar.jsx',
                    replacements: [{ search: '<div>old</div>\n', replace: '<div>suffix</div>\n' }]
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Prefer exact repair edit' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/components/NavBar.jsx', {
        content: '<div>exact</div>\n'
      });
    });

    test('accepts upsert repair edits and applies their content', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/frontend/src/existing.txt') {
          return Promise.resolve({ data: { success: true, content: 'old\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/existing.txt',
                      replacements: [{ search: 'missing', replace: 'present' }]
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'upsert',
                    path: 'src/existing.txt',
                    content: 'repaired\n'
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Upsert repair content' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/existing.txt', {
        content: 'repaired\n'
      });
    });

    test('prefers an exact-path upsert repair edit when available', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/frontend/src/existing.txt') {
          return Promise.resolve({ data: { success: true, content: 'old\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'frontend/src/existing.txt',
                      replacements: [{ search: 'missing', replace: 'present' }]
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'upsert',
                    path: 'frontend/src/existing.txt',
                    content: 'repaired\n'
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Exact upsert repair' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/frontend/src/existing.txt', {
        content: 'repaired\n'
      });
    });

    test('fails the goal when modify repair fails with a non-syntax error', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({ data: { success: true, content: 'export const a = 1;\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'src/existing.js',
                      replacements: [{ search: 'missing', replace: 'present' }]
                    }
                  ]
                })
              }
            });
          }

          const err = new Error('repair request failed');
          err.response = { status: 500 };
          return Promise.reject(err);
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Non-syntax repair failure' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'repair request failed' });
    });

    test('does not retry modify repair when the repair request fails non-syntax', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({ data: { success: true, content: 'export const a = 1;\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'src/existing.js',
                      replacements: [{ search: 'missing', replace: 'present' }]
                    }
                  ]
                })
              }
            });
          }

          const err = new Error('repair request failed');
          err.response = { status: 500 };
          return Promise.reject(err);
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Non-syntax repair failure (no retry)' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'repair request failed' });
      // Extra call comes from the stage-level retry that now re-runs the implementation stage once.
      expect(llmCall).toBe(5);
    });

    test('fails the goal when a repair edit cannot be applied and rethrows the original error', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({ data: { success: true, content: 'export const a = 1;\n' } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 2) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({
                  edits: [
                    {
                      type: 'modify',
                      path: 'src/existing.js',
                      replacements: [{ search: 'missing', replace: 'present' }]
                    }
                  ]
                })
              }
            });
          }

          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: [{ search: 'still missing', replace: 'ok' }]
                  }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Repair apply fails' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'Replacement search text not found' });
    });

    test('fails the goal when a replacement entry is invalid', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({
            data: {
              success: true,
              content: 'export const answer = 1;\n'
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: [{ search: 123, replace: 'ok' }]
                  }
                ]
              })
            }
          });
        }
      });

      const goal = { id: 1, prompt: 'Invalid replacement entry' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'Invalid replacement entry' });
    });

    test('fails the goal when reading the modify target throws non-404', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.reject(new Error('Read failed'));
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: [{ search: 'a', replace: 'b' }]
                  }
                ]
              })
            }
          });
        }
      });

      const goal = { id: 1, prompt: 'Read file error' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'Read failed' });
    });

    test('handles non-string LLM response content by treating it as no edits', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: 123 } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/NonStringOk.jsx', content: 'export const NonStringOk = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Non-string LLM content' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
    });

    test('skips modify edits when replacements produce no changes', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({
            data: {
              success: true,
              content: 'export const answer = 1;\n'
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: []
                  },
                  { type: 'upsert', path: 'src/NonNoop.jsx', content: 'export const NonNoop = 1;' }
                ]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'No-op modify' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).not.toHaveBeenCalledWith('/api/projects/42/files/src/existing.js', expect.anything());
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/NonNoop.jsx', {
        content: 'export const NonNoop = 1;'
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/NonNoop.jsx',
        source: 'ai'
      });
    });

    test('fails the goal when modify target file is missing', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/missing.js') {
          return Promise.reject({ response: { status: 404 } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/missing.js',
                    replacements: [{ search: 'a', replace: 'b' }]
                  }
                ]
              })
            }
          });
        }
      });

      const goal = { id: 1, prompt: 'Modify missing file' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'File not found: src/missing.js' });
    });

    test('rethrows non-parse edit errors from the tests stage', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({
            data: {
              success: true,
              content: 'export const answer = 1;\n'
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          // First call is tests stage; make it fail with a real edit error.
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: [
                      { search: 'export const missing = 1;\n', replace: 'export const missing = 2;\n' }
                    ]
                  }
                ]
              })
            }
          });
        }
      });

      const goal = { id: 1, prompt: 'Bad tests-stage edit' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'Replacement search text not found' });
      expect(advanceGoalPhase).toHaveBeenCalledWith(1, 'testing');
      expect(advanceGoalPhase).not.toHaveBeenCalledWith(1, 'implementing');
    });

    test('rethrows non-parse edit errors from the implementation stage', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({ data: { success: true, files: [] } });
        }
        if (url === '/api/projects/42/files/src/existing.js') {
          return Promise.resolve({
            data: {
              success: true,
              content: 'export const answer = 1;\n'
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            // Tests stage: no edits.
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          // Implementation stage: force a real edit error during apply.
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  {
                    type: 'modify',
                    path: 'src/existing.js',
                    replacements: [
                      { search: 'export const missing = 1;\n', replace: 'export const missing = 2;\n' }
                    ]
                  }
                ]
              })
            }
          });
        }
      });

      const goal = { id: 1, prompt: 'Bad impl-stage edit' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'Replacement search text not found' });
      expect(advanceGoalPhase).toHaveBeenCalledWith(1, 'testing');
      expect(advanceGoalPhase).toHaveBeenCalledWith(1, 'implementing');
      expect(advanceGoalPhase).not.toHaveBeenCalledWith(1, 'verifying');
    });

    test('applies delete edits via files-ops/delete then stages', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url, payload) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 3) {
            // Repair attempt for modify failures: return no edits so the goal still fails.
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          if (llmCall === 3) {
            // Repair attempt for modify failures: return no edits so the goal still fails.
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'delete', path: 'src/to-delete.js', recursive: false }]
              })
            }
          });
        }
        if (url === '/api/projects/42/files-ops/delete') {
          return Promise.resolve({ data: { success: true } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Delete file' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/files-ops/delete', {
        confirm: true,
        targetPath: 'src/to-delete.js',
        recursive: false
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/to-delete.js',
        source: 'ai'
      });
    });

    test('creates missing file via create-file endpoint then stages it', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.put.mockRejectedValueOnce({ response: { status: 404 } });

      let llmCall = 0;

      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/New.jsx', content: 'export const New = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/files-ops/create-file') {
          return Promise.resolve({ data: { success: true, filePath: 'src/New.jsx' } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Create missing file' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/New.jsx', {
        content: 'export const New = 1;'
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/files-ops/create-file', {
        filePath: 'src/New.jsx',
        content: 'export const New = 1;'
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/branches/stage', {
        filePath: 'src/New.jsx',
        source: 'ai'
      });
    });

    test('when knownPathsSet is populated, create-file adds the path and avoids duplicate creates', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({
            data: {
              success: true,
              files: [{ path: 'src/existing.js', type: 'file' }]
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put.mockResolvedValue({ data: { success: true } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [
                  { type: 'upsert', path: 'src/Dupe.js', content: 'export const a = 1;\n' },
                  { type: 'upsert', path: 'src/Dupe.js', content: 'export const a = 2;\n' }
                ]
              })
            }
          });
        }

        if (url === '/api/projects/42/files-ops/create-file') {
          return Promise.resolve({ data: { success: true, filePath: 'src/Dupe.js' } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Create with knownPathsSet' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/files-ops/create-file', {
        filePath: 'src/Dupe.js',
        content: 'export const a = 1;\n'
      });

      // Second upsert should use PUT instead of attempting another create-file.
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/Dupe.js', {
        content: 'export const a = 2;\n'
      });

      const createCalls = axios.post.mock.calls.filter((c) => c[0] === '/api/projects/42/files-ops/create-file');
      expect(createCalls).toHaveLength(1);
    });

    test('when knownPathsSet is populated, create-file errors with non-409 status are thrown', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          return Promise.resolve({
            data: {
              success: true,
              files: [{ path: 'src/existing.js', type: 'file' }]
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/WontCreate.js', content: 'export const x = 1;\n' }]
              })
            }
          });
        }

        if (url === '/api/projects/42/files-ops/create-file') {
          const err = new Error('create failed');
          err.response = { status: 500 };
          return Promise.reject(err);
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Create file fails' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: false, error: 'create failed' });
    });

    test('when knownPathsSet is populated, PUT 404 falls back to create-file and still updates known paths', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files') {
          // Include the target path to make knownPathsSet non-empty and containing the file.
          return Promise.resolve({
            data: {
              success: true,
              files: [{ path: 'src/Racey.js', type: 'file' }]
            }
          });
        }
        return Promise.resolve({ data: { success: true } });
      });

      axios.put.mockRejectedValueOnce({ response: { status: 404 } });

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/Racey.js', content: 'export const r = 1;\n' }]
              })
            }
          });
        }

        if (url === '/api/projects/42/files-ops/create-file') {
          return Promise.resolve({ data: { success: true, filePath: 'src/Racey.js' } });
        }

        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }

        return Promise.resolve({ data: { success: true } });
      });

      const goal = { id: 1, prompt: 'Racey file exists then 404' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(axios.put).toHaveBeenCalledWith('/api/projects/42/files/src/Racey.js', {
        content: 'export const r = 1;\n'
      });
      expect(axios.post).toHaveBeenCalledWith('/api/projects/42/files-ops/create-file', {
        filePath: 'src/Racey.js',
        content: 'export const r = 1;\n'
      });
    });

    test('continues when file tree scan fails', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      axios.get.mockRejectedValueOnce(new Error('Tree failed'));

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({
              data: {
                content: JSON.stringify({ edits: [] })
              }
            });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/TreeFailOk.jsx', content: 'export const TreeFailOk = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Scan failure should not abort' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(consoleWarnSpy).toHaveBeenCalledWith('Failed to fetch project file tree:', expect.any(Error));
      consoleWarnSpy.mockRestore();
    });

    test('returns error on phase advancement failure', async () => {
      advanceGoalPhase.mockRejectedValueOnce({
        response: { data: { error: 'Phase transition failed' } }
      });

      const goal = { id: 1, prompt: 'Test' };
      
      const result = await processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      // Execute state updater to cover error message construction
      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({
        success: false,
        error: 'Phase transition failed'
      });
      expect(mockSetMessages).toHaveBeenCalledWith(expect.any(Function));
      expect(mockCreateMessage).toHaveBeenCalledWith('assistant', 'Error processing goal: Phase transition failed', { variant: 'error' });
    });

    test('uses error.message when no structured backend error exists', async () => {
      advanceGoalPhase.mockRejectedValueOnce(new Error('Boom'));

      const goal = { id: 1, prompt: 'Test' };
      const result = await processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({ success: false, error: 'Boom' });
      expect(mockCreateMessage).toHaveBeenCalledWith('assistant', 'Error processing goal: Boom', { variant: 'error' });
    });

    test('works when setPreviewPanelTab is undefined', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});
      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/NoPreviewTab.jsx', content: 'export const NoPreviewTab = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'No preview tab' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        undefined,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
    });

    test('sets goal count to 0 when fetchGoals returns non-array', async () => {
      fetchGoals
        .mockResolvedValueOnce({ not: 'an array' })
        .mockResolvedValueOnce({ also: 'not an array' });
      advanceGoalPhase.mockResolvedValue({});
      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/GoalCountOk.jsx', content: 'export const GoalCountOk = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Non-array goals' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
      expect(mockSetGoalCount).toHaveBeenCalledWith(0);
    });

    test('handles LLM response with neither response nor content', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});

      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          if (llmCall === 1) {
            return Promise.resolve({ data: {} });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: 'src/AfterEmptyPayload.jsx', content: 'export const AfterEmptyPayload = 1;' }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goal = { id: 1, prompt: 'Empty llm payload' };
      const promise = processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result).toEqual({ success: true });
    });

    test("uses 'Unknown error' when thrown value has no message/response", async () => {
      advanceGoalPhase.mockRejectedValueOnce({});

      const goal = { id: 1, prompt: 'Unknown error' };
      const result = await processGoal(
        goal,
        42,
        '/test',
        'info',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      const [updater] = mockSetMessages.mock.calls[0];
      updater([]);

      expect(result).toEqual({ success: false, error: 'Unknown error' });
      expect(mockCreateMessage).toHaveBeenCalledWith('assistant', 'Error processing goal: Unknown error', { variant: 'error' });
    });
  });

  describe('processGoals', () => {
    test('processes multiple goals in sequence', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});
      let llmCall = 0;
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          llmCall += 1;
          // Each goal calls the LLM twice (tests + implementation).
          if (llmCall % 2 === 1) {
            return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
          }
          return Promise.resolve({
            data: {
              content: JSON.stringify({
                edits: [{ type: 'upsert', path: `src/Goal${llmCall}.jsx`, content: `export const Goal${llmCall} = 1;` }]
              })
            }
          });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goals = [
        { id: 1, prompt: 'Goal 1' },
        { id: 2, prompt: 'Goal 2' }
      ];

      const promise = processGoals(
        goals,
        42,
        mockProject,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(10000);
      await promise;

      expect(advanceGoalPhase).toHaveBeenCalledWith(1, 'testing');
      expect(advanceGoalPhase).toHaveBeenCalledWith(2, 'testing');
    });

    test('processes nested goals depth-first and skips parents by default', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goals = [
        {
          id: 1,
          prompt: 'Parent goal',
          children: [
            {
              id: 2,
              prompt: 'Child goal',
              children: [{ id: 3, prompt: 'Leaf goal', children: [] }]
            }
          ]
        }
      ];

      const promise = processGoals(
        goals,
        42,
        mockProject,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(10000);
      await promise;

      expect(advanceGoalPhase).toHaveBeenCalledWith(3, 'testing');
      expect(advanceGoalPhase).not.toHaveBeenCalledWith(1, 'testing');
      expect(advanceGoalPhase).not.toHaveBeenCalledWith(2, 'testing');
    });

    test('processes parent goals when processParentGoals is enabled', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: JSON.stringify({ edits: [] }) } });
        }
        if (url === '/api/projects/42/branches/stage') {
          return Promise.resolve({ data: { success: true } });
        }
      });

      const goals = [
        {
          id: 1,
          prompt: 'Parent goal',
          children: [
            { id: 2, prompt: 'Child goal', children: [] }
          ]
        }
      ];

      const promise = processGoals(
        goals,
        42,
        mockProject,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages,
        { processParentGoals: true }
      );

      await vi.advanceTimersByTimeAsync(10000);
      await promise;

      expect(advanceGoalPhase).toHaveBeenCalledWith(2, 'testing');
    });

    test('stops processing on first error', async () => {
      advanceGoalPhase
        .mockRejectedValueOnce(new Error('Failed'))
        .mockResolvedValue({});

      const goals = [
        { id: 1, prompt: 'Goal 1' },
        { id: 2, prompt: 'Goal 2' }
      ];

      const promise = processGoals(
        goals,
        42,
        mockProject,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(5000);
      await promise;

      // Only first goal should be attempted
      const testingCalls = advanceGoalPhase.mock.calls.filter(
        call => call[1] === 'testing'
      );
      expect(testingCalls).toHaveLength(1);
    });

    test('handles empty goal list', async () => {
      const promise = processGoals(
        [],
        42,
        mockProject,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await promise;

      expect(advanceGoalPhase).not.toHaveBeenCalled();
    });

    test('uses default framework/language in projectInfo when missing', async () => {
      fetchGoals.mockResolvedValue([]);
      advanceGoalPhase.mockResolvedValue({});
      axios.post.mockResolvedValue({ data: { content: JSON.stringify({ edits: [] }) } });

      const goals = [{ id: 1, prompt: 'Goal 1' }];
      const projectMissingMeta = {
        id: 42,
        name: 'Test Project',
        path: '/test/path'
      };

      const promise = processGoals(
        goals,
        42,
        projectMissingMeta,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(10000);
      await promise;

      const llmCall = axios.post.mock.calls.find((call) => call[0] === '/api/llm/generate');
      expect(llmCall).toBeTruthy();
      const payload = llmCall[1];
      const userMessageContent = payload?.messages?.find((m) => m.role === 'user')?.content || '';
      expect(userMessageContent).toContain('Framework: unknown');
      expect(userMessageContent).toContain('Language: javascript');
    });
  });

  describe('handlePlanOnlyFeature', () => {
    test('plans goals and processes them', async () => {
      planMetaGoal.mockResolvedValue({
        children: [{ id: 1, prompt: 'Goal 1' }]
      });
      fetchGoals.mockResolvedValue([{ id: 1 }]);
      advanceGoalPhase.mockResolvedValue({});
      axios.get.mockResolvedValue({ data: { workingBranches: [{ stagedFiles: ['file.js'] }] } });
      axios.post.mockResolvedValue({
        data: { content: JSON.stringify({ edits: [] }) }
      });

      await handlePlanOnlyFeature(
        42,
        mockProject,
        'Create feature',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      // Execute message updaters so the callback bodies are covered
      for (const [updater] of mockSetMessages.mock.calls) {
        if (typeof updater === 'function') {
          updater([]);
        }
      }

      expect(planMetaGoal).toHaveBeenCalledWith({
        projectId: 42,
        prompt: 'Create feature'
      });
      expect(mockSetMessages).toHaveBeenCalled();
      expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('goals', { source: 'automation' });
      expect(mockCreateMessage).toHaveBeenCalledWith('assistant', 'Goals created.', { variant: 'status' });
    });

    test('surfaces clarifying questions and skips processing when needed', async () => {
      planMetaGoal.mockResolvedValue({
        questions: ['Which layout should we use?'],
        children: [{ id: 1, prompt: 'Goal 1' }]
      });
      fetchGoals.mockResolvedValue([{ id: 1 }]);
      axios.get.mockResolvedValue({ data: { workingBranches: [{ stagedFiles: ['file.js'] }] } });
      axios.post.mockResolvedValue({ data: { content: JSON.stringify({ edits: [] }) } });

      await handlePlanOnlyFeature(
        42,
        mockProject,
        'Need clarification',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(1000);

      for (const [updater] of mockSetMessages.mock.calls) {
        if (typeof updater === 'function') {
          updater([]);
        }
      }

      expect(advanceGoalPhase).not.toHaveBeenCalled();
      const messages = mockCreateMessage.mock.calls.map((call) => call[1]);
      expect(messages).toContain('I need clarification before proceeding:');
      expect(messages).toContain('Which layout should we use?');
    });

    test('handles goal fetch error', async () => {
      planMetaGoal.mockResolvedValue({ children: [] });
      fetchGoals.mockRejectedValue(new Error('Fetch failed'));

      await handlePlanOnlyFeature(
        42,
        mockProject,
        'Test',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      expect(mockSetGoalCount).toHaveBeenCalledWith(0);
    });

    test('sets goal count to 0 when fetchGoals returns non-array', async () => {
      planMetaGoal.mockResolvedValue({ children: [] });
      fetchGoals.mockResolvedValue(null);
      axios.get.mockResolvedValue({ data: { workingBranches: [{ stagedFiles: ['file.js'] }] } });
      axios.post.mockResolvedValue({ data: { content: JSON.stringify({ edits: [] }) } });

      await handlePlanOnlyFeature(
        42,
        mockProject,
        'Test',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      expect(mockSetGoalCount).toHaveBeenCalledWith(0);
    });

    test('handles planMetaGoal returning undefined (children fallback)', async () => {
      planMetaGoal.mockResolvedValue(undefined);
      fetchGoals.mockResolvedValue([]);

      axios.get.mockResolvedValue({ data: { workingBranches: [] } });
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: 'feature-plan-undefined' } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { branch: { name: 'feature-plan-undefined' } } });
        }
      });

      await handlePlanOnlyFeature(
        42,
        mockProject,
        'Test',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(450);

      expect(axios.get).toHaveBeenCalledWith('/api/projects/42/branches');
    });

    test('executes deferred branch creation + processing via setTimeout', async () => {
      planMetaGoal.mockResolvedValue({ children: [] });
      fetchGoals.mockResolvedValue([]);

      // Ensure ensureBranch runs its creation path
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });
      axios.post.mockImplementation((url) => {
        if (url === '/api/llm/generate') {
          return Promise.resolve({ data: { content: 'feature-deferred' } });
        }
        if (url === '/api/projects/42/branches') {
          return Promise.resolve({ data: { branch: { name: 'feature-deferred' } } });
        }
      });

      await handlePlanOnlyFeature(
        42,
        mockProject,
        'Create feature',
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      // Fires the internal setTimeout(…, 400)
      await vi.advanceTimersByTimeAsync(450);

      expect(axios.get).toHaveBeenCalledWith('/api/projects/42/branches');
      expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('branches', { source: 'automation' });
    });
  });

  describe('handleRegularFeature', () => {
    test('processes regular feature with goals', async () => {
      fetchGoals.mockResolvedValue([{ id: 1 }]);
      advanceGoalPhase.mockResolvedValue({});
      axios.get.mockResolvedValue({ data: { workingBranches: [{ stagedFiles: ['file.js'] }] } });
      axios.post.mockResolvedValue({
        data: { content: JSON.stringify({ edits: [] }) }
      });

      const result = {
        kind: 'feature',
        children: [{ id: 1, prompt: 'Goal 1' }]
      };

      const promise = handleRegularFeature(
        42,
        mockProject,
        'Create feature',
        result,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(10000);
      await promise;

      // Execute message updaters so the callback bodies are covered
      for (const [updater] of mockSetMessages.mock.calls) {
        if (typeof updater === 'function') {
          updater([]);
        }
      }

      expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('goals', { source: 'automation' });
      expect(mockSetMessages).toHaveBeenCalled();
      expect(mockCreateMessage).toHaveBeenCalledWith('assistant', 'Goals created.', { variant: 'status' });
    });

    test('surfaces clarifying questions and skips processing when needed', async () => {
      fetchGoals.mockResolvedValue([{ id: 1 }]);
      axios.get.mockResolvedValue({ data: { workingBranches: [{ stagedFiles: ['file.js'] }] } });
      axios.post.mockResolvedValue({ data: { content: JSON.stringify({ edits: [] }) } });

      const promise = handleRegularFeature(
        42,
        mockProject,
        'Need clarification',
        { questions: ['Confirm the desired behavior'], children: [{ id: 1, prompt: 'Goal 1' }] },
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      for (const [updater] of mockSetMessages.mock.calls) {
        if (typeof updater === 'function') {
          updater([]);
        }
      }

      expect(advanceGoalPhase).not.toHaveBeenCalled();
      const messages = mockCreateMessage.mock.calls.map((call) => call[1]);
      expect(messages).toContain('I need clarification before proceeding:');
      expect(messages).toContain('Confirm the desired behavior');
    });

    test('handles goal count fetch error', async () => {
      fetchGoals.mockRejectedValue(new Error('Failed'));
      axios.get.mockResolvedValue({ data: { workingBranches: [] } });

      const result = { children: [] };

      const promise = handleRegularFeature(
        42,
        mockProject,
        'Test',
        result,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mockSetGoalCount).toHaveBeenCalledWith(0);
    });

    test('sets goal count to 0 when fetchGoals returns non-array', async () => {
      fetchGoals.mockResolvedValue(undefined);
      axios.get.mockResolvedValue({ data: { workingBranches: [{ stagedFiles: ['file.js'] }] } });
      axios.post.mockResolvedValue({ data: { content: JSON.stringify({ edits: [] }) } });

      const promise = handleRegularFeature(
        42,
        mockProject,
        'Test',
        { children: [] },
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mockSetGoalCount).toHaveBeenCalledWith(0);
    });

    test('handles missing result children gracefully', async () => {
      fetchGoals.mockResolvedValue([]);

      axios.get.mockResolvedValue({ data: { workingBranches: [{ stagedFiles: ['file.js'] }] } });
      axios.post.mockResolvedValue({ data: { content: JSON.stringify({ edits: [] }) } });

      const promise = handleRegularFeature(
        42,
        mockProject,
        'Test',
        undefined,
        mockSetPreviewPanelTab,
        mockSetGoalCount,
        mockCreateMessage,
        mockSetMessages
      );

      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('goals', { source: 'automation' });
    });
  });

  describe('coverage: loose JSON + replacement edge cases', () => {
    test('tryParseLooseJson quotes keys and strips trailing commas', () => {
      const input = '{ edits: [ { type: "upsert", path: "src/x.js", content: "export const x = 1;", }, ], }';
      const parsed = __testOnly.tryParseLooseJson(input);

      expect(parsed).toBeTruthy();
      expect(Array.isArray(parsed.edits)).toBe(true);
      expect(parsed.edits[0]).toEqual(
        expect.objectContaining({
          type: 'upsert',
          path: 'src/x.js'
        })
      );
    });

    test('tryParseLooseJson does not assume numeric keys are identifiers (coverage branch)', () => {
      // Exercises the "{ or ," lookahead branch where the next token is neither a quote
      // nor an identifier (so we fall through and keep scanning).
      expect(__testOnly.tryParseLooseJson('{ 1: 2 }')).toBeNull();
    });

    test('tryParseLooseJson handles object start with missing key (coverage branch)', () => {
      // Exercises the lookahead branch where `input[lookahead]` is undefined.
      expect(__testOnly.tryParseLooseJson('{')).toBeNull();
    });

    test('parseEditsFromLLM rethrows when JSON.parse fails and loose JSON cannot recover', () => {
      const response = {
        data: {
          content: '{edits:[}'
        }
      };

      expect(() => __testOnly.parseEditsFromLLM(response)).toThrow();
    });

    test('applyEdits modify throws when replacement search is whitespace-only', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/whitespace.js') {
          return Promise.resolve({ data: { content: 'console.log("hi");\n' } });
        }
        return Promise.resolve({ data: { content: '' } });
      });

      await expect(
        __testOnly.applyEdits({
          projectId: 42,
          edits: [
            {
              type: 'modify',
              path: 'frontend/src/whitespace.js',
              replacements: [{ search: '   \n\t', replace: 'console.log("bye");' }]
            }
          ]
        })
      ).rejects.toThrow('Replacement search text not found');
    });

    test('applyEdits modify throws when whitespace-insensitive replacement is ambiguous', async () => {
      axios.get.mockImplementation((url) => {
        if (url === '/api/projects/42/files/frontend/src/ambiguous.js') {
          return Promise.resolve({ data: { content: 'abc\nabc\n' } });
        }
        return Promise.resolve({ data: { content: '' } });
      });

      await expect(
        __testOnly.applyEdits({
          projectId: 42,
          edits: [
            {
              type: 'modify',
              path: 'frontend/src/ambiguous.js',
              replacements: [{ search: 'a b c', replace: 'XYZ' }]
            }
          ]
        })
      ).rejects.toThrow('Replacement search text is ambiguous');
    });
  });
});
