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
    
    if (arg === '--help') {
      options.help = true;
    } else if (arg === '--version') {
      options.version = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--output') {
      options.outputPath = args[++i];
    } else if (arg === '--citation-key-format') {
      const format = args[++i];
      if (!['authorYearTitle', 'authorYear', 'numeric'].includes(format)) {
        throw new Error(`Invalid citation key format "${format}". Use authorYearTitle, authorYear, or numeric`);
      }
      options.citationKeyFormat = format as any;
    } else if (arg === '--bib') {
      options.bibPath = args[++i];
    } else if (arg === '--template') {
      options.templatePath = args[++i];
    } else if (arg === '--author') {
      options.authorName = args[++i];
    } else if (arg === '--mixed-citation-style') {
      const style = args[++i];
      if (!['separate', 'unified'].includes(style)) {
        throw new Error(`Invalid mixed citation style "${style}". Use separate or unified`);
      }
      options.mixedCitationStyle = style as any;
    } else if (arg === '--csl-cache-dir') {
      options.cslCacheDir = args[++i];
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
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  console.log(packageJson.version);
}

export function deriveDocxToMdPaths(inputPath: string, outputPath?: string): { mdPath: string; bibPath: string } {
  const inputDir = path.dirname(inputPath);
  const inputBase = path.basename(inputPath, '.docx');
  const basePath = outputPath
    ? outputPath.replace(/\.md$/, '')
    : path.join(inputDir, inputBase);
  return { mdPath: basePath + '.md', bibPath: basePath + '.bib' };
}

async function runDocxToMd(options: CliOptions) {
  const { convertDocx } = await import('./converter');
  const data = new Uint8Array(fs.readFileSync(options.inputPath));

  const { mdPath, bibPath } = deriveDocxToMdPaths(options.inputPath, options.outputPath);

  // Check output conflicts
  if (!options.force) {
    const conflicts: string[] = [];
    if (fs.existsSync(mdPath)) conflicts.push(mdPath);
    if (fs.existsSync(bibPath)) conflicts.push(bibPath);
    if (conflicts.length > 0) {
      throw new Error(`Output file(s) already exist: ${conflicts.join(', ')}\nUse --force to overwrite`);
    }
  }

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
  const inputBase = path.basename(inputPath, '.md');
  return path.join(inputDir, inputBase + '.docx');
}

export function resolveAuthor(authorFlag?: string): string {
  return authorFlag || os.userInfo().username;
}

async function runMdToDocx(options: CliOptions) {
  const { convertMdToDocx } = await import('./md-to-docx');
  const markdown = fs.readFileSync(options.inputPath, 'utf8');

  // Auto-detect or use specified bib file
  let bibtex: string | undefined;
  const bibPath = options.bibPath || path.join(
    path.dirname(options.inputPath),
    path.basename(options.inputPath, '.md') + '.bib'
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
  if (!options.force && fs.existsSync(docxPath)) {
    throw new Error(`Output file already exists: ${docxPath}\nUse --force to overwrite`);
  }

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