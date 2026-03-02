import { describe, it, expect } from 'vitest';
import {
  extractJsonObjectWithKey,
  extractJsonObject,
  extractJsonArray
} from '../../services/goalAutomation/automationUtils/jsonParsing.js';

describe('jsonParsing guards', () => {
  it('extractJsonObjectWithKey returns null when value is non-string or key is missing', () => {
    expect(extractJsonObjectWithKey(null, 'edits')).toBeNull();
    expect(extractJsonObjectWithKey('{"edits":[]}', '')).toBeNull();
  });

  it('extractJsonObject returns null for non-string inputs', () => {
    expect(extractJsonObject(null)).toBeNull();
    expect(extractJsonObject({ edits: [] })).toBeNull();
  });

  it('extractJsonArray returns null for non-string inputs', () => {
    expect(extractJsonArray(undefined)).toBeNull();
    expect(extractJsonArray({ items: [] })).toBeNull();
  });
});
