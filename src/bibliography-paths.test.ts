import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  bibliographyCandidatePaths,
  resolveExistingBibliographyPath,
  defaultBibliographyWritePath,
  resolveBibliographyWritePath,
  resolveBibliographyWritePathForOutput,
  resolveDocumentBibliography,
  resolveDocumentBibliographyPath,
} from './bibliography-paths';

describe('bibliography path helpers', () => {
  test('relative bibliography prefers markdown directory then workspace root', () => {
    const candidates = bibliographyCandidatePaths('refs/library', '/repo/docs/paper', '/repo');
    expect(candidates).toEqual([
      '/repo/docs/paper/refs/library.bib',
      '/repo/refs/library.bib',
    ]);
  });

  test('absolute bibliography path is not prefixed with workspace root', () => {
    const candidates = bibliographyCandidatePaths('/shared/library', '/repo/docs/paper', '/repo');
    expect(candidates).toEqual(['/shared/library.bib']);
  });

  test('resolveExistingBibliographyPath finds workspace-root fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-bib-paths-'));
    try {
      const mdDir = join(root, 'docs');
      const wsRoot = join(root, 'workspace');
      mkdirSync(mdDir, { recursive: true });
      mkdirSync(join(wsRoot, 'refs'), { recursive: true });
      const bibPath = join(wsRoot, 'refs', 'library.bib');
      writeFileSync(bibPath, '@article{key,}\n');

      const resolved = await resolveExistingBibliographyPath(
        'refs/library',
        mdDir,
        async (p) => Bun.file(p).exists(),
        wsRoot,
      );
      expect(resolved).toBe(bibPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('defaultBibliographyWritePath creates relative paths under markdown directory', () => {
    expect(defaultBibliographyWritePath('refs/library', '/repo/docs/paper'))
      .toBe('/repo/docs/paper/refs/library.bib');
  });

  test('resolveBibliographyWritePath prefers the resolved existing file', () => {
    expect(resolveBibliographyWritePath(
      'refs/library',
      '/repo/docs/paper',
      '/repo/refs/library.bib',
    )).toBe('/repo/refs/library.bib');
  });

  test('resolveBibliographyWritePathForOutput uses the current markdown directory after rename', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-bib-write-'));
    try {
      const originalMdDir = join(root, 'original');
      const renamedMdDir = join(root, 'renamed');
      mkdirSync(join(originalMdDir, 'refs'), { recursive: true });
      mkdirSync(renamedMdDir, { recursive: true });
      writeFileSync(join(originalMdDir, 'refs', 'library.bib'), '@article{old,}\n');

      const resolved = await resolveBibliographyWritePathForOutput(
        'refs/library',
        renamedMdDir,
        async (p) => Bun.file(p).exists(),
      );
      expect(resolved).toBe(join(renamedMdDir, 'refs', 'library.bib'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolveDocumentBibliographyPath prefers the frontmatter bibliography', async () => {
    const existing = new Set(['/repo/docs/refs.bib', '/repo/docs/paper.bib']);
    const resolved = await resolveDocumentBibliographyPath(
      'refs',
      '/repo/docs/paper',
      async (p) => existing.has(p),
      '/repo',
    );
    expect(resolved).toBe('/repo/docs/refs.bib');
  });

  test('resolveDocumentBibliographyPath falls back to <basePath>.bib', async () => {
    const existing = new Set(['/repo/docs/paper.bib']);
    // Configured but missing, and not configured at all, both fall back.
    for (const bibliography of ['refs', undefined]) {
      const resolved = await resolveDocumentBibliographyPath(
        bibliography,
        '/repo/docs/paper',
        async (p) => existing.has(p),
        '/repo',
      );
      expect(resolved).toBe('/repo/docs/paper.bib');
    }
  });

  test('resolveDocumentBibliographyPath returns undefined when nothing exists', async () => {
    const resolved = await resolveDocumentBibliographyPath(
      'refs',
      '/repo/docs/paper',
      async () => false,
      '/repo',
    );
    expect(resolved).toBeUndefined();
  });

  test('resolveDocumentBibliography reports whether the hit was configured or fallback', async () => {
    // Export warns when a *configured* bibliography is missing but the
    // fallback exists; that warning hangs on this distinction.
    const existing = new Set(['/repo/docs/refs.bib', '/repo/docs/paper.bib']);
    const fileExists = async (p: string) => existing.has(p);

    const configured = await resolveDocumentBibliography('refs', '/repo/docs/paper', fileExists, '/repo');
    expect(configured).toEqual({ path: '/repo/docs/refs.bib', source: 'configured' });

    const missingConfigured = await resolveDocumentBibliography('other', '/repo/docs/paper', fileExists, '/repo');
    expect(missingConfigured).toEqual({ path: '/repo/docs/paper.bib', source: 'fallback' });

    const unconfigured = await resolveDocumentBibliography(undefined, '/repo/docs/paper', fileExists, '/repo');
    expect(unconfigured).toEqual({ path: '/repo/docs/paper.bib', source: 'fallback' });
  });
});
