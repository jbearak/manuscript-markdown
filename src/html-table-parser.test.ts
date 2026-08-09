import { describe, expect, test } from 'bun:test';
import { extractHtmlTables } from './html-table-parser';

describe('HTML table metadata', () => {
  test('parses shared numeric attributes', () => {
    const [table] = extractHtmlTables('<table data-digits="2" data-decimal-mark="midpoint" data-digit-grouping="thin-space"><tr><td>1</td></tr></table>');
    expect(table).toMatchObject({
      digits: 2,
      decimalMark: 'midpoint',
      digitGrouping: 'thin-space',
    });
  });

  test('keeps citation-like text inside code elements literal', () => {
    const [table] = extractHtmlTables('<table><tr><td><code>@smith</code> @jones</td></tr></table>');
    expect(table.rows[0].cells[0].runs).toEqual([
      { type: 'text', text: '@smith', code: true },
      { type: 'text', text: ' ' },
      { type: 'citation', text: 'jones', keys: ['jones'], narrative: true },
    ]);
  });

  test('keeps citation-like script and style raw text literal', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td>'
      + '<script>@script</script><style>@style</style> @visible'
      + '</td></tr></table>',
    );
    const runs = table.rows[0].cells[0].runs;
    expect(runs.filter(run => run.type === 'citation')).toEqual([{
      type: 'citation',
      text: 'visible',
      keys: ['visible'],
      narrative: true,
    }]);
    expect(
      runs.filter(run => run.type === 'text').map(run => run.text).join(''),
    ).toBe('@script@style ');
  });

  test('preserves literal provenance for GFM-disallowed raw HTML text', () => {
    const literal = '<em>@hidden</em><!-- note -->';
    const literalCharacters = [...literal].flatMap((value, offset) => (
      value === '@' || value === '<' || value === '>'
        ? [{ offset, value }]
        : []
    ));
    for (const tag of [
      'title', 'textarea', 'style', 'xmp', 'iframe',
      'noembed', 'noframes', 'script', 'plaintext',
    ]) {
      const [table] = extractHtmlTables(
        '<table><tr><td><' + tag + '>' + literal + '</' + tag
        + '> @visible</td></tr></table>',
      );
      expect(table.rows[0].cells[0].runs).toEqual([
        {
          type: 'text',
          text: literal,
          literalCharacters,
        },
        { type: 'text', text: ' ' },
        { type: 'citation', text: 'visible', keys: ['visible'], narrative: true },
      ]);
    }
  });

  test('requires matching raw-text element closers before citations resume', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td><script>@hidden</style> @wrong</script></td></tr></table>',
    );
    const runs = table.rows[0].cells[0].runs;
    expect(runs.some(run => run.type === 'citation')).toBe(false);
    expect(runs.map(run => run.text).join('')).toBe('@hidden</style> @wrong');
  });

  test('treats tag-like script and style raw text as literal content', () => {
    for (const tag of ['script', 'style']) {
      const [table] = extractHtmlTables(
        '<table><tr><td><' + tag + '><em>@hidden</em></' + tag + '> @visible</td></tr></table>',
      );
      const runs = table.rows[0].cells[0].runs;
      expect(runs.filter(run => run.type === 'citation').map(run => run.keys))
        .toEqual([['visible']]);
      expect(runs.filter(run => run.type === 'text').map(run => run.text).join(''))
        .toBe('<em>@hidden</em> ');
      expect(runs.some(run => run.italic)).toBe(false);
    }
  });

  test('does not close script raw text at malformed end-tag syntax', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td><script>@hidden</ script> @wrong</script> @visible</td></tr></table>',
    );
    const runs = table.rows[0].cells[0].runs;
    expect(runs.filter(run => run.type === 'citation').map(run => run.keys))
      .toEqual([['visible']]);
    expect(runs.filter(run => run.type === 'text').map(run => run.text).join(''))
      .toBe('@hidden</ script> @wrong ');
  });

  test('does not treat structural closers inside raw text as tags', () => {
    for (const tag of ['script', 'style']) {
      const [table] = extractHtmlTables(
        '<table><tr><td><' + tag + '>'
        + '"</td></tr></table>"'
        + '</' + tag + '>after</td></tr></table>',
      );
      expect(table.rows[0].cells[0].runs.map(run => run.text).join(''))
        .toBe('"</td></tr></table>"after');
    }
  });

  test('treats self-closing code syntax as a non-void opening tag', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td><code/>@hidden</code> @visible</td></tr></table>',
    );
    expect(table.rows[0].cells[0].runs).toEqual([
      { type: 'text', text: '@hidden', code: true },
      { type: 'text', text: ' ' },
      { type: 'citation', text: 'visible', keys: ['visible'], narrative: true },
    ]);
  });

  test('does not treat table, row, or cell closers inside comments as structural', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td>'
      + '<!-- </td></tr></table> -->after'
      + '</td></tr></table>',
    );
    expect(table.rows[0].cells[0].runs).toEqual([
      { type: 'text', text: 'after' },
    ]);
    expect(extractHtmlTables(
      '<table><tr><td><!-- </td></tr></table>',
    )).toEqual([]);
  });

  test('does not join a citekey across removed tags', () => {
    const literal = '[@al<em></em>pha, p. 2]';
    const [table] = extractHtmlTables(
      '<table><tr><td>' + literal + '</td></tr></table>',
    );
    const runs = table.rows[0].cells[0].runs;
    expect(runs.some(run => run.type === 'citation')).toBe(false);
    expect(runs.map(run => run.text).join('')).toBe('[@alpha, p. 2]');
  });

  test('finds citations in decoded visible cell text', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td>[@smith, p.&nbsp;20]</td></tr></table>',
    );
    expect(table.rows[0].cells[0].runs).toEqual([{
      type: 'citation',
      text: 'smith, p. 20',
      keys: ['smith'],
      locators: new Map([['smith', 'p. 20']]),
    }]);
  });

  test('keeps entity-derived angle brackets as literal locator text', () => {
    for (const { source, locator } of [
      {
        source: '[@smith, &lt;x&gt;2&lt;/x&gt;]',
        locator: '<x>2</x>',
      },
      {
        source: '[@smith, &lt;!-- note --&gt;2]',
        locator: '<!-- note -->2',
      },
    ]) {
      const [table] = extractHtmlTables(
        '<table><tr><td>' + source + '</td></tr></table>',
      );
      const [run] = table.rows[0].cells[0].runs;
      expect(run).toMatchObject({
        type: 'citation',
        text: 'smith, ' + locator,
        keys: ['smith'],
        locators: new Map([['smith', locator]]),
      });
      expect(run.literalCharacters).toEqual(
        [...locator].flatMap((value, offset) => value === '<' || value === '>'
          ? [{ offset: 'smith, '.length + offset, value }]
          : []),
      );
    }
  });

  test('retains repeated citation occurrence metadata across internal markup', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td>'
      + '[@smith, p. 1; <em>-@smith, p. 2</em>]'
      + '</td></tr></table>',
    );
    expect(table.rows[0].cells[0].runs).toEqual([{
      type: 'citation',
      text: 'smith, p. 1; -@smith, p. 2',
      keys: ['smith', 'smith'],
      locators: new Map([['smith', 'p. 2']]),
      suppressAuthorKeys: new Set(['smith']),
      citationItems: [
        { key: 'smith', locator: 'p. 1', suppressAuthor: false },
        { key: 'smith', locator: 'p. 2', suppressAuthor: true },
      ],
    }]);
  });

  test('canonicalizes formatting tags inside atomic citations', () => {
    const [opening] = extractHtmlTables(
      '<table><tr><td><em>[@alpha</em>; @beta]</td></tr></table>',
    );
    expect(opening.rows[0].cells[0].runs).toEqual([{
      type: 'citation',
      text: 'alpha; @beta',
      keys: ['alpha', 'beta'],
      italic: true,
    }]);

    const [closing] = extractHtmlTables(
      '<table><tr><td>[@alpha; <em>@beta] inside</em></td></tr></table>',
    );
    expect(closing.rows[0].cells[0].runs).toEqual([
      {
        type: 'citation',
        text: 'alpha; @beta',
        keys: ['alpha', 'beta'],
      },
      { type: 'text', text: ' inside', italic: true },
    ]);

    const [suppressed] = extractHtmlTables(
      '<table><tr><td>[<em>-@alpha</em>]</td></tr></table>',
    );
    expect(suppressed.rows[0].cells[0].runs).toEqual([{
      type: 'citation',
      text: '-@alpha',
      keys: ['alpha'],
      suppressAuthorKeys: new Set(['alpha']),
    }]);
  });

  test('keeps nested same-tag formatting depth across an atomic citation', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td>'
      + '<em>[@alpha; <em>@beta] inner</em> outer</em>'
      + '</td></tr></table>',
    );
    expect(table.rows[0].cells[0].runs).toEqual([
      {
        type: 'citation',
        text: 'alpha; @beta',
        keys: ['alpha', 'beta'],
        italic: true,
      },
      { type: 'text', text: ' inner', italic: true },
      { type: 'text', text: ' outer', italic: true },
    ]);
  });

  test('looks through inline tags when excluding visible emails', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td>'
      + 'contact<em>@example</em>.com'
      + '</td></tr></table>',
    );
    const runs = table.rows[0].cells[0].runs;
    expect(runs.some(run => run.type === 'citation')).toBe(false);
    expect(runs.map(run => run.text).join('')).toBe(
      'contact@example.com',
    );
  });

  test('keeps citations in quoted tag attributes inert', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td>'
      + '<span title="x > @hidden">text</span> @visible'
      + '</td></tr></table>',
    );
    expect(
      table.rows[0].cells[0].runs
        .filter(run => run.type === 'citation')
        .map(run => run.keys),
    ).toEqual([['visible']]);
  });

  test('projects malformed tag candidates in linear time', () => {
    const elapsed = (count: number): number => {
      const source = '<a'.repeat(count) + ' @visible';
      const started = performance.now();
      const [table] = extractHtmlTables(
        '<table><tr><td>' + source + '</td></tr></table>',
      );
      expect(
        table.rows[0].cells[0].runs
          .some(run => run.type === 'citation'),
      ).toBe(true);
      return performance.now() - started;
    };
    const small = elapsed(20_000);
    const large = elapsed(80_000);
    expect(large).toBeLessThan(2_000);
    expect(large).toBeLessThan(small * 6 + 50);
  });

  test('matches table rows and cells without rescanning all tokens per row', () => {
    const elapsed = (count: number): number => {
      const rows = '<tr><td>x</td></tr>'.repeat(count);
      const started = performance.now();
      const [table] = extractHtmlTables('<table>' + rows + '</table>');
      expect(table.rows).toHaveLength(count);
      return performance.now() - started;
    };
    elapsed(200);
    const small = elapsed(2_000);
    const large = elapsed(8_000);
    expect(large).toBeLessThan(2_000);
    expect(large).toBeLessThan(small * 8 + 100);
  });

  test('preserves authored citation syntax in cell source display text', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td data-mm-kind="number">[@alpha] and @beta</td></tr></table>',
    );
    expect(table.rows[0].cells[0].source).toEqual({
      kind: 'number',
      display: '[@alpha] and @beta',
    });
  });

  test('keeps literal PUA while restoring entity-derived citation metadata', () => {
    const pua = '￼';
    const [table] = extractHtmlTables(
      '<table><tr><td data-mm-kind="identifier">'
      + pua + ' [@smith, &#64;page &lt;em&gt;x&lt;/em&gt;]'
      + '</td></tr></table>',
    );
    const cell = table.rows[0].cells[0];
    expect(cell.source?.display).toBe(
      pua + ' [@smith, @page <em>x</em>]',
    );
    expect(cell.runs[0]).toEqual({ type: 'text', text: pua + ' ' });
    expect(cell.runs[1]).toMatchObject({
      type: 'citation',
      text: 'smith, @page <em>x</em>',
      keys: ['smith'],
      locators: new Map([['smith', '@page <em>x</em>']]),
    });
  });

  test('keeps entity-derived at-signs citation-inert with literal provenance', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td>&#64;smith @jones</td></tr></table>',
    );
    expect(table.rows[0].cells[0].runs).toEqual([
      {
        type: 'text',
        text: '@smith ',
        literalCharacters: [{ offset: 0, value: '@' }],
      },
      { type: 'citation', text: 'jones', keys: ['jones'], narrative: true },
    ]);
  });

  test('keeps data-embed-idx cell citations literal', () => {
    const [table] = extractHtmlTables(
      '<table data-embed-idx="0"><tr><td>@smith [@jones]</td></tr></table>',
    );
    expect(table.embedIdx).toBe(0);
    expect(table.rows[0].cells[0].runs).toEqual([{
      type: 'text',
      text: '@smith [@jones]',
      literalCharacters: [
        { offset: 0, value: '@' },
        { offset: 8, value: '@' },
      ],
    }]);
  });

  test('preserves code whitespace in runs and source display metadata', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td data-mm-kind="identifier"><code>A  B</code></td></tr></table>',
    );
    expect(table.rows[0].cells[0].runs).toEqual([
      { type: 'text', text: 'A  B', code: true },
    ]);
    expect(table.rows[0].cells[0].source?.display).toBe('A  B');
  });

  test('does not manufacture CriticMarkup adjacency across removed tags', () => {
    const [table] = extractHtmlTables(
      '<table><tr><td>@alpha--<em></em>}</td></tr></table>',
    );
    const runs = table.rows[0].cells[0].runs;
    expect(runs.some(run => run.type === 'citation')).toBe(false);
    expect(runs.map(run => run.text).join('')).toBe('@alpha--}');
  });

  test('accepts only exact cell source kinds', () => {
    const [table] = extractHtmlTables('<table><tr><td data-mm-kind="number" data-mm-raw="12">12</td><td data-mm-kind="NUMBER">12</td><td data-mm-kind=" number ">12</td><td data-mm-kind="unknown">12</td></tr></table>');
    expect(table.rows[0].cells[0].source).toMatchObject({ kind: 'number', rawValue: 12 });
    expect(table.rows[0].cells[1].source).toBeUndefined();
    expect(table.rows[0].cells[2].source).toBeUndefined();
    expect(table.rows[0].cells[3].source).toBeUndefined();
  });
});
