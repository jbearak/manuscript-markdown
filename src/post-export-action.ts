export type PostExportAction =
	| { label: 'Open in Word'; kind: 'openExternal' }
	| { label: 'Show in Explorer'; kind: 'revealInExplorer' }
	| { label: 'Copy Path'; kind: 'copyPath' };

export function getPostExportAction(
	remoteName: string | undefined,
	isInsideWorkspace: boolean
): PostExportAction {
	if (remoteName === undefined) {
		return { label: 'Open in Word', kind: 'openExternal' };
	}
	return isInsideWorkspace
		? { label: 'Show in Explorer', kind: 'revealInExplorer' }
		: { label: 'Copy Path', kind: 'copyPath' };
}
