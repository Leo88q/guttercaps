import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

it('feature views do not reintroduce fixed decimal strings or implicit browser locales', () => {
  const root = path.resolve(process.cwd(), process.cwd().endsWith('/client') ? 'src/features' : 'client/src/features');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(f => /\.tsx?$/.test(f) && !f.includes('.test.'));
  const violations: string[] = [];
  for (const file of files) {
    const tree = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(n: ts.Node) {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        if (method === 'toFixed' || (/^toLocale(?:DateString|TimeString|String)$/.test(method) && (!n.arguments.length || n.arguments[0].getText(tree) === 'undefined'))) {
          violations.push(`${file}:${tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1}: ${n.getText(tree)}`);
        }
      }
      if (ts.isNewExpression(n) && /^Intl\.(NumberFormat|DateTimeFormat)$/.test(n.expression.getText(tree)) && (!n.arguments?.length || n.arguments[0].getText(tree) === 'undefined')) violations.push(`${file}: implicit Intl locale`);
      ts.forEachChild(n, visit);
    }
    visit(tree);
  }
  expect(files.length).toBeGreaterThan(20);
  expect(violations).toEqual([]);
});
