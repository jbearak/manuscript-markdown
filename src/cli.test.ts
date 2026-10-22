import { test, expect } from 'bun:test';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import {
  main,
  parseArgs,
  detectDirection,
  deriveDocxToMdPaths,
  deriveMdToDocxPath,
  resolveAuthor,
  assertNoDocxToMdConflicts,
  assertNoMdToDocxConflict
} from './cli';

test('Property 1: Extension-based dispatch correctness', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes('/')),
      (filename) => {
        const docxPath = filename + '.docx';
        const mdPath = filename + '.md';
        const otherPath = filename + '.txt';

        expect(detectDirection(docxPath)).toBe('docx-to-md');
        expect(detectDirection(mdPath)).toBe('md-to-docx');
        expect(() => detectDirection(otherPath)).toThrow('Unsupported file type ".txt". Use .docx or .md');
      }
    ),
    { numRuns: 100 }
  );
});

test('path derivation strips extension case-insensitively', () => {
  const derivedDocx = deriveDocxToMdPaths('/tmp/paper.DOCX');
  expect(derivedDocx.mdPath).toBe('/tmp/paper.md');
  expect(derivedDocx.bibPath).toBe('/tmp/paper.bib');

  const derivedDocxWithOutput = deriveDocxToMdPaths('/tmp/paper.DOCX', '/tmp/output.MD');
  expect(derivedDocxWithOutput.mdPath).toBe('/tmp/output.md');
  expect(derivedDocxWithOutput.bibPath).toBe('/tmp/output.bib');

  expect(deriveMdToDocxPath('/tmp/paper.MD')).toBe('/tmp/paper.docx');
});

test('Property 2: Argument parser preserves all flag values', () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{0,9}$/), // Start with letter to avoid flag-like strings
      fc.option(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{0,9}$/)),
      fc.boolean(),
      fc.constantFrom('authorYearTitle', 'authorYear', 'numeric'),
      fc.option(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{0,9}$/)),
      fc.option(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{0,9}$/)),
      fc.option(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ._-]{0,9}$/)),
      (inputPath, outputPath, force, citationKeyFormat, bibPath, templatePath, authorName) => {
        const args = ['node', 'cli.js', inputPath];
        
        if (outputPath) {
          args.push('--output', outputPath);
        }
        if (force) {
          args.push('--force');
        }
        args.push('--citation-key-format', citationKeyFormat);
        if (bibPath) {
          args.push('--bib', bibPath);
        }
        if (templatePath) {
          args.push('--template', templatePath);
        }
        if (authorName) {
          args.push('--author', authorName);
        }

        const result = parseArgs(args);

        expect(result.inputPath).toBe(inputPath);
        expect(result.outputPath).toBe(outputPath || undefined);
        expect(result.force).toBe(force);
        expect(result.citationKeyFormat).toBe(citationKeyFormat);
        expect(result.bibPath).toBe(bibPath || undefined);
        expect(result.templatePath).toBe(templatePath || undefined);
        expect(result.authorName).toBe(authorName || undefined);
      }
    ),
    { numRuns: 100 }
  );
});

test('parseArgs handles defaults correctly', () => {
  const result = parseArgs(['node', 'cli.js', 'test.md']);
  
  expect(result.inputPath).toBe('test.md');
  expect(result.force).toBe(false);
  expect(result.citationKeyFormat).toBe('authorYearTitle');
  expect(result.cslCacheDir).toMatch(/.manuscript-markdown\/csl-cache$/);
});

test('parseArgs throws on unknown flags', () => {
  expect(() => parseArgs(['node', 'cli.js', '--unknown'])).toThrow('Unknown option "--unknown"');
  expect(() => parseArgs(['node', 'cli.js', 'test.md', '--mixed-citation-style', 'unified']))
    .toThrow('Unknown option "--mixed-citation-style"');
});

test('parseArgs throws on invalid citation key format', () => {
  expect(() => parseArgs(['node', 'cli.js', 'test.md', '--citation-key-format', 'invalid']))
    .toThrow('Invalid citation key format "invalid". Use authorYearTitle, authorYear, or numeric');
});

test('parseArgs defaults tableIndent to 2 spaces', () => {
  const result = parseArgs(['node', 'cli.js', 'test.docx']);
  expect(result.tableIndent).toBe('  ');
});

test('parseArgs parses --table-indent', () => {
  const result = parseArgs(['node', 'cli.js', 'test.docx', '--table-indent', '4']);
  expect(result.tableIndent).toBe('    ');
});

test('parseArgs --table-indent 0 produces empty string', () => {
  const result = parseArgs(['node', 'cli.js', 'test.docx', '--table-indent', '0']);
  expect(result.tableIndent).toBe('');
});

test('parseArgs throws on invalid --table-indent', () => {
  expect(() => parseArgs(['node', 'cli.js', 'test.docx', '--table-indent', 'abc']))
    .toThrow('Invalid table indent "abc". Use a non-negative integer');
});

test('parseArgs defaults noTemplate to false', () => {
  const result = parseArgs(['node', 'cli.js', 'test.md']);
  expect(result.noTemplate).toBe(false);
});

test('parseArgs parses --no-template', () => {
  const result = parseArgs(['node', 'cli.js', 'test.md', '--no-template']);
  expect(result.noTemplate).toBe(true);
});

test('parseArgs throws when value-taking flags are missing values', () => {
  const valueFlags = [
    '--output',
    '--citation-key-format',
    '--bib',
    '--template',
    '--author',
    '--csl-cache-dir',
    '--table-indent'
  ];

  for (const flag of valueFlags) {
    expect(() => parseArgs(['node', 'cli.js', 'test.md', flag])).toThrow(`${flag} requires a value`);
    expect(() => parseArgs(['node', 'cli.js', 'test.md', flag, '--force'])).toThrow(`${flag} requires a value`);
  }
});

test('parseArgs throws when no input specified', () => {
  expect(() => parseArgs(['node', 'cli.js'])).toThrow('No input file specified');
});

test('Property 3: Output path derivation with --output override', () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{0,9}$/),
      fc.option(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._/-]{0,19}$/)),
      (inputBase, outputPath) => {
        const inputPath = inputBase + '.docx';
        const result = deriveDocxToMdPaths(inputPath, outputPath);
        
        if (outputPath) {
          const expectedBase = outputPath.replace(/\.md$/i, '');
          expect(result.mdPath).toBe(expectedBase + '.md');
          expect(result.bibPath).toBe(expectedBase + '.bib');
        } else {
          expect(result.mdPath).toBe(inputBase + '.md');
          expect(result.bibPath).toBe(inputBase + '.bib');
        }
      }
    ),
    { numRuns: 100 }
  );
});

test('Property 5: Dual conflict reporting for DOCX→MD', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  
  try {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{0,9}$/),
        (basename) => {
          const inputPath = path.join(tempDir, basename + '.docx');
          const mdPath = path.join(tempDir, basename + '.md');
          const bibPath = path.join(tempDir, basename + '.bib');
          
          // Create conflicting files
          fs.writeFileSync(mdPath, 'test');
          fs.writeFileSync(bibPath, 'test');

          const { mdPath: derivedMd, bibPath: derivedBib } = deriveDocxToMdPaths(inputPath);
          expect(() => assertNoDocxToMdConflicts(derivedMd, derivedBib, false))
            .toThrow(/Output file\(s\) already exist:.*\.md.*\.bib/);
          
          // Clean up for next iteration
          fs.unlinkSync(mdPath);
          fs.unlinkSync(bibPath);
        }
      ),
      { numRuns: 100 }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Property 4: Conflict detection respects --force', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  
  try {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._-]{0,9}$/),
        fc.boolean(),
        (basename, force) => {
          const inputPath = path.join(tempDir, basename + '.md');
          const docxPath = deriveMdToDocxPath(inputPath);
          
          // Create conflicting file
          fs.writeFileSync(docxPath, 'test');
          
          if (force) {
            // Should not throw when force=true
            expect(() => assertNoMdToDocxConflict(docxPath, force)).not.toThrow();
          } else {
            // Should throw when force=false
            expect(() => assertNoMdToDocxConflict(docxPath, force))
              .toThrow(/Output file already exists:.*\.docx/);
          }
          
          // Clean up for next iteration
          fs.unlinkSync(docxPath);
        }
      ),
      { numRuns: 100 }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Property 6: Author name resolution', () => {
  fc.assert(
    fc.property(
      fc.option(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ._-]{0,19}$/)),
      (authorFlag) => {
        const result = resolveAuthor(authorFlag);
        
        if (authorFlag) {
          expect(result).toBe(authorFlag);
        } else {
          expect(result).toBe(os.userInfo().username);
        }
      }
    ),
    { numRuns: 100 }
  );
});

test('--blockquote-style parses valid values', () => {
  const quoteOpts = parseArgs(['node', 'cli.js', 'file.md', '--blockquote-style', 'Quote']);
  expect(quoteOpts.blockquoteStyle).toBe('Quote');

  const intenseOpts = parseArgs(['node', 'cli.js', 'file.md', '--blockquote-style', 'IntenseQuote']);
  expect(intenseOpts.blockquoteStyle).toBe('IntenseQuote');

  const githubOpts = parseArgs(['node', 'cli.js', 'file.md', '--blockquote-style', 'GitHub']);
  expect(githubOpts.blockquoteStyle).toBe('GitHub');
});

test('--blockquote-style is case-insensitive', () => {
  expect(parseArgs(['node', 'cli.js', 'file.md', '--blockquote-style', 'github']).blockquoteStyle).toBe('GitHub');
  expect(parseArgs(['node', 'cli.js', 'file.md', '--blockquote-style', 'QUOTE']).blockquoteStyle).toBe('Quote');
  expect(parseArgs(['node', 'cli.js', 'file.md', '--blockquote-style', 'intensequote']).blockquoteStyle).toBe('IntenseQuote');
});

test('--blockquote-style rejects invalid values', () => {
  expect(() => parseArgs(['node', 'cli.js', 'file.md', '--blockquote-style', 'Fancy'])).toThrow('Invalid blockquote style');
});

test('blockquoteStyle defaults to GitHub', () => {
  const opts = parseArgs(['node', 'cli.js', 'file.md']);
  expect(opts.blockquoteStyle).toBe('GitHub');
});

test('--colors parses valid values', () => {
  const githubOpts = parseArgs(['node', 'cli.js', 'file.md', '--colors', 'github']);
  expect(githubOpts.colors).toBe('github');

  const guttmacherOpts = parseArgs(['node', 'cli.js', 'file.md', '--colors', 'guttmacher']);
  expect(guttmacherOpts.colors).toBe('guttmacher');
});

test('--colors is case-insensitive', () => {
  expect(parseArgs(['node', 'cli.js', 'file.md', '--colors', 'GitHub']).colors).toBe('github');
  expect(parseArgs(['node', 'cli.js', 'file.md', '--colors', 'GUTTMACHER']).colors).toBe('guttmacher');
  expect(parseArgs(['node', 'cli.js', 'file.md', '--colors', 'Guttmacher']).colors).toBe('guttmacher');
});

test('--colors rejects invalid values', () => {
  expect(() => parseArgs(['node', 'cli.js', 'file.md', '--colors', 'rainbow'])).toThrow('Invalid color scheme');
});

test('colors defaults to guttmacher', () => {
  const opts = parseArgs(['node', 'cli.js', 'file.md']);
  expect(opts.colors).toBe('guttmacher');
});

test('DOCX→MD writes each warning of the conversion to stderr, as for a tracked formatting change it accepts', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  const { argv } = process;
  const { log, error } = console;
  const errors: unknown[] = [];
  try {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="1" w:author="Alice" w:date="2024-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>Bold</w:t></w:r></w:p>'
      + '</w:body></w:document>');
    const inputPath = path.join(tempDir, 'paper.docx');
    fs.writeFileSync(inputPath, await zip.generateAsync({ type: 'uint8array' }));
    process.argv = ['node', 'cli.js', inputPath];
    console.log = () => {};
    console.error = (message: unknown) => { errors.push(message); };
    await main();
    expect(fs.readFileSync(path.join(tempDir, 'paper.md'), 'utf8')).toContain('**Bold**');
    expect(errors).toEqual(['Warning: Accepted 1 tracked formatting change by Alice; Markdown has no syntax for it, so the text shows its new formatting.']);
  } finally {
    process.argv = argv;
    console.log = log;
    console.error = error;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
