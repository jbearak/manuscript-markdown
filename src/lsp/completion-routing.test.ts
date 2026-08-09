import { describe, expect, test } from 'bun:test';
import { analyzeCitationDocument } from '../citation-scanner';
import { getFrontmatterCompletionItems } from './frontmatter-language';
import { getCompletionRoutingAtOffset } from './completion-routing';

describe('completion routing', () => {
	test('skips citation analysis for ordinary frontmatter but preserves nocite completion', () => {
		let analysisCalls = 0;
		const route = (text: string, offset: number) =>
			getCompletionRoutingAtOffset(text, offset, () => {
				analysisCalls++;
				return analyzeCitationDocument(text);
			});

		const ordinary = '---\nfont: Geo\n---\n';
		const ordinaryRoute = route(ordinary, ordinary.indexOf('Geo') + 'Geo'.length);
		expect(
			getFrontmatterCompletionItems(ordinaryRoute.frontmatterLocation, 'darwin')
				.map(item => item.label),
		).toContain('Georgia');
		expect(ordinaryRoute.citationContext).toBeUndefined();
		expect(analysisCalls).toBe(0);

		const nocite = '---\nnocite: |\n  @smi\n---\n';
		const nociteRoute = route(nocite, nocite.indexOf('@smi') + '@smi'.length);
		expect(nociteRoute.citationContext).toMatchObject({
			form: 'nocite',
			prefix: 'smi',
		});
		expect(analysisCalls).toBe(1);
	});

	test('preserves ordinary completion in large closed frontmatter', () => {
		let analysisCalls = 0;
		const text = '---\ntitle: ' + 'x'.repeat(20_000) + '\nfont: Geo\n---\n';
		const offset = text.indexOf('Geo') + 'Geo'.length;
		const routing = getCompletionRoutingAtOffset(text, offset, () => {
			analysisCalls++;
			return analyzeCitationDocument(text);
		});

		expect(
			getFrontmatterCompletionItems(routing.frontmatterLocation, 'darwin')
				.map(item => item.label),
		).toContain('Georgia');
		expect(routing.citationContext).toBeUndefined();
		expect(analysisCalls).toBe(0);
	});
});
