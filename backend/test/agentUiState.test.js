import { describe, it, expect, beforeEach } from 'vitest';

import {
  enqueueUiCommand,
  listKnownSessionIds,
  __agentUiStateTestHelpers
} from '../services/agentUiState.js';

describe('agentUiState', () => {
  beforeEach(() => {
    __agentUiStateTestHelpers.reset();
  });

  it('lists known session ids for a project (normalized + unique)', () => {
    enqueueUiCommand(1, { type: 'PING', payload: null }, undefined);
    enqueueUiCommand(1, { type: 'PING', payload: null }, '  s1  ');
    enqueueUiCommand(1, { type: 'PING', payload: null }, 's1');
    enqueueUiCommand(1, { type: 'PING', payload: null }, 123);

    // Add another project to exercise the prefix filter/continue branch.
    enqueueUiCommand(2, { type: 'PING', payload: null }, 'other');

    const sessions = listKnownSessionIds(1);

    expect(sessions).toEqual(expect.arrayContaining(['default', 's1']));
    expect(sessions).toHaveLength(2);
  });

  it('returns an empty array when no sessions exist for the project', () => {
    enqueueUiCommand(2, { type: 'PING', payload: null }, 's1');

    expect(listKnownSessionIds(1)).toEqual([]);
  });
});
