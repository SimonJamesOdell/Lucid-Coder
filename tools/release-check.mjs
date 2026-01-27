import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const readJson = async (filePath) => {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
};

const readText = async (filePath) => {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw.trim();
};

const fail = (message) => {
  console.error(`release:check failed: ${message}`);
  process.exitCode = 1;
};

const main = async () => {
  const repoRoot = process.cwd();

  const rootPackage = await readJson(path.join(repoRoot, 'package.json'));
  const backendPackage = await readJson(path.join(repoRoot, 'backend', 'package.json'));
  const frontendPackage = await readJson(path.join(repoRoot, 'frontend', 'package.json'));

  const versionFile = await readText(path.join(repoRoot, 'VERSION'));

  // shared/version.mjs is an ES module exporting a string constant.
  // Use dynamic import with a file:// URL.
  const sharedVersionModule = await import(pathToFileURL(path.join(repoRoot, 'shared', 'version.mjs')));
  const sharedVersion = typeof sharedVersionModule?.VERSION === 'string'
    ? sharedVersionModule.VERSION
    : (typeof sharedVersionModule?.default === 'string' ? sharedVersionModule.default : null);

  const expected = rootPackage.version;

  if (!expected) {
    fail('root package.json is missing version');
    return;
  }

  const mismatches = [];

  if (backendPackage.version !== expected) mismatches.push(`backend/package.json (${backendPackage.version})`);
  if (frontendPackage.version !== expected) mismatches.push(`frontend/package.json (${frontendPackage.version})`);
  if (versionFile !== expected) mismatches.push(`VERSION (${versionFile})`);
  if (sharedVersion !== expected) mismatches.push(`shared/version.mjs (${sharedVersion ?? 'missing export'})`);

  if (mismatches.length) {
    fail(`version mismatch vs root ${expected}: ${mismatches.join(', ')}`);
  }

  const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
  const changelog = await readText(changelogPath);
  const hasChangelogEntry = changelog.includes(`## ${expected} (`);

  if (!hasChangelogEntry) {
    fail(`CHANGELOG.md missing heading for ${expected} (expected "## ${expected} (YYYY-MM-DD)")`);
  }

  if (process.exitCode !== 1) {
    console.log(`release:check OK for ${expected}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
