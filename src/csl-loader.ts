import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, isAbsolute, dirname } from 'path';

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
 * List of bundled CSL style short names.
 */
export const BUNDLED_STYLES = [
  'apa',
  'bmj',
  'chicago-author-date',
  'chicago-fullnote-bibliography',
  'chicago-note-bibliography',
  'modern-language-association',
  'ieee',
  'nature',
  'cell',
  'science',
  'american-medical-association',
  'american-chemical-society',
  'american-political-science-association',
  'american-sociological-association',
  'vancouver',
  'harvard-cite-them-right',
];

/**
 * Load a CSL style XML string by short name or file path (synchronous).
 * - If `name` matches a bundled or previously-downloaded style, loads from disk.
 * - Otherwise, treats `name` as a file path and reads from disk.
 * - Does NOT download. Use `loadStyleAsync` for on-demand downloading.
 */
export function loadStyle(name: string): string {
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
export async function loadStyleAsync(name: string): Promise<string> {
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
  const url = CSL_STYLES_URL + name + '.csl';
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const xml = await response.text();
    if (!xml.includes('<style')) {
      throw new Error('Downloaded content is not a valid CSL style');
    }

    // Cache to disk for future use
    try {
      if (!existsSync(BUNDLED_STYLES_DIR)) {
        mkdirSync(BUNDLED_STYLES_DIR, { recursive: true });
      }
      writeFileSync(bundledPath, xml, 'utf-8');
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
  const url = CSL_STYLES_URL + name + '.csl';
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const xml = await response.text();
  if (!xml.includes('<style')) {
    throw new Error('Downloaded content is not a valid CSL style');
  }

  // Save to target directory
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }
  writeFileSync(join(targetDir, name + '.csl'), xml, 'utf-8');

  // Also cache in memory
  styleCache.set(name, xml);
  return xml;
}

/**
 * Load a CSL locale XML string by language tag (e.g., "en-US").
 * Falls back to en-US if the requested locale is not available.
 */
export function loadLocale(lang: string): string {
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
