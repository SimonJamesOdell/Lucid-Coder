#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const workspaceRoot = process.cwd();

async function readJSON(file) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

async function findFiles(dir, exts = ['.js', '.jsx', '.ts', '.tsx', '.vue']) {
  const results = [];
  async function walk(d) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else {
        if (exts.includes(path.extname(e.name))) results.push(p);
      }
    }
  }
  await walk(dir);
  return results;
}

function scanForRouterSigns(content) {
  const signs = {
    importsRouter: false,
    routerStrings: false
  };
  if (/from\s+['"]react-router-dom['"]/m.test(content) || /react-router-dom/.test(content)) signs.importsRouter = true;
  if (/BrowserRouter|createBrowserRouter|Routes|Route|router-link|useNavigate|useRouter/m.test(content)) signs.routerStrings = true;
  return signs;
}

function findAnchorCandidates(content) {
  const lines = content.split(/\r?\n/);
  const matches = [];
  const re = /<a\s+([^>]*)>/gi;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let m;
    while ((m = re.exec(line)) !== null) {
      const attrs = m[1];
      const hrefMatch = /href\s*=\s*\{?['"`]?(.*?)["'`\}]?(\s|$|>)/i.exec(attrs);
      const download = /\bdownload\b/.test(attrs);
      const targetBlank = /target\s*=\s*['_\"]?_?blank/i.test(attrs);
      let href = hrefMatch ? hrefMatch[1] : null;
      let isExternal = false;
      if (href) {
        const h = href.trim();
        if (/^(https?:)?\/\//i.test(h) || /^mailto:/i.test(h)) isExternal = true;
        if (h === '' || h.startsWith('#')) isExternal = true;
      } else {
        // dynamic expressions — unknown
      }
      matches.push({ line: i + 1, snippet: line.trim(), href, isExternal, download, targetBlank });
    }
  }
  return matches;
}

async function buildProfileForFrontend() {
  const frontendDir = path.join(workspaceRoot, 'frontend');
  const profile = { project: 'frontend', detected: {}, anchors: [] };

  const pkg = await readJSON(path.join(frontendDir, 'package.json'));
  if (pkg) {
    profile.detected.package = { name: pkg.name, version: pkg.version };
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    profile.detected.dependencies = Object.keys(deps).sort();
    // framework heuristics
    if (deps.react || deps['react-dom']) profile.detected.framework = 'react';
    if (deps.vue) profile.detected.framework = 'vue';
    if (deps['svelte'] || deps['@sveltejs/kit']) profile.detected.framework = 'svelte';
    profile.detected.routerDependency = !!(deps['react-router-dom'] || deps['vue-router'] || deps['@remix-run/react'] || deps['next'] || deps['@sveltejs/kit']);
  }

  // gather source files
  const srcDir = path.join(frontendDir, 'src');
  const files = await findFiles(srcDir).catch(() => []);
  profile.detected.sourceFileCount = files.length;

  let routerImportsFound = false;
  for (const f of files) {
    let content;
    try { content = await fs.readFile(f, 'utf8'); } catch (e) { continue; }
    const signs = scanForRouterSigns(content);
    if (signs.importsRouter || signs.routerStrings) routerImportsFound = true;
    const anchors = findAnchorCandidates(content);
    if (anchors.length) {
      for (const a of anchors) {
        // mark internal candidate heuristically
        const internal = a.href ? (!a.isExternal && !a.download && !a.targetBlank) : true;
        profile.anchors.push({ file: path.relative(workspaceRoot, f).replace(/\\/g, '/'), ...a, internal });
      }
    }
  }
  profile.detected.routerImportsFound = routerImportsFound;
  profile.summary = {
    framework: profile.detected.framework || 'unknown',
    routerDependency: profile.detected.routerDependency || false,
    routerImportsFound: routerImportsFound,
    anchorCount: profile.anchors.length
  };

  const outFile = path.join(frontendDir, 'project_profile.json');
  await fs.writeFile(outFile, JSON.stringify(profile, null, 2), 'utf8');
  console.log('Wrote', outFile);
  console.log(JSON.stringify(profile.summary, null, 2));
}

async function main() {
  try {
    await buildProfileForFrontend();
  } catch (e) {
    console.error('Error building profile:', e);
    process.exit(1);
  }
}

main();
