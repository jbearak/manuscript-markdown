import { beforeAll, describe, expect, it } from 'bun:test';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPREAD_LIMIT_CASES } from './spread-limit.fixtures';

// A spread of a document's items into a call, as push(...runs), passes each
// as an argument, which Node, the extension's runtime, holds on its stack:
// past about 120,000 of them it threw RangeError: Maximum call stack size
// exceeded. Bun takes some 500,000, more than some cases can make in a
// test's time, so each runs under Node, from a bundle as esbuild.mjs builds
// the extension's, with a stack of 128 KB, which takes about 14,000, and
// inputs of 24,000 items.
const N = 24000;
const STACK_KB = 128;
// Processes the cases go between, as the slowest take some seconds each
const WORKERS = 4;

const expected: Record<string, string> = {
  'a highlight\'s tokens': String(2 * N),
  'the paragraphs a revision goes on over': String(N + 1),
  'a list\'s items': String(N),
  'a list item\'s items': String(N + 1),
  'a quote\'s paragraphs': String(N),
  'a paragraph\'s runs': String(2 * N - 1),
  'a list item\'s runs': String(2 * N - 1),
  'a deletion\'s comments': String(N),
  'the runs on a line with a comment\'s body': String(N),
  'the range markers in an addition with a comment\'s body': String(N),
  'the warnings of a table\'s numbers': String(N),
  'the warnings of a note\'s table\'s numbers': String(N),
  'the warnings of a note': '2',
  'a table\'s rows without its grid': String(N),
  'the URLs before an = before a highlight': String(N),
  'the URLs before a scheme whose host is struck': String(N + 1),
  'a document\'s links': String(N),
  'a pipe table\'s rows': String(N),
  'a grid table\'s rows': String(N),
  'a grid table\'s cell\'s lines': String(N),
  'the comments in a pipe table\'s header cell': String(N),
  'the comments in a pipe table\'s cell': String(N),
  'the comments in a grid table\'s cell': String(N),
  'the comments in an HTML table\'s cell': String(N),
  'the comments before a table\'s directive': String(N),
  'the comments before a tracked paragraph break': String(N),
  'the comments on an equation text follows': String(N),
  'the comments in a note': String(N),
  'the comments in a note before its next paragraph': String(N),
  'the comments in a note before its code': String(N),
  'the comments in a note before its equation': String(N),
  'the comments in a note before its table': String(N),
  'the comments on an equation in a note': String(N),
  'a table\'s rows to reflow': String(N + 2),
  'the ranges outside code to decorate': String(N),
  'the directives in a note': String(N),
  'the numbers in an HTML table\'s cell': String(N),
  'the alerts in a quote\'s paragraph': String(N + 1),
};

const node = Bun.which('node');

describe.skipIf(!node)('A document\'s items, more than a call takes arguments, under Node', () => {
  const results: Record<string, string> = {};

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spread-limit-'));
    try {
      const bundle = join(dir, 'cases.cjs');
      // Runs the cases named in ONLY, and writes what each gave, or its error
      const contents = 'import { SPREAD_LIMIT_CASES } from \'./spread-limit.fixtures\';\n'
        + '(async () => {\n'
        + '  const results = {};\n'
        + '  for (const name of JSON.parse(process.env.ONLY)) {\n'
        + '    try { results[name] = String(await SPREAD_LIMIT_CASES[name](Number(process.env.N))); } catch (e) { results[name] = String(e); }\n'
        + '  }\n'
        + '  process.stdout.write(JSON.stringify(results));\n'
        + '})();\n';
      await build({ stdin: { contents, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: bundle, logLevel: 'error' });
      const names = Object.keys(SPREAD_LIMIT_CASES);
      await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
        const only = names.filter((_name, k) => k % WORKERS === w);
        const proc = Bun.spawn([node!, '--stack-size=' + STACK_KB, bundle], {
          env: { ...process.env, N: String(N), ONLY: JSON.stringify(only) },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (!stdout) throw new Error('Node gave nothing: ' + stderr);
        Object.assign(results, JSON.parse(stdout));
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);

  it('has a summary to expect for each case', () => {
    expect(Object.keys(SPREAD_LIMIT_CASES).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const name of Object.keys(SPREAD_LIMIT_CASES)) {
    it('takes ' + name, () => {
      expect(results[name]).toBe(expected[name]);
    });
  }
});
