import { describe, test, expect } from 'vitest';
import { buildTemplateProjectGitSettings } from '../routes/projects.js';

describe('buildTemplateProjectGitSettings coverage', () => {
  test('falls back to defaults when body and global values are blank', () => {
    expect(buildTemplateProjectGitSettings({ body: {}, globalGitSettings: {} })).toMatchObject({
      workflow: 'local',
      provider: 'github',
      defaultBranch: 'main'
    });
  });

  test('falls back to global provider/default branch when body values are blank', () => {
    expect(
      buildTemplateProjectGitSettings({
        body: { gitProvider: ' ', gitDefaultBranch: ' ' },
        globalGitSettings: { provider: 'gitlab', defaultBranch: 'develop' }
      })
    ).toMatchObject({
      provider: 'gitlab',
      defaultBranch: 'develop'
    });
  });
});
