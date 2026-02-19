// Implementation note: Before writing ${base}.md / ${base}.bib, detect pre-existing
// targets and prompt with overwrite/rename/cancel to prevent silent data loss.
export type OutputConflictScenario = 'md' | 'bib' | 'both';

export function getOutputConflictScenario(
	mdExists: boolean,
	bibExists: boolean
): OutputConflictScenario | null {
	if (mdExists && bibExists) {
		return 'both';
	}
	if (mdExists) {
		return 'md';
	}
	if (bibExists) {
		return 'bib';
	}
	return null;
}

export function getOutputConflictMessage(
	basePath: string,
	scenario: OutputConflictScenario
): string {
	const name = basePath.split(/[/\\]/).pop()!;
	if (scenario === 'both') {
		return `"${name}.md" and "${name}.bib" already exist in this folder. Replace them or save with a new name?`;
	}
	if (scenario === 'md') {
		return `"${name}.md" already exists in this folder. Replace it or save with a new name?`;
	}
	return `"${name}.bib" already exists in this folder. Replace it or save with a new name?`;
}

export function getOutputBasePath(selectedPath: string): string {
	return selectedPath.replace(/\.md$/i, '');
}
