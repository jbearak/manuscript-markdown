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

async function runDocxToMd(options: CliOptions) {
  // Placeholder for Task 2
  console.log('DOCX to Markdown conversion not yet implemented');
}

async function runMdToDocx(options: CliOptions) {
  // Placeholder for Task 3
  console.log('Markdown to DOCX conversion not yet implemented');
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