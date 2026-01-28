import { describe, expect, test } from 'vitest';
import { createLogBuffer } from '../services/logBuffer.js';

describe('log buffer', () => {
  test('redacts sensitive keys and enforces max entries', () => {
    const buffer = createLogBuffer({ maxEntries: 2, now: () => '2026-01-01T00:00:00.000Z' });

    const first = buffer.add({
      level: 'info',
      message: 'hello',
      correlationId: '  c1  ',
      meta: {
        keep: true,
        apiKey: 'abc',
        nested: { password: 'p', ok: 1 },
        arr: [{ token: 't' }, { ok: true }]
      }
    });

    expect(first).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      message: 'hello',
      correlationId: 'c1',
      meta: {
        keep: true,
        apiKey: '[redacted]',
        nested: { password: '[redacted]', ok: 1 },
        arr: [{ token: '[redacted]' }, { ok: true }]
      }
    });

    buffer.add({ message: 'second' });
    buffer.add({ message: 'third' });

    const listed = buffer.list({ limit: 10 });
    expect(listed).toHaveLength(2);
    expect(listed.map((e) => e.message)).toEqual(['second', 'third']);
  });

  test('accepts non-object entries and defaults fields', () => {
    const buffer = createLogBuffer({ maxEntries: 5, now: () => 'now' });
    const entry = buffer.add('raw');
    expect(entry).toEqual({
      ts: 'now',
      level: 'info',
      message: 'raw',
      correlationId: null,
      meta: null
    });

    expect(buffer.list({ limit: 1 })).toEqual([entry]);
  });

  test('respects explicit timestamps and normalizes level/message/meta', () => {
    const buffer = createLogBuffer({ maxEntries: 5, now: () => 'now' });

    const entry = buffer.add({
      ts: 'explicit-ts',
      level: '   ',
      message: 123,
      meta: undefined
    });

    expect(entry).toEqual({
      ts: 'explicit-ts',
      level: 'info',
      message: '123',
      correlationId: null,
      meta: null
    });

    // Invalid/empty limit falls back to cap.
    expect(buffer.list({ limit: 0 })).toHaveLength(1);
  });

  test('handles invalid maxEntries and missing/nullish message', () => {
    const bufferNonPositive = createLogBuffer({ maxEntries: 0, now: () => 'now' });
    const bufferNotFinite = createLogBuffer({ maxEntries: Number.NaN, now: () => 'now' });

    expect(bufferNonPositive.add()).toMatchObject({ message: '' });
    expect(bufferNotFinite.add({ message: null })).toMatchObject({ message: '' });
  });
});
