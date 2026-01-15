#!/usr/bin/env node
/**
 * Minimal file peeker: print a single inclusive line range.
 * Usage: node tools/file-peek.cjs <file> <startLine> <endLine> [context]
 */
const fs = require('fs');
const path = require('path');

const usage = 'Usage: node tools/file-peek.cjs <file> <startLine> <endLine> [context]';

const parseIntStrict = (value, label) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
};

const args = process.argv.slice(2);
if (args.length < 3 || args.length > 4) {
  console.error(usage);
  process.exit(1);
}

const [fileArg, startArg, endArg, contextArg] = args;
let startLine;
let endLine;
let context = 0;

try {
  startLine = parseIntStrict(startArg, 'start line');
  endLine = parseIntStrict(endArg, 'end line');
  if (contextArg !== undefined) {
    context = parseIntStrict(contextArg, 'context');
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (endLine < startLine) {
  [startLine, endLine] = [endLine, startLine];
}

const resolvedPath = path.resolve(process.cwd(), fileArg);
if (!fs.existsSync(resolvedPath)) {
  console.error(`File not found: ${fileArg}`);
  process.exit(1);
}

const content = fs.readFileSync(resolvedPath, 'utf8');
const lines = content.split(/\r?\n/);
const totalLines = lines.length;
const padWidth = String(totalLines).length;

const from = Math.max(1, startLine - context);
const to = Math.min(totalLines, endLine + context);

console.log(`${path.relative(process.cwd(), resolvedPath)}:${from}-${to}`);
for (let lineNumber = from; lineNumber <= to; lineNumber += 1) {
  const lineText = lines[lineNumber - 1] ?? '';
  console.log(`${String(lineNumber).padStart(padWidth, ' ')}: ${lineText}`);
}
