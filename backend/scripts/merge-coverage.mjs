import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import istanbulCoverage from 'istanbul-lib-coverage';
import istanbulReport from 'istanbul-lib-report';
import istanbulReports from 'istanbul-reports';

const { createCoverageMap } = istanbulCoverage;
const { createContext } = istanbulReport;
const reports = istanbulReports;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/merge-coverage.mjs <coverage-dir> [<coverage-dir> ...]');
  process.exit(1);
}

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, 'coverage');

const normalizeCoverageTarget = (value, fallback = 100) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  if (numeric < 0 || numeric > 100) {
    return fallback;
  }
  return numeric;
};

const coverageTarget = normalizeCoverageTarget(process.env.LUCIDCODER_COVERAGE_TARGET, 100);

const sleepSync = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }

  // Node-compatible synchronous sleep.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const normalizeCoverageJson = (json, { label } = {}) => {
  let normalized = 0;

  for (const fileCoverage of Object.values(json ?? {})) {
    if (!fileCoverage || typeof fileCoverage !== 'object') continue;
    if (!fileCoverage.b || typeof fileCoverage.b !== 'object') continue;

    for (const [branchId, counts] of Object.entries(fileCoverage.b)) {
      if (!Array.isArray(counts)) continue;

      const next = counts.map((value) => {
        if (!Number.isFinite(value)) {
          normalized += 1;
          return 0;
        }

        if (value < 0) {
          // We've seen rare negative branch hit counts from v8 coverage conversion
          // during highly-parallel runs. Negative hit counts are nonsensical and
          // cause false "partial branch" (yellow) reporting.
          normalized += 1;
          return Math.abs(value);
        }

        return value;
      });

      fileCoverage.b[branchId] = next;
    }
  }

  if (normalized) {
    const suffix = label ? ` (${label})` : '';
    console.warn(`⚠️ Normalized ${normalized} invalid branch hit count(s)${suffix}.`);
  }

  return json;
};

const readCoverage = (dir) => {
  const coveragePath = path.join(projectRoot, dir, 'coverage-final.json');
  // On Windows (especially with fork pools), Vitest can finish the main process
  // slightly before the coverage JSON lands on disk. Retry briefly to avoid
  // flaky merge failures.
  const maxAttempts = 40;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (fs.existsSync(coveragePath)) {
      break;
    }

    if (attempt === maxAttempts) {
      throw new Error(`Missing coverage-final.json at ${coveragePath}`);
    }

    sleepSync(50);
  }
  const raw = fs.readFileSync(coveragePath, 'utf-8');
  return normalizeCoverageJson(JSON.parse(raw), { label: dir });
};

const coverageMap = createCoverageMap({});
for (const dir of args) {
  const json = readCoverage(dir);
  coverageMap.merge(json);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(
  path.join(outDir, 'coverage-final.json'),
  JSON.stringify(coverageMap.toJSON()),
  'utf-8'
);

const context = createContext({
  dir: outDir,
  coverageMap
});

for (const reporterName of ['text', 'html', 'json']) {
  reports.create(reporterName).execute(context);
}

// Enforce merged coverage at the configured threshold.
try {
  const summary = coverageMap.getCoverageSummary();
  const metrics = ['lines', 'statements', 'functions', 'branches'];
  const failures = metrics
    .map((metric) => ({ metric, pct: summary?.[metric]?.pct }))
    .filter((entry) => Number.isFinite(entry.pct) && entry.pct < coverageTarget);

  if (failures.length) {
    console.error(`❌ Merged coverage is below ${coverageTarget}% for one or more metrics:`);
    for (const entry of failures) {
      console.error(`- ${entry.metric}: ${entry.pct}%`);
    }
    process.exit(2);
  }
} catch (error) {
  console.error('❌ Failed to validate merged coverage summary:', error);
  process.exit(2);
}

// Optional cleanup of intermediate coverage JSON directories.
// Disabled by default because on Windows with forked workers, Vitest can still be flushing
// coverage fragments briefly after the main process has exited; deleting coverage-tmp too early
// can cause sporadic ENOENT write failures.
const shouldCleanupCoverageTmp = process.env.LUCIDCODER_CLEANUP_COVERAGE_TMP === '1';

if (shouldCleanupCoverageTmp) {
  for (const dir of args) {
    try {
      const resolved = path.resolve(projectRoot, dir);
      const relative = path.relative(projectRoot, resolved);

      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        continue;
      }

      const normalized = relative.split(path.sep).join('/');
      if (!normalized.startsWith('coverage-tmp/')) {
        continue;
      }

      fs.rmSync(resolved, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  try {
    const coverageTmpRoot = path.join(projectRoot, 'coverage-tmp');
    if (fs.existsSync(coverageTmpRoot)) {
      const remaining = fs.readdirSync(coverageTmpRoot);
      if (!remaining || remaining.length === 0) {
        fs.rmSync(coverageTmpRoot, { recursive: true, force: true });
      }
    }
  } catch {
    // ignore
  }
}
