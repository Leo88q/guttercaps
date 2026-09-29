#!/usr/bin/env node
/** Inventory, not a claim of translation completeness. Dynamic API text, template
 * expressions, external wallet UIs and text embedded in artwork need manual review.
 * Run: node scripts/i18n-audit.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'client/src');
const candidates = [];
const brands = new Set(['NFT', 'SOL', 'USDC', 'SKR', '$CG', 'GUTTERCAPS', 'GUTTER CITY']);
const visibleAttributes = new Set(['title', 'aria-label', 'alt', 'placeholder', 'label', 'k', 'v']);
for (const file of fs.readdirSync(source, { recursive: true }).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.') && !f.startsWith('shared/i18n/'))) {
  const text = fs.readFileSync(path.join(source, file), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function candidate(node, value, kind) {
    value = value.trim().replace(/\s+/g, ' ');
    if (!/[A-Za-z]/.test(value) || brands.has(value) || /^(?:https?:\/\/|#[0-9a-f]{3,8}$)/i.test(value)) return;
    const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
    candidates.push({ file: 'client/src/' + file, line: line + 1, kind, text: value });
  }
  function displayExpression(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) candidate(node, node.text, 'display-expression');
    else if (ts.isTemplateExpression(node)) {
      candidate(node, [node.head.text, ...node.templateSpans.map(s => s.literal.text)].join(' {…} '), 'template-display');
      for (const span of node.templateSpans) displayExpression(span.expression);
    }
    // A data-object label may be canonical English even though JSX has no literal.
    // These are review candidates, not failures: localized adapters and user names also occur here.
    else if (ts.isPropertyAccessExpression(node) && ['name', 'label', 'title', 'description'].includes(node.name.text)) {
      candidate(node, node.getText(ast), 'dynamic-display');
    }
    else if (ts.isConditionalExpression(node)) { displayExpression(node.whenTrue); displayExpression(node.whenFalse); }
    else if (ts.isParenthesizedExpression(node)) displayExpression(node.expression);
    else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) displayExpression(node.right);
      else if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind)) {
        displayExpression(node.left); displayExpression(node.right);
      }
    }
  }
  function visit(node) {
    if (ts.isJsxText(node)) candidate(node, node.text, 'text');
    if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.text) && node.initializer && ts.isStringLiteral(node.initializer)) {
      candidate(node, node.initializer.text, node.name.text);
    }
    if (ts.isPropertyAssignment(node) && ['label', 'title', 'hint', 'body'].includes(node.name.getText(ast)) && ts.isStringLiteral(node.initializer)) {
      if (!/^(?:ui|common|shop|opening|collection|arena|services|errors|catalog|leaderboard|nav|market|screens|staking|quests|admin|legal|profile|pass)\./.test(node.initializer.text)) candidate(node, node.initializer.text, 'message');
    }
    // Template literals in notifications were missed by the original JSX-only scan.
    if (ts.isPropertyAssignment(node) && ['label', 'title', 'hint', 'body'].includes(node.name.getText(ast)) && ts.isTemplateExpression(node.initializer)) {
      const parts = [node.initializer.head.text, ...node.initializer.templateSpans.map((s) => s.literal.text)].join(' {…} ');
      candidate(node, parts, 'template-message');
    }
    // Inspect display expressions, but not conditions, class names or translation-key arguments.
    // This catches labels that appear only after selecting a recipe, not on an empty bench.
    if (ts.isJsxExpression(node) && node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent) ||
       (ts.isJsxAttribute(node.parent) && visibleAttributes.has(node.parent.name.text)))) {
      displayExpression(node.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
if (process.argv.includes('--json')) console.log(JSON.stringify(candidates, null, 2));
else {
  console.log(`# Unlocalized-text candidates: ${candidates.length}\n\nThis is a review queue, not a failure count. It includes technical labels; it cannot find every dynamic API message.\n`);
  for (const c of candidates) console.log(`- \`${c.file}:${c.line}\` (${c.kind}) — ${c.text.replaceAll('|', '\\|')}`);
}
