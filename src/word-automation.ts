import JSZip from 'jszip';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { homedir, platform } from 'os';

export type DirtyFlagState = 'DIRTY' | 'CLEAN';

export interface DocxPartDiff {
  path: string;
  diff: string | null;
}

export interface DocxDiffSummary {
  changedParts: string[];
  addedParts: string[];
  removedParts: string[];
  changedDiffs: DocxPartDiff[];
  originalParts: Map<string, string>;
  modifiedParts: Map<string, string>;
}

export interface WordAutomationAvailability {
  available: boolean;
  reason?: string;
}

export const wordDocsDir = join(homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents');
export const wordRoundtripOutputDir = join(__dirname, '..', 'scripts', 'word-roundtrip-output');

export function isMacOS(): boolean {
  return platform() === 'darwin';
}

export function ensureDirectory(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function resetDirectory(dirPath: string): void {
  rmSync(dirPath, { recursive: true, force: true });
  mkdirSync(dirPath, { recursive: true });
}

export function ensureWordDocsDir(): void {
  ensureDirectory(wordDocsDir);
}

export function quitWordIfRunning(): void {
  runAppleScript([
    'if application "Microsoft Word" is running then',
    '  tell application "Microsoft Word" to quit saving no',
    '  delay 2',
    'end if',
  ], 30_000);
}

function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function runAppleScript(lines: string[], timeoutMs = 120_000): string {
  const args = lines.flatMap(line => ['-e', line]);
  const result = spawnSync('osascript', args, {
    timeout: timeoutMs,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error('osascript failed: ' + (result.stderr || 'status ' + result.status));
  }
  return (result.stdout + '\n' + result.stderr).trim();
}

export function hasWordInstalled(): boolean {
  if (!isMacOS()) return false;
  const result = spawnSync('osascript', ['-e', 'id of application "Microsoft Word"'], {
    timeout: 15_000,
    encoding: 'utf-8',
  });
  return result.status === 0;
}

export function getWordAutomationAvailability(): WordAutomationAvailability {
  if (!isMacOS()) {
    return { available: false, reason: 'Word automation requires macOS.' };
  }
  if (!hasWordInstalled()) {
    return { available: false, reason: 'Microsoft Word is not installed.' };
  }
  return { available: true };
}

export function checkDirtyFlag(filePath: string): DirtyFlagState {
  const escapedPath = escapeAppleScriptString(filePath);
  const output = runAppleScript([
    'tell application "Microsoft Word"',
    '  set targetFile to POSIX file "' + escapedPath + '"',
    '  activate',
    '  delay 5',
    '  open targetFile',
    '  delay 5',
    '  set openedDoc to missing value',
    '  set docsList to get documents',
    '  repeat with docRef in docsList',
    '    try',
    '      if (full name of docRef as text) is (targetFile as text) then',
    '        set openedDoc to docRef',
    '        exit repeat',
    '      end if',
    '    end try',
    '  end repeat',
    '  if openedDoc is missing value then error "Unable to resolve opened document for " & (targetFile as text)',
    '  set maxChecks to 10',
    '  set allClean to true',
    '  repeat maxChecks times',
    '    delay 1',
    '    if not (saved of openedDoc) then',
    '      set allClean to false',
    '      exit repeat',
    '    end if',
    '  end repeat',
    '  if allClean then',
    '    log "CLEAN"',
    '  else',
    '    log "DIRTY"',
    '  end if',
    '  close openedDoc saving no',
    'end tell',
  ]);
  return output.includes('DIRTY') ? 'DIRTY' : 'CLEAN';
}

export function openAndSaveInWord(
  filePath: string,
  options: { activateDelaySeconds?: number; openDelaySeconds?: number; saveDelaySeconds?: number } = {}
): void {
  const activateDelaySeconds = options.activateDelaySeconds ?? 3;
  const openDelaySeconds = options.openDelaySeconds ?? 3;
  const saveDelaySeconds = options.saveDelaySeconds ?? 2;
  const escapedPath = escapeAppleScriptString(filePath);
  runAppleScript([
    'tell application "Microsoft Word"',
    '  set targetFile to POSIX file "' + escapedPath + '"',
    '  activate',
    '  delay ' + activateDelaySeconds,
    '  open targetFile',
    '  delay ' + openDelaySeconds,
    '  set openedDoc to missing value',
    '  set docsList to get documents',
    '  repeat with docRef in docsList',
    '    try',
    '      if (full name of docRef as text) is (targetFile as text) then',
    '        set openedDoc to docRef',
    '        exit repeat',
    '      end if',
    '    end try',
    '  end repeat',
    '  if openedDoc is missing value then error "Unable to resolve opened document for " & (targetFile as text)',
    '  save openedDoc',
    '  delay ' + saveDelaySeconds,
    '  close openedDoc saving no',
    'end tell',
  ], 60_000);
}

export function saveCopyFromWord(originalPath: string, savedCopyPath: string): void {
  copyFileSync(originalPath, savedCopyPath);
  openAndSaveInWord(savedCopyPath, { activateDelaySeconds: 3, openDelaySeconds: 5, saveDelaySeconds: 3 });
}

export async function unpackZipEntries(data: Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(data);
  const entries = new Map<string, string>();
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    try {
      entries.set(path, await file.async('string'));
    } catch {
      const bin = await file.async('uint8array');
      entries.set(path, '[binary ' + bin.length + ' bytes]');
    }
  }
  return entries;
}

function diffStrings(a: string, b: string, label: string, tempDir: string): string | null {
  if (a === b) return null;
  ensureDirectory(tempDir);
  const safe = sanitizeArtifactName(label);
  const tmpA = join(tempDir, safe + '.a.tmp');
  const tmpB = join(tempDir, safe + '.b.tmp');
  writeFileSync(tmpA, a);
  writeFileSync(tmpB, b);
  const result = spawnSync('diff', [
    '-u',
    '--label', 'original/' + label,
    '--label', 'word/' + label,
    tmpA, tmpB,
  ], { encoding: 'utf-8' });
  try { unlinkSync(tmpA); } catch { /* Best-effort temporary-file cleanup. */ }
  try { unlinkSync(tmpB); } catch { /* Best-effort temporary-file cleanup. */ }
  return result.stdout || null;
}

export async function diffDocxParts(
  originalData: Uint8Array,
  modifiedData: Uint8Array,
  tempDir: string
): Promise<DocxDiffSummary> {
  const originalParts = await unpackZipEntries(originalData);
  const modifiedParts = await unpackZipEntries(modifiedData);
  const allPaths = new Set([...originalParts.keys(), ...modifiedParts.keys()]);
  const changedParts: string[] = [];
  const addedParts: string[] = [];
  const removedParts: string[] = [];
  const changedDiffs: DocxPartDiff[] = [];

  for (const path of [...allPaths].sort()) {
    const original = originalParts.get(path);
    const modified = modifiedParts.get(path);
    if (original === undefined) {
      addedParts.push(path);
      continue;
    }
    if (modified === undefined) {
      removedParts.push(path);
      continue;
    }
    if (original !== modified) {
      changedParts.push(path);
      changedDiffs.push({ path, diff: diffStrings(original, modified, path, tempDir) });
    }
  }

  return { changedParts, addedParts, removedParts, changedDiffs, originalParts, modifiedParts };
}

export async function replacePartInZip(
  originalData: Uint8Array,
  partPath: string,
  replacementContent: string
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(originalData);
  zip.file(partPath, replacementContent);
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path]?.dir) delete (zip.files as Record<string, unknown>)[path];
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export function readUint8Array(filePath: string): Uint8Array {
  return new Uint8Array(readFileSync(filePath));
}

export function sanitizeArtifactName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function writeJsonFile(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

export function writeTextFile(filePath: string, text: string): void {
  writeFileSync(filePath, text);
}

export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}
