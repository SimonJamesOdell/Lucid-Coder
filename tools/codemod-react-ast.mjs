#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

const workspaceRoot = process.cwd();
const frontendDir = path.join(workspaceRoot, 'frontend');

async function readJSON(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch (e) { return null; }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

function isInternalHref(value) {
  if (!value) return false;
  if (t.isStringLiteral(value)) {
    const v = value.value;
    return v.startsWith('/') && !v.startsWith('//');
  }
  if (t.isJSXExpressionContainer(value) && t.isStringLiteral(value.expression)) {
    const v = value.expression.value;
    return v.startsWith('/') && !v.startsWith('//');
  }
  return false;
}

function hasImportLink(ast) {
  let found = false;
  traverse(ast, {
    ImportDeclaration(path) {
      if (path.node.source.value === 'react-router-dom') {
        for (const spec of path.node.specifiers) {
          if (t.isImportSpecifier(spec) && spec.imported.name === 'Link') found = true;
        }
      }
    }
  });
  return found;
}

function addLinkImport(ast) {
  let added = false;
  traverse(ast, {
    Program(path) {
      // try to find existing import from react-router-dom
      const body = path.node.body;
      for (const node of body) {
        if (t.isImportDeclaration(node) && node.source.value === 'react-router-dom') {
          // add Link if not present
          const has = node.specifiers.some(s => t.isImportSpecifier(s) && s.imported.name === 'Link');
          if (!has) {
            node.specifiers.push(t.importSpecifier(t.identifier('Link'), t.identifier('Link')));
            added = true;
          }
          return;
        }
      }
      // otherwise insert new import at top
      const imp = t.importDeclaration([t.importSpecifier(t.identifier('Link'), t.identifier('Link'))], t.stringLiteral('react-router-dom'));
      body.unshift(imp);
      added = true;
      path.stop();
    }
  });
  return added;
}

async function run() {
  const profile = await readJSON(path.join(frontendDir, 'project_profile.json'));
  if (!profile) {
    console.error('run preflight first');
    process.exit(1);
  }

  const candidates = (profile.anchors || []).filter(a => a.internal === true);
  if (candidates.length === 0) {
    console.log('No internal anchor candidates found to convert (AST codemod).');
    return;
  }

  const patchesDir = path.join(frontendDir, 'proposed_patches_ast');
  await ensureDir(patchesDir);

  const files = new Set(candidates.map(c => path.join(workspaceRoot, c.file)));
  let touched = 0;
  for (const filePath of files) {
    let code;
    try { code = await fs.readFile(filePath, 'utf8'); } catch (e) { continue; }
    const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'classProperties', 'optionalChaining'] });
    let modified = false;

    traverse(ast, {
      JSXElement(path) {
        const opening = path.node.openingElement;
        if (t.isJSXIdentifier(opening.name, { name: 'a' })) {
          // find href attribute
          const hrefAttr = opening.attributes.find(attr => t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name, { name: 'href' }));
          if (!hrefAttr) return;
          if (!isInternalHref(hrefAttr.value)) return;

          // change name to Link
          opening.name = t.jsxIdentifier('Link');
          path.node.closingElement && (path.node.closingElement.name = t.jsxIdentifier('Link'));
          // rename href to to
          hrefAttr.name.name = 'to';
          modified = true;
        }
      }
    });

    if (modified) {
      addLinkImport(ast);
      const out = generate(ast, { retainLines: true }).code;
      const rel = path.relative(frontendDir, filePath).replace(/\\/g, '/');
      const outPath = path.join(patchesDir, rel + '.modified');
      await ensureDir(path.dirname(outPath));
      await fs.writeFile(outPath, out, 'utf8');
      touched++;
    }
  }

  console.log(`Wrote ${touched} AST-based proposed patch(es) to ${patchesDir}`);
}

run().catch(e => { console.error(e); process.exit(1); });
