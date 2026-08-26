import { describe, it, expect } from 'bun:test';
import { preprocessGridTablesWithMap, wrapBareLatexEnvironmentsWithMap, preprocessCriticMarkupWithMap } from './preprocess-with-map';

describe('preprocessGridTablesWithMap', () => {
  it('returns identity map when no grid tables present', () => {
    const src = 'Hello\n\nWorld\n';
    const { output, map } = preprocessGridTablesWithMap(src);
    expect(output).toBe(src);
    expect(map.isIdentity).toBe(true);
  });

  it('remaps lines after a grid table to correct original positions', () => {
    const src = [
      'Before line 0',        // 0
      '',                      // 1
      '+---+---+',             // 2  grid table start
      '| a | b |',             // 3
      '+---+---+',             // 4
      '| c | d |',             // 5
      '+---+---+',             // 6  grid table end
      '',                      // 7
      'After line 8',          // 8
      'After line 9',          // 9
    ].join('\n');

    const { output, map } = preprocessGridTablesWithMap(src);
    const outLines = output.split('\n');

    // The grid table (5 lines) gets replaced with placeholder + blank lines
    // "Before line 0" should still be on preprocessed line 0
    expect(map.remap(0)).toBe(0);

    // Find "After line 8" in the output
    const afterIdx = outLines.indexOf('After line 8');
    expect(afterIdx).toBeGreaterThan(-1);
    // It should remap to original line 8
    expect(map.remap(afterIdx)).toBe(8);
  });
});

describe('wrapBareLatexEnvironmentsWithMap', () => {
  it('returns identity map when no LaTeX environments present', () => {
    const src = 'Hello\n\nWorld\n';
    const { output, map } = wrapBareLatexEnvironmentsWithMap(src);
    expect(output).toBe(src);
    expect(map.isIdentity).toBe(true);
  });

  it('remaps lines after a LaTeX block with internal blank lines', () => {
    const src = [
      'Before',                    // 0
      '',                          // 1
      '\\begin{equation}',         // 2
      'x = 1',                     // 3
      '',                          // 4  blank line that gets collapsed
      'y = 2',                     // 5
      '\\end{equation}',           // 6
      '',                          // 7
      'After',                     // 8
    ].join('\n');

    const { output, map } = wrapBareLatexEnvironmentsWithMap(src);
    const outLines = output.split('\n');

    // "Before" should still map correctly
    expect(map.remap(0)).toBe(0);

    // Find "After" in the output
    const afterIdx = outLines.indexOf('After');
    expect(afterIdx).toBeGreaterThan(-1);
    // It should remap to original line 8
    expect(map.remap(afterIdx)).toBe(8);
  });
});

describe('preprocessGridTablesWithMap — large table', () => {
  it('remaps correctly for a grid table with more than 200 rows', () => {
    const rows: string[] = [];
    rows.push('Before');           // 0
    rows.push('');                 // 1
    rows.push('+------+------+');  // 2
    for (let i = 0; i < 210; i++) {
      rows.push('| a    | b    |');
      rows.push('+------+------+');
    }
    rows.push('');
    rows.push('After large table');
    const afterOrigLine = rows.length - 1;

    const src = rows.join('\n');
    const { output, map } = preprocessGridTablesWithMap(src);
    const outLines = output.split('\n');

    const afterIdx = outLines.indexOf('After large table');
    expect(afterIdx).toBeGreaterThan(-1);
    expect(map.remap(afterIdx)).toBe(afterOrigLine);
  });
});

describe('preprocessCriticMarkupWithMap', () => {
  it('returns identity map when no CriticMarkup present', () => {
    const src = 'Hello\n\nWorld\n';
    const { output, map } = preprocessCriticMarkupWithMap(src);
    expect(output).toBe(src);
    expect(map.isIdentity).toBe(true);
  });

  it('remaps lines after CriticMarkup with internal blank lines', () => {
    const src = [
      'Before',                              // 0
      '',                                    // 1
      '{++added text',                       // 2
      '',                                    // 3  blank line pair that gets placeholder
      'more added text++}',                  // 4
      '',                                    // 5
      'After',                               // 6
    ].join('\n');

    const { output, map } = preprocessCriticMarkupWithMap(src);
    const outLines = output.split('\n');

    // "Before" should still map correctly
    expect(map.remap(0)).toBe(0);

    // Find "After" in the output
    const afterIdx = outLines.indexOf('After');
    expect(afterIdx).toBeGreaterThan(-1);
    // It should remap to original line 6
    expect(map.remap(afterIdx)).toBe(6);
  });

  it('maps a changed first line to its source rather than a later anchor', () => {
    const src = 'Before {++a\nb++}\nAfter';
    const { output, map } = preprocessCriticMarkupWithMap(src);
    const outLines = output.split('\n');

    expect(outLines).toHaveLength(2);
    expect(map.remap(0)).toBe(0);
    expect(map.remap(outLines.indexOf('After'))).toBe(2);
    expect(map.remap(outLines.length)).toBe(3);
  });

  it('maps a leading collapsed paragraph span and the following anchor monotonically', () => {
    const src = '{++a\n\nb++}\nAfter';
    const { output, map } = preprocessCriticMarkupWithMap(src);
    const outLines = output.split('\n');
    const mapped = outLines.map((_line, index) => map.remap(index));

    expect(mapped[0]).toBe(0);
    expect(map.remap(outLines.indexOf('After'))).toBe(3);
    expect(mapped).toEqual([...mapped].sort((a, b) => a - b));
  });
});
