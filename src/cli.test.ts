import { test, expect } from 'bun:test';
import * as fc from 'fast-check';
import { parseArgs, detectDirection, CliOptions } from './cli';

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
      fc.constantFrom('separate', 'unified'),
      (inputPath, outputPath, force, citationKeyFormat, bibPath, templatePath, authorName, mixedCitationStyle) => {
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
        args.push('--mixed-citation-style', mixedCitationStyle);

        const result = parseArgs(args);

        expect(result.inputPath).toBe(inputPath);
        expect(result.outputPath).toBe(outputPath || undefined);
        expect(result.force).toBe(force);
        expect(result.citationKeyFormat).toBe(citationKeyFormat);
        expect(result.bibPath).toBe(bibPath || undefined);
        expect(result.templatePath).toBe(templatePath || undefined);
        expect(result.authorName).toBe(authorName || undefined);
        expect(result.mixedCitationStyle).toBe(mixedCitationStyle);
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
  expect(result.mixedCitationStyle).toBe('separate');
  expect(result.cslCacheDir).toMatch(/.manuscript-markdown\/csl-cache$/);
});

test('parseArgs throws on unknown flags', () => {
  expect(() => parseArgs(['node', 'cli.js', '--unknown'])).toThrow('Unknown option "--unknown"');
});

test('parseArgs throws on invalid citation key format', () => {
  expect(() => parseArgs(['node', 'cli.js', 'test.md', '--citation-key-format', 'invalid']))
    .toThrow('Invalid citation key format "invalid". Use authorYearTitle, authorYear, or numeric');
});

test('parseArgs throws on invalid mixed citation style', () => {
  expect(() => parseArgs(['node', 'cli.js', 'test.md', '--mixed-citation-style', 'invalid']))
    .toThrow('Invalid mixed citation style "invalid". Use separate or unified');
});

test('parseArgs throws when no input specified', () => {
  expect(() => parseArgs(['node', 'cli.js'])).toThrow('No input file specified');
});