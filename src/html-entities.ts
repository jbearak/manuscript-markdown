/** Decode a numeric HTML entity without allowing malformed input to throw. */
export function decodeNumericHtmlEntity(entity: string, digits: string, radix: 10 | 16): string {
	const codePoint = Number.parseInt(digits, radix);
	if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff
			|| (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
		return '\ufffd';
	}
	try {
		return String.fromCodePoint(codePoint);
	} catch {
		return entity;
	}
}
