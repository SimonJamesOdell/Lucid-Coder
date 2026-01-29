export const extractUncoveredLines = (coverageEntry) => {
  if (!coverageEntry || typeof coverageEntry !== 'object') {
    return [];
  }

  const lineMap = coverageEntry.l;
  if (lineMap && typeof lineMap === 'object') {
    const lines = Object.entries(lineMap)
      .map(([line, count]) => ({ line: Number(line), count: Number(count) }))
      .filter((entry) => Number.isFinite(entry.line) && entry.count === 0)
      .map((entry) => entry.line)
      .sort((a, b) => a - b);
    return Array.from(new Set(lines));
  }

  const statementMap = coverageEntry.statementMap;
  const statementCounts = coverageEntry.s;
  if (!statementMap || typeof statementMap !== 'object' || !statementCounts || typeof statementCounts !== 'object') {
    return [];
  }

  const lines = [];
  for (const key of Object.keys(statementMap)) {
    const hitCount = Number(statementCounts[key]);
    if (Number.isFinite(hitCount) && hitCount > 0) {
      continue;
    }
    const loc = statementMap[key];
    const startLine = Number(loc?.start?.line);
    const endLine = Number(loc?.end?.line);
    if (!Number.isFinite(startLine)) {
      continue;
    }
    if (!Number.isFinite(endLine) || endLine === startLine) {
      lines.push(startLine);
      continue;
    }
    const boundedEnd = Math.min(endLine, startLine + 25);
    for (let line = startLine; line <= boundedEnd; line += 1) {
      lines.push(line);
    }
  }

  lines.sort((a, b) => a - b);
  return Array.from(new Set(lines));
};
