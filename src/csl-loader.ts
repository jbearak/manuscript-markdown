// Implementation note — resolution order for isCslAvailable / isCslAvailableAsync:
// bundled style names → bundled directory → cache directories → file path
// (with sourceDir fallback for relative .csl paths). loadStyle/loadStyleAsync
// follow the same cascade but do not accept a sourceDir option.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { access } from 'fs/promises';
import { join, isAbsolute, dirname } from 'path';

const VALID_STYLE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const VALID_LOCALE_TAG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

function validateStyleName(name: string): void {
  if (!isAbsolute(name) && !name.endsWith('.csl') && !VALID_STYLE_NAME.test(name)) {
    throw new Error(`Invalid CSL style name: ${name}`);
  }
}

function validateLocaleTag(lang: string): void {
  if (!VALID_LOCALE_TAG.test(lang)) {
    throw new Error(`Invalid CSL locale tag: ${lang}`);
  }
}

/**
 * Resolve the bundled CSL directory.  Works both when running from source
 * (`src/csl-loader.ts` → `src/csl-styles/`) and from the compiled output
 * (`out/csl-loader.js` → `src/csl-styles/` relative to project root).
 */
function resolveDir(subdir: string): string {
  // When running via bun test, __dirname is the src/ folder
  const fromSrc = join(__dirname, subdir);
  if (existsSync(fromSrc)) return fromSrc;
  // When running compiled (out/csl-loader.js), go up to project root
  const fromOut = join(dirname(__dirname), 'src', subdir);
  if (existsSync(fromOut)) return fromOut;
  return fromSrc; // fallback
}

const BUNDLED_STYLES_DIR = resolveDir('csl-styles');
const BUNDLED_LOCALES_DIR = resolveDir('csl-locales');

const CSL_STYLES_URL = 'https://raw.githubusercontent.com/citation-style-language/styles-distribution/master/';
const CSL_LOCALES_URL = 'https://raw.githubusercontent.com/citation-style-language/locales/master/';

// Cache loaded styles and locales in memory
const styleCache = new Map<string, string>();
const localeCache = new Map<string, string>();

/**
 * Single source of truth for bundled CSL styles (name + display label).
 */
const BUNDLED_STYLE_ENTRIES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'apa', label: 'APA (7th edition)' },
  { name: 'bmj', label: 'BMJ' },
  { name: 'chicago-author-date', label: 'Chicago (Author-Date)' },
  { name: 'chicago-fullnote-bibliography', label: 'Chicago (Full Note)' },
  { name: 'chicago-note-bibliography', label: 'Chicago (Note-Bibliography)' },
  { name: 'modern-language-association', label: 'MLA (9th edition)' },
  { name: 'ieee', label: 'IEEE' },
  { name: 'nature', label: 'Nature' },
  { name: 'cell', label: 'Cell' },
  { name: 'science', label: 'Science' },
  { name: 'american-medical-association', label: 'AMA (American Medical Association)' },
  { name: 'american-chemical-society', label: 'ACS (American Chemical Society)' },
  { name: 'american-political-science-association', label: 'APSA (American Political Science Association)' },
  { name: 'american-sociological-association', label: 'ASA (American Sociological Association)' },
  { name: 'vancouver', label: 'Vancouver' },
  { name: 'harvard-cite-them-right', label: 'Harvard (Cite Them Right)' },
];

/**
 * List of bundled CSL style short names.
 */
export const BUNDLED_STYLES: readonly string[] = BUNDLED_STYLE_ENTRIES.map(e => e.name);

/**
 * Human-readable display names for each bundled CSL style.
 */
export const BUNDLED_STYLE_LABELS: ReadonlyMap<string, string> = new Map(
  BUNDLED_STYLE_ENTRIES.map(e => [e.name, e.label] as const)
);

/**
 * Lightweight existence check for a CSL style (no XML parsing).
 * Checks bundled styles list, bundled directory, optional cache directories,
 * and file paths.
 */
export function isCslAvailable(
  name: string,
  options?: { cacheDirs?: string[]; sourceDir?: string }
): boolean {
  if (!name) return false;

  // Fast in-memory check against known bundled style names
  if (BUNDLED_STYLES.includes(name)) {
    return true;
  }

  // Check bundled directory (for downloaded/cached styles not in the list)
  if (existsSync(join(BUNDLED_STYLES_DIR, name + '.csl'))) {
    return true;
  }

  // Check cache directories
  if (options?.cacheDirs) {
    for (const dir of options.cacheDirs) {
      if (existsSync(join(dir, name + '.csl'))) {
        return true;
      }
    }
  }

  // Check as file path (absolute or relative to sourceDir)
  if (isAbsolute(name) || name.endsWith('.csl')) {
    if (existsSync(name)) return true;
    if (options?.sourceDir && !isAbsolute(name)) {
      if (existsSync(join(options.sourceDir, name))) return true;
    }
  }

  return false;
}

/**
 * Async variant of isCslAvailable that avoids blocking the event loop.
 */
export async function isCslAvailableAsync(
  name: string,
  options?: { cacheDirs?: string[]; sourceDir?: string }
): Promise<boolean> {
  if (!name) return false;

  // Fast in-memory check against known bundled style names
  if (BUNDLED_STYLES.includes(name)) {
    return true;
  }

  const fileExists = async (p: string) => {
    try { await access(p); return true; } catch { return false; }
  };

  // Check bundled directory
  if (await fileExists(join(BUNDLED_STYLES_DIR, name + '.csl'))) {
    return true;
  }

  // Check cache directories
  if (options?.cacheDirs) {
    for (const dir of options.cacheDirs) {
      if (await fileExists(join(dir, name + '.csl'))) {
        return true;
      }
    }
  }

  // Check as file path (absolute or relative to sourceDir)
  if (isAbsolute(name) || name.endsWith('.csl')) {
    if (await fileExists(name)) return true;
    if (options?.sourceDir && !isAbsolute(name)) {
      if (await fileExists(join(options.sourceDir, name))) return true;
    }
  }

  return false;
}

/**
 * Load a CSL style XML string by short name or file path (synchronous).
 * - If `name` matches a bundled or previously-downloaded style, loads from disk.
 * - Otherwise, treats `name` as a file path and reads from disk.
 * - Does NOT download. Use `loadStyleAsync` for on-demand downloading.
 */
export function loadStyle(name: string): string {
  validateStyleName(name);
  const cached = styleCache.get(name);
  if (cached) return cached;

  let xml: string;
  // Try reading from the bundled directory (covers both listed and previously-downloaded styles)
  const bundledPath = join(BUNDLED_STYLES_DIR, name + '.csl');
  if (existsSync(bundledPath)) {
    xml = readFileSync(bundledPath, 'utf-8');
  } else if (isAbsolute(name) || name.endsWith('.csl')) {
    xml = readFileSync(name, 'utf-8');
  } else {
    throw new Error(`CSL style not found: ${name}. Use loadStyleAsync() to download from the CSL repository.`);
  }

  styleCache.set(name, xml);
  return xml;
}

/**
 * Load a CSL style XML string by short name or file path.
 * If the style is not bundled, attempts to download it from the
 * CSL styles distribution repository and caches it locally.
 */
export async function loadStyleAsync(name: string, cacheDir?: string): Promise<string> {
  validateStyleName(name);
  // Check memory cache first
  const cached = styleCache.get(name);
  if (cached) return cached;

  // Try loading from disk (bundled or previously-downloaded)
  const bundledPath = join(BUNDLED_STYLES_DIR, name + '.csl');
  if (existsSync(bundledPath)) {
    const xml = readFileSync(bundledPath, 'utf-8');
    styleCache.set(name, xml);
    return xml;
  }

  // If it's an absolute path or .csl file path, read directly
  if (isAbsolute(name) || name.endsWith('.csl')) {
    const xml = readFileSync(name, 'utf-8');
    styleCache.set(name, xml);
    return xml;
  }

  // Try downloading from the CSL repository
  const url = CSL_STYLES_URL + (name.endsWith('.csl') ? name.slice(0, -4) : name) + '.csl';
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const xml = await response.text();
    if (!xml.includes('<style') || !xml.includes('xmlns="http://purl.org/net/xbiblio/csl"')) {
      throw new Error('Downloaded content is not a valid CSL style');
    }

    // Cache to writable directory (prefer cacheDir over bundled dir which may be read-only)
    const diskCacheDir = cacheDir ?? BUNDLED_STYLES_DIR;
    try {
      if (!existsSync(diskCacheDir)) {
        mkdirSync(diskCacheDir, { recursive: true });
      }
      writeFileSync(join(diskCacheDir, name + '.csl'), xml, 'utf-8');
    } catch {
      // Disk caching is best-effort; memory cache still works
    }

    styleCache.set(name, xml);
    return xml;
  } catch (e) {
    throw new Error(`CSL style "${name}" not found locally and could not be downloaded from ${url}: ${e}`);
  }
}

/**
 * Download a CSL style from the repository and save it to `targetDir`.
 * Returns the XML string on success, or throws on failure.
 */
export async function downloadStyle(name: string, targetDir: string): Promise<string> {
  validateStyleName(name);
  const url = CSL_STYLES_URL + (name.endsWith('.csl') ? name.slice(0, -4) : name) + '.csl';
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const xml = await response.text();
  if (!xml.includes('<style') || !xml.includes('xmlns="http://purl.org/net/xbiblio/csl"')) {
    throw new Error('Downloaded content is not a valid CSL style');
  }

  // Save to target directory
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }
  writeFileSync(join(targetDir, name.endsWith('.csl') ? name : name + '.csl'), xml, 'utf-8');

  // Also cache in memory
  styleCache.set(name, xml);
  return xml;
}

/**
 * Load a CSL locale XML string by language tag (e.g., "en-US").
 * Falls back to en-US if the requested locale is not available.
 */
export function loadLocale(lang: string): string {
  validateLocaleTag(lang);
  const cached = localeCache.get(lang);
  if (cached) return cached;

  const filename = `locales-${lang}.xml`;
  const localePath = join(BUNDLED_LOCALES_DIR, filename);
  if (existsSync(localePath)) {
    const xml = readFileSync(localePath, 'utf-8');
    localeCache.set(lang, xml);
    return xml;
  }

  // Fall back to en-US
  if (lang !== 'en-US') {
    return loadLocale('en-US');
  }
  throw new Error(`CSL locale not found: ${lang}`);
}

/**
 * Load a CSL locale, downloading if not available locally.
 */
export async function loadLocaleAsync(lang: string): Promise<string> {
  validateLocaleTag(lang);
  const cached = localeCache.get(lang);
  if (cached) return cached;

  const filename = `locales-${lang}.xml`;
  const localePath = join(BUNDLED_LOCALES_DIR, filename);
  if (existsSync(localePath)) {
    const xml = readFileSync(localePath, 'utf-8');
    localeCache.set(lang, xml);
    return xml;
  }

  // Try downloading
  const url = CSL_LOCALES_URL + filename;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    if (!xml.includes('xmlns="http://purl.org/net/xbiblio/csl"')) {
      throw new Error('Downloaded content is not a valid CSL locale');
    }

    // Cache to disk
    try {
      if (!existsSync(BUNDLED_LOCALES_DIR)) {
        mkdirSync(BUNDLED_LOCALES_DIR, { recursive: true });
      }
      writeFileSync(localePath, xml, 'utf-8');
    } catch { /* best-effort */ }

    localeCache.set(lang, xml);
    return xml;
  } catch {
    // Fall back to en-US
    if (lang !== 'en-US') {
      return loadLocaleAsync('en-US');
    }
    throw new Error(`CSL locale not found and could not be downloaded: ${lang}`);
  }
}
