import { join, isAbsolute, dirname } from 'path';
import { normalizeBibPath } from './frontmatter';

export function bibliographyCandidatePaths(
  bibliography: string,
  mdDir: string,
  workspaceRoot?: string,
): string[] {
  const bibFile = normalizeBibPath(bibliography);
  if (isAbsolute(bibFile)) {
    return [bibFile];
  }

  const candidates = [join(mdDir, bibFile)];
  if (workspaceRoot) {
    const workspacePath = join(workspaceRoot, bibFile);
    if (!candidates.includes(workspacePath)) candidates.push(workspacePath);
  }
  return candidates;
}

export async function resolveExistingBibliographyPath(
  bibliography: string,
  mdDir: string,
  fileExists: (path: string) => Promise<boolean>,
  workspaceRoot?: string,
): Promise<string | undefined> {
  for (const candidate of bibliographyCandidatePaths(bibliography, mdDir, workspaceRoot)) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

export function defaultBibliographyWritePath(
  bibliography: string,
  mdDir: string,
): string {
  const bibFile = normalizeBibPath(bibliography);
  return isAbsolute(bibFile) ? bibFile : join(mdDir, bibFile);
}

export function resolveBibliographyWritePath(
  bibliography: string,
  mdDir: string,
  resolvedExistingPath?: string,
): string {
  return resolvedExistingPath ?? defaultBibliographyWritePath(bibliography, mdDir);
}

export async function resolveBibliographyWritePathForOutput(
  bibliography: string,
  mdDir: string,
  fileExists: (path: string) => Promise<boolean>,
  workspaceRoot?: string,
): Promise<string> {
  const resolvedExistingPath = await resolveExistingBibliographyPath(
    bibliography,
    mdDir,
    fileExists,
    workspaceRoot,
  );
  return resolveBibliographyWritePath(bibliography, mdDir, resolvedExistingPath);
}

/** The bibliography file a Markdown document reads from, as export resolves
 *  it: the frontmatter `bibliography:` candidates first (beside the document,
 *  then the workspace root), falling back to `<basePath>.bib`.  Returns the
 *  first path that exists, or undefined with no guessing — callers that
 *  would *create* a bibliography use the write-path helpers instead. */
export async function resolveDocumentBibliographyPath(
  bibliography: string | undefined,
  basePath: string,
  fileExists: (path: string) => Promise<boolean>,
  workspaceRoot?: string,
): Promise<string | undefined> {
  if (bibliography) {
    const configured = await resolveExistingBibliographyPath(
      bibliography,
      dirname(basePath),
      fileExists,
      workspaceRoot,
    );
    if (configured !== undefined) return configured;
  }
  const fallback = basePath + '.bib';
  return (await fileExists(fallback)) ? fallback : undefined;
}
