import { basename, dirname, join } from 'path';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { convertMdToDocx } from './md-to-docx';
import {
  checkDirtyFlag,
  diffDocxParts,
  ensureDirectory,
  ensureWordDocsDir,
  fileExists,
  getWordAutomationAvailability,
  quitWordIfRunning,
  readUint8Array,
  replacePartInZip,
  resetDirectory,
  sanitizeArtifactName,
  saveCopyFromWord,
  wordDocsDir,
  wordRoundtripOutputDir,
  writeJsonFile,
  writeTextFile,
} from './word-automation';

export type WordDirtyFixtureKind = 'text';
export type WordDirtyExpectedState = 'expected-clean' | 'frontier-serialized-dirty' | 'deferred';
export type WordDirtyStatus = 'clean' | 'ui-dirty' | 'serialized-dirty' | 'deferred' | 'skipped';

export interface WordDirtyFixture {
  id: string;
  md: string;
  kind: WordDirtyFixtureKind;
  expectedState: WordDirtyExpectedState;
}

export interface WordDirtyBisectResult {
  partPath: string;
  result: 'DIRTY' | 'CLEAN';
}

export interface WordDirtyResult {
  fixtureId: string;
  status: WordDirtyStatus;
  artifactDir: string;
  changedParts: string[];
  addedParts: string[];
  removedParts: string[];
  warnings: string[];
  bisectResults: WordDirtyBisectResult[];
  byteIdenticalAfterSave: boolean | null;
  note?: string;
}

export interface WordDirtyRunSummary {
  mode: 'discover' | 'verify' | 'diagnose';
  actualFrontierFixtureId: string | null;
  results: WordDirtyResult[];
}

const wordDirtyOutputDir = join(wordRoundtripOutputDir, 'dirty-flag');

export const WORD_DIRTY_FIXTURES: WordDirtyFixture[] = [
  {
    id: 'single-paragraph',
    kind: 'text',
    expectedState: 'expected-clean',
    md: 'Hello world.',
  },
  {
    id: 'two-paragraphs',
    kind: 'text',
    expectedState: 'expected-clean',
    md: [
      'Hello world.',
      '',
      'Second plain paragraph.',
    ].join('\n'),
  },
  {
    id: 'single-heading',
    kind: 'text',
    expectedState: 'expected-clean',
    md: '# Heading 1',
  },
  {
    id: 'heading-plus-paragraph',
    kind: 'text',
    expectedState: 'expected-clean',
    md: [
      '# Heading 1',
      '',
      'Hello world.',
    ].join('\n'),
  },
  {
    id: 'plain-text-composite',
    kind: 'text',
    expectedState: 'frontier-serialized-dirty',
    md: [
      '# Heading 1',
      '',
      '## Heading 2',
      '',
      '### Heading 3',
      '',
      '#### Heading 4',
      '',
      '##### Heading 5',
      '',
      '###### Heading 6',
      '',
      'This is a plain paragraph of text. It has multiple sentences. Nothing fancy here.',
      '',
      'Another paragraph to verify spacing between paragraphs is preserved.',
      '',
      '---',
      '',
      'Text after a horizontal rule.',
    ].join('\n'),
  },
];

function getWordDirtyArtifactDir(id: string): string {
  return join(wordDirtyOutputDir, sanitizeArtifactName(id));
}

function summarizePartList(label: string, parts: string[]): string {
  if (parts.length === 0) return label + ': none';
  return label + ':\n' + parts.map(part => '  - ' + part).join('\n');
}

function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function writeChangedPartDiffs(artifactDir: string, changedDiffs: Array<{ path: string; diff: string | null }>): void {
  const diffsDir = join(artifactDir, 'diffs');
  ensureDirectory(diffsDir);
  for (const changed of changedDiffs) {
    const diffPath = join(diffsDir, sanitizeArtifactName(changed.path) + '.diff');
    writeTextFile(diffPath, changed.diff || '');
  }
}

async function writeAnalysisArtifacts(
  artifactDir: string,
  originalDocx: Uint8Array,
  wordSavedDocx: Uint8Array,
  summary: Awaited<ReturnType<typeof diffDocxParts>>,
  result: WordDirtyResult
): Promise<void> {
  writeFileSync(join(artifactDir, 'original.docx'), originalDocx);
  writeFileSync(join(artifactDir, 'word-saved.docx'), wordSavedDocx);
  writeChangedPartDiffs(artifactDir, summary.changedDiffs);
  const summaryText = [
    'Fixture: ' + result.fixtureId,
    'Status: ' + result.status,
    'Byte-identical after save: ' + (result.byteIdenticalAfterSave === null ? 'n/a' : String(result.byteIdenticalAfterSave)),
    summarizePartList('Changed parts', summary.changedParts),
    summarizePartList('Added parts', summary.addedParts),
    summarizePartList('Removed parts', summary.removedParts),
  ].join('\n\n') + '\n';
  writeTextFile(join(artifactDir, 'summary.txt'), summaryText);
  writeJsonFile(join(artifactDir, 'summary.json'), {
    fixtureId: result.fixtureId,
    status: result.status,
    changedParts: summary.changedParts,
    addedParts: summary.addedParts,
    removedParts: summary.removedParts,
    warnings: result.warnings,
    bisectResults: result.bisectResults,
    byteIdenticalAfterSave: result.byteIdenticalAfterSave,
    note: result.note,
  });
}

async function maybeBisectChangedParts(
  originalDocx: Uint8Array,
  diffSummary: Awaited<ReturnType<typeof diffDocxParts>>,
  fixtureId: string,
  keepWordCopies: boolean
): Promise<WordDirtyBisectResult[]> {
  const results: WordDirtyBisectResult[] = [];
  const tempBase = sanitizeArtifactName(fixtureId);

  for (const partPath of diffSummary.changedParts) {
    const replacementContent = diffSummary.modifiedParts.get(partPath);
    if (replacementContent === undefined) continue;
    const variant = await replacePartInZip(originalDocx, partPath, replacementContent);
    const variantPath = join(wordDocsDir, tempBase + '-bisect.docx');
    writeFileSync(variantPath, variant);
    try {
      results.push({
        partPath,
        result: checkDirtyFlag(variantPath),
      });
    } finally {
      if (!keepWordCopies && fileExists(variantPath)) {
        try { unlinkSync(variantPath); } catch { /* Best-effort temporary-file cleanup. */ }
      }
    }
  }

  return results;
}

async function analyzeMarkdown(
  id: string,
  md: string,
  options: { keepWordCopies?: boolean; sourceDir?: string; bibtex?: string; bisect?: boolean } = {}
): Promise<WordDirtyResult> {
  const keepWordCopies = options.keepWordCopies ?? false;
  const artifactDir = getWordDirtyArtifactDir(id);
  resetDirectory(artifactDir);
  ensureWordDocsDir();

  const result: WordDirtyResult = {
    fixtureId: id,
    status: 'clean',
    artifactDir,
    changedParts: [],
    addedParts: [],
    removedParts: [],
    warnings: [],
    bisectResults: [],
    byteIdenticalAfterSave: null,
  };

  const availability = getWordAutomationAvailability();
  if (!availability.available) {
    result.status = 'skipped';
    result.note = availability.reason;
    writeJsonFile(join(artifactDir, 'summary.json'), result);
    writeTextFile(join(artifactDir, 'summary.txt'), 'Skipped: ' + availability.reason + '\n');
    return result;
  }

  const conversion = await convertMdToDocx(md, {
    bibtex: options.bibtex,
    sourceDir: options.sourceDir,
  });
  result.warnings = conversion.warnings;

  const originalDocx = conversion.docx;
  writeFileSync(join(artifactDir, 'original.docx'), originalDocx);

  const tempBase = sanitizeArtifactName(id);
  const wordInputPath = join(wordDocsDir, tempBase + '.docx');
  const wordSavedPath = join(wordDocsDir, tempBase + '-word-saved.docx');
  writeFileSync(wordInputPath, originalDocx);

  try {
    quitWordIfRunning();
    const dirtyFlag = checkDirtyFlag(wordInputPath);
    if (dirtyFlag === 'CLEAN') {
      result.status = 'clean';
      writeJsonFile(join(artifactDir, 'summary.json'), result);
      writeTextFile(join(artifactDir, 'summary.txt'), 'Fixture: ' + id + '\nStatus: clean\n');
      return result;
    }

    saveCopyFromWord(wordInputPath, wordSavedPath);
    const wordSavedDocx = readUint8Array(wordSavedPath);
    const diffSummary = await diffDocxParts(originalDocx, wordSavedDocx, join(artifactDir, '.tmp'));
    result.byteIdenticalAfterSave = uint8ArraysEqual(originalDocx, wordSavedDocx);

    result.changedParts = diffSummary.changedParts;
    result.addedParts = diffSummary.addedParts;
    result.removedParts = diffSummary.removedParts;
    const hasSerializedDiff =
      diffSummary.changedParts.length === 0 &&
      diffSummary.addedParts.length === 0 &&
      diffSummary.removedParts.length === 0
        ? false
        : true;

    if (!hasSerializedDiff && result.byteIdenticalAfterSave) {
      result.status = 'ui-dirty';
      result.note = 'Word flipped the saved flag, but saving produced a byte-identical DOCX.';
    } else if (!hasSerializedDiff) {
      result.status = 'serialized-dirty';
      result.note = 'Word marked the file dirty, but no XML part differences were found. Zip-level normalization may still be involved.';
    } else {
      result.status = 'serialized-dirty';
    }
    if (options.bisect && result.status === 'serialized-dirty' && diffSummary.changedParts.length > 0) {
      result.bisectResults = await maybeBisectChangedParts(originalDocx, diffSummary, id, keepWordCopies);
    }

    await writeAnalysisArtifacts(artifactDir, originalDocx, wordSavedDocx, diffSummary, result);
    return result;
  } finally {
    if (!keepWordCopies) {
      for (const cleanupPath of [wordInputPath, wordSavedPath]) {
        try {
          if (fileExists(cleanupPath)) {
            unlinkSync(cleanupPath);
          }
        } catch {
          // Best-effort cleanup; preserve the diagnostic result if removal fails.
        }
      }
    }
  }
}

function markDeferredResults(fixtures: WordDirtyFixture[], startIndex: number): WordDirtyResult[] {
  return fixtures.slice(startIndex).map(fixture => ({
    fixtureId: fixture.id,
    status: 'deferred',
    artifactDir: getWordDirtyArtifactDir(fixture.id),
    changedParts: [],
    addedParts: [],
    removedParts: [],
    warnings: [],
    bisectResults: [],
    byteIdenticalAfterSave: null,
    note: 'Deferred until earlier simpler fixtures are clean.',
  }));
}

export function getExpectedWordDirtyFrontier(): WordDirtyFixture {
  const frontiers = WORD_DIRTY_FIXTURES.filter(fixture => fixture.expectedState === 'frontier-serialized-dirty');
  if (frontiers.length !== 1) {
    throw new Error('Expected exactly one frontier-serialized-dirty fixture; found ' + frontiers.length + '.');
  }
  return frontiers[0];
}

export async function discoverWordDirtyFrontier(
  options: { fixtureId?: string; keepWordCopies?: boolean; bisect?: boolean } = {}
): Promise<WordDirtyRunSummary> {
  const fixtures = options.fixtureId
    ? WORD_DIRTY_FIXTURES.filter(fixture => fixture.id === options.fixtureId)
    : WORD_DIRTY_FIXTURES;
  if (fixtures.length === 0) {
    throw new Error('Unknown fixture id: ' + options.fixtureId);
  }

  const availability = getWordAutomationAvailability();
  if (!availability.available) {
    const summary: WordDirtyRunSummary = {
      mode: 'discover',
      actualFrontierFixtureId: null,
      results: fixtures.map(fixture => ({
        fixtureId: fixture.id,
        status: 'skipped',
        artifactDir: getWordDirtyArtifactDir(fixture.id),
        changedParts: [],
        addedParts: [],
        removedParts: [],
        warnings: [],
        bisectResults: [],
        byteIdenticalAfterSave: null,
        note: availability.reason,
      })),
    };
    ensureDirectory(wordDirtyOutputDir);
    writeJsonFile(join(wordDirtyOutputDir, 'discover-summary.json'), summary);
    return summary;
  }

  ensureDirectory(wordDirtyOutputDir);
  const results: WordDirtyResult[] = [];
  let actualFrontierFixtureId: string | null = null;

  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    const result = await analyzeMarkdown(fixture.id, fixture.md, {
      keepWordCopies: options.keepWordCopies,
      bisect: options.bisect,
    });
    results.push(result);
    if (result.status === 'serialized-dirty') {
      actualFrontierFixtureId = fixture.id;
      if (!options.fixtureId) {
        results.push(...markDeferredResults(fixtures, i + 1));
      }
      break;
    }
  }

  const summary: WordDirtyRunSummary = {
    mode: 'discover',
    actualFrontierFixtureId,
    results,
  };
  writeJsonFile(join(wordDirtyOutputDir, 'discover-summary.json'), summary);
  return summary;
}

export async function verifyWordDirtyBaseline(
  options: { keepWordCopies?: boolean; bisect?: boolean } = {}
): Promise<WordDirtyRunSummary> {
  const availability = getWordAutomationAvailability();
  if (!availability.available) {
    const summary: WordDirtyRunSummary = {
      mode: 'verify',
      actualFrontierFixtureId: null,
      results: WORD_DIRTY_FIXTURES.map(fixture => ({
        fixtureId: fixture.id,
        status: 'skipped',
        artifactDir: getWordDirtyArtifactDir(fixture.id),
        changedParts: [],
        addedParts: [],
        removedParts: [],
        warnings: [],
        bisectResults: [],
        byteIdenticalAfterSave: null,
        note: availability.reason,
      })),
    };
    ensureDirectory(wordDirtyOutputDir);
    writeJsonFile(join(wordDirtyOutputDir, 'verify-summary.json'), summary);
    return summary;
  }

  const expectedFrontier = getExpectedWordDirtyFrontier();
  const expectedFrontierIndex = WORD_DIRTY_FIXTURES.findIndex(fixture => fixture.id === expectedFrontier.id);
  const results: WordDirtyResult[] = [];

  for (let i = 0; i <= expectedFrontierIndex; i++) {
    const fixture = WORD_DIRTY_FIXTURES[i];
    const result = await analyzeMarkdown(fixture.id, fixture.md, {
      keepWordCopies: options.keepWordCopies,
      bisect: options.bisect,
    });
    results.push(result);

    if (i < expectedFrontierIndex && result.status === 'serialized-dirty') {
      throw new Error(
        'Expected earlier fixture "' + fixture.id + '" to be clean, but Word marked it dirty. ' +
        'The dirty frontier regressed to a simpler case.'
      );
    }

    if (fixture.id === expectedFrontier.id) {
      if (result.status !== 'serialized-dirty') {
        throw new Error(
          'Expected frontier fixture "' + fixture.id + '" to remain dirty, but it is now ' + result.status + '. ' +
          'Promote the next fixture and rerun discovery.'
        );
      }
      if (
        result.changedParts.length === 0 &&
        result.addedParts.length === 0 &&
        result.removedParts.length === 0
      ) {
        throw new Error(
          'Frontier fixture "' + fixture.id + '" is dirty but produced no XML part differences. ' +
          'Investigate zip-level normalization before advancing the baseline.'
        );
      }
    }
  }

  results.push(...markDeferredResults(WORD_DIRTY_FIXTURES, expectedFrontierIndex + 1));
  const summary: WordDirtyRunSummary = {
    mode: 'verify',
    actualFrontierFixtureId: expectedFrontier.id,
    results,
  };
  writeJsonFile(join(wordDirtyOutputDir, 'verify-summary.json'), summary);
  return summary;
}

export async function diagnoseMarkdownPath(
  mdPath: string,
  options: { keepWordCopies?: boolean; bisect?: boolean } = {}
): Promise<WordDirtyRunSummary> {
  if (!fileExists(mdPath)) {
    throw new Error('File not found: ' + mdPath);
  }
  const md = readFileSync(mdPath, 'utf-8');
  const bibPath = mdPath.replace(/\.md$/, '.bib');
  const bibtex = fileExists(bibPath) ? readFileSync(bibPath, 'utf-8') : undefined;
  const id = 'diagnose-' + sanitizeArtifactName(basename(mdPath, '.md'));
  const result = await analyzeMarkdown(id, md, {
    keepWordCopies: options.keepWordCopies,
    sourceDir: dirname(mdPath),
    bibtex,
    bisect: options.bisect,
  });
  const summary: WordDirtyRunSummary = {
    mode: 'diagnose',
    actualFrontierFixtureId: result.status === 'serialized-dirty' ? result.fixtureId : null,
    results: [result],
  };
  writeJsonFile(join(result.artifactDir, 'diagnose-summary.json'), summary);
  return summary;
}
