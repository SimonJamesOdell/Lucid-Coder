import { describe, it, expect, vi } from 'vitest';

const makeDirent = (name, isDir) => ({
  name,
  isDirectory: () => isDir
});

const setup = async ({ readdirImpl, readFileImpl, getProjectImpl }) => {
  vi.resetModules();

  const readFile = vi.fn(readFileImpl);
  const readdir = vi.fn(readdirImpl);

  vi.doMock('fs/promises', async () => {
    const actual = await vi.importActual('fs/promises');
    const baseDefault = actual?.default && typeof actual.default === 'object' ? actual.default : actual;

    return {
      ...actual,
      readFile,
      readdir,
      default: {
        ...baseDefault,
        readFile,
        readdir
      }
    };
  });

  const getProject = vi.fn(getProjectImpl);
  vi.doMock('../database.js', async () => {
    const actual = await vi.importActual('../database.js');
    return {
      ...actual,
      getProject
    };
  });

  const { __testExports__ } = await import('../services/agentOrchestrator.js');
  return { __testExports__, readFile, readdir, getProject };
};

describe('agentOrchestrator snapshot helpers', () => {
  it('collectProjectFileList skips ignored entries and walks directories', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async (targetPath) => {
        const normalized = targetPath.replace(/\\/g, '/');
        if (normalized.endsWith('/repo')) {
          return [
            makeDirent('node_modules', true),
            makeDirent('src', true),
            makeDirent('package.json', false),
            makeDirent('.DS_Store', false),
            makeDirent('B.txt', false)
          ];
        }
        if (normalized.endsWith('/repo/src')) {
          return [
            makeDirent('nested', true),
            makeDirent('index.js', false)
          ];
        }
        if (normalized.endsWith('/repo/src/nested')) {
          return [
            makeDirent('deep.js', false)
          ];
        }
        return [];
      },
      readFileImpl: async () => ''
    });

    const results = await __testExports__.collectProjectFileList('/repo', 50);

    expect(results).toEqual(expect.arrayContaining([
      'B.txt',
      'package.json',
      'src/',
      'src/index.js',
      'src/nested/',
      'src/nested/deep.js'
    ]));

    expect(results).not.toEqual(expect.arrayContaining(['node_modules/', '.DS_Store']));
  });

  it('collectProjectFileList tolerates readdir failures and respects the limit', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async (targetPath) => {
        const normalized = targetPath.replace(/\\/g, '/');
        if (normalized.endsWith('/repo')) {
          return [
            makeDirent('bad', true),
            makeDirent('src', true),
            makeDirent('a.txt', false)
          ];
        }
        if (normalized.endsWith('/repo/bad')) {
          throw new Error('boom');
        }
        if (normalized.endsWith('/repo/src')) {
          return [makeDirent('index.js', false)];
        }
        return [];
      },
      readFileImpl: async () => ''
    });

    const results = await __testExports__.collectProjectFileList('/repo', 2);

    expect(results.length).toBe(2);
  });

  it('collectProjectFileList returns empty array when root readdir fails', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async () => {
        throw new Error('boom');
      },
      readFileImpl: async () => ''
    });

    const results = await __testExports__.collectProjectFileList('/repo', 5);
    expect(results).toEqual([]);
  });

  it('buildPlannerProjectSnapshot returns empty string when project path is missing', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async () => [],
      readFileImpl: async () => '',
      getProjectImpl: async () => null
    });

    const snapshot = await __testExports__.buildPlannerProjectSnapshot(999);
    expect(snapshot).toBe('');
  });

  it('buildPlannerProjectSnapshot includes file sections and a truncated file list', async () => {
    const { __testExports__ } = await setup({
      getProjectImpl: async () => ({ path: '/repo' }),
      readFileImpl: async (targetPath) => {
        const normalized = targetPath.replace(/\\/g, '/');
        if (normalized.endsWith('/repo/README.md')) {
          return 'Readme content';
        }
        if (normalized.endsWith('/repo/frontend/package.json')) {
          return '{"name":"frontend"}';
        }
        throw new Error('missing');
      },
      readdirImpl: async (targetPath) => {
        const normalized = targetPath.replace(/\\/g, '/');
        if (normalized.endsWith('/repo')) {
          return [makeDirent('src', true), makeDirent('README.md', false)];
        }
        if (normalized.endsWith('/repo/src')) {
          return [makeDirent('main.js', false)];
        }
        return [];
      }
    });

    const snapshot = await __testExports__.buildPlannerProjectSnapshot(1);

    const normalized = snapshot.replace(/\\/g, '/');

    expect(normalized).toContain('README (README.md):');
    expect(normalized).toContain('Readme content');
    expect(normalized).toContain('Frontend package.json (frontend/package.json):');
    expect(normalized).toContain('{"name":"frontend"}');
    expect(normalized).toContain('Project file list (truncated):');
    expect(normalized).toContain('src/');
  });

  it('parses fenced JSON and extracts JSON substrings', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async () => [],
      readFileImpl: async () => '',
      getProjectImpl: async () => null
    });

    const fenced = '```json\n{"a":1}\n```';
    expect(__testExports__.stripCodeFences(fenced)).toBe('{"a":1}');

    const recovered = __testExports__.extractFirstJsonObjectSubstring(
      'prefix {"a":"{inside}","b":2} suffix'
    );
    expect(recovered).toBe('{"a":"{inside}","b":2}');

    expect(__testExports__.extractJsonObject(null)).toBeNull();
    expect(__testExports__.extractJsonObject(fenced)).toEqual({ a: 1 });
    expect(__testExports__.extractJsonObject('prefix {"b":2} suffix')).toEqual({ b: 2 });
    expect(__testExports__.extractJsonObject('no json here')).toBeNull();
  });

  it('handles non-string inputs for JSON helpers', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async () => [],
      readFileImpl: async () => '',
      getProjectImpl: async () => null
    });

    expect(__testExports__.stripCodeFences(42)).toBe(42);
    expect(__testExports__.extractFirstJsonObjectSubstring('no braces')).toBeNull();
    expect(__testExports__.extractJsonObject({ nope: true })).toBeNull();
  });

  it('extracts acceptance criteria from AC headers and bullets', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async () => [],
      readFileImpl: async () => '',
      getProjectImpl: async () => null
    });

    const prompt = [
      'AC: Ship the feature',
      '- First requirement',
      'Notes:'
    ].join('\n');

    expect(__testExports__.extractAcceptanceCriteria(prompt)).toEqual([
      'Ship the feature',
      'First requirement'
    ]);
  });

  it('extractAcceptanceCriteria returns empty when section missing', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async () => [],
      readFileImpl: async () => '',
      getProjectImpl: async () => null
    });

    expect(__testExports__.extractAcceptanceCriteria('No criteria here')).toEqual([]);
  });

  it('readJsonFile/readTextFile handle success and failure cases', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async () => [],
      readFileImpl: async (targetPath) => {
        if (String(targetPath).includes('ok.json')) {
          return '{"ok":true}';
        }
        if (String(targetPath).includes('ok.txt')) {
          return 'hello';
        }
        throw new Error('missing');
      },
      getProjectImpl: async () => null
    });

    await expect(__testExports__.readJsonFile('ok.json')).resolves.toEqual({ ok: true });
    await expect(__testExports__.readJsonFile('missing.json')).resolves.toBeNull();

    await expect(__testExports__.readTextFile('ok.txt')).resolves.toBe('hello');
    await expect(__testExports__.readTextFile('missing.txt')).resolves.toBe('');
  });

  it('detects framework hints and normalizes dependency maps', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async () => [],
      readFileImpl: async () => '',
      getProjectImpl: async () => null
    });

    const deps = __testExports__.normalizeDeps({
      dependencies: { next: '^13.0.0' },
      devDependencies: { jest: '^29.0.0' }
    });
    expect(deps.next).toBe('^13.0.0');
    expect(deps.jest).toBe('^29.0.0');

    expect(__testExports__.detectFrontendFramework({ dependencies: { next: '^13.0.0' } })).toBe('nextjs');
    expect(__testExports__.detectBackendFramework({ dependencies: { koa: '^2.0.0' } })).toBe('koa');
    expect(__testExports__.detectPythonFramework('fastapi==0.1')).toBe('fastapi');
    expect(__testExports__.detectFrontendFramework({})).toBe('');
    expect(__testExports__.detectBackendFramework({})).toBe('');
    expect(__testExports__.detectPythonFramework('')).toBe('');
  });

  it('resolveProjectStackContext returns null when project is missing', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async () => [],
      readFileImpl: async () => '',
      getProjectImpl: async () => null
    });

    const result = await __testExports__.resolveProjectStackContext(123);
    expect(result).toBeNull();
  });

  it('resolveProjectStackContext detects frameworks and languages from workspace files', async () => {
    const { __testExports__ } = await setup({
      getProjectImpl: async () => ({
        path: '/repo',
        frontend_framework: '',
        backend_framework: '',
        frontend_language: '',
        backend_language: ''
      }),
      readFileImpl: async (targetPath) => {
        const normalized = targetPath.replace(/\\/g, '/');
        if (normalized.endsWith('/repo/frontend/package.json')) {
          return JSON.stringify({ dependencies: { react: '^18.0.0' } });
        }
        if (normalized.endsWith('/repo/backend/package.json')) {
          throw new Error('missing');
        }
        if (normalized.endsWith('/repo/backend/requirements.txt')) {
          return 'Django==3.2';
        }
        throw new Error('missing');
      },
      readdirImpl: async () => []
    });

    const result = await __testExports__.resolveProjectStackContext(1);

    expect(result).toContain('frontend: react (javascript)');
    expect(result).toContain('backend: django (python)');
    expect(result).toContain('path: /repo');
  });

  it('resolveProjectStackContext sets backend language when backend package.json exists', async () => {
    const { __testExports__ } = await setup({
      getProjectImpl: async () => ({
        path: '/repo',
        frontend_framework: '',
        backend_framework: '',
        frontend_language: '',
        backend_language: ''
      }),
      readFileImpl: async (targetPath) => {
        const normalized = targetPath.replace(/\\/g, '/');
        if (normalized.endsWith('/repo/frontend/package.json')) {
          return JSON.stringify({ dependencies: { vue: '^3.0.0' } });
        }
        if (normalized.endsWith('/repo/backend/package.json')) {
          return JSON.stringify({ dependencies: { express: '^4.0.0' } });
        }
        if (normalized.endsWith('/repo/backend/requirements.txt')) {
          throw new Error('missing');
        }
        throw new Error('missing');
      },
      readdirImpl: async () => []
    });

    const result = await __testExports__.resolveProjectStackContext(3);

    expect(result).toContain('frontend: vue (javascript)');
    expect(result).toContain('backend: express (javascript)');
  });

  it('resolveProjectStackContext falls back to unknown when requirements file fails', async () => {
    const { __testExports__ } = await setup({
      getProjectImpl: async () => ({
        path: '/repo',
        frontend_framework: '',
        backend_framework: '',
        frontend_language: '',
        backend_language: ''
      }),
      readFileImpl: async (targetPath) => {
        const normalized = targetPath.replace(/\\/g, '/');
        if (normalized.endsWith('/repo/frontend/package.json')) {
          return JSON.stringify({ dependencies: { vue: '^3.0.0' } });
        }
        if (normalized.endsWith('/repo/backend/package.json')) {
          throw new Error('missing');
        }
        if (normalized.endsWith('/repo/backend/requirements.txt')) {
          throw new Error('missing');
        }
        throw new Error('missing');
      },
      readdirImpl: async () => []
    });

    const result = await __testExports__.resolveProjectStackContext(2);

    expect(result).toContain('frontend: vue (javascript)');
    expect(result).toContain('backend: unknown (unknown)');
  });

  it('truncateSection returns empty strings and truncates when over limit', async () => {
    const { __testExports__ } = await setup({
      readdirImpl: async () => [],
      readFileImpl: async () => '',
      getProjectImpl: async () => null
    });

    expect(__testExports__.truncateSection('', 5)).toBe('');
    expect(__testExports__.truncateSection('short', 10)).toBe('short');
    expect(__testExports__.truncateSection('abcdefghij', 5)).toBe('abcde\n…truncated…');
  });
});
