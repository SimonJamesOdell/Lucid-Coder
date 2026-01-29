export const parseSemver = (version) => {
  const input = typeof version === 'string' ? version.trim() : '';
  const match = input.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isFinite)) {
    return null;
  }
  return { major, minor, patch };
};

export const incrementPatch = (version) => {
  const parsed = parseSemver(version);
  if (!parsed) {
    return null;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
};

export const extractUnreleasedEntries = (text) => {
  const input = typeof text === 'string' ? text : '';
  const normalized = input.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const headingIndex = lines.findIndex((line) => /^##[ \t]+Unreleased[ \t]*$/i.test(line.trim()));
  if (headingIndex === -1) {
    return { hasHeading: false, entries: [] };
  }
  const entries = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    if (/^[-*]\s+/.test(line.trim())) {
      entries.push(line.trim());
    }
  }
  return { hasHeading: true, entries };
};

export const rollChangelogToVersion = (text, newVersion) => {
  const input = typeof text === 'string' ? text : '';
  const normalized = input.replace(/\r\n/g, '\n');
  const extracted = extractUnreleasedEntries(normalized);
  if (!extracted.hasHeading || !extracted.entries.length) {
    return input;
  }

  const date = new Date().toISOString().slice(0, 10);
  const injected = `\n\n## ${newVersion} (${date})\n\n${extracted.entries.join('\n')}\n`;

  // Replace Unreleased section contents with an empty section (keep heading).
  const unreleasedBlockRe = /(^##[ \t]+Unreleased[ \t]*$)[\s\S]*?(?=^##[ \t]+|\Z)/im;
  let next = normalized.replace(unreleasedBlockRe, `$1\n`);

  // Insert the new version section right after the Unreleased heading.
  const unreleasedHeadingRe = /^##[ \t]+Unreleased[ \t]*$/im;
  const match = unreleasedHeadingRe.exec(next);
  if (!match) {
    return input;
  }
  const insertAt = match.index + match[0].length;
  next = `${next.slice(0, insertAt)}${injected}${next.slice(insertAt)}`;

  return next;
};

export const coerceSingleLine = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
};

export const normalizeChangelogBullet = (value) => {
  const singleLine = coerceSingleLine(value);
  if (!singleLine) {
    return '';
  }
  const withoutPrefix = singleLine.replace(/^[-*]\s+/, '').trim();
  const truncated = withoutPrefix.length > 140 ? `${withoutPrefix.slice(0, 137)}...` : withoutPrefix;
  return truncated;
};

export const ensureChangelogUnreleasedEntry = async (fs, path, projectPath, entryText) => {
  const basePath = typeof projectPath === 'string' ? projectPath.trim() : '';
  const entry = normalizeChangelogBullet(entryText);
  if (!basePath || !entry) {
    return { updated: false };
  }

  const changelogPath = path.join(basePath, 'CHANGELOG.md');
  const bulletLine = `- ${entry}`;

  let existing = '';
  try {
    existing = await fs.readFile(changelogPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { updated: false };
    }
  }

  if (typeof existing !== 'string' || !existing.trim()) {
    const fresh = `# Changelog\n\n## Unreleased\n\n${bulletLine}\n`;
    await fs.writeFile(changelogPath, fresh, 'utf8');
    return { updated: true };
  }

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const normalized = existing.replace(/\r\n/g, '\n');

  if (
    normalized.includes(`\n${bulletLine}\n`) ||
    normalized.startsWith(`${bulletLine}\n`) ||
    normalized.endsWith(`\n${bulletLine}`) ||
    normalized === bulletLine
  ) {
    return { updated: false };
  }

  let next = normalized;
  const unreleasedHeadingRe = /^##[ \t]+Unreleased[ \t]*$/im;
  const match = unreleasedHeadingRe.exec(next);

  if (!match) {
    const changelogTitleRe = /^#\s+Changelog\s*$/im;
    const titleMatch = changelogTitleRe.exec(next);
    if (titleMatch) {
      const titleLineEnd = next.indexOf('\n', titleMatch.index + titleMatch[0].length);
      const insertPos = titleLineEnd === -1 ? next.length : titleLineEnd;
      const prefix = next.slice(0, insertPos);
      const suffix = next.slice(insertPos);
      next = `${prefix}\n\n## Unreleased\n\n${bulletLine}\n${suffix.replace(/^\n+/, '\n')}`;
    } else {
      next = `# Changelog\n\n## Unreleased\n\n${bulletLine}\n\n${next.replace(/^\n+/, '')}`;
    }
  } else {
    const headingEndIndex = match.index + match[0].length;
    let insertPos = next.indexOf('\n', headingEndIndex);
    if (insertPos === -1) {
      next = `${next}\n`;
      insertPos = next.length - 1;
    }
    insertPos += 1;

    while (next[insertPos] === '\n') {
      insertPos += 1;
    }

    next = `${next.slice(0, insertPos)}${bulletLine}\n${next.slice(insertPos)}`;
  }

  if (!next.endsWith('\n')) {
    next += '\n';
  }

  const finalText = eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next;
  const updated = finalText !== existing;
  if (updated) {
    await fs.writeFile(changelogPath, finalText, 'utf8');
  }
  return { updated };
};

export const updatePackageVersionIfPresent = async (fs, absolutePath, newVersion) => {
  try {
    const raw = await fs.readFile(absolutePath, 'utf8');
    const prev = JSON.parse(String(raw || ''));
    if (!prev || typeof prev !== 'object') {
      return false;
    }
    const next = { ...prev, version: newVersion };
    const eol = typeof raw === 'string' && raw.includes('\r\n') ? '\r\n' : '\n';
    await fs.writeFile(absolutePath, JSON.stringify(next, null, 2).replace(/\n/g, eol) + eol, 'utf8');
    return true;
  } catch {
    return false;
  }
};

export const bumpVersionAndRollChangelog = async (fs, path, projectPath, entryText) => {
  const basePath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!basePath) {
    return { updated: false, version: null };
  }

  const versionPath = path.join(basePath, 'VERSION');
  const changelogPath = path.join(basePath, 'CHANGELOG.md');
  const frontendPkgPath = path.join(basePath, 'frontend', 'package.json');
  const backendPkgPath = path.join(basePath, 'backend', 'package.json');

  await ensureChangelogUnreleasedEntry(fs, path, basePath, entryText).catch(() => ({ updated: false }));

  const currentVersionRaw = await fs.readFile(versionPath, 'utf8').catch(() => '0.1.0\n');
  const currentVersion = String(currentVersionRaw || '').trim() || '0.1.0';
  const nextVersion = incrementPatch(currentVersion) || '0.1.0';

  const changelogText = await fs.readFile(changelogPath, 'utf8').catch(() => null);
  if (typeof changelogText === 'string') {
    const rolled = rollChangelogToVersion(changelogText, nextVersion);
    await fs.writeFile(changelogPath, rolled, 'utf8');
  }

  await fs.writeFile(versionPath, `${nextVersion}\n`, 'utf8');

  await updatePackageVersionIfPresent(fs, frontendPkgPath, nextVersion);
  await updatePackageVersionIfPresent(fs, backendPkgPath, nextVersion);

  return { updated: true, version: nextVersion };
};
