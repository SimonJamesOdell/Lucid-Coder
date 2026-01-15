import { describe, it, expect } from 'vitest';

import { buildFileTree } from '../routes/projects/fileTree.js';

describe('fileTree', () => {
  it('rejects when getFsModule is not provided', async () => {
    await expect(buildFileTree('C:/tmp')).rejects.toThrow('getFsModule must be provided');
  });
});
