/** GFM disallowed raw HTML tags (extension §6.11). */
const DISALLOWED_RAW_HTML_TAGS = new Set([
  'title',
  'textarea',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'script',
  'plaintext',
]);

function getLeadingRawHtmlTagName(html: string): string | undefined {
  const match = html.match(/^\s*<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s|>|\/)/);
  if (!match) return undefined;
  return match[1].toLowerCase();
}

export function isGfmDisallowedRawHtmlTagName(tagName: string): boolean {
  return DISALLOWED_RAW_HTML_TAGS.has(tagName.toLowerCase());
}

export function isGfmDisallowedRawHtml(html: string): boolean {
  const tagName = getLeadingRawHtmlTagName(html);
  return !!tagName && isGfmDisallowedRawHtmlTagName(tagName);
}

export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function parseTaskListMarker(text: string): { checked: boolean; rest: string } | undefined {
  const match = text.match(/^\[( |x|X)\](?:\s+|$)/);
  if (!match) return undefined;
  return {
    checked: match[1].toLowerCase() === 'x',
    rest: text.slice(match[0].length),
  };
}

export const GFM_ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type GfmAlertType = typeof GFM_ALERT_TYPES[number];

const ALERT_TYPE_SET = new Set<string>(GFM_ALERT_TYPES);

export function parseGfmAlertMarker(text: string): { type: GfmAlertType; rest: string } | undefined {
  const match = text.match(/^\[!([A-Za-z]+)\](?:[ \t]+|$)/);
  if (!match) return undefined;
  const type = match[1].toLowerCase();
  if (!ALERT_TYPE_SET.has(type)) return undefined;
  return {
    type: type as GfmAlertType,
    rest: text.slice(match[0].length),
  };
}

export function toGfmAlertMarker(type: GfmAlertType): string {
  return `[!${type.toUpperCase()}]`;
}

export function gfmAlertTitle(type: GfmAlertType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}
