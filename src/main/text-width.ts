/**
 * Terminal-style display width, for text laid out in monospace columns — the
 * tables the read tool renders. CJK and fullwidth characters take two columns,
 * combining marks none; everything else one. Close enough for alignment in a
 * tool result; this is not a full wcwidth.
 */

function isWide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

function charWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (code === 0 || (code >= 0x0300 && code <= 0x036f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
	return isWide(code) ? 2 : 1;
}

export function textWidth(text: string): number {
	let width = 0;
	for (const char of text) width += charWidth(char);
	return width;
}

/** Cut `text` to at most `width` columns, ending in `…` when anything was cut. */
export function truncateToWidth(text: string, width: number): string {
	if (textWidth(text) <= width) return text;
	let used = 0;
	let out = "";
	for (const char of text) {
		const next = charWidth(char);
		if (used + next > width - 1) break;
		out += char;
		used += next;
	}
	return `${out}…`;
}
