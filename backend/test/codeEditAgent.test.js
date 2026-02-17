import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../llm-client.js', () => ({
  llmClient: {
    generateResponse: vi.fn()
  }
}));

vi.mock('../services/projectTools.js', () => ({
  getProjectRoot: vi.fn(),
  readProjectFile: vi.fn(),
  writeProjectFile: vi.fn()
}));

vi.mock('fs/promises', () => ({
  default: {
    readdir: vi.fn()
  }
}));

import fs from 'fs/promises';
import { llmClient } from '../llm-client.js';
import { getProjectRoot, readProjectFile, writeProjectFile } from '../services/projectTools.js';
import { applyCodeChange, __testing } from '../services/codeEditAgent.js';

const queueResponses = (responses) => {
  const queue = responses.slice();
  llmClient.generateResponse.mockImplementation(async () => {
    if (!queue.length) {
      return JSON.stringify({ action: 'finalize', summary: 'done' });
    }
    return queue.shift();
  });
};

describe('codeEditAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProjectRoot.mockResolvedValue('/project');
    readProjectFile.mockResolvedValue('hello world');
    writeProjectFile.mockResolvedValue();
    fs.readdir.mockResolvedValue([]);
  });

  test('applies read_file flow and finalize summary', async () => {
    readProjectFile.mockResolvedValue('x'.repeat(21000));
    queueResponses([
      JSON.stringify({ action: 'read_file', path: 'src/app.js', reason: 'check' }),
      JSON.stringify({ action: 'finalize', summary: 'All good' })
    ]);

    const result = await applyCodeChange({ projectId: 1, prompt: 'Inspect app' });

    expect(result.summary).toBe('All good');
    expect(result.steps.some((step) => step.action === 'read_file')).toBe(true);
    expect(readProjectFile).toHaveBeenCalledWith(1, 'src/app.js');
  });

  test('handles invalid responses, missing action, and unsupported action', async () => {
    queueResponses([
      'not json',
      JSON.stringify({ note: 'missing action' }),
      JSON.stringify({ action: 123 }),
      JSON.stringify({ action: 'unsupported', path: 'src/file.txt' }),
      JSON.stringify({ action: 'unsupported' }),
      JSON.stringify({ action: 'finalize', summary: 'ok' })
    ]);

    const result = await applyCodeChange({ projectId: 2, prompt: 'Handle invalid actions' });

    expect(result.summary).toBe('ok');
    const unsupported = result.steps.find((step) => step.action === 'unsupported');
    expect(unsupported.meta).toBe('Unsupported action');
  });

  test('parses fenced json responses and handles list_dir error', async () => {
    fs.readdir.mockRejectedValue(new Error('nope'));
    queueResponses([
      '```json\n{"action":"list_dir","path":"."}\n```',
      'prefix {"action":"finalize","summary":"done"} suffix'
    ]);

    const result = await applyCodeChange({ projectId: 3, prompt: 'List root' });

    expect(result.summary).toBe('done');
    const listObservation = result.steps.find((step) => step.action === 'list_dir' && step.type === 'observation');
    expect(listObservation.summary).toContain('Error:');
  });

  test('handles write_file content validation and enforces write limit', async () => {
    const bigContent = 'x'.repeat(200_001);
    queueResponses([
      JSON.stringify({ action: 'write_file', path: 'src/app.js' }),
      JSON.stringify({ action: 'write_file', path: 'src/app.js', content: 'ok' }),
      JSON.stringify({ action: 'write_file', path: 'src/app.js', content: bigContent })
    ]);

    await expect(applyCodeChange({ projectId: 4, prompt: 'Write file' })).rejects.toThrow(
      'write_file content exceeds 200000 characters'
    );
  });

  test('rejects non-string write_file content without writing', async () => {
    queueResponses([
      JSON.stringify({ action: 'write_file', path: 'src/app.js', content: 123 }),
      JSON.stringify({ action: 'finalize', summary: 'done' })
    ]);

    const result = await applyCodeChange({ projectId: 15, prompt: 'Bad content' });

    expect(result.summary).toBe('done');
    expect(writeProjectFile).not.toHaveBeenCalled();
  });

  test('throws when write limit is reached', async () => {
    const responses = [];
    for (let i = 0; i < 13; i += 1) {
      responses.push(JSON.stringify({ action: 'write_file', path: `src/file-${i}.js`, content: 'ok' }));
      responses.push(JSON.stringify({ action: 'read_file', path: 'src/app.js' }));
    }
    queueResponses(responses);

    await expect(applyCodeChange({ projectId: 16, prompt: 'Write limit' })).rejects.toThrow(
      'Write limit reached while attempting to apply changes.'
    );
  });

  test('throws on invalid project or prompt', async () => {
    await expect(applyCodeChange({ prompt: 'Missing project' })).rejects.toThrow('projectId is required');
    await expect(applyCodeChange({ projectId: 5, prompt: '' })).rejects.toThrow('prompt is required');
  });

  test('handles non-string LLM responses', async () => {
    llmClient.generateResponse.mockResolvedValueOnce({ action: 'finalize', summary: 'ignored' });
    llmClient.generateResponse.mockResolvedValueOnce(JSON.stringify({ action: 'finalize', summary: 'ok' }));

    const result = await applyCodeChange({ projectId: 17, prompt: 'Non-string response' });

    expect(result.summary).toBe('ok');
  });

  test('detects looping responses', async () => {
    queueResponses([
      JSON.stringify({ action: 'plan', note: 'Loop' }),
      JSON.stringify({ action: 'plan', note: 'Loop' }),
      JSON.stringify({ action: 'plan', note: 'Loop' }),
      JSON.stringify({ action: 'plan', note: 'Loop' }),
      JSON.stringify({ action: 'plan', note: 'Loop' }),
      JSON.stringify({ action: 'plan', note: 'Loop' })
    ]);

    await expect(applyCodeChange({ projectId: 6, prompt: 'Loop test' })).rejects.toThrow(
      'Code edit agent detected a potential infinite loop.'
    );
  });

  test('detects looping responses without write actions', async () => {
    queueResponses([
      JSON.stringify({ action: 'read_file', path: 'src/app.js' }),
      JSON.stringify({ action: 'list_dir', path: '.' }),
      JSON.stringify({ action: 'read_file', path: 'src/app.js' }),
      JSON.stringify({ action: 'list_dir', path: '.' }),
      JSON.stringify({ action: 'read_file', path: 'src/app.js' }),
      JSON.stringify({ action: 'list_dir', path: '.' })
    ]);

    await expect(applyCodeChange({ projectId: 10, prompt: 'Loop without writes' })).rejects.toThrow(
      'Code edit agent detected a potential infinite loop.'
    );
  });

  test('handles read_file errors and write_file success', async () => {
    readProjectFile.mockRejectedValue({});
    queueResponses([
      JSON.stringify({ action: 'read_file', path: 'src/missing.js' }),
      JSON.stringify({ action: 'write_file', path: 'src/new.js', content: 'console.log(1);' }),
      JSON.stringify({ action: 'finalize', summary: 'done' })
    ]);

    const result = await applyCodeChange({ projectId: 7, prompt: 'Read and write' });

    expect(result.summary).toBe('done');
    expect(writeProjectFile).toHaveBeenCalledWith(7, 'src/new.js', 'console.log(1);');
  });

  test('supports list_dir success and filters ignored entries', async () => {
    const entries = [
      { name: 'node_modules', isDirectory: () => true },
      { name: 'src', isDirectory: () => true },
      { name: 'README.md', isDirectory: () => false }
    ];
    fs.readdir.mockResolvedValue(entries);

    queueResponses([
      JSON.stringify({ action: 'list_dir', path: '' }),
      JSON.stringify({ action: 'finalize', summary: 'listed' })
    ]);

    const result = await applyCodeChange({ projectId: 11, prompt: 'List dir' });

    expect(result.summary).toBe('listed');
    const listObservation = result.steps.find((step) => step.action === 'list_dir' && step.type === 'observation');
    expect(listObservation.summary).toContain('Listed');
  });

  test('rejects list_dir outside project root', async () => {
    queueResponses([
      JSON.stringify({ action: 'list_dir', path: '../outside' })
    ]);

    await expect(applyCodeChange({ projectId: 8, prompt: 'List outside' })).rejects.toThrow(
      'Directory access outside of project root is not allowed'
    );
  });

  test('rejects unsafe read/write paths', async () => {
    queueResponses([
      JSON.stringify({ action: 'read_file', path: '' })
    ]);

    await expect(applyCodeChange({ projectId: 12, prompt: 'Bad path' })).rejects.toThrow('Path is required');

    queueResponses([
      JSON.stringify({ action: 'write_file', path: '../escape', content: 'x' })
    ]);

    await expect(applyCodeChange({ projectId: 13, prompt: 'Bad write path' })).rejects.toThrow(
      'Path must stay within the project workspace'
    );
  });

  test('finalize uses answer fallback', async () => {
    queueResponses([
      JSON.stringify({ action: 'answer', answer: 'All done' })
    ]);

    const result = await applyCodeChange({ projectId: 9, prompt: 'Answer fallback' });

    expect(result.summary).toBe('All done');
  });

  test('finalize prefers answer when summary is blank', async () => {
    queueResponses([
      JSON.stringify({ action: 'finalize', summary: '   ', answer: 'From answer' })
    ]);

    const result = await applyCodeChange({ projectId: 19, prompt: 'Blank summary' });

    expect(result.summary).toBe('From answer');
  });

  test('plan action defaults to acknowledgement text', async () => {
    queueResponses([
      JSON.stringify({ action: 'plan' }),
      JSON.stringify({ action: 'finalize' })
    ]);

    const result = await applyCodeChange({ projectId: 14, prompt: 'Plan test' });

    expect(result.summary).toBe('Completed edit session.');
    const planStep = result.steps.find((step) => step.action === 'plan');
    expect(planStep.meta).toBe('Updated plan.');
  });

  test('covers helper edge cases directly', async () => {
    expect(__testing.truncateForObservation(123)).toBe('');
    expect(__testing.truncateForObservation('short')).toBe('short');
    expect(__testing.stripCodeFences(5)).toBe('');
    expect(__testing.stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(__testing.extractFirstJsonObject(42)).toBeNull();
    expect(__testing.extractFirstJsonObject('no json')).toBeNull();
    expect(__testing.extractFirstJsonObject('prefix {"a": {"b": 1}} suffix')).toBe('{"a": {"b": 1}}');
    expect(__testing.extractFirstJsonObject('prefix {"a":"{\\"b\\"}"} suffix')).toBe('{"a":"{\\"b\\"}"}');
    expect(__testing.parseActionResponse('')).toBeNull();
    expect(__testing.parseActionResponse('prefix {invalid}')).toBeNull();
    expect(__testing.parseActionResponse('{"action":"finalize","summary":"ok"}')).toEqual({
      action: 'finalize',
      summary: 'ok'
    });
    expect(__testing.buildInitialUserMessage({ prompt: 'Do thing', fileTree: null })).toContain(
      '(file tree unavailable)'
    );
  });

  test('covers queueAsyncWalk and buildFileTreeSnapshot branches', async () => {
    fs.readdir.mockResolvedValueOnce([
      { name: 'node_modules', isDirectory: () => true },
      { name: 'src', isDirectory: () => true },
      { name: 'package-lock.json', isDirectory: () => false },
      { name: '', isDirectory: () => false }
    ]);
    const listing = await __testing.queueAsyncWalk('/project', 10);
    expect(listing).toContain('src/');

    fs.readdir.mockResolvedValueOnce([
      { name: 'a.txt', isDirectory: () => false },
      { name: 'b.txt', isDirectory: () => false }
    ]);
    const limited = await __testing.queueAsyncWalk('/project', 1);
    expect(limited).toEqual(['a.txt']);

    fs.readdir.mockResolvedValueOnce([{ name: '/', isDirectory: () => false }]);
    const snapshot = await __testing.buildFileTreeSnapshot('/project');
    expect(snapshot).toContain('- .');

    fs.readdir.mockResolvedValueOnce(null);
    const errorSnapshot = await __testing.buildFileTreeSnapshot('/project');
    expect(errorSnapshot).toContain('unable to build file tree');
  });

  test('covers listDirectoryForAgent return paths and error branch', async () => {
    fs.readdir.mockResolvedValueOnce([{ name: 'src', isDirectory: () => true }]);
    const listing = await __testing.listDirectoryForAgent('/project', '');
    expect(listing.path).toBe('.');

    fs.readdir.mockResolvedValueOnce([{ name: 'src', isDirectory: () => true }]);
    const trimmedListing = await __testing.listDirectoryForAgent('/project', '   ');
    expect(trimmedListing.path).toBe('.');

    fs.readdir.mockRejectedValueOnce(new Error('boom'));
    const errorListing = await __testing.listDirectoryForAgent('/project', '');
    expect(errorListing.error).toBe('boom');
    expect(errorListing.path).toBe('.');

    fs.readdir.mockRejectedValueOnce(new Error('boom'));
    const trimmedErrorListing = await __testing.listDirectoryForAgent('/project', '   ');
    expect(trimmedErrorListing.error).toBe('boom');
    expect(trimmedErrorListing.path).toBe('.');
  });

  test('covers writeFileForAgent and LoopDetector helper branches', async () => {
    await expect(__testing.writeFileForAgent(1, 'src/app.js', 123)).rejects.toThrow(
      'write_file content must be a string'
    );

    const detector = new __testing.LoopDetector(3);
    detector.record('read_file', 'a');
    detector.record('list_dir', 'b');
    detector.record('read_file', 'c');
    expect(detector.isLooping()).toBe(true);
  });

  test('throws when max actions are exceeded', async () => {
    llmClient.generateResponse.mockResolvedValue('not json');

    await expect(applyCodeChange({ projectId: 18, prompt: 'Too many steps' })).rejects.toThrow(
      'Code edit agent exceeded the maximum number of steps without finalizing.'
    );
  });

  test('applies stylesheet writes without prompt-string style scope gating', async () => {
    queueResponses([
      JSON.stringify({
        action: 'write_file',
        path: 'frontend/src/index.css',
        content: 'body { background: #000; color: #fff; }'
      }),
      JSON.stringify({ action: 'finalize', summary: 'done' })
    ]);

    const result = await applyCodeChange({
      projectId: 20,
      prompt: 'make the navigation bar have a black background with white text'
    });

    expect(result.summary).toBe('done');
    expect(writeProjectFile).toHaveBeenCalledWith(20, 'frontend/src/index.css', 'body { background: #000; color: #fff; }');
  });

  test('allows targeted navbar style writes when content references target selector', async () => {
    queueResponses([
      JSON.stringify({
        action: 'write_file',
        path: 'frontend/src/index.css',
        content: '.navbar { background: #000; color: #fff; }'
      }),
      JSON.stringify({ action: 'finalize', summary: 'done' })
    ]);

    const result = await applyCodeChange({
      projectId: 21,
      prompt: 'make the navigation bar have a black background with white text'
    });

    expect(result.summary).toBe('done');
    expect(writeProjectFile).toHaveBeenCalledWith(21, 'frontend/src/index.css', '.navbar { background: #000; color: #fff; }');
  });

  test('write_file with missing path throws path validation error', async () => {
    queueResponses([
      JSON.stringify({
        action: 'write_file',
        content: 'body { background: #000; color: #fff; }'
      }),
      JSON.stringify({ action: 'finalize', summary: 'done' })
    ]);

    await expect(
      applyCodeChange({
        projectId: 22,
        prompt: 'make the navigation bar have a black background with white text'
      })
    ).rejects.toThrow('Path is required');
    expect(writeProjectFile).not.toHaveBeenCalled();
  });
});
