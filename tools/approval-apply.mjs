#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const workspaceRoot = process.cwd();
const frontendDir = path.join(workspaceRoot, 'frontend');

async function readJSON(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch (e) { return null; }
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

function navBarUsingLink() {
  return `import React from 'react';
import { Link } from 'react-router-dom';

export default function NavBar() {
  return (
    <nav className="nav-bar">
      <ul>
        <li><Link to="/">Home</Link></li>
        <li><Link to="/about">About</Link></li>
        <li><Link to="/contact">Contact</Link></li>
      </ul>
    </nav>
  );
}
`;
}

function navBarFallback() {
  return `import React from 'react';

export default function NavBarFallback() {
  return (
    <nav className="nav-bar">
      <ul>
        <li><a href="/">Home</a></li>
        <li><a href="/about">About</a></li>
        <li><a href="/contact">Contact</a></li>
      </ul>
    </nav>
  );
}
`;
}

async function main() {
  const decision = await readJSON(path.join(frontendDir, 'decision.json')) || {};
  const proposedDir = path.join(frontendDir, 'proposed_patches', 'components');
  await fs.mkdir(proposedDir, { recursive: true });

  const linkContent = navBarUsingLink();
  const fallbackContent = navBarFallback();

  await writeFile(path.join(proposedDir, 'NavBar.jsx.modified'), linkContent);
  await writeFile(path.join(proposedDir, 'NavBar.fallback.modified.jsx'), fallbackContent);

  console.log('Created proposed NavBar files under frontend/proposed_patches/components');

  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('\nReview the proposed files. To apply the Link-based NavBar run with --apply.');
    console.log('NOTE: react-router-dom is not installed in this project. To enable Link navigation run:');
    console.log('\n  npm --prefix frontend install react-router-dom\n');
    return;
  }

  // apply: write the Link-based component into src/components/NavBar.generated.jsx
  const dest = path.join(frontendDir, 'src', 'components', 'NavBar.generated.jsx');
  await writeFile(dest, linkContent);
  console.log('Wrote', dest);
  console.log('NavBar applied. If you want to use it, import NavBar.generated.jsx in your app or replace existing Navigation component.');
}

main().catch(e => { console.error(e); process.exit(1); });
