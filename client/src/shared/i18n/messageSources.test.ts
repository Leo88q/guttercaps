import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

it('notification producers do not freeze translations or locale-formatted amounts', () => {
  const root = path.resolve(process.cwd(), process.cwd().endsWith('/client') ? 'src' : 'client/src');
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name))
      : /\.tsx?$/.test(e.name) && !e.name.includes('.test.') ? [path.join(dir, e.name)] : []);
  }
  const violations: string[] = [];
  let sites = 0;
  for (const file of files(root)) {
    const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function check(n: ts.Node) {
      if (ts.isCallExpression(n) && /^(t|fmt\w+|phaseLabel|leagueName|chipName|rarityName)$/.test(n.expression.getText(tree))) {
        violations.push(`${path.relative(root, file)}:${tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1}: ${n.getText(tree)}`);
      }
      ts.forEachChild(n, check);
    }
    function visit(n: ts.Node) {
      if (ts.isCallExpression(n) && ['toast', 'ui.toast'].includes(n.expression.getText(tree))) {
        const arg = n.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          sites++;
          for (const p of arg.properties) if (ts.isPropertyAssignment(p) && ['title', 'body'].includes(p.name.getText(tree))) check(p.initializer);
        }
      }
      ts.forEachChild(n, visit);
    }
    visit(tree);
  }
  expect(sites).toBeGreaterThan(60);
  expect(violations).toEqual([]);
});
