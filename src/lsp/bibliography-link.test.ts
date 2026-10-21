import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findBibliographyLink } from './bibliography-link';
import { fsPathToUri } from './citekey-language';
import { fastestRunAsync } from '../test-timing';

// The files the links name, beside a document, in a folder under it, and
// in a workspace root above another document:
//   paper.md (not written), paper.bib, refs.bib, my refs.bib, a.bib, b.bib,
//   refs/library.bib,
//   root/shared.bib, root/both.bib,
//   root/chapter/ch1.md (not written), root/chapter/local.bib, root/chapter/both.bib
let tmp: string;
let paperUri: string;
let chapterUri: string;
let root: string;

beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-lsp-bib-link-'));
	root = path.join(tmp, 'root');
	for (const file of [
		'paper.bib', 'refs.bib', 'my refs.bib', 'a.bib', 'b.bib', path.join('refs', 'library.bib'),
		path.join('root', 'shared.bib'), path.join('root', 'both.bib'),
		path.join('root', 'chapter', 'local.bib'), path.join('root', 'chapter', 'both.bib'),
	]) {
		fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
		fs.writeFileSync(path.join(tmp, file), '@article{a,\n  title={A}\n}\n');
	}
	paperUri = fsPathToUri(path.join(tmp, 'paper.md'));
	chapterUri = fsPathToUri(path.join(root, 'chapter', 'ch1.md'));
});

afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** `marked` without its « and », and the offsets of the text between them, the link's range */
function unmark(marked: string): { text: string; start: number; end: number } {
	const start = marked.indexOf('«');
	const end = marked.indexOf('»') - 1;
	return { text: marked.replace('«', '').replace('»', ''), start, end };
}

/** The link of the document at `uri` that is `marked`, with the link's text and the file relative to `tmp` */
async function linkOf(marked: string, uri: string, roots: string[] = []) {
	const { text } = unmark(marked);
	const link = await findBibliographyLink(uri, text, roots);
	return link && { text: text.slice(link.start, link.end), start: link.start, end: link.end, file: path.relative(tmp, link.path) };
}

describe('findBibliographyLink', () => {
	test.each([
		['bibliography:', '---\nbibliography: «refs.bib»\n---\n\nText [@a].\n', 'refs.bib'],
		['bib:', '---\nbib: «refs.bib»\n---\n', 'refs.bib'],
		['bibtex:', '---\nbibtex: «refs.bib»\n---\n', 'refs.bib'],
		['a value in double quotes', '---\nbibliography: "«refs.bib»"\n---\n', 'refs.bib'],
		['a value in single quotes', '---\nbibliography: \'«refs.bib»\'\n---\n', 'refs.bib'],
		['a value in quotes with spaces after them', '---\nbibliography: "«refs.bib»"   \n---\n', 'refs.bib'],
		['a value with spaces after it', '---\nbibliography: «refs.bib» \t\n---\n', 'refs.bib'],
		['a value with spaces in it', '---\nbibliography: «my refs.bib»\n---\n', 'my refs.bib'],
		['a value with spaces in it in quotes, without .bib', '---\nbibliography: "«my refs»"\n---\n', 'my refs.bib'],
		['a value without .bib', '---\nbibliography: «refs»\n---\n', 'refs.bib'],
		['a relative path in a subfolder', '---\nbibliography: «refs/library.bib»\n---\n', path.join('refs', 'library.bib')],
		['a relative path in a subfolder without .bib', '---\nbibliography: «refs/library»\n---\n', path.join('refs', 'library.bib')],
		['a key with a space before its colon', '---\nbibliography : «refs.bib»\n---\n', 'refs.bib'],
		['a key after other keys', '---\ntitle: Paper\nauthor: Me\nbibliography: «refs.bib»\ncsl: apa\n---\n', 'refs.bib'],
		['a key after a styles block', '---\nstyles:\n  box:\n    font: Arial\nbibliography: «refs.bib»\n---\n', 'refs.bib'],
		// The first key with a value wins, as export reads them
		['the first of two keys', '---\nbib: «a.bib»\nbibliography: b.bib\n---\n', 'a.bib'],
		['the second of two keys, where the first has no value', '---\nbibliography:\nbibtex: «b.bib»\n---\n', 'b.bib'],
		// A block list's first item of text, as export reads it
		['a block list\'s first item', '---\nbibliography:\n  - «refs.bib»\n  - a.bib\n---\n', 'refs.bib'],
		['a block list after a comment, in quotes', '---\nbibliography: # the library\n  - "«refs/library.bib»"\n---\n', path.join('refs', 'library.bib')],
		['a block list with its - unindented', '---\nbib:\n- «refs.bib»\n---\n', 'refs.bib'],
		['a block list whose first item is empty', '---\nbibliography:\n  -\n  - «a.bib»\n---\n', 'a.bib'],
		['a block list, with blank lines and comments between its items', '---\nbibliography:\n\n  # none yet\n  -   «b.bib»  \n---\n', 'b.bib'],
		// CRLF line ends
		['a value in a document of CRLF lines', '---\r\nbibliography: «refs.bib»\r\n---\r\n\r\nText.\r\n', 'refs.bib'],
		['a quoted value in a document of CRLF lines', '---\r\ntitle: T\r\nbib: "«refs»"\r\n---\r\n', 'refs.bib'],
		['a block list in a document of CRLF lines', '---\r\nbibliography:\r\n  - «refs.bib»\r\n---\r\n', 'refs.bib'],
	])('links %s', async (_name, marked, file) => {
		const { start, end } = unmark(marked);
		const linked = marked.slice(start + 1, end + 1);
		expect(await linkOf(marked, paperUri)).toEqual({ text: linked, start, end, file });
	});

	test('links an absolute path', async () => {
		const marked = '---\nbibliography: "«' + path.join(tmp, 'my refs') + '»"\n---\n';
		const { start, end } = unmark(marked);
		expect(await linkOf(marked, paperUri)).toEqual({ text: path.join(tmp, 'my refs'), start, end, file: 'my refs.bib' });
		// With a workspace root, under which the path names no file
		expect(await linkOf(marked, paperUri, [root])).toEqual({ text: path.join(tmp, 'my refs'), start, end, file: 'my refs.bib' });
	});

	test.each([
		// A path that starts with / in the workspace root
		['a root-relative path', '---\nbibliography: «/shared.bib»\n---\n', path.join('root', 'shared.bib')],
		['a root-relative path without .bib', '---\nbibliography: «/shared»\n---\n', path.join('root', 'shared.bib')],
		// A relative path beside the document, then in the workspace root
		['a relative path beside the document', '---\nbibliography: «local.bib»\n---\n', path.join('root', 'chapter', 'local.bib')],
		['a relative path in the workspace root', '---\nbibliography: «shared.bib»\n---\n', path.join('root', 'shared.bib')],
		['a relative path beside the document and in the workspace root', '---\nbibliography: «both»\n---\n', path.join('root', 'chapter', 'both.bib')],
		['a root-relative path in the workspace root and beside the document', '---\nbibliography: «/both»\n---\n', path.join('root', 'both.bib')],
	])('links %s to the file the server resolves', async (_name, marked, file) => {
		const { start, end } = unmark(marked);
		expect(await linkOf(marked, chapterUri, [root])).toEqual({ text: marked.slice(start + 1, end + 1), start, end, file });
	});

	test.each([
		['a missing file', '---\nbibliography: missing.bib\n---\n'],
		// Export reads the first, which names no file, not the second
		['a missing file before a key that names one', '---\nbibliography: missing.bib\nbib: refs.bib\n---\n'],
		['a document with no frontmatter', 'Text [@a].\n'],
		['a key in a document with no frontmatter', 'bibliography: refs.bib\n'],
		['frontmatter that isn\'t at the top', 'Intro.\n\n---\nbibliography: refs.bib\n---\n'],
		['frontmatter with no closing line', '---\nbibliography: refs.bib\n\nText.\n'],
		['a key with no value', '---\nbibliography:\n---\n'],
		['a key in quotes', '---\n"bibliography": refs.bib\n---\n'],
		['a key in a comment', '---\n# bibliography: refs.bib\n---\n'],
		['a key in a styles block', '---\nstyles:\n  bibliography: refs.bib\n---\n'],
		['a block list whose item is a mapping', '---\nbibliography:\n  - path: refs.bib\n---\n'],
		// Export reads the comment as part of the path, and finds no file
		['a value with a comment after it', '---\nbibliography: refs.bib # the library\n---\n'],
		['a root-relative path with no workspace root', '---\nbibliography: /shared.bib\n---\n'],
	])('gives no link for %s, though the document\'s name has a .bib file', async (_name, text) => {
		expect(fs.existsSync(path.join(tmp, 'paper.bib'))).toBe(true);
		expect(await findBibliographyLink(paperUri, text, [])).toBeUndefined();
	});

	test('gives no link in a document with no file', async () => {
		expect(await findBibliographyLink('untitled:Untitled-1', '---\nbibliography: ' + path.join(tmp, 'refs.bib') + '\n---\n', [tmp])).toBeUndefined();
	});

	test('reads a long frontmatter block, and nothing past it, in linear time', async () => {
		// Many lists, many blank lines and comments after a key with none,
		// many styles, then the key, and a long body after the block
		const block = Array.from({ length: 4000 }, (_, k) => 'title:\n  - T' + k + '\n  # c\n\n  - U' + k).join('\n')
			+ '\nauthor:\n' + '\n# c\n'.repeat(20000)
			+ 'styles:\n' + Array.from({ length: 4000 }, (_, k) => '  s' + k + ':\n    font: Arial\n').join('')
			+ 'bibliography: «refs.bib»\n';
		const marked = '---\n' + block + '---\n\n' + 'Text [@a] and more text.\n\n'.repeat(100000);
		const { text, start, end } = unmark(marked);
		let link: Awaited<ReturnType<typeof findBibliographyLink>>;
		// Reading the block in the square of its lines would take seconds
		// here; linear takes milliseconds
		expect(await fastestRunAsync(async () => { link = await findBibliographyLink(paperUri, text, []); })).toBeLessThan(2000);
		expect(link!).toEqual({ start, end, path: path.join(tmp, 'refs.bib') });
	}, 30000);
});
