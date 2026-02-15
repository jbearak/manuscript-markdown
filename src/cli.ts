import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CliOptions {
  help: boolean;
  version: boolean;
  inputPath: string;
  outputPath?: string;
  force: boolean;
  citationKeyFormat: 'authorYearTitle' | 'authorYear' | 'numeric';
  bibPath?: string;
  templatePath?: string;
  authorName?: string;
  mixedCitationStyle: 'separate' | 'unified';
  cslCacheDir: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const options: CliOptions = {
    help: false,
    version: false,
    inputPath: '',
    force: false,
    citationKeyFormat: 'authorYearTitle',
    mixedCitationStyle: 'separate',
    cslCacheDir: path.join(os.homedir(), '.manuscript-markdown', 'csl-cache')
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const requireValue = (flag: string): string => {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      i++;
      return args[i];
    };
    
    if (arg === '--help') {
      options.help = true;
    } else if (arg === '--version') {
      options.version = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--output') {
      options.outputPath = requireValue('--output');
    } else if (arg === '--citation-key-format') {
      const format = requireValue('--citation-key-format');
      if (!['authorYearTitle', 'authorYear', 'numeric'].includes(format)) {
        throw new Error(`Invalid citation key format "${format}". Use authorYearTitle, authorYear, or numeric`);
      }
      options.citationKeyFormat = format as any;
    } else if (arg === '--bib') {
      options.bibPath = requireValue('--bib');
    } else if (arg === '--template') {
      options.templatePath = requireValue('--template');
    } else if (arg === '--author') {
      options.authorName = requireValue('--author');
    } else if (arg === '--mixed-citation-style') {
      const style = requireValue('--mixed-citation-style');
      if (!['separate', 'unified'].includes(style)) {
        throw new Error(`Invalid mixed citation style "${style}". Use separate or unified`);
      }
      options.mixedCitationStyle = style as any;
    } else if (arg === '--csl-cache-dir') {
      options.cslCacheDir = requireValue('--csl-cache-dir');
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option "${arg}"`);
    } else if (!options.inputPath) {
      options.inputPath = arg;
    }
  }

  if (!options.help && !options.version && !options.inputPath) {
    throw new Error('No input file specified');
  }

  return options;
}

export function detectDirection(inputPath: string): 'docx-to-md' | 'md-to-docx' {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.docx') return 'docx-to-md';
  if (ext === '.md') return 'md-to-docx';
  throw new Error(`Unsupported file type "${ext}". Use .docx or .md`);
}

function showHelp() {
  console.log(`Usage: manuscript-markdown <input> [options]

Convert between Manuscript Markdown and DOCX.
Conversion direction is determined by input file extension.

Options:
  --help                          Show this help message
  --version                       Show version number
  --output <path>                 Output file path
  --force                         Overwrite existing output files
  --citation-key-format <fmt>     Citation key format: authorYearTitle, authorYear, numeric (default: authorYearTitle)
  --bib <path>                    BibTeX file path (MD→DOCX)
  --template <path>               Template DOCX file (MD→DOCX)
  --author <name>                 Author name (MD→DOCX, default: OS username)
  --mixed-citation-style <style>  Mixed citation style: separate, unified (default: separate)
  --csl-cache-dir <path>          CSL style cache directory`);
}

function showVersion() {
  const { version } = require('../package.json');
  console.log(version);
}

export function deriveDocxToMdPaths(inputPath: string, outputPath?: string): { mdPath: string; bibPath: string } {
  const inputDir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const inputBase = path.basename(inputPath, ext);
  const basePath = outputPath
    ? outputPath.replace(/\.md$/i, '')
    : path.join(inputDir, inputBase);
  return { mdPath: basePath + '.md', bibPath: basePath + '.bib' };
}
export function findDocxToMdConflicts(
  mdPath: string,
  bibPath: string,
  checks: { checkMd?: boolean; checkBib?: boolean } = {}
): string[] {
  const { checkMd = true, checkBib = true } = checks;
  const conflicts: string[] = [];
  if (checkMd && fs.existsSync(mdPath)) conflicts.push(mdPath);
  if (checkBib && fs.existsSync(bibPath)) conflicts.push(bibPath);
  return conflicts;
}

export function assertNoDocxToMdConflicts(
  mdPath: string,
  bibPath: string,
  force: boolean,
  checks: { checkMd?: boolean; checkBib?: boolean } = {}
) {
  if (force) return;
  const conflicts = findDocxToMdConflicts(mdPath, bibPath, checks);
  if (conflicts.length > 0) {
    throw new Error(`Output file(s) already exist: ${conflicts.join(', ')}\nUse --force to overwrite`);
  }
}

async function runDocxToMd(options: CliOptions) {
  const { convertDocx } = await import('./converter');
  const data = new Uint8Array(fs.readFileSync(options.inputPath));

  const { mdPath, bibPath } = deriveDocxToMdPaths(options.inputPath, options.outputPath);
  // Check output conflicts up-front so dual conflicts are reported together.
  assertNoDocxToMdConflicts(mdPath, bibPath, options.force);

  const result = await convertDocx(data, options.citationKeyFormat);
  fs.writeFileSync(mdPath, result.markdown);
  console.log(mdPath);

  if (result.bibtex) {
    fs.writeFileSync(bibPath, result.bibtex);
    console.log(bibPath);
  }
}

export function deriveMdToDocxPath(inputPath: string, outputPath?: string): string {
  if (outputPath) return outputPath;
  const inputDir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const inputBase = path.basename(inputPath, ext);
  return path.join(inputDir, inputBase + '.docx');
}

export function resolveAuthor(authorFlag?: string): string {
  return authorFlag || os.userInfo().username;
}

export function assertNoMdToDocxConflict(docxPath: string, force: boolean) {
  if (!force && fs.existsSync(docxPath)) {
    throw new Error(`Output file already exists: ${docxPath}\nUse --force to overwrite`);
  }
}

async function runMdToDocx(options: CliOptions) {
  const { convertMdToDocx } = await import('./md-to-docx');
  const markdown = fs.readFileSync(options.inputPath, 'utf8');

  // Auto-detect or use specified bib file
  let bibtex: string | undefined;
  const inputExt = path.extname(options.inputPath);
  const inputBase = path.basename(options.inputPath, inputExt);
  const bibPath = options.bibPath || path.join(
    path.dirname(options.inputPath),
    inputBase + '.bib'
  );
  if (options.bibPath) {
    if (!fs.existsSync(options.bibPath)) {
      throw new Error(`BibTeX file not found: ${options.bibPath}`);
    }
    bibtex = fs.readFileSync(options.bibPath, 'utf8');
  } else if (fs.existsSync(bibPath)) {
    bibtex = fs.readFileSync(bibPath, 'utf8');
  }

  // Read template if specified
  let templateDocx: Uint8Array | undefined;
  if (options.templatePath) {
    if (!fs.existsSync(options.templatePath)) {
      throw new Error(`Template file not found: ${options.templatePath}`);
    }
    templateDocx = new Uint8Array(fs.readFileSync(options.templatePath));
  }

  const docxPath = deriveMdToDocxPath(options.inputPath, options.outputPath);
  // Check output conflict
  assertNoMdToDocxConflict(docxPath, options.force);

  const authorName = resolveAuthor(options.authorName);

  const result = await convertMdToDocx(markdown, {
    bibtex,
    authorName,
    templateDocx,
    cslCacheDir: options.cslCacheDir,
    sourceDir: path.dirname(options.inputPath),
    onStyleNotFound: async () => true,
    mixedCitationStyle: options.mixedCitationStyle,
  });

  fs.writeFileSync(docxPath, result.docx);
  console.log(docxPath);

  for (const warning of result.warnings) {
    console.error(`Warning: ${warning}`);
  }
}

export async function main() {
  const options = parseArgs(process.argv);

  if (options.help) {
    showHelp();
    return;
  }

  if (options.version) {
    showVersion();
    return;
  }

  if (!fs.existsSync(options.inputPath)) {
    throw new Error(`File not found: ${options.inputPath}`);
  }

  const direction = detectDirection(options.inputPath);

  if (direction === 'docx-to-md') {
    await runDocxToMd(options);
  } else {
    await runMdToDocx(options);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
