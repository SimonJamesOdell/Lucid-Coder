#!/usr/bin/env node
/**
 * Framework Decision Orchestrator
 * 
 * Coordinates preflight detection → decision engine → confidence scoring
 * to provide intelligent framework recommendations and prevent common failures.
 * 
 * Usage:
 *   import { analyzeProject } from './framework-orchestrator.mjs'
 *   const result = await analyzeProject(projectPath, userIntent)
 *   // result.profile, result.decision, result.recommendation
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

const workspaceRoot = process.cwd();
const frontendDir = path.join(workspaceRoot, 'frontend');

async function readJSON(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch (e) { return null; }
}

/**
 * Run preflight detection on the project
 */
async function runPreflight() {
  try {
    execSync(`node ./tools/preflight-detector.mjs`, { stdio: 'pipe', cwd: workspaceRoot });
    const profile = await readJSON(path.join(frontendDir, 'project_profile.json'));
    return profile;
  } catch (e) {
    console.error('[orchestrator] preflight detection failed:', e.message);
    return null;
  }
}

/**
 * Run decision engine with user intent
 */
async function runDecision(userIntent) {
  try {
    execSync(`node ./tools/decision-engine.mjs "${userIntent}"`, { stdio: 'pipe', cwd: workspaceRoot });
    const decision = await readJSON(path.join(frontendDir, 'decision.json'));
    return decision;
  } catch (e) {
    console.error('[orchestrator] decision engine failed:', e.message);
    return null;
  }
}

/**
 * Analyze project: run preflight + decision and return combined result
 */
export async function analyzeProject(userIntent = '') {
  const profile = await runPreflight();
  if (!profile) {
    return {
      success: false,
      error: 'Preflight detection failed',
      profile: null,
      decision: null
    };
  }

  const decision = await runDecision(userIntent);
  if (!decision) {
    return {
      success: false,
      error: 'Decision engine failed',
      profile,
      decision: null
    };
  }

  return {
    success: true,
    profile,
    decision,
    summary: {
      framework: profile.detected?.framework || 'unknown',
      routerPresent: profile.detected?.routerDependency || false,
      decision: decision.decision,
      confidence: decision.normalized,
      rationale: decision.rationale,
      recommendation: decision.recommendation
    }
  };
}

/**
 * Check if a medium-confidence decision requires user approval
 */
export function requiresApproval(decision) {
  return decision && decision.decision === 'suggest_router_with_approval';
}

/**
 * Check if we can safely auto-apply the recommendation
 */
export function canAutoApply(decision) {
  return decision && decision.decision === 'auto_apply_router_api';
}

/**
 * Check if router dependency is present
 * This validates failure prevention #2: Dependency Confusion
 * Ensures we won't generate code using router APIs if the dependency isn't installed
 */
export function validateRouterDependency(profile) {
  return {
    present: profile?.detected?.routerDependency === true,
    reason: profile?.detected?.routerDependency 
      ? 'Router dependency (react-router-dom) is installed' 
      : 'Router dependency (react-router-dom) is NOT installed - fallback to safe HTML'
  };
}

/**
 * Comprehensive validation for code generation safety
 * Returns diagnostic info for all three failure prevention vectors
 */
export function validateGenerationSafety(profile, decision) {
  const diagnostics = {
    framework: {
      detected: profile?.detected?.framework || 'unknown',
      safe: profile?.detected?.framework === 'react'
    },
    routerConfidence: {
      score: decision?.normalized || 0,
      safe: decision?.normalized >= 0.7 || decision?.decision === 'fallback_safe',
      decision: decision?.decision,
      reasoning: decision?.rationale
    },
    routerDependency: validateRouterDependency(profile),
    failureVectors: {
      duplicateClarification: {
        risk: 'Medium - use ClarificationTracker',
        prevention: 'Track asked questions by intent hash to avoid repeats'
      },
      dependencyConfusion: {
        risk: profile?.detected?.routerDependency ? 'Low' : 'HIGH - missing dependency',
        prevention: 'Validate routerDependency before generating router code'
      },
      cascadingTestFailures: {
        risk: decision?.decision === 'suggest_router_with_approval' ? 'Low - approval gating enabled' : 'None',
        prevention: 'Use confidence thresholds to gate code generation'
      }
    },
    safeToGenerate: {
      withRouter: profile?.detected?.routerDependency === true && decision?.decision !== 'fallback_safe',
      withFallback: true, // Always safe to use HTML fallback
      recommendation: profile?.detected?.routerDependency === true 
        ? 'Can use router API - dependency present'
        : 'MUST use HTML fallback - dependency not installed'
    }
  };
  
  return diagnostics;
}

/**
 * Format decision for display in UI/console
 */
export function formatDecision(decision) {
  if (!decision) return 'No decision available';
  return `
[${decision.decision}] Confidence: ${(decision.normalized * 100).toFixed(0)}%

Recommendation: ${decision.recommendation}

Rationale: ${decision.rationale}

${decision.commands?.length ? `Suggested actions:\n${decision.commands.map(c => `  • ${c.title}: ${c.cmd}`).join('\n')}` : ''}
  `.trim();
}

/**
 * CLI interface for testing
 */
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const intent = process.argv.slice(2).join(' ') || 'Add a navigation bar';
  const result = await analyzeProject(intent);
  console.log(JSON.stringify(result, null, 2));
}
