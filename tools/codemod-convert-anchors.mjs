#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const workspaceRoot = process.cwd();
const frontendDir = path.join(workspaceRoot, 'frontend');

async function readJSON(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch (e) { return null; }
}

function ensureDir(p) {
  return fs.mkdir(p, { recursive: true }).catch(() => {});
}

function addLinkImport(content) {
  // naive: if any import from 'react-router-dom' exists, add a named import for Link if missing
  if (/from\s+['"]react-router-dom['"]/.test(content)) {
    if (/\bLink\b/.test(content)) return content; // already present
    // try to inject a new import line before first import from react-router-dom or at top
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/from\s+['"]react-router-dom['"]/.test(lines[i])) {
        // if line already has braces, try to add Link inside braces
        const m = lines[i].match(/import\s+\{([^}]*)\}\s+from\s+['"]react-router-dom['"]/);
        if (m) {
          const inner = m[1].trim();
          if (inner.length === 0) {
            lines[i] = lines[i].replace(/\{\s*\}/, '{ Link }');
          } else {
            lines[i] = lines[i].replace(/\{([^}]*)\}/, `{${inner}, Link}`);
          }
          return lines.join('\n');
        }
        // otherwise, insert a new import after this line
        lines.splice(i+1, 0, "import { Link } from 'react-router-dom';");
        return lines.join('\n');
      }
    }
    // no existing react-router-dom import, add at top
    return "import { Link } from 'react-router-dom';\n" + content;
  } else {
    // no react-router-dom imports; add at top
    return "import { Link } from 'react-router-dom';\n" + content;
  }
}

function replaceAnchorAtPosition(content, openIdx) {
  // find the closing '>' of opening tag
  const gtIdx = content.indexOf('>', openIdx);
  if (gtIdx === -1) return null;
  // replace '<a' with '<Link' and 'href=' with 'to='
  let modified = content.slice(0, openIdx) + '<Link' + content.slice(openIdx + 2);
  // adjust index shift
  const hrefRe = /href\s*=\s*/g;
  modified = modified.replace(hrefRe, 'to=');
  // find the corresponding closing </a>
  const closeIdx = modified.indexOf('</a>', gtIdx);
  if (closeIdx === -1) return null;
  modified = modified.slice(0, closeIdx) + '</Link>' + modified.slice(closeIdx + 4);
  return modified;
}

async function runDryRun() {
  const profile = await readJSON(path.join(frontendDir, 'project_profile.json'));
  if (!profile) {
    console.error('Missing frontend/project_profile.json — run preflight first');
    process.exit(1);
  }

  const decision = await readJSON(path.join(frontendDir, 'decision.json')) || {};
  if (decision.decision === 'fallback_safe') {
    console.log('Decision engine prefers safe fallback. Aborting codemod.');
    return;
  }

  const patchesDir = path.join(frontendDir, 'proposed_patches');
  await ensureDir(patchesDir);

  const candidates = (profile.anchors || []).filter(a => a.internal === true);
  if (candidates.length === 0) {
    console.log('No internal anchor candidates found to convert.');
    return;
  }

  const filesTouched = new Set();
  for (const c of candidates) {
    const fullPath = path.join(workspaceRoot, c.file);
    let content;
    try { content = await fs.readFile(fullPath, 'utf8'); } catch (e) { continue; }
    // find the nth occurrence of '<a' at or after the recorded line
    const lines = content.split(/\r?\n/);
    const lineIdx = c.line - 1;
    // compute offset index of that line
    let offset = 0;
    for (let i = 0; i < lineIdx; i++) offset += lines[i].length + 1;
    const line = lines[lineIdx];
    const openRel = line.indexOf('<a');
    if (openRel === -1) {
      // fallback: search from offset for '<a' with href
      const searchIdx = content.indexOf('<a', offset);
      if (searchIdx === -1) continue;
      const modified = replaceAnchorAtPosition(content, searchIdx);
      if (!modified) continue;
      let mod2 = addLinkImport(modified);
      const outPath = path.join(patchesDir, path.relative(frontendDir, c.file).replace(/\\/g, '_') + '.modified');
      await ensureDir(path.dirname(outPath));
      await fs.writeFile(outPath, mod2, 'utf8');
      filesTouched.add(c.file);
      continue;
    }
    const openIdx = offset + openRel;
    const modified = replaceAnchorAtPosition(content, openIdx);
    if (!modified) continue;
    const modWithImport = addLinkImport(modified);
    const rel = path.relative(frontendDir, c.file).replace(/\\/g, '/');
    const outPath = path.join(patchesDir, rel + '.modified');
    await ensureDir(path.dirname(outPath));
    await fs.writeFile(outPath, modWithImport, 'utf8');
    filesTouched.add(c.file);
  }

  console.log('Wrote proposed patches for', filesTouched.size, 'file(s) to', patchesDir);
  for (const f of filesTouched) console.log(' -', f);
  console.log('\nTo apply patches, review files in frontend/proposed_patches and overwrite originals if desired.');
}

runDryRun().catch(e => { console.error(e); process.exit(1); });
