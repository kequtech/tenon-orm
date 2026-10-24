import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { renderValue } from '../src/safeql/composition.js';

async function compositions(source: string): Promise<Map<string, string | Error>> {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-composition-'));
  const file = join(directory, 'queries.ts');
  try {
    await writeFile(
      file,
      `import { sql, identifier, type SqlFragment } from ${JSON.stringify(resolve('dist/index.js'))};\n${source}`,
    );
    const program = ts.createProgram([file], {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
    });
    const checker = program.getTypeChecker();
    const results = new Map<string, string | Error>();
    function visit(node: ts.Node): void {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText().startsWith('query') &&
        node.initializer &&
        ts.isTaggedTemplateExpression(node.initializer)
      ) {
        const template = node.initializer.template;
        assert.ok(ts.isTemplateExpression(template));
        try {
          results.set(
            node.name.getText(),
            template.templateSpans.map((span) => renderValue(span.expression, checker)).join(''),
          );
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          results.set(node.name.getText(), error);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(program.getSourceFile(file)!);
    return results;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('constant fragments, literal joins, identifiers, and complete query functions remain checkable', async () => {
  const results = await compositions(`
    const column = identifier('users', 'id');
    const active = sql.fragment\`active = \${true}\`;
    const alias = active;
    const queryConstant = sql\`\${sql.fragment\`\${column} > \${0} AND (\${alias})\`}\`;
    const queryJoin = sql\`\${sql.join([active, sql.fragment\`name = \${'x'}\`], 'AND')}\`;
    function completeQuery(id: number) {
      const predicate = sql.fragment\`id = \${id}\`;
      const queryWithin = sql\`\${predicate}\`;
      return queryWithin;
    }
    const queryScalar = sql\`\${Math.random() ? 'one' : 'two'}\`;
  `);
  assert.deepEqual(Object.fromEntries(results), {
    queryConstant: '"users"."id" > $N AND (active = $N)',
    queryJoin: 'active = $N AND name = $N',
    queryWithin: 'id = $N',
    queryScalar: '$N',
  });
});

test('fragment factories and conditional structure are rejected without inspecting function bodies', async () => {
  const results = await compositions(`
    const simple = () => sql.fragment\`TRUE\`;
    function defaults(enabled = true) {
      return enabled ? sql.fragment\`TRUE\` : sql.fragment\`FALSE\`;
    }
    function sideEffect(enabled = true) {
      const ignored = (enabled = false);
      return enabled ? sql.fragment\`TRUE\` : sql.fragment\`missing_column = 1\`;
    }
    const querySimple = sql\`\${simple()}\`;
    const queryDefault = sql\`\${defaults()}\`;
    const querySideEffect = sql\`\${sideEffect()}\`;
    const queryConditional = sql\`\${true ? sql.fragment\`TRUE\` : sql.fragment\`FALSE\`}\`;
    const queryWrapped = sql\`\${sql.fragment\`(\${sideEffect()})\`}\`;
    const parts = [sql.fragment\`TRUE\`];
    const queryList = sql\`\${sql.join(parts, 'AND')}\`;
    const circular: SqlFragment = sql.fragment\`\${circular}\`;
    const queryCircular = sql\`\${circular}\`;
  `);
  assert.equal(results.size, 7);
  for (const [name, result] of results) {
    assert.ok(result instanceof Error, `${name}: ${result}`);
    assert.match(result.message, /Tenon cannot statically check this composition/);
  }
  assert.match((results.get('querySideEffect') as Error).message, /Function-generated fragments/);
  assert.match((results.get('queryCircular') as Error).message, /Circular fragment reference/);
});

test('official mutation helpers use literal shapes or explicit columns without interpreting data builders', async () => {
  const results = await compositions(`
    declare const rows: { name?: string; score?: number }[];
    declare const patch: { name?: string; score?: number };
    const queryInsert = sql\`\${sql.insertValues([{ name: 'one' }, { score: null }])}\`;
    const queryDefault = sql\`\${sql.insertValues({ name: undefined })}\`;
    const queryNoColumns = sql\`\${sql.insertValues({ name: 'x' }, undefined)}\`;
    const queryUpdate = sql\`\${sql.assignments({ name: 'x', score: undefined })}\`;
    const insert = sql.insertValues;
    const queryRows = sql\`\${insert(rows, ['name', 'score'])}\`;
    const queryPatch = sql\`\${sql.assignments(patch, ['name', 'score'])}\`;
    const queryOpaque = sql\`\${sql.insertValues(rows.map(row => ({ ...row })), ['name', 'score'])}\`;
    const queryUnknown = sql\`\${sql.insertValues(rows)}\`;
    const querySpread = sql\`\${sql.assignments({ ...patch })}\`;
    const columns = ['name'] as const;
    const queryColumns = sql\`\${sql.assignments(patch, columns)}\`;
    const queryEmpty = sql\`\${sql.insertValues([])}\`;
    const queryEmptyUpdate = sql\`\${sql.assignments({ name: undefined })}\`;
    const queryDuplicate = sql\`\${sql.assignments(patch, ['name', 'name'])}\`;
  `);
  assert.equal(results.get('queryInsert'), '("name", "score") VALUES ($N, DEFAULT), (DEFAULT, $N)');
  assert.equal(results.get('queryDefault'), 'DEFAULT VALUES');
  assert.equal(results.get('queryNoColumns'), '("name") VALUES ($N)');
  assert.equal(results.get('queryUpdate'), '"name" = $N');
  assert.equal(results.get('queryRows'), '("name", "score") VALUES ($N, $N)');
  assert.equal(results.get('queryPatch'), '"name" = $N, "score" = $N');
  assert.equal(results.get('queryOpaque'), results.get('queryRows'));
  for (const key of [
    'queryUnknown',
    'querySpread',
    'queryColumns',
    'queryEmpty',
    'queryEmptyUpdate',
    'queryDuplicate',
  ]) {
    assert.ok(results.get(key) instanceof Error, key);
  }
});
