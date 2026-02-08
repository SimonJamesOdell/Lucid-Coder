import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd());

const usage = () => {
  console.log('Usage: node tools/bump-version.mjs <newVersion> [--dry-run]');
  console.log('Example: node tools/bump-version.mjs 0.2.5');
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const newVersion = args.find((arg) => !arg.startsWith('-'));

if (!newVersion || newVersion === '--help' || newVersion === '-h') {
  usage();
  process.exit(newVersion ? 0 : 1);
}

if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error(`Invalid version: ${newVersion}`);
  console.error('Expected semver like 0.2.5');
  process.exit(1);
}

const updates = [];

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const withEol = (text, eol) => {
  if (eol === '\r\n') {
    return text.replace(/\r?\n/g, '\r\n');
  }

  return text.replace(/\r\n/g, '\n');
};

const replaceOnceOrThrow = (text, regex, replacement, fileLabel) => {
  if (!regex.test(text)) {
    throw new Error(`Expected pattern not found in ${fileLabel}`);
  }
  return text.replace(regex, replacement);
};

const updateFile = (relativePath, transform, { ensureTrailingNewline = false } = {}) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Missing file: ${relativePath}`);
  }

  const prev = readFileSync(absolutePath, 'utf8');
  const eol = detectEol(prev);
  const next = transform(prev);
  const normalized = withEol(next, eol);
  const finalText = ensureTrailingNewline && !normalized.endsWith(eol) ? `${normalized}${eol}` : normalized;
  if (finalText === prev) {
    return;
  }
  if (!dryRun) {
    writeFileSync(absolutePath, finalText, 'utf8');
  }
  updates.push(relativePath);
};

const updateJsonFile = (relativePath, mutate) => {
  updateFile(
    relativePath,
    (prev) => {
      const eol = detectEol(prev);
      const parsed = JSON.parse(prev);
      const mutated = mutate(parsed) || parsed;
      return withEol(`${JSON.stringify(mutated, null, 2)}\n`, eol);
    },
    { ensureTrailingNewline: true }
  );
};

const updateOptionalJsonFile = (relativePath, mutate) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return;
  }
  updateJsonFile(relativePath, mutate);
};

// Central config for code/tests.
updateFile(
  'shared/version.mjs',
  (text) =>
    replaceOnceOrThrow(
      text,
      /export const VERSION = '([^']+)'\s*;/,
      `export const VERSION = '${newVersion}';`,
      'shared/version.mjs'
    )
);

// NPM package versions (kept in sync so /api/version is consistent).
updateJsonFile('package.json', (pkg) => ({ ...pkg, version: newVersion }));
updateJsonFile('backend/package.json', (pkg) => ({ ...pkg, version: newVersion }));
updateJsonFile('frontend/package.json', (pkg) => ({ ...pkg, version: newVersion }));

// Keep lockfile's root package version consistent (do not touch dependency versions).
updateJsonFile('package-lock.json', (lock) => {
  const next = { ...lock };
  next.version = newVersion;
  if (next.packages && next.packages['']) {
    next.packages = { ...next.packages, '': { ...next.packages[''], version: newVersion } };
  }
  return next;
});

// Sub-workspace lockfiles (if present).
updateOptionalJsonFile('backend/package-lock.json', (lock) => {
  const next = { ...lock };
  next.version = newVersion;
  if (next.packages && next.packages['']) {
    next.packages = { ...next.packages, '': { ...next.packages[''], version: newVersion } };
  }
  return next;
});

updateOptionalJsonFile('frontend/package-lock.json', (lock) => {
  const next = { ...lock };
  next.version = newVersion;
  if (next.packages && next.packages['']) {
    next.packages = { ...next.packages, '': { ...next.packages[''], version: newVersion } };
  }
  return next;
});

// Flat files.
updateFile('VERSION', () => `${newVersion}\n`);
updateFile(
  'README.md',
  (text) => replaceOnceOrThrow(text, /^Version:[ \t]*\S+[ \t]*$/m, `Version: ${newVersion}`, 'README.md')
);
updateFile(
  'docs/VERSIONING.md',
  (text) =>
    replaceOnceOrThrow(
      text,
      /(## Current version[ \t]*\r?\n)(?:\r?\n)?[ \t]*\S+[ \t]*\r?\n(?:\r?\n)*/m,
      `$1\n${newVersion}\n\n`,
      'docs/VERSIONING.md'
    )
);

console.log(`${dryRun ? 'Would bump' : 'Bumped'} version to ${newVersion}`);
if (updates.length) {
  console.log(`${dryRun ? 'Would update' : 'Updated'}:`);
  for (const file of updates) {
    console.log(`- ${file}`);
  }
} else {
  console.log('No files changed.');
}
