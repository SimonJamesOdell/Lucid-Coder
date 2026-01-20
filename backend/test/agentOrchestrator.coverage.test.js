import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../database.js';
import {
  createMetaGoalWithChildren,
  __testExports__
} from '../services/agentOrchestrator.js';

const resetAgentTables = async () => {
  const { default: db } = await import('../database.js');
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('DELETE FROM agent_tasks', (err) => {
        if (err && !/no such table/i.test(err.message)) return reject(err);
        db.run('DELETE FROM agent_goals', (err2) => {
          if (err2 && !/no such table/i.test(err2.message)) return reject(err2);
          resolve();
        });
      });
    });
  });
};

describe('agentOrchestrator coverage helpers (unit)', () => {
  beforeEach(async () => {
    await initializeDatabase();
    await resetAgentTables();
  });

  it('covers normalizeChildPlans object + string branches', () => {
    const { normalizeChildPlans } = __testExports__;

    const plans = normalizeChildPlans([
      { title: 'Custom title', prompt: 'Implement flow' },
      'Write docs'
    ]);

    expect(plans).toEqual([
      { title: 'Custom title', prompt: 'Implement flow' },
      { title: 'Write Docs', prompt: 'Write docs' }
    ]);
  });

  it('handles non-string titles in child plan normalization', () => {
    const { normalizeChildPlans } = __testExports__;

    const plans = normalizeChildPlans([{ title: 123, prompt: 'Do work' }]);

    expect(plans).toEqual([{ title: 'Do Work', prompt: 'Do work' }]);
  });

  it('filters non-string clarifying questions', () => {
    const { normalizeClarifyingQuestions } = __testExports__;

    const normalized = normalizeClarifyingQuestions(['  First  ', 123, null, undefined, '']);

    expect(normalized).toEqual(['First']);
  });

  it('covers id fallback ordering in goal tree sort', () => {
    const { buildGoalTreeFromList } = __testExports__;

    const tree = buildGoalTreeFromList([
      { id: 4, parentGoalId: null, createdAt: 'invalid' },
      { id: 2, parentGoalId: null, createdAt: 'invalid' }
    ]);

    expect(tree.map((node) => node.id)).toEqual([2, 4]);
  });

  it('sorts by id when createdAt timestamps match', () => {
    const { buildGoalTreeFromList } = __testExports__;
    const createdAt = '2024-01-01T00:00:00.000Z';

    const tree = buildGoalTreeFromList([
      { id: 10, parentGoalId: null, createdAt },
      { id: 2, parentGoalId: null, createdAt }
    ]);

    expect(tree.map((node) => node.id)).toEqual([2, 10]);
  });

  it('handles falsy ids in goal tree sort fallback', () => {
    const { buildGoalTreeFromList } = __testExports__;

    const treeFirst = buildGoalTreeFromList([
      { id: 0, parentGoalId: null, createdAt: 'invalid' },
      { id: 2, parentGoalId: null, createdAt: 'invalid' }
    ]);

    const treeSecond = buildGoalTreeFromList([
      { id: 2, parentGoalId: null, createdAt: 'invalid' },
      { id: 0, parentGoalId: null, createdAt: 'invalid' }
    ]);

    expect(treeFirst.map((node) => node.id)).toEqual([0, 2]);
    expect(treeSecond.map((node) => node.id)).toEqual([0, 2]);
  });

  it('covers nested child creation when plans include children', async () => {
    const { children } = await createMetaGoalWithChildren({
      projectId: 501,
      prompt: 'Nested plan coverage',
      childPrompts: [
        {
          prompt: 'Parent child',
          children: [{ prompt: 'Nested leaf' }]
        }
      ]
    });

    expect(children).toHaveLength(1);
    expect(children[0].children).toHaveLength(1);
  });

  it('handles empty children arrays when creating nodes', async () => {
    const { children } = await createMetaGoalWithChildren({
      projectId: 502,
      prompt: 'Empty children coverage',
      childPrompts: [
        {
          prompt: 'Child goal',
          children: []
        }
      ]
    });

    expect(children).toHaveLength(1);
    expect(children[0].children).toEqual([]);
  });

  it('skips non-array children when creating nodes', async () => {
    const { children } = await createMetaGoalWithChildren({
      projectId: 503,
      prompt: 'Non-array children coverage',
      childPrompts: [
        {
          prompt: 'Child without array children',
          children: null
        }
      ]
    });

    expect(children).toHaveLength(1);
    expect(children[0].children).toEqual([]);
  });
});
