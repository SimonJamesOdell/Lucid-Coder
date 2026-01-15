import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __agentUiStateTestHelpers,
  acknowledgeUiCommands,
  enqueueUiCommand,
  getUiSnapshot,
  listUiCommands,
  upsertUiSnapshot
} from '../services/agentUiState.js';

describe('agentUiState', () => {
  beforeEach(() => {
    __agentUiStateTestHelpers.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes session ids and builds state keys', () => {
    expect(__agentUiStateTestHelpers.normalizeSessionId(undefined)).toBe('default');
    expect(__agentUiStateTestHelpers.normalizeSessionId(123)).toBe('default');
    expect(__agentUiStateTestHelpers.normalizeSessionId('   ')).toBe('default');
    expect(__agentUiStateTestHelpers.normalizeSessionId('session-a')).toBe('session-a');
    expect(__agentUiStateTestHelpers.normalizeSessionId('  session-b  ')).toBe('session-b');

    expect(__agentUiStateTestHelpers.buildStateKey(42, '  s1 ')).toBe('42:s1');
  });

  it('upserts and returns snapshots; getUiSnapshot returns null when missing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    expect(getUiSnapshot('p1', 's1')).toBeNull();
    expect(getUiSnapshot('p1', '   ')).toBeNull();

    const created = upsertUiSnapshot('p1', { hello: 'world' }, '  s1  ');
    expect(created).toEqual({
      projectId: 'p1',
      sessionId: 's1',
      updatedAt: '2024-01-01T00:00:00.000Z',
      snapshot: { hello: 'world' }
    });

    const fetched = getUiSnapshot('p1', 's1');
    expect(fetched).toEqual(created);
  });

  it('enqueues commands with ids and defaults payload/meta to null', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const c1 = enqueueUiCommand('p1', { type: 'A' }, 's1');
    expect(c1).toEqual({
      id: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      type: 'A',
      payload: null,
      meta: null
    });

    const c2 = enqueueUiCommand('p1', { type: 'B', payload: { ok: true }, meta: { source: 'test' } }, 's1');
    expect(c2).toEqual({
      id: 2,
      createdAt: '2024-01-01T00:00:00.000Z',
      type: 'B',
      payload: { ok: true },
      meta: { source: 'test' }
    });
  });

  it('lists commands after a given id and treats invalid afterId as 0', () => {
    enqueueUiCommand('p1', { type: 'A' }, 's1');
    enqueueUiCommand('p1', { type: 'B' }, 's1');
    enqueueUiCommand('p1', { type: 'C' }, 's1');

    expect(listUiCommands('missing', 0, 's1')).toEqual([]);
    expect(listUiCommands('p1', NaN, 's1').map((c) => c.type)).toEqual(['A', 'B', 'C']);
    expect(listUiCommands('p1', 1, 's1').map((c) => c.type)).toEqual(['B', 'C']);
    expect(listUiCommands('p1', 2, 's1').map((c) => c.type)).toEqual(['C']);
  });

  it('acknowledgeUiCommands returns pruned=0 when state missing', () => {
    const res = acknowledgeUiCommands('p1', 1, 's1');
    expect(res).toEqual({ projectId: 'p1', sessionId: 's1', pruned: 0 });
  });

  it('acknowledgeUiCommands returns pruned=0 for invalid upToId', () => {
    enqueueUiCommand('p1', { type: 'A' }, 's1');

    const res1 = acknowledgeUiCommands('p1', 'not-a-number', 's1');
    expect(res1).toEqual({ projectId: 'p1', sessionId: 's1', pruned: 0 });

    const res2 = acknowledgeUiCommands('p1', 0, 's1');
    expect(res2).toEqual({ projectId: 'p1', sessionId: 's1', pruned: 0 });
  });

  it('acknowledgeUiCommands prunes commands up to the given id', () => {
    enqueueUiCommand('p1', { type: 'A' }, 's1');
    enqueueUiCommand('p1', { type: 'B' }, 's1');
    enqueueUiCommand('p1', { type: 'C' }, 's1');

    const res = acknowledgeUiCommands('p1', '2', 's1');
    expect(res).toEqual({ projectId: 'p1', sessionId: 's1', pruned: 2 });

    const remaining = listUiCommands('p1', 0, 's1');
    expect(remaining.map((c) => c.type)).toEqual(['C']);
  });
});
