import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const writeText = (filePath, text, { eol = '\r\n' } = {}) => {
  const normalized = text.replace(/\r?\n/g, eol);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, normalized, 'utf8');
};

const readRepoText = (relativePath) => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
};

describe('tools/bump-version.mjs', () => {
  test('dry-run is a no-op on CRLF repos when versions already match', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidcoder-bump-version-'));

    // Copy the bump tool into the temp repo.
    writeText(path.join(tmpRoot, 'tools', 'bump-version.mjs'), readRepoText('tools/bump-version.mjs'));

    // Minimal repo files that the tool expects.
    writeText(path.join(tmpRoot, 'shared', 'version.mjs'), "export const VERSION = '0.5.3';\n");

    writeText(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'x', version: '0.5.3' }, null, 2) + '\n');
    writeText(
      path.join(tmpRoot, 'backend', 'package.json'),
      JSON.stringify({ name: 'x-backend', version: '0.5.3' }, null, 2) + '\n'
    );
    writeText(
      path.join(tmpRoot, 'frontend', 'package.json'),
      JSON.stringify({ name: 'x-frontend', version: '0.5.3' }, null, 2) + '\n'
    );

    writeText(
      path.join(tmpRoot, 'package-lock.json'),
      JSON.stringify({ name: 'x', version: '0.5.3', packages: { '': { name: 'x', version: '0.5.3' } } }, null, 2) +
        '\n'
    );

    writeText(path.join(tmpRoot, 'VERSION'), '0.5.3\n');
    writeText(
      path.join(tmpRoot, 'README.md'),
      ['My repo', '', 'Version: 0.5.3', '', '## Notes', 'Hello'].join('\n') + '\n'
    );
    writeText(
      path.join(tmpRoot, 'docs', 'VERSIONING.md'),
      ['## Current version', '', '0.5.3', '', '## Policy', '- ...'].join('\n') + '\n'
    );

    const stdout = execFileSync('node', ['tools/bump-version.mjs', '0.5.3', '--dry-run'], {
      cwd: tmpRoot,
      encoding: 'utf8',
    });

    expect(stdout).toContain('Would bump version to 0.5.3');
    expect(stdout).toContain('No files changed.');
    expect(stdout).not.toContain('Would update:');
  });
});
