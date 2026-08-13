import { describe, expect, it } from 'bun:test';
import { getPostExportAction } from './post-export-action';

describe('getPostExportAction', () => {
	it('opens the exported document externally in local windows', () => {
		expect(getPostExportAction(undefined, false)).toEqual({
			label: 'Open in Word',
			kind: 'openExternal',
		});
	});

	it('shows remote exports that are inside the workspace in Explorer', () => {
		expect(getPostExportAction('ssh-remote', true)).toEqual({
			label: 'Show in Explorer',
			kind: 'revealInExplorer',
		});
	});

	it('copies remote export paths when Explorer cannot reveal the file', () => {
		expect(getPostExportAction('ssh-remote', false)).toEqual({
			label: 'Copy Path',
			kind: 'copyPath',
		});
	});
});
