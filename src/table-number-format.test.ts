import { describe, expect, test } from 'bun:test';
import { applyTableNumberSourceEdits, formatTableNumbers, validateTableNumberFormat } from './table-number-format';
import { preprocessGridTables, preprocessGridTablesWithSourceMap } from './grid-table-preprocess';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { convertMdToDocx } from './md-to-docx';
import { convertDocx } from './converter';

describe('table number formatting', () => {
  test('rounds and pads pipe-table values while formatting separators independently', () => {
    const input = '| Value | Stat |\n| --- | --- |\n| 1234.5 | 12.3 (4.56) |';
    const result = formatTableNumbers(input, { digits: 2, decimalMark: 'midpoint', digitGrouping: 'thin-space' });
    expect(result.output).toContain('| 1\u202f234\u00b750 | 12\u00b730 (4\u00b756) |');
  });

  test('pads integer values with a point when no source decimal exists', () => {
    const result = formatTableNumbers('| V |\n| --- |\n| 12 |', { digits: 2 });
    expect(result.output).toContain('| 12.00 |');
  });

  test('rounds large textual integers without binary precision loss', () => {
    const result = formatTableNumbers('| V |\n| --- |\n| 9007199254740993.1 |', { digits: 0 });
    expect(result.output).toContain('| 9007199254740993 |');
  });

  test('per-table source independently cancels inherited digits', () => {
    const input = '<!-- table-digits: source -->\n| Value |\n| --- |\n| 12.30 |';
    const result = formatTableNumbers(input, { digits: 1, decimalMark: 'comma' });
    expect(result.output).toContain('| 12,30 |');
  });

  test('formats grid table placeholder data', () => {
    const grid = preprocessGridTables('+-------+\n| 12.30 |\n+-------+');
    const result = formatTableNumbers(grid, { decimalMark: 'midpoint' });
    const decoded = Buffer.from(result.output.match(/MANUSCRIPT_GRID_TABLE:([^ ]+)/)![1], 'base64').toString();
    expect(decoded).toContain('12\u00b730');
  });

  test('uses typed raw percent value for a digits override', () => {
    const html = '<table><tr><td data-mm-kind="percent" data-mm-raw="0.12345">12.35%</td></tr></table>';
    expect(formatTableNumbers(html, { digits: 1, decimalMark: 'midpoint' }).output).toContain('12\u00b73%');
  });

  test('handles typed scientific values at zero digits', () => {
    const html = '<table><tr><td data-mm-kind="scientific" data-mm-raw="12345">1.23E+4</td></tr></table>';
    expect(formatTableNumbers(html, { digits: 0 }).output).toContain('1E+4');
  });

  test('normalizes scientific mantissa when rounding carries', () => {
    const html = '<table><tr><td data-mm-kind="scientific" data-mm-raw="9990">9.99E+3</td></tr></table>';
    expect(formatTableNumbers(html, { digits: 1 }).output).toContain('1.0E+4');
  });

	test('retains scientific notation from number-kind sources and converts typed fractions', () => {
		const scientific = '<table><tr><td data-mm-kind="number" data-mm-raw="1e21">1E+21</td></tr></table>';
		expect(formatTableNumbers(scientific, { digits: 2 }).output).toContain('1.00E+21');
		const fraction = '<table><tr><td data-mm-kind="number" data-mm-raw="1.5">1 1/2</td></tr></table>';
		expect(formatTableNumbers(fraction, { digits: 2 }).output).toContain('1.50');
		const affixedFraction = '<table><tr><td data-mm-kind="currency" data-mm-raw="1.5">$1 1/2</td></tr></table>';
		expect(formatTableNumbers(affixedFraction, { digits: 2 }).output).toContain('$1.50');
		const negativeFraction = '<table><tr><td data-mm-kind="number" data-mm-raw="-1.5">-1 1/2</td></tr></table>';
		expect(formatTableNumbers(negativeFraction, { digits: 2 }).output).toContain('-1.50');
		const percentFraction = '<table><tr><td data-mm-kind="percent" data-mm-raw="0.005">1/2%</td></tr></table>';
		expect(formatTableNumbers(percentFraction, { digits: 2 }).output).toContain('0.50%');
		const rupeeFraction = '<table><tr><td data-mm-kind="currency" data-mm-raw="1.5">₹1 1/2</td></tr></table>';
		expect(formatTableNumbers(rupeeFraction, { digits: 2 }).output).toContain('₹1.50');
		const scaledFraction = '<table><tr><td data-mm-kind="number" data-mm-raw="1500" data-mm-format="# ?/?,&quot;K&quot;">1 1/2K</td></tr></table>';
		expect(formatTableNumbers(scaledFraction, { digits: 2 }).output).toContain('1.50K');
		const escapedFraction = '<table><tr><td data-mm-kind="number" data-mm-raw="1.5" data-mm-format="# ?/?\\K">1 1/2K</td></tr></table>';
		expect(formatTableNumbers(escapedFraction, { digits: 2 }).output).toContain('1.50K');
		const scientificPercent = '<table><tr><td data-mm-kind="percent" data-mm-raw="12.345">1.23E+03%</td></tr></table>';
		expect(formatTableNumbers(scientificPercent, { digits: 1 }).output).toContain('1.2E+3%');
		const thousands = '<table><tr><td data-mm-kind="number" data-mm-raw="1234" data-mm-format="0.0,&quot;K&quot;">1.2K</td></tr></table>';
		expect(formatTableNumbers(thousands, { digits: 2 }).output).toContain('1.23K');
		const negativeThousands = '<table><tr><td data-mm-kind="number" data-mm-raw="-1234" data-mm-format="0.0;(0.0,)">(1.2)</td></tr></table>';
		expect(formatTableNumbers(negativeThousands, { digits: 2 }).output).toContain('(1.23)');
		const suppressedSign = '<table><tr><td data-mm-kind="number" data-mm-raw="-12.3" data-mm-format="0.0;0.0">12.3</td></tr></table>';
		expect(formatTableNumbers(suppressedSign, { digits: 2 }).output).toContain('>12.30<');
		const conditional = '<table><tr><td data-mm-kind="number" data-mm-raw="50" data-mm-format="[&gt;=100]0.0,;[&lt;100]0.0">50.0</td></tr></table>';
		expect(formatTableNumbers(conditional, { digits: 2 }).output).toContain('>50.00<');
	});

  test('formats long fractional and scientific mantissas as single tokens', () => {
    const decimal = '<table><tr><td data-mm-kind="number" data-mm-raw="0.0000001">0.0000001</td></tr></table>';
    expect(formatTableNumbers(decimal, { digits: 8 }).output).toContain('0.00000010');
    const scientific = '<table><tr><td data-mm-kind="scientific" data-mm-raw="12345">1.2345E+4</td></tr></table>';
    expect(formatTableNumbers(scientific, { digits: 2 }).output).toContain('1.23E+4');
  });

  test('preserves parenthetical negative convention for typed percentages', () => {
    const html = '<table><tr><td data-mm-kind="percent" data-mm-raw="-0.12345">(12.35%)</td></tr></table>';
    expect(formatTableNumbers(html, { digits: 1 }).output).toContain('(12.3%)');
  });

	test('preserves prefix and spaced percentage affixes', () => {
		const typedSuffix = '<table><tr><td data-mm-kind="percent" data-mm-raw="0.1235">12.35 %</td></tr></table>';
		expect(formatTableNumbers(typedSuffix, { digits: 1, decimalMark: 'midpoint' }).output).toContain('12\u00b74 %');
		const typedPrefix = '<table><tr><td data-mm-kind="percent" data-mm-raw="0.1235">%12.35</td></tr></table>';
		expect(formatTableNumbers(typedPrefix, { digits: 1, decimalMark: 'midpoint' }).output).toContain('%12\u00b74');
		const markdown = '| Percent |\n| --- |\n| 12.30\u00a0% |';
		expect(formatTableNumbers(markdown, { digits: 1, decimalMark: 'midpoint' }).output).toContain('12\u00b73\u00a0%');
	});

  test('preserves trailing-minus convention for typed negatives', () => {
    const html = '<table><tr><td data-mm-kind="number" data-mm-raw="-12.34">12.34-</td></tr></table>';
    expect(formatTableNumbers(html, { digits: 1 }).output).toContain('12.3-');
  });

  test('honors HTML table data attributes over document defaults', () => {
    const html = '<table data-digits="1"><tr><td>12.34</td></tr></table>';
    expect(formatTableNumbers(html, { digits: 3 }).output).toContain('12.3');
    expect(formatTableNumbers('<table data-digits=1><tr><td>12.34</td></tr></table>', { digits: 3 }).output).toContain('12.3');
  });

  test('applies all HTML table number-format attributes together', () => {
    const html = '<table data-digits="2" data-decimal-mark="midpoint" data-digit-grouping="thin-space"><tr><td>1234.5</td></tr></table>';
    expect(formatTableNumbers(html, {}).output).toContain('>1 234·50<');
  });

  test('uses typed source format to disambiguate grouping-only changes', () => {
    const html = '<table><tr><td data-mm-kind="number" data-mm-raw="1234" data-mm-format="#,##0">1,234</td></tr></table>';
    expect(formatTableNumbers(html, { digitGrouping: 'none' }).output).toContain('>1234<');
  });

  test('disambiguates period grouping and three-digit comma decimals from raw values', () => {
    const grouped = '<table><tr><td data-mm-kind="number" data-mm-raw="1234" data-mm-format="#.##0">1.234</td></tr></table>';
    expect(formatTableNumbers(grouped, { digitGrouping: 'none' }).output).toContain('>1234<');
    const decimal = '<table><tr><td data-mm-kind="number" data-mm-raw="1.234" data-mm-format="0,000">1,234</td></tr></table>';
    expect(formatTableNumbers(decimal, { digits: 2 }).output).toContain('>1,23<');
  });

  test('preserves dates, identifiers, and labels', () => {
    const html = '<table><tr><td data-mm-kind="date">1/2/2024</td><td data-mm-kind="identifier">00123</td><td data-mm-kind="label">123</td></tr></table>';
    const output = formatTableNumbers(html, { digits: 2, decimalMark: 'midpoint' }).output;
    expect(output).toContain('>1/2/2024<');
    expect(output).toContain('>00123<');
    expect(output).toContain('>123<');
    expect(formatTableNumbers('| V |\n| --- |\n| 00123 |', { digits: 2 }).output).toContain('00123');
  });

	test('formats styled Markdown and inline HTML numeric cells without dropping markup', () => {
    const markdown = '| V |\n| --- |\n| **12.30** |';
    expect(formatTableNumbers(markdown, { decimalMark: 'midpoint' }).output).toContain('**12\u00b730**');
    const html = '<table><tr><td><em>12.30</em></td><td><p>4.50</p></td></tr></table>';
    const output = formatTableNumbers(html, { decimalMark: 'midpoint' }).output;
    expect(output).toContain('<em>12\u00b730</em>');
		expect(output).toContain('<p>4\u00b750</p>');
  });

  test('preserves HTML structure, attributes, mixed cell tags, and line layout', () => {
    const html = '<table id="t" data-digits="1">\n<caption>Results</caption>\n<tr class="r"><th scope="row">A</th><td class="n" style="color:red"><span>12.34</span></td></tr>\n</table>';
    const output = formatTableNumbers(html).output;
    expect(output).toContain('<table id="t" data-digits="1">\n<caption>Results</caption>');
    expect(output).toContain('<tr class="r"><th scope="row">A</th><td class="n" style="color:red"><span>12.3</span></td></tr>');
    expect(output.split('\n')).toHaveLength(html.split('\n').length);
  });

	test('handles angle brackets inside quoted HTML attributes', () => {
		const html = '<table title="a < b > c" data-digits="1"><tr><td title="c > d < e" data-mm-kind="number" data-mm-raw="12.36">12.34</td></tr></table>';
		expect(formatTableNumbers(html, {}).output)
			.toBe('<table title="a < b > c" data-digits="1"><tr><td title="c > d < e" data-mm-kind="number" data-mm-raw="12.36">12.4</td></tr></table>');
	});

  test('preserves and formats multiple HTML tables on one line', () => {
    const html = '<table><tr><td>1.20</td></tr></table> x <table><tr><td>4.50</td></tr></table>';
    const output = formatTableNumbers(html, { decimalMark: 'midpoint' }).output;
    expect(output).toContain('1\u00b720');
    expect(output).toContain(' x ');
    expect(output).toContain('4\u00b750');
  });

  test('formats multi-run statistical cells and preserves times', () => {
    const html = '<table><tr><td>$<strong>12.30</strong> (4.50)</td></tr></table>';
    const output = formatTableNumbers(html, { decimalMark: 'midpoint' }).output;
    expect(output).toContain('$<strong>12\u00b730</strong> (4\u00b750)');
    const time = '| Time |\n| --- |\n| 12:30 |';
    expect(formatTableNumbers(time, { digits: 2, decimalMark: 'midpoint' }).output).toContain('12:30');
  });

	test('formats numeric tokens across HTML runs without changing repeated runs', () => {
		const split = '<table><tr><td><strong>12</strong>.<em>3456</em></td></tr></table>';
		expect(formatTableNumbers(split, { digits: 2 }).output).toContain('<strong>12</strong>.<em>35</em>');
		const repeated = '<table><tr><td><strong>12.3</strong> / <em>12.3</em></td></tr></table>';
		const output = formatTableNumbers(repeated, { digits: 2 }).output;
		expect(output).toContain('<strong>12.30</strong> / <em>12.30</em>');
	});

	test('keeps inserted typed negative signs in the numeric inline run', () => {
		const html = '<table><tr><td data-mm-kind="currency" data-mm-raw="-12.34">'
			+ '<span>$</span><strong>12.34</strong></td></tr></table>';
		expect(formatTableNumbers(html, { digits: 1 }).output)
			.toBe('<table><tr><td data-mm-kind="currency" data-mm-raw="-12.34">'
				+ '<span>$</span><strong>-12.3</strong></td></tr></table>');
	});

	test('does not join numbers across HTML break or block boundaries', () => {
		const breaks = '<table><tr><td>12<br>34</td><td><p>12</p>34</td><td><h1>12</h1><h2>34</h2></td></tr></table>';
		const output = formatTableNumbers(breaks, { digits: 2, digitGrouping: 'comma' }).output;
		expect(output).toContain('12.00<br>34.00');
		expect(output).not.toContain('1,234');
	});

	test('does not format numeric-looking content in inert HTML elements', () => {
		for (const tag of ['script', 'style', 'textarea', 'template', 'title', 'xmp', 'iframe', 'noembed', 'noframes',
			'plaintext', 'pre', 'sup', 'sub']) {
			const html = '<table><tr><td><' + tag + '>[12.34]</' + tag + '></td></tr></table>';
			expect(formatTableNumbers(html, { digits: 1 }).output).toBe(html);
		}
	});

	test('ignores table text inside HTML comments', () => {
		for (const prefix of ['<!-- mention <table> here -->', '<!--\n<table>\n-->', '`<table>`', 'Text mentioning <table without a tag',
			'<script>\nconst marker = "<table";\n</script>']) {
			const markdown = prefix + '\n\n| V |\n| --- |\n| 12.30 |';
			expect(formatTableNumbers(markdown, { decimalMark: 'midpoint' }).output).toContain('| 12\u00b730 |');
		}
	});

	test('keeps CDATA, processing instructions, and declarations inert', () => {
		const payload = [
			'<!-- table-digits: nope -->',
			'| Value |',
			'| --- |',
			'| 12.34 |',
			'<table><tr><td>56.78</td></tr></table>',
		].join('\n');
		const complete = [
			'<![CDATA[\n' + payload + '\n]]>',
			'<?target\n' + payload + '\n?>',
			'<!DECL "' + payload + '">',
		];
		for (const inert of complete) {
			const valid = '| Real |\n| --- |\n| 90.12 |';
			const result = formatTableNumbers(inert + '\n' + valid, { digits: 1 });
			expect(result.output).toStartWith(inert);
			expect(result.output).toEndWith('| 90.1 |');
			expect(result.warnings).toEqual([]);
		}
		for (const inert of [
			'<![CDATA[\n' + payload,
			'<?target\n' + payload,
			'<!DECL "' + payload,
		]) {
			const result = formatTableNumbers(inert, { digits: 1 });
			expect(result.output).toBe(inert);
			expect(result.warnings).toEqual([]);
		}
	});

	test('does not consume inert constructs as pipe-table continuation rows', () => {
		const table = '| Value |\n| --- |\n| 1.23 |';
		const complete = [
			'<![CDATA[ | 12.34 | ]]>',
			'<?target | 12.34 | ?>',
			'<!DECL "| 12.34 |">',
			'<!-- | 12.34 | -->',
			'<script>| 12.34 |</script>',
		];
		for (const inert of complete) {
			const result = formatTableNumbers(table + '\n' + inert, { digits: 1 });
			expect(result.output).toBe('| Value |\n| --- |\n| 1.2 |\n' + inert);
			expect(result.warnings).toEqual([]);
		}
		for (const inert of [
			'<![CDATA[ | 12.34 |',
			'<?target | 12.34 |',
			'<!DECL "| 12.34 |',
			'<!-- | 12.34 |',
			'<script>| 12.34 |',
		]) {
			const result = formatTableNumbers(table + '\n' + inert, { digits: 1 });
			expect(result.output).toBe('| Value |\n| --- |\n| 1.2 |\n' + inert);
			expect(result.warnings).toEqual([]);
		}
	});

	test('does not consume four-space-indented code as a pipe continuation row', () => {
		const input = '| Value |\n| --- |\n| 1.23 |\n    | 12.34 |';
		expect(formatTableNumbers(input, { digits: 1 }).output)
			.toBe('| Value |\n| --- |\n| 1.2 |\n    | 12.34 |');
	});

	test('does not underflow numeric inert depth on unmatched closing tags', () => {
		const html = '<table><tr><td></code>12.34</td><td><code>56.78</code>90.12</td></tr></table>';
		expect(formatTableNumbers(html, { digits: 1 }).output)
			.toBe('<table><tr><td></code>12.3</td><td><code>56.78</code>90.1</td></tr></table>');
	});

	test('matches numeric inert closing tags by name', () => {
		const html = '<table><tr>'
			+ '<td><code>hidden</pre>12.34</code>56.78</td>'
			+ '<td><pre>hidden</sub>12.34</pre>56.78</td>'
			+ '<td></code>12.34</pre>56.78</td>'
			+ '<td></pre>12.34</sub>56.78</td>'
			+ '</tr></table>';
		expect(formatTableNumbers(html, { digits: 1 }).output).toBe('<table><tr>'
			+ '<td><code>hidden</pre>12.34</code>56.8</td>'
			+ '<td><pre>hidden</sub>12.34</pre>56.8</td>'
			+ '<td></code>12.3</pre>56.8</td>'
			+ '<td></pre>12.3</sub>56.8</td>'
			+ '</tr></table>');
	});

	test('does not parse table markup inside raw-text HTML elements', () => {
		const html = '<table><tr><td><script>const x="<table><tr><td>1.2345</td></tr></table>";</script>12.34</td></tr></table>';
		const output = formatTableNumbers(html, { digits: 1 }).output;
		expect(output).toContain('<script>const x="<table><tr><td>1.2345</td></tr></table>";</script>');
		expect(output).toContain('</script>12.3');
		const commentedPipe = '<!--\n| V |\n| --- |\n| 12.34 |\n-->';
		expect(formatTableNumbers(commentedPipe, { digits: 1 }).output).toBe(commentedPipe);
		const multilineScript = '<script\n type="text/javascript">\nconst tpl = `\n<table><tr><td>1.2345</td></tr></table>\n`;\n</script>';
		expect(formatTableNumbers(multilineScript, { digits: 1 }).output).toBe(multilineScript);
		const sameLineClose = '<script>ignore</script><table data-digits="1"><tr><td>12.34</td></tr></table>';
		expect(formatTableNumbers(sameLineClose, { digits: 2 }).output).toContain('<td>12.3</td>');
		const prefixClose = '<table><tr><td><script>const x="</scripture><table><tr><td>99.9</td></tr></table>"</script>12.34</td></tr></table>';
		const prefixOutput = formatTableNumbers(prefixClose, { digits: 2 }).output;
		expect(prefixOutput).toContain('<td>99.9</td>');
		expect(prefixOutput).toContain('</script>12.34');
	});

	test('treats every GFM literal HTML element as structurally inert', () => {
		for (const tag of ['title', 'xmp', 'iframe', 'noembed', 'noframes']) {
			const inert = '<' + tag + '>\n`code`\n| Value |\n| --- |\n| 99.99 |\n'
				+ '<table><tr><td>88.88</td></tr></table>\n</' + tag + '>';
			const valid = '<table><tr><td>12.34</td></tr></table>';
			const output = formatTableNumbers(inert + '\n' + valid, { digits: 1 }).output;
			expect(output).toStartWith(inert);
			expect(output).toEndWith('<table><tr><td>12.3</td></tr></table>');
		}
		for (const tag of ['title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']) {
			const selfClosing = '<' + tag + '/><table><tr><td>12.34</td></tr></table>';
			expect(formatTableNumbers(selfClosing, { digits: 1 }).output)
				.toBe('<' + tag + '/><table><tr><td>12.3</td></tr></table>');
			const inCell = '<table><tr><td><' + tag + '/>12.34</td></tr></table>';
			expect(formatTableNumbers(inCell, { digits: 1 }).output)
				.toBe('<table><tr><td><' + tag + '/>12.3</td></tr></table>');
		}
		const plaintext = '<plaintext>\n`code`\n| Value |\n| --- |\n| 99.99 |\n'
			+ '<table><tr><td>88.88</td></tr></table>\n</plaintext>\n'
			+ '<table><tr><td>12.34</td></tr></table>';
		expect(formatTableNumbers(plaintext, { digits: 1 }).output).toBe(plaintext);
	});

	test('continues formatting pipe rows that contain inline code', () => {
		const markdown = '| V | Note |\n| --- | --- |\n| 12.34 | `x` |\n| 56.78 | ok |';
		const output = formatTableNumbers(markdown, { digits: 1 }).output;
		expect(output).toContain('| 12.3 | `x` |');
		expect(output).toContain('| 56.8 | ok |');
	});

	test('ignores fenced HTML table and cell tags inside a multiline table', () => {
		const fenced = [
			'<table>',
			'<tr><td>',
			'```html',
			'</td></tr></table>',
			'<table><tr><td>99.99</td></tr></table>',
			'<td>88.88</td>',
			'```',
			'12.34',
			'</td></tr>',
			'</table>',
		].join('\n');
		const output = formatTableNumbers(fenced, { digits: 1 }).output;
		expect(output).toContain('```html\n</td></tr></table>\n<table><tr><td>99.99</td></tr></table>\n<td>88.88</td>\n```');
		expect(output).toContain('```\n12.3\n</td></tr>');
	});

	test('ignores inline-code HTML tags inside a multiline table cell', () => {
		const markdown = [
			'<table>',
			'<tr><td>`</td></tr></table><table><tr><td>99.99</td></tr></table><td>88.88</td>` 12.34</td></tr>',
			'</table>',
		].join('\n');
		const output = formatTableNumbers(markdown, { digits: 1 }).output;
		expect(output).toContain('`</td></tr></table><table><tr><td>99.99</td></tr></table><td>88.88</td>` 12.3');
	});

	test('formats typed accounting zero placeholders', () => {
		const html = '<table><tr><td data-mm-kind="currency" data-mm-raw="0" data-mm-format="$#,##0.00;($#,##0.00);-">-</td></tr></table>';
		expect(formatTableNumbers(html, { digits: 2 }).output).toContain('$0.00');
		const percent = '<table><tr><td data-mm-kind="percent" data-mm-raw="0" data-mm-format="0.0%;(0.0%);-">-</td></tr></table>';
		expect(formatTableNumbers(percent, { digits: 2 }).output).toContain('0.00%');
		const suffixCurrency = '<table><tr><td data-mm-kind="currency" data-mm-raw="0" data-mm-format="#,##0.00 €;(#,##0.00 €);- €">- €</td></tr></table>';
		expect(formatTableNumbers(suffixCurrency, { digits: 2 }).output).toContain('0.00 €');
		const tightSuffix = '<table><tr><td data-mm-kind="currency" data-mm-raw="0" data-mm-format="0.00€;(0.00€);-€">-€</td></tr></table>';
		expect(formatTableNumbers(tightSuffix, { digits: 2 }).output).toContain('0.00€');
		const spacedPrefix = '<table><tr><td data-mm-kind="currency" data-mm-raw="0" data-mm-format="€ 0.00;(€ 0.00);€ -">€ -</td></tr></table>';
		expect(formatTableNumbers(spacedPrefix, { digits: 2 }).output).toContain('€ 0.00');
		const localeRupee = '<table><tr><td data-mm-kind="currency" data-mm-raw="0" data-mm-format="[$₹-en-IN]#,##0.00;([$₹-en-IN]#,##0.00);-">-</td></tr></table>';
		expect(formatTableNumbers(localeRupee, { digits: 2 }).output).toContain('₹0.00');
		const colored = '<table><tr><td data-mm-kind="number" data-mm-raw="0" data-mm-format="[RED]0.00;[RED]-0.00;[RED]-">-</td></tr></table>';
		expect(formatTableNumbers(colored, { digits: 2 }).output).toContain('>0.00<');
		const quotedScientific = '<table><tr><td data-mm-kind="number" data-mm-raw="0" data-mm-format="0&quot;E+00&quot;;-0&quot;E+00&quot;;-">-</td></tr></table>';
		expect(formatTableNumbers(quotedScientific, { digits: 2 }).output).toContain('>0.00<');
		const label = '<table><tr><td data-mm-kind="number" data-mm-raw="0">N/A -</td></tr></table>';
		expect(formatTableNumbers(label, { digits: 2 }).output).toBe(label);
	});

	test('formats nested tables without shifting later outer cells', () => {
		const html = '<table data-digits="1"><tr><td>12.34<table data-digits="3"><tr><td>4.5678</td></tr></table></td><td>6.78</td></tr></table>';
		const output = formatTableNumbers(html, { digits: 2 }).output;
		expect(output).toContain('12.3<table');
		expect(output).toContain('4.568');
		expect(output).toContain('<td>6.8</td>');
		const multiline = '<table data-digits="1">\n<tr><td>12.34\n<table data-digits="3">\n<tr><td>4.5678</td></tr>\n</table>\n</td><td>6.78</td></tr>\n</table>';
		const multilineOutput = formatTableNumbers(multiline, { digits: 2 }).output;
		expect(multilineOutput).toContain('12.3\n<table');
		expect(multilineOutput).toContain('4.568');
		expect(multilineOutput).toContain('<td>6.8</td>');
		const multilineOpening = '<table\n data-digits="1"><tr><td>12.34</td></tr></table>';
		expect(formatTableNumbers(multilineOpening, { digits: 2 }).output).toContain('<td>12.3</td>');
	});

	test('rejects malformed overlapping and out-of-owner cell ranges', () => {
		const overlapping = '<table><tr><td>1.23<td>4.56</td></td></tr></table>';
		expect(formatTableNumbers(overlapping, { digits: 1 }).output).toBe(overlapping);

		const outsideOwner = '<table><tr><td>12.34</table></td></tr>';
		expect(formatTableNumbers(outsideOwner, { digits: 1 }).output).toBe(outsideOwner);

		const balanced = '<table><tr><td>1.23</td><td>4.56</td></tr></table>';
		expect(formatTableNumbers(balanced, { digits: 1 }).output)
			.toBe('<table><tr><td>1.2</td><td>4.6</td></tr></table>');
	});

	test('recovers from a table opener missing its closing angle bracket', () => {
		const input = '<table\nmalformed source\n\n| Value |\n| --- |\n| 12.34 |';
		expect(formatTableNumbers(input, { digits: 1 }).output)
			.toBe('<table\nmalformed source\n\n| Value |\n| --- |\n| 12.3 |');
	});

	test('restarts malformed tag recovery at the next unquoted opener', () => {
		const input = '<table broken <table><tr><td>12.34</td></tr></table>';
		expect(formatTableNumbers(input, { digits: 1 }).output)
			.toBe('<table broken <table><tr><td>12.3</td></tr></table>');
	});

	test('recovers from an unclosed HTML table before a valid pipe table', () => {
		const input = '<table><tr><td>99.99</td></tr>\n\n| Value |\n| --- |\n| 12.34 |';
		expect(formatTableNumbers(input, { digits: 1 }).output)
			.toBe('<table><tr><td>99.99</td></tr>\n\n| Value |\n| --- |\n| 12.3 |');
	});

	test('formats complete same-line tables beside an unclosed sibling', () => {
		const completeFirst = '<table><tr><td>1.23</td></tr></table><table><tr><td>4.56</td></tr>';
		expect(formatTableNumbers(completeFirst, { digits: 1 }).output)
			.toBe('<table><tr><td>1.2</td></tr></table><table><tr><td>4.56</td></tr>');

		const completeLast = '<table><tr><td>1.23</td></tr><table><tr><td>4.56</td></tr></table>';
		expect(formatTableNumbers(completeLast, { digits: 1 }).output)
			.toBe('<table><tr><td>1.23</td></tr><table><tr><td>4.6</td></tr></table>');
	});

	test('recovers complete multiline tables beside unclosed siblings', () => {
		const unclosedFirst = '<table><tr><td>broken</td></tr><table>\n<tr><td>1.23</td></tr>\n</table>';
		expect(formatTableNumbers(unclosedFirst, { digits: 1 }).output)
			.toBe('<table><tr><td>broken</td></tr><table>\n<tr><td>1.2</td></tr>\n</table>');

		const unclosedLast = '<table>\n<tr><td>1.23</td></tr>\n</table><table><tr><td>broken</td></tr>';
		expect(formatTableNumbers(unclosedLast, { digits: 1 }).output)
			.toBe('<table>\n<tr><td>1.2</td></tr>\n</table><table><tr><td>broken</td></tr>');
	});

	test('collects a multiline outer table with a complete nested table on its opening line', () => {
		const input = '<!-- table-digits: 1 -->\n<table><tr><td><table><tr><td>1.23</td></tr></table></td>\n<td>4.56</td></tr></table>';
		expect(formatTableNumbers(input, {}).output)
			.toBe('<!-- table-digits: 1 -->\n<table><tr><td><table><tr><td>1.2</td></tr></table></td>\n<td>4.6</td></tr></table>');
	});

	test('preserves nonbreaking HTML source while formatting grouped values', () => {
		const entity = '<table><tr><td>1&nbsp;234.50&nbsp;$</td></tr></table>';
		const entityOutput = formatTableNumbers(entity, { digits: 1, decimalMark: 'midpoint' }).output;
		expect(entityOutput).toContain('1&nbsp;234\u00b75&nbsp;$');
		const narrow = '<table><tr><td>1\u202f234.50</td></tr></table>';
		expect(formatTableNumbers(narrow, { digits: 1 }).output).toContain('1\u202f234.5');
	});

	test('keeps surviving digits in their original HTML runs when grouping is removed', () => {
		const html = '<table><tr><td><b>1</b>&nbsp;<i>234</i>.50</td></tr></table>';
		const output = formatTableNumbers(html, { digitGrouping: 'none', decimalMark: 'midpoint' }).output;
		expect(output).toContain('<b>1</b><i>234</i>\u00b750');
	});

  test('rejects precision beyond the supported safety bound', () => {
    const result = formatTableNumbers('| V |\n| --- |\n| 1.2 |', { digits: 1001 as any });
    expect(result.output).toContain('1.2');
    expect(result.warnings[0]).toContain('table-digits');
  });

  test('separator-only override preserves source trailing zeroes', () => {
    const html = '<table><tr><td data-mm-kind="percent" data-mm-raw="0.123">12.30%</td></tr></table>';
    expect(formatTableNumbers(html, { decimalMark: 'midpoint' }).output).toContain('12\u00b730%');
  });

  test('leaves ambiguous punctuation unchanged and warns', () => {
    const input = '| Value |\n| --- |\n| 1.234 |';
    const result = formatTableNumbers(input, { decimalMark: 'comma' });
    expect(result.output).toContain('1.234');
    expect(result.warnings).toHaveLength(1);
  });

	test('leaves comma-separated lists unchanged and warns', () => {
		const input = '| Values |\n| --- |\n| 1,2,3 |';
		const result = formatTableNumbers(input, { digits: 2 });
		expect(result.output).toBe(input);
		expect(result.warnings).toHaveLength(1);
	});

  test('rejects identical decimal and grouping characters', () => {
    expect(validateTableNumberFormat({ decimalMark: 'point', digitGrouping: 'period' })).toBeTruthy();
    expect(validateTableNumberFormat({ decimalMark: 'comma', digitGrouping: 'comma' })).toBeTruthy();
  });

  test('rejects invalid per-table directives instead of inheriting defaults', () => {
    const pipe = '<!-- table-digits: nope -->\n| V |\n| --- |\n| 12.34 |';
    const pipeResult = formatTableNumbers(pipe, { digits: 1 });
    expect(pipeResult.output).toBe(pipe);
    expect(pipeResult.warnings).toContain('Invalid <!-- table-digits: nope --> directive ignored.');

    const html = '<!-- table-decimal-mark: invalid -->\n<table data-digits="1"><tr><td>12.34</td></tr></table>';
    const htmlResult = formatTableNumbers(html, { digits: 2 });
    expect(htmlResult.output).toBe(html);
    expect(htmlResult.warnings[0]).toContain('table-decimal-mark');
  });

  test('leaves source-separator collisions unchanged and warns', () => {
    const point = '| V |\n| --- |\n| 1,234.56 |';
    const pointResult = formatTableNumbers(point, { decimalMark: 'source', digitGrouping: 'period' });
    expect(pointResult.output).toBe(point);
    expect(pointResult.warnings[0]).toContain('Conflicting decimal and grouping separators');

    const comma = '| V |\n| --- |\n| 1.234,56 |';
    const commaResult = formatTableNumbers(comma, { decimalMark: 'point', digitGrouping: 'source' });
    expect(commaResult.output).toBe(comma);
    expect(commaResult.warnings[0]).toContain('Conflicting decimal and grouping separators');

    const short = '| V |\n| --- |\n| 12.34 |';
    const shortResult = formatTableNumbers(short, { digits: 1, decimalMark: 'source', digitGrouping: 'period' });
    expect(shortResult.output).toContain('| 12.3 |');
    expect(shortResult.warnings).toEqual([]);

    const integer = formatTableNumbers(point, { digits: 0, decimalMark: 'source', digitGrouping: 'period' });
    expect(integer.output).toContain('| 1.235 |');
    expect(integer.warnings).toEqual([]);

    for (const decimalMark of ['source', undefined] as const) {
      const paddedInteger = '| V |\n| --- |\n| 1234 |';
      const paddedResult = formatTableNumbers(paddedInteger, { digits: 2, decimalMark, digitGrouping: 'period' });
      expect(paddedResult.output).toBe(paddedInteger);
      expect(paddedResult.warnings[0]).toContain('Conflicting decimal and grouping separators');
      expect(paddedResult.warningDetails).toHaveLength(1);
    }
  });

  test('handles malformed numeric entities and very long numeric tokens safely', () => {
    const invalid = '<table><tr><td>&#1114112;</td><td>&#xD800;</td><td>&#999999999999;</td></tr></table>';
    expect(() => formatTableNumbers(invalid, { digits: 1 })).not.toThrow();

    // This exceeds the 1,000,000-cell diff-matrix cap without making the
    // regression depend on runner speed or a per-test timeout.
    const digits = '1'.repeat(2_000);
    const html = '<table><tr><td>' + digits + '</td></tr></table>';
    const result = formatTableNumbers(html, { digitGrouping: 'comma' });
    expect(result.output.length).toBeGreaterThan(html.length);
    expect(result.output).toContain(',');
  });

  test('preserves declared ordering for multiple insertions at one source offset', () => {
    expect(applyTableNumberSourceEdits('value', [
      { start: 0, end: 0, insert: 'A' },
      { start: 0, end: 0, insert: 'B' },
    ])).toBe('ABvalue');
  });

  test('performs one structural scan for an arbitrarily long unclosed table candidate', () => {
    const input = '<table><tr><td>99.99</td></tr>\n'
      + Array.from({ length: 4_000 }, (_, index) => 'malformed row ' + index).join('\n')
      + '\n\n| Value |\n| --- |\n| 12.34 |';
    const stats = { structuralScans: 0, structuralCharacters: 0, structuralTokens: 0, completedTables: 0,
      tableRangeVisits: 0, decodedPiecesMapped: 0, decodedRawCharactersMapped: 0,
      tableFormatVisits: 0, visibleTokenVisits: 0, visiblePieceSearches: 0, visiblePieceVisits: 0,
      sourceEditPasses: 0, sourceEditsApplied: 0, sourceCharactersCopied: 0,
      htmlTagCharactersVisited: 0, malformedTagRecoveries: 0 };
    const result = formatTableNumbers(input, { digits: 1 }, stats);
    expect(result.output).toEndWith('| 12.3 |');
    expect(stats.structuralScans).toBe(1);
    expect(stats.structuralCharacters).toBe(input.length);
    expect(stats.completedTables).toBe(0);
  });

  test('recovers repeated malformed tags with linear tokenizer work', () => {
    const malformedCount = 2_000;
    const valid = '<table title="a < b"><tr><td>12.34</td></tr></table>';
    const input = '<table broken '.repeat(malformedCount) + valid;
    const stats = { structuralScans: 0, structuralCharacters: 0, structuralTokens: 0, completedTables: 0,
      tableRangeVisits: 0, decodedPiecesMapped: 0, decodedRawCharactersMapped: 0,
      tableFormatVisits: 0, visibleTokenVisits: 0, visiblePieceSearches: 0, visiblePieceVisits: 0,
      sourceEditPasses: 0, sourceEditsApplied: 0, sourceCharactersCopied: 0,
      htmlTagCharactersVisited: 0, malformedTagRecoveries: 0 };
    const result = formatTableNumbers(input, { digits: 1 }, stats);
    expect(result.output).toEndWith('<table title="a < b"><tr><td>12.3</td></tr></table>');
    expect(stats.structuralScans).toBe(1);
    expect(stats.malformedTagRecoveries).toBe(malformedCount);
    expect(stats.htmlTagCharactersVisited).toBeLessThanOrEqual(input.length);
  });

  test('formats complete HTML tables without a fixed line limit', () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => '<tr><td>' + index + '.25</td></tr>');
    const input = '<table>\n' + rows.join('\n') + '\n</table>';
    const stats = { structuralScans: 0, structuralCharacters: 0, structuralTokens: 0, completedTables: 0,
      tableRangeVisits: 0, decodedPiecesMapped: 0, decodedRawCharactersMapped: 0,
      tableFormatVisits: 0, visibleTokenVisits: 0, visiblePieceSearches: 0, visiblePieceVisits: 0,
      sourceEditPasses: 0, sourceEditsApplied: 0, sourceCharactersCopied: 0,
      htmlTagCharactersVisited: 0, malformedTagRecoveries: 0 };
    const result = formatTableNumbers(input, { digits: 1 }, stats);
    expect(result.output).toContain('<tr><td>0.3</td></tr>');
    expect(result.output).toContain('<tr><td>4999.3</td></tr>');
    expect(stats).toMatchObject({ structuralScans: 1, structuralCharacters: input.length, completedTables: 1 });
  });

  test('selects many independent HTML tables without rescanning the global table list', () => {
    const tableCount = 2_048;
    const input = Array.from({ length: tableCount }, () => '<table><tr><td>1.25</td></tr></table>').join('\n');
    const stats = { structuralScans: 0, structuralCharacters: 0, structuralTokens: 0, completedTables: 0,
      tableRangeVisits: 0, decodedPiecesMapped: 0, decodedRawCharactersMapped: 0,
      tableFormatVisits: 0, visibleTokenVisits: 0, visiblePieceSearches: 0, visiblePieceVisits: 0,
      sourceEditPasses: 0, sourceEditsApplied: 0, sourceCharactersCopied: 0,
      htmlTagCharactersVisited: 0, malformedTagRecoveries: 0 };
    const result = formatTableNumbers(input, { digits: 1 }, stats);
    expect(result.output.match(/<td>1\.3<\/td>/g)).toHaveLength(tableCount);
    expect(stats.completedTables).toBe(tableCount);
    expect(stats.tableRangeVisits).toBe(tableCount);
  });

  test('maps decoded offsets once for many numeric edits in one visible piece', () => {
    const tokenCount = 1_500;
    const content = Array.from({ length: tokenCount }, () => '1.25').join(' / ');
    const input = '<table><tr><td>' + content + '</td></tr></table>';
    const stats = { structuralScans: 0, structuralCharacters: 0, structuralTokens: 0, completedTables: 0,
      tableRangeVisits: 0, decodedPiecesMapped: 0, decodedRawCharactersMapped: 0,
      tableFormatVisits: 0, visibleTokenVisits: 0, visiblePieceSearches: 0, visiblePieceVisits: 0,
      sourceEditPasses: 0, sourceEditsApplied: 0, sourceCharactersCopied: 0,
      htmlTagCharactersVisited: 0, malformedTagRecoveries: 0 };
    const result = formatTableNumbers(input, { digits: 1 }, stats);
    expect(result.output.match(/1\.3/g)).toHaveLength(tokenCount);
    expect(stats.decodedPiecesMapped).toBe(1);
    expect(stats.decodedRawCharactersMapped).toBe(content.length);
    expect(stats.sourceEditPasses).toBe(1);
    expect(stats.sourceEditsApplied).toBeGreaterThanOrEqual(tokenCount);
    expect(stats.sourceCharactersCopied).toBeLessThanOrEqual(input.length);
  });

  test('formats deeply nested tables with iterative linear token traversal', () => {
    const depth = 2_000;
    const input = '<table><tr><td>1.25'.repeat(depth) + '</td></tr></table>'.repeat(depth);
    const stats = { structuralScans: 0, structuralCharacters: 0, structuralTokens: 0, completedTables: 0,
      tableRangeVisits: 0, decodedPiecesMapped: 0, decodedRawCharactersMapped: 0,
      tableFormatVisits: 0, visibleTokenVisits: 0, visiblePieceSearches: 0, visiblePieceVisits: 0,
      sourceEditPasses: 0, sourceEditsApplied: 0, sourceCharactersCopied: 0,
      htmlTagCharactersVisited: 0, malformedTagRecoveries: 0 };
    const result = formatTableNumbers(input, { digits: 1 }, stats);
    expect(result.output.match(/1\.3/g)).toHaveLength(depth);
    expect(stats.tableFormatVisits).toBe(depth);
    expect(stats.visibleTokenVisits).toBeLessThanOrEqual(depth * 2);
  });

  test('indexes visible pieces for numeric edits split across many inline runs', () => {
    const tokenCount = 1_500;
    const content = Array.from({ length: tokenCount }, () => '<span>1.25</span>').join(' / ');
    const input = '<table><tr><td>' + content + '</td></tr></table>';
    const stats = { structuralScans: 0, structuralCharacters: 0, structuralTokens: 0, completedTables: 0,
      tableRangeVisits: 0, decodedPiecesMapped: 0, decodedRawCharactersMapped: 0,
      tableFormatVisits: 0, visibleTokenVisits: 0, visiblePieceSearches: 0, visiblePieceVisits: 0,
      sourceEditPasses: 0, sourceEditsApplied: 0, sourceCharactersCopied: 0,
      htmlTagCharactersVisited: 0, malformedTagRecoveries: 0 };
    const result = formatTableNumbers(input, { decimalMark: 'midpoint' }, stats);
    expect(result.output.match(/1·25/g)).toHaveLength(tokenCount);
    expect(stats.visiblePieceSearches).toBe(tokenCount);
    expect(stats.visiblePieceVisits).toBeLessThanOrEqual(tokenCount * 2);
  });

  test('scopes HTML warnings to exact same-line and malformed sibling tables', () => {
    const first = '<table><tr><td>1,2,3</td></tr></table>';
    const second = '<table><tr><td>4,5,6</td></tr></table>';
    const siblings = first + ' x ' + second;
    const siblingDetails = formatTableNumbers(siblings, { digits: 2 }).warningDetails;
    expect(siblingDetails).toEqual([
      { message: 'Ambiguous numeric table cell left unchanged: 4,5,6', start: first.length + 3, end: siblings.length },
      { message: 'Ambiguous numeric table cell left unchanged: 1,2,3', start: 0, end: first.length },
    ]);

    const malformedPrefix = '<table><tr><td>broken</td></tr>';
    const complete = '<table>\n<tr><td>1,2,3</td></tr>\n</table>';
    const malformed = malformedPrefix + complete;
    expect(formatTableNumbers(malformed, { digits: 2 }).warningDetails).toEqual([{
      message: 'Ambiguous numeric table cell left unchanged: 1,2,3',
      start: malformedPrefix.length,
      end: malformed.length,
    }]);
  });

  test('returns table-scoped warning ranges and grid placeholder source mappings', () => {
    const input = '```\n| V |\n| --- |\n| 1,2,3 |\n```\n\n| V |\n| --- |\n| 1,2,3 |';
    const result = formatTableNumbers(input, { digits: 2 });
    expect(result.warningDetails).toHaveLength(1);
    expect(result.warningDetails[0].start).toBe(input.lastIndexOf('| V |'));
    expect(input.slice(result.warningDetails[0].start, result.warningDetails[0].end)).toContain('1,2,3');

    const grid = '+-----+\n| 1,2,3 |\n+-----+';
    const mapped = preprocessGridTablesWithSourceMap(grid);
    expect(mapped.sourceMap).toHaveLength(1);
    expect(mapped.sourceMap[0].sourceStart).toBe(0);
    expect(mapped.sourceMap[0].sourceEnd).toBe(grid.length);
    expect(mapped.output.slice(mapped.sourceMap[0].outputStart, mapped.sourceMap[0].outputEnd))
      .toStartWith('<!-- MANUSCRIPT_GRID_TABLE:');

    const duplicate = '```\n' + mapped.output + '\n```\n' + grid;
    const duplicateMap = preprocessGridTablesWithSourceMap(duplicate);
    expect(duplicateMap.sourceMap).toHaveLength(1);
    expect(duplicateMap.sourceMap[0].sourceStart).toBe(duplicate.lastIndexOf(grid));
    expect(duplicateMap.sourceMap[0].outputStart).toBeGreaterThan(duplicateMap.output.indexOf(mapped.output));
  });

  test('does not report directives or preprocessed grids in inert regions', () => {
    const invalidDirective = '<script>\n<!-- table-digits: nope -->\n</script>';
    expect(formatTableNumbers(invalidDirective, { digits: 1 }).warningDetails).toEqual([]);

    for (const input of [
      '<!--\n+-------+\n| 1,2,3 |\n+-------+\n-->',
      '<script>\n+-------+\n| 1,2,3 |\n+-------+\n</script>',
    ]) {
      const result = formatTableNumbers(preprocessGridTables(input), { digits: 2 });
      expect(result.warningDetails).toEqual([]);
    }

    const indented = '    +-------+\n    | 1,2,3 |\n    +-------+';
    expect(preprocessGridTables(indented)).toBe(indented);
  });

  test('does not format table-like content in code blocks', () => {
    const fenced = '```markdown\n| Value |\n| --- |\n| 12.30 |\n```';
    expect(formatTableNumbers(fenced, { decimalMark: 'midpoint' }).output).toBe(fenced);
  });

  test('frontmatter parses and serializes all settings including zero', () => {
    const parsed = parseFrontmatter('---\ntable-digits: 0\ntable-decimal-mark: midpoint\ntable-digit-grouping: thin-space\n---\n');
    expect(parsed.metadata.tableDigits).toBe(0);
    expect(serializeFrontmatter(parsed.metadata)).toContain('table-digits: 0');
  });

  test('document defaults and explicit source overrides survive DOCX round trip', async () => {
    const markdown = [
      '---', 'table-digits: 2', 'table-decimal-mark: midpoint',
      'table-digit-grouping: thin-space', '---', '',
      '<!-- table-digits: source -->', '<!-- table-decimal-mark: source -->', '<!-- table-digit-grouping: source -->',
      '| Value |', '| --- |', '| 12.30 |',
    ].join('\n');
    const docx = await convertMdToDocx(markdown);
    const roundTrip = await convertDocx(docx.docx);
    expect(roundTrip.markdown).toContain('table-digits: 2');
    expect(roundTrip.markdown).toContain('table-decimal-mark: midpoint');
    expect(roundTrip.markdown).toContain('table-digit-grouping: thin-space');
    expect(roundTrip.markdown).toContain('<!-- table-digits: source -->');
    expect(roundTrip.markdown).toContain('<!-- table-decimal-mark: source -->');
    expect(roundTrip.markdown).toContain('<!-- table-digit-grouping: source -->');
  });
});
