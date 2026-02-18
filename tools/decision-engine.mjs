#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const workspaceRoot = process.cwd();

async function readJSON(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch (e) { return null; }
}

function computeScore(profile) {
  // simple weighted heuristic
  let score = 0;
  const reasons = [];
  const deps = profile.detected.dependencies || [];
  const framework = profile.detected.framework || 'unknown';
  const routerDep = profile.detected.routerDependency;
  const routerImports = profile.detected.routerImportsFound;
  const anchorCount = profile.anchors ? profile.anchors.length : 0;

  if (framework === 'react') { score += 1; reasons.push('framework=react'); }
  if (routerDep) { score += 5; reasons.push('router dependency present'); }
  if (routerImports) { score += 4; reasons.push('router imports/strings found'); }
  if (anchorCount > 0) { score += 2; reasons.push(`${anchorCount} anchor(s) detected`); }
  if (!routerDep && routerImports) { score -= 2; reasons.push('router imports present but dependency missing (contradiction)'); }

  const max = 12; // upper bound
  const normalized = Math.max(0, Math.min(1, score / max));
  return { score, normalized, reasons };
}

function decide(intent, profile) {
  const { score, normalized, reasons } = computeScore(profile);
  const action = { intent, score, normalized, reasons };

  if (normalized >= 0.7) {
    action.decision = 'auto_apply_router_api';
    action.rationale = 'High confidence: router present and used across project.';
    action.recommendation = 'Convert internal anchors to router Link components and add tests.';
  } else if (normalized >= 0.4) {
    action.decision = 'suggest_router_with_approval';
    action.rationale = 'Moderate confidence: recommend using router API; ask user approval.';
    action.recommendation = 'Propose installing router dependency and applying codemod upon approval.';
  } else {
    action.decision = 'fallback_safe';
    action.rationale = 'Low confidence: prefer safe fallback and ask clarifying question.';
    action.recommendation = 'Generate navbar using standard anchors and offer to add router if user approves.';
  }

  // concrete helper commands
  action.commands = [];
  if (profile.detected.framework === 'react' && !profile.detected.routerDependency) {
    action.commands.push({
      title: 'Install react-router-dom (npm)',
      cmd: 'npm --prefix frontend install react-router-dom'
    });
  }

  return action;
}

async function main() {
  const intent = process.argv.slice(2).join(' ') || 'Add a navigation bar with links';
  const profilePath = path.join(workspaceRoot, 'frontend', 'project_profile.json');
  const profile = await readJSON(profilePath);
  if (!profile) {
    console.error('No project_profile.json found at', profilePath);
    process.exit(1);
  }

  const action = decide(intent, profile);
  const outPath = path.join(workspaceRoot, 'frontend', 'decision.json');
  await fs.writeFile(outPath, JSON.stringify(action, null, 2), 'utf8');
  console.log('Wrote', outPath);
  console.log(JSON.stringify({ decision: action.decision, normalized: action.normalized }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
