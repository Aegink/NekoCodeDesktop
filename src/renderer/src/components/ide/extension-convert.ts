import type * as Monaco from "monaco-editor";
import type { ConvertedTheme } from "./monaco-setup";

/**
 * VS Code's declarative extension formats, turned into what Monaco takes.
 * Plain functions over JSON: the parts of extension support that can be wrong
 * in interesting ways, kept apart from the editor.
 */

const HEX_COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `#abc`, `#abcd`, `#aabbcc`, `#aabbccdd` → `#aabbcc[dd]`; anything else → null. */
export function normalizeHex(value: unknown): string | null {
	if (typeof value !== "string" || !HEX_COLOR.test(value.trim())) return null;
	const hex = value.trim().slice(1).toLowerCase();
	return `#${hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex}`;
}

const FONT_STYLES = new Set(["italic", "bold", "underline", "strikethrough"]);

export interface RawTheme {
	colors?: Record<string, unknown>;
	tokenColors?: unknown;
}

/**
 * A VS Code color theme as a Monaco one. Workbench colors carry over by name —
 * Monaco uses VS Code's color registry — and each TextMate rule becomes a
 * token rule on the last part of its selector, which is what a token is
 * matched against here.
 */
export function convertTheme(raw: RawTheme, uiTheme: string): ConvertedTheme {
	const base: Monaco.editor.BuiltinTheme =
		uiTheme === "vs" ? "vs" : uiTheme === "hc-black" ? "hc-black" : uiTheme === "hc-light" ? "hc-light" : "vs-dark";
	const colors: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw.colors ?? {})) {
		const hex = normalizeHex(value);
		if (hex) colors[key] = hex;
	}
	const rules: Monaco.editor.ITokenThemeRule[] = [];
	for (const entry of Array.isArray(raw.tokenColors) ? raw.tokenColors : []) {
		if (!entry || typeof entry !== "object") continue;
		const { scope, settings } = entry as { scope?: unknown; settings?: Record<string, unknown> };
		if (!settings) continue;
		const foreground = normalizeHex(settings.foreground)?.slice(1, 7);
		const background = normalizeHex(settings.background)?.slice(1, 7);
		const fontStyle =
			typeof settings.fontStyle === "string"
				? settings.fontStyle
						.split(/\s+/)
						.filter((style) => FONT_STYLES.has(style))
						.join(" ")
				: undefined;
		if (scope === undefined || scope === "") {
			// A rule without a scope sets the defaults for all text.
			if (foreground) colors["editor.foreground"] ??= `#${foreground}`;
			if (background) colors["editor.background"] ??= `#${background}`;
			continue;
		}
		const selectors = Array.isArray(scope) ? scope : String(scope).split(",");
		for (const selector of selectors) {
			if (typeof selector !== "string") continue;
			// `a b` is a descendant selector and `a - b` an exclusion: the token
			// is matched against the last part of what it includes.
			const token = selector.split(" - ")[0]?.trim().split(/\s+/).pop();
			if (!token) continue;
			rules.push({
				token,
				...(foreground ? { foreground } : {}),
				...(background ? { background } : {}),
				...(fontStyle !== undefined ? { fontStyle } : {}),
			});
		}
	}
	return { base, rules, colors };
}

/**
 * The one scope Monaco colors a TextMate token by. A token carries its whole
 * scope stack — `source.ts string.quoted.double.ts punctuation.definition.string.begin.ts`
 * — and Monaco takes a single name, so this picks the most specific scope the
 * active theme has a rule for, falling back to the innermost one.
 */
export function pickScope(scopes: readonly string[], known: ReadonlySet<string>): string {
	for (let index = scopes.length - 1; index >= 0; index--) {
		const scope = scopes[index]!;
		const parts = scope.split(".");
		for (let length = parts.length; length > 0; length--) {
			if (known.has(parts.slice(0, length).join("."))) return scope;
		}
	}
	return scopes[scopes.length - 1] ?? "";
}

function toRegExp(value: unknown): RegExp | undefined {
	const pattern = typeof value === "string" ? value : value && typeof value === "object" ? (value as { pattern?: unknown }).pattern : undefined;
	const flags = value && typeof value === "object" ? (value as { flags?: unknown }).flags : undefined;
	if (typeof pattern !== "string") return undefined;
	try {
		return new RegExp(pattern, typeof flags === "string" ? flags.replace(/[^gimsuy]/g, "") : undefined);
	} catch {
		// Oniguruma syntax JavaScript does not have; the rule is dropped, not the file.
		return undefined;
	}
}

function pairs(value: unknown): Array<{ open: string; close: string; notIn?: string[] }> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
			return [{ open: entry[0], close: entry[1] }];
		}
		if (entry && typeof entry === "object" && typeof entry.open === "string" && typeof entry.close === "string") {
			return [
				{
					open: entry.open,
					close: entry.close,
					...(Array.isArray(entry.notIn) ? { notIn: entry.notIn.filter((item: unknown) => typeof item === "string") } : {}),
				},
			];
		}
		return [];
	});
}

/** A `language-configuration.json` as Monaco's language configuration. */
export function toLanguageConfiguration(raw: Record<string, any>): Monaco.languages.LanguageConfiguration {
	const config: Monaco.languages.LanguageConfiguration = {};
	const comments = raw.comments;
	if (comments && typeof comments === "object") {
		const line = typeof comments.lineComment === "string" ? comments.lineComment : comments.lineComment?.comment;
		const block = Array.isArray(comments.blockComment) && comments.blockComment.length === 2 ? comments.blockComment : undefined;
		config.comments = {
			...(typeof line === "string" ? { lineComment: line } : {}),
			...(block ? { blockComment: [String(block[0]), String(block[1])] as [string, string] } : {}),
		};
	}
	if (Array.isArray(raw.brackets)) {
		config.brackets = raw.brackets.filter(
			(pair: unknown): pair is [string, string] =>
				Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string",
		);
	}
	const autoClosing = pairs(raw.autoClosingPairs);
	if (autoClosing.length) config.autoClosingPairs = autoClosing;
	const surrounding = pairs(raw.surroundingPairs);
	if (surrounding.length) config.surroundingPairs = surrounding.map(({ open, close }) => ({ open, close }));
	if (Array.isArray(raw.colorizedBracketPairs)) {
		config.colorizedBracketPairs = raw.colorizedBracketPairs.filter(
			(pair: unknown): pair is [string, string] => Array.isArray(pair) && pair.length === 2,
		);
	}
	const wordPattern = toRegExp(raw.wordPattern);
	if (wordPattern) config.wordPattern = wordPattern;
	const start = toRegExp(raw.folding?.markers?.start);
	const end = toRegExp(raw.folding?.markers?.end);
	if (raw.folding && typeof raw.folding === "object") {
		config.folding = {
			...(typeof raw.folding.offSide === "boolean" ? { offSide: raw.folding.offSide } : {}),
			...(start && end ? { markers: { start, end } } : {}),
		};
	}
	const increase = toRegExp(raw.indentationRules?.increaseIndentPattern);
	const decrease = toRegExp(raw.indentationRules?.decreaseIndentPattern);
	if (increase && decrease) {
		const indentNext = toRegExp(raw.indentationRules?.indentNextLinePattern);
		const unIndented = toRegExp(raw.indentationRules?.unIndentedLinePattern);
		config.indentationRules = {
			increaseIndentPattern: increase,
			decreaseIndentPattern: decrease,
			...(indentNext ? { indentNextLinePattern: indentNext } : {}),
			...(unIndented ? { unIndentedLinePattern: unIndented } : {}),
		};
	}
	return config;
}

export interface Snippet {
	name: string;
	prefixes: string[];
	body: string;
	description?: string;
}

/** A VS Code snippet file: `{ name: { prefix, body, description } }`. */
export function parseSnippets(raw: unknown): Snippet[] {
	if (!raw || typeof raw !== "object") return [];
	const snippets: Snippet[] = [];
	for (const [name, value] of Object.entries(raw as Record<string, any>)) {
		if (!value || typeof value !== "object") continue;
		const prefixes = (Array.isArray(value.prefix) ? value.prefix : [value.prefix]).filter(
			(prefix: unknown): prefix is string => typeof prefix === "string" && prefix.length > 0,
		);
		const body = Array.isArray(value.body) ? value.body.join("\n") : typeof value.body === "string" ? value.body : null;
		if (!prefixes.length || body === null) continue;
		snippets.push({
			name,
			prefixes,
			body,
			...(typeof value.description === "string" ? { description: value.description } : {}),
		});
	}
	return snippets;
}
