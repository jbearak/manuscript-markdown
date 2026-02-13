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
	if (scenario === 'both') {
		return `Both output files already exist:\n${basePath}.md\n${basePath}.bib\n\nWhat would you like to do?`;
	}
	if (scenario === 'md') {
		return `Output file already exists:\n${basePath}.md\n\nWhat would you like to do?`;
	}
	return `Output file already exists:\n${basePath}.bib\n\nWhat would you like to do?`;
}

export function getOutputBasePath(selectedPath: string): string {
	return selectedPath.replace(/\.md$/i, '');
}
