import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unmock('../../services/goalAutomation/automationUtils/jsonParsing.js');
  vi.unmock('../../services/goalAutomation/automationUtils/reflection.js');
  vi.unmock('../../services/goalAutomation/automationUtils/applyEdits.js');
  vi.unmock('axios');
});

const importWithJsonParsingMock = async (tryParseImpl) => {
  vi.resetModules();

  vi.doMock('axios', () => ({
    default: {
      post: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn()
    }
  }));

  vi.doMock('../../services/goalAutomation/automationUtils/reflection.js', async (importOriginal) => {
    const actual = await importOriginal();
    return actual;
  });

  vi.doMock('../../services/goalAutomation/automationUtils/applyEdits.js', () => ({
    createApplyEditsModule: () => ({
      applyEdits: vi.fn(),
      __setApplyEditsTestDeps: vi.fn()
    })
  }));

  vi.doMock('../../services/goalAutomation/automationUtils/jsonParsing.js', () => ({
    extractJsonObjectWithKey: vi.fn(() => null),
    extractJsonArray: vi.fn(() => null),
    extractJsonObject: vi.fn(() => null),
    tryParseLooseJson: vi.fn(tryParseImpl),
    extractJsonObjectFromIndex: vi.fn(() => null),
    extractJsonArrayFromIndex: vi.fn(() => null),
    normalizeJsonLikeText: vi.fn((value) => String(value || ''))
  }));

  return import('../../services/goalAutomation/automationUtils.js');
};

describe('parseEditsFromLLM fallback branches', () => {
  it('returns loose-json array fallback when no json block is extracted', async () => {
    const module = await importWithJsonParsingMock(() => [{ type: 'modify', path: 'frontend/src/App.jsx' }]);
    const edits = module.parseEditsFromLLM({ data: { response: 'no explicit block' } });
    expect(edits).toEqual([{ type: 'modify', path: 'frontend/src/App.jsx' }]);
  });

  it('returns loose-json edits array from fallback object when no json block is extracted', async () => {
    const module = await importWithJsonParsingMock(() => ({ edits: [{ type: 'modify', path: 'frontend/src/App.jsx' }] }));
    const edits = module.parseEditsFromLLM({ data: { response: 'still no block' } });
    expect(edits).toEqual([{ type: 'modify', path: 'frontend/src/App.jsx' }]);
  });

  it('returns [] when loose-json fallback resolves to null and no json block is extracted', async () => {
    const module = await importWithJsonParsingMock(() => null);
    const edits = module.parseEditsFromLLM({ data: { response: 'no edits here' } });
    expect(edits).toEqual([]);
  });
});
