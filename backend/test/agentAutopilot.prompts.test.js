import { describe, expect, test } from 'vitest';
import {
  buildFailingTestsPrompt,
  buildImplementationPrompt,
  buildVerificationFixPrompt,
  buildUserGuidanceFixPrompt
} from '../services/agentAutopilot/prompts.js';

describe('agentAutopilot prompts', () => {
  test('buildFailingTestsPrompt uses default goal text when missing', () => {
    const prompt = buildFailingTestsPrompt('');

    expect(prompt).toContain('Stage: Write failing tests');
    expect(prompt).toContain('Goal Details:\nFollow the previously described requirement.');
  });

  test('buildImplementationPrompt includes test summary and goal', () => {
    const prompt = buildImplementationPrompt('Ship it', 'Tests failing on feature');

    expect(prompt).toContain('Stage: Implement feature');
    expect(prompt).toContain('Latest Test Context:\nTests failing on feature');
    expect(prompt).toContain('Goal Details:\nShip it');
  });

  test('buildVerificationFixPrompt formats attempt and max attempts', () => {
    const prompt = buildVerificationFixPrompt('Fix flakes', 'Jest timeout', 2, 5);

    expect(prompt).toContain('Stage: Stabilize verification run (2/5)');
    expect(prompt).toContain('Latest Test Context:\nJest timeout');
    expect(prompt).toContain('Goal Details:\nFix flakes');
  });

  test('buildUserGuidanceFixPrompt omits guidance when empty', () => {
    const prompt = buildUserGuidanceFixPrompt('Do work', 'None', '   ');

    expect(prompt).toContain('Stage: Apply user guidance');
    expect(prompt).not.toContain('User Guidance:');
    expect(prompt).toContain('Latest Test Context:\nNone');
  });

  test('buildUserGuidanceFixPrompt includes guidance when provided', () => {
    const prompt = buildUserGuidanceFixPrompt('Do work', null, 'Please prioritize safety');

    expect(prompt).toContain('User Guidance:\nPlease prioritize safety');
    expect(prompt).toContain('Latest Test Context:\n(No additional test output was provided.)');
  });
});
