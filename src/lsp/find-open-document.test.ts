import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { findOpenDocumentForPath } from './citekey-language';

function openDocuments(uris: string[]) {
	const docs = uris.map(uri => ({ uri }));
	return {
		get: (uri: string) => docs.find(doc => doc.uri === uri),
		all: () => docs,
	};
}

describe('findOpenDocumentForPath', () => {
	const fsPath = path.resolve('/no-such-dir/refs/a:b.bib');

	test('finds a document whose URI is the one fsPathToUri makes', async () => {
		const uri = pathToFileURL(fsPath).toString();
		expect((await findOpenDocumentForPath(openDocuments([uri]), fsPath))?.uri).toBe(uri);
	});

	test('finds a document whose URI encodes the path differently, keeping its URI', async () => {
		// VS Code encodes ':' in a path as %3A; pathToFileURL doesn't
		const uri = pathToFileURL(fsPath).toString().replace('a:b.bib', 'a%3Ab.bib');
		expect(uri).not.toBe(pathToFileURL(fsPath).toString());
		expect((await findOpenDocumentForPath(openDocuments([uri]), fsPath))?.uri).toBe(uri);
	});

	test('finds no document at another path', async () => {
		const other = pathToFileURL(path.resolve('/no-such-dir/refs/other.bib')).toString();
		expect(await findOpenDocumentForPath(openDocuments([other, 'untitled:Untitled-1']), fsPath)).toBeUndefined();
	});
});
