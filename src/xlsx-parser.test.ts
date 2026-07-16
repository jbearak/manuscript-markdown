import { describe, it, expect } from 'bun:test';
import * as XLSX from '@e965/xlsx';
import { parseXlsx } from './xlsx-parser';

/** Build an XLSX buffer from a 2D array of cell values. */
function buildXlsx(data: string[][], opts?: {
  sheetName?: string;
  merges?: XLSX.Range[];
  extraSheets?: Array<{ name: string; data: string[][] }>;
  definedNames?: Array<{ name: string; ref: string; sheet: string }>;
}): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  if (opts?.merges) {
    ws['!merges'] = opts.merges;
  }
  XLSX.utils.book_append_sheet(wb, ws, opts?.sheetName ?? 'Sheet1');
  if (opts?.extraSheets) {
    for (const extra of opts.extraSheets) {
      const extraWs = XLSX.utils.aoa_to_sheet(extra.data);
      XLSX.utils.book_append_sheet(wb, extraWs, extra.name);
    }
  }
  if (opts?.definedNames) {
    wb.Workbook = wb.Workbook || {};
    wb.Workbook.Names = opts.definedNames.map(dn => ({
      Name: dn.name,
      Ref: `'${dn.sheet}'!${dn.ref}`,
    }));
  }
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(buf);
}

describe('parseXlsx', () => {
  it('parses a simple table from the first sheet', () => {
    const data = [
      ['Name', 'Age'],
      ['Alice', '30'],
      ['Bob', '25'],
    ];
    const buf = buildXlsx(data);
    const meta = parseXlsx(buf, { headers: 1 });

    expect(meta.rows.length).toBe(3);
    expect(meta.rows[0].header).toBe(true);
    expect(meta.rows[1].header).toBe(false);
    expect(meta.rows[0].cells[0].runs[0].text).toBe('Name');
    expect(meta.rows[0].cells[1].runs[0].text).toBe('Age');
    expect(meta.rows[1].cells[0].runs[0].text).toBe('Alice');
  });

  it('selects a sheet by name', () => {
    const buf = buildXlsx([['A']], {
      sheetName: 'First',
      extraSheets: [{ name: 'Second', data: [['B'], ['C']] }],
    });
    const meta = parseXlsx(buf, { sheet: 'Second', headers: 1 });

    expect(meta.rows[0].cells[0].runs[0].text).toBe('B');
    expect(meta.rows[1].cells[0].runs[0].text).toBe('C');
  });

  it('selects a sheet by 1-based index', () => {
    const buf = buildXlsx([['A']], {
      sheetName: 'First',
      extraSheets: [{ name: 'Second', data: [['B']] }],
    });
    const meta = parseXlsx(buf, { sheet: '2', headers: 0 });

    expect(meta.rows[0].cells[0].runs[0].text).toBe('B');
  });

  it('auto-detects the bounding rectangle when no range specified', () => {
    // Create a sheet with data not starting at A1
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([]);
    // Place data at C3:D4
    XLSX.utils.sheet_add_aoa(ws, [['X', 'Y'], ['1', '2']], { origin: 'C3' });
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

    const meta = parseXlsx(buf, { headers: 1 });
    expect(meta.rows.length).toBe(2);
    expect(meta.rows[0].cells.length).toBe(2);
    expect(meta.rows[0].cells[0].runs[0].text).toBe('X');
  });

  it('respects an explicit cell range', () => {
    const data = [
      ['A', 'B', 'C'],
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['7', '8', '9'],
    ];
    const buf = buildXlsx(data);
    const meta = parseXlsx(buf, { range: 'B2:C3', headers: 0 });

    expect(meta.rows.length).toBe(2);
    expect(meta.rows[0].cells.length).toBe(2);
    expect(meta.rows[0].cells[0].runs[0].text).toBe('2');
    expect(meta.rows[0].cells[1].runs[0].text).toBe('3');
    expect(meta.rows[1].cells[0].runs[0].text).toBe('5');
  });

  it('resolves a named range', () => {
    const data = [
      ['A', 'B', 'C'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ];
    const buf = buildXlsx(data, {
      definedNames: [{ name: 'MyRange', ref: '$B$1:$C$2', sheet: 'Sheet1' }],
    });
    const meta = parseXlsx(buf, { range: 'MyRange', headers: 1 });

    expect(meta.rows.length).toBe(2);
    expect(meta.rows[0].header).toBe(true);
    expect(meta.rows[0].cells[0].runs[0].text).toBe('B');
    expect(meta.rows[0].cells[1].runs[0].text).toBe('C');
  });

  it('resolves a named range that points to a different sheet', () => {
    const buf = buildXlsx([['Wrong']], {
      sheetName: 'First',
      extraSheets: [{ name: 'Second', data: [['Right'], ['Data']] }],
      definedNames: [{ name: 'CrossSheet', ref: '$A$1:$A$2', sheet: 'Second' }],
    });
    const meta = parseXlsx(buf, { range: 'CrossSheet', headers: 1 });

    expect(meta.rows.length).toBe(2);
    expect(meta.rows[0].cells[0].runs[0].text).toBe('Right');
    expect(meta.rows[1].cells[0].runs[0].text).toBe('Data');
  });

  it('handles merged cells with colspan', () => {
    const data = [
      ['Merged', '', 'C'],
      ['1', '2', '3'],
    ];
    const buf = buildXlsx(data, {
      merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }], // A1:B1 merged
    });
    const meta = parseXlsx(buf, { headers: 1 });

    expect(meta.rows[0].cells[0].colspan).toBe(2);
    expect(meta.rows[0].cells[0].runs[0].text).toBe('Merged');
    // The merged cell should only produce one cell in the row, not two
    // Total cells in header row: the merged cell + C = 2 logical cells
    expect(meta.rows[0].cells.length).toBe(2);
  });

  it('handles merged cells with rowspan', () => {
    const data = [
      ['Header', 'Value'],
      ['Span', '1'],
      ['', '2'],
    ];
    const buf = buildXlsx(data, {
      merges: [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }], // A2:A3 merged
    });
    const meta = parseXlsx(buf, { headers: 1 });

    expect(meta.rows[1].cells[0].rowspan).toBe(2);
    expect(meta.rows[1].cells[0].runs[0].text).toBe('Span');
    // Row 3 should not have the merged cell
    expect(meta.rows[2].cells.length).toBe(1); // only the Value column
  });

  it('handles merged cells with both colspan and rowspan', () => {
    const data = [
      ['Merged', '', 'C'],
      ['', '', 'D'],
      ['E', 'F', 'G'],
    ];
    const buf = buildXlsx(data, {
      merges: [{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }], // A1:B2 merged
    });
    const meta = parseXlsx(buf, { headers: 0 });

    expect(meta.rows[0].cells[0].colspan).toBe(2);
    expect(meta.rows[0].cells[0].rowspan).toBe(2);
  });

  it('defaults to headers=1 when not specified', () => {
    const data = [
      ['Name', 'Age'],
      ['Alice', '30'],
    ];
    const buf = buildXlsx(data);
    const meta = parseXlsx(buf);

    expect(meta.rows[0].header).toBe(true);
    expect(meta.rows[1].header).toBe(false);
  });

  it('throws for non-existent sheet name', () => {
    const buf = buildXlsx([['A']]);
    expect(() => parseXlsx(buf, { sheet: 'NonExistent' })).toThrow();
  });

  it('throws for out-of-range sheet index', () => {
    const buf = buildXlsx([['A']]);
    expect(() => parseXlsx(buf, { sheet: '99' })).toThrow();
  });

  it('throws for non-existent named range', () => {
    const buf = buildXlsx([['A']]);
    expect(() => parseXlsx(buf, { range: 'DoesNotExist' })).toThrow();
  });

  it('handles numeric cell values', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Count'], [42], [3.14]]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

    const meta = parseXlsx(buf, { headers: 1 });
    expect(meta.rows[1].cells[0].runs[0].text).toBe('42');
    expect(meta.rows[2].cells[0].runs[0].text).toBe('3.14');
  });

  it('preserves Excel display text and typed numeric metadata', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Value', 'Percent'], [12.345, 0.12345]]);
    ws.A2.z = '#,##0.00';
    ws.B2.z = '0.00%';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const meta = parseXlsx(new Uint8Array(bytes));
    expect(meta.rows[1].cells[0].runs[0].text).toBe('12.35');
    expect(meta.rows[1].cells[0].source).toMatchObject({ kind: 'number', rawValue: 12.345, sourceFormat: '#,##0.00' });
    expect(meta.rows[1].cells[1].runs[0].text).toBe('12.35%');
    expect(meta.rows[1].cells[1].source).toMatchObject({ kind: 'percent', rawValue: 0.12345 });
  });

  it('classifies boolean and scientific cells', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Flag', 'Value'], [true, 12345]]);
    ws.B2.z = '0.00E+00';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
    expect(meta.rows[1].cells[0].source?.kind).toBe('boolean');
    expect(meta.rows[1].cells[1].source).toMatchObject({ kind: 'scientific', rawValue: 12345 });
  });

  it('preserves cell-kind precedence for overlapping formats', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Boolean', 'Date', 'Percent', 'Scientific', 'Currency', 'Identifier', 'Number'],
      [true, 2, 0.12, 1234, 12, 12, 12],
    ]);
    ws.A2.z = '0.00';
    ws.B2.z = 'mm-dd%';
    ws.C2.z = '0.00E+00%';
    ws.D2.z = '$0.00E+00';
    ws.E2.z = '$0000';
    ws.F2.z = '0000';
    ws.G2.z = '0';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
    expect(meta.rows[1].cells.map(cell => cell.source?.kind)).toEqual([
      'boolean',
      'date',
      'percent',
      'scientific',
      'currency',
      'identifier',
      'number',
    ]);
  });

	it('classifies multi-part zero masks as identifiers', () => {
    const ws = XLSX.utils.aoa_to_sheet([['ID'], [123456789]]);
    ws.A2.z = '000-00-0000';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
    expect(meta.rows[1].cells[0].source?.kind).toBe('identifier');
    expect(meta.rows[1].cells[0].source?.rawValue).toBeUndefined();
  });

	it('classifies active multi-section zero-padding masks as identifiers', () => {
		const ws = XLSX.utils.aoa_to_sheet([['ID'], [12]]);
		ws.A2.z = '0000;[Red]-0000';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source?.kind).toBe('identifier');
	});

	it('classifies the standard integer zero format as numeric', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Value'], [12]]);
		ws.A2.z = '0';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source).toMatchObject({ kind: 'number', rawValue: 12, sourceFormat: '0' });
	});

	it('classifies Unicode currency formats as currency', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Value'], [12]]);
		ws.A2.z = '₹#,##0.00';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source?.kind).toBe('currency');
	});

	it('does not classify Excel color directives as currency', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Value'], [0]]);
		ws.A2.z = '[RED]0.00;[RED]-0.00;[RED]-';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source?.kind).toBe('number');
	});

	it('ignores quoted percent, scientific, and unit literals', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Percent literal', 'Scientific literal', 'Unit'], [0.1234, 12, 3]]);
		ws.A2.z = '0.00"%"';
		ws.B2.z = '0"E+00"';
		ws.C2.z = '0.00 "kg"';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		for (const cell of meta.rows[1].cells) expect(cell.source?.kind).toBe('number');
	});

	it('classifies semantics from the active numeric format section', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Positive', 'Negative'], [0.123, -0.123]]);
		ws.A2.z = '0.0;0.0%';
		ws.B2.z = '0.0;0.0%';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source?.kind).toBe('number');
		expect(meta.rows[1].cells[1].source?.kind).toBe('percent');
	});

	it('supports leading-decimal conditional thresholds', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Value'], [0.25]]);
		ws.A2.z = '[>.5]0.0;0.0%';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source?.kind).toBe('percent');
	});

	it('detects dates only from the active numeric format section', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Value'], [2]]);
		ws.A2.z = '[>=1]0.0;mm-dd';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source).toMatchObject({ kind: 'number', rawValue: 2 });
	});

	it('protects zero placeholders backed by date formats', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Date'], [0]]);
		ws.A2.z = 'mm-dd-yyyy;mm-dd-yyyy;-';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source?.kind).toBe('date');
	});

	it('protects elapsed-time bracket formats', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Hours', 'Minutes', 'Seconds'], [1.5, 1.5, 1.5]]);
		ws.A2.z = '[h]'; ws.B2.z = '[m]'; ws.C2.z = '[s]';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		for (const cell of meta.rows[1].cells) expect(cell.source?.kind).toBe('date');
	});

	it('protects active conditional elapsed-time sections at zero', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Minutes'], [0]]);
		ws.A2.z = '[>=1]0.0;[m]';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source?.kind).toBe('date');
	});

	it('classifies phone-style zero masks as identifiers', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Phone'], [1234567890]]);
		ws.A2.z = '(000) 000-0000';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source?.kind).toBe('identifier');
	});

	it('classifies zero placeholders from the positive semantic section', () => {
		const ws = XLSX.utils.aoa_to_sheet([['Currency', 'Percent'], [0, 0]]);
		ws.A2.z = '$0.00;($0.00);-';
		ws.B2.z = '0.0%;(0.0%);-';
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
		const meta = parseXlsx(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
		expect(meta.rows[1].cells[0].source?.kind).toBe('currency');
		expect(meta.rows[1].cells[1].source?.kind).toBe('percent');
	});

  it('preserves raw cell content (escaping deferred to renderRuns)', () => {
    const data = [
      ['Header'],
      ['<0.05'],
      ['a & b'],
      ['"quoted"'],
    ];
    const buf = buildXlsx(data);
    const meta = parseXlsx(buf, { headers: 1 });

    expect(meta.rows[1].cells[0].runs[0].text).toBe('<0.05');
    expect(meta.rows[2].cells[0].runs[0].text).toBe('a & b');
    expect(meta.rows[3].cells[0].runs[0].text).toBe('"quoted"');
  });

  it('handles empty cells as empty text', () => {
    const data = [
      ['A', 'B'],
      ['', '1'],
      ['2', ''],
    ];
    const buf = buildXlsx(data);
    const meta = parseXlsx(buf, { headers: 1 });

    expect(meta.rows[1].cells[0].runs[0].text).toBe('');
    expect(meta.rows[2].cells[1].runs[0].text).toBe('');
  });
});
