/**
 * VS Code extensions in the IDE layout — the declarative part of them.
 *
 * An extension is a manifest plus files. Much of what editors install is only
 * that: color themes, TextMate grammars, language settings, snippets. Those are
 * data, and the IDE applies them to Monaco. An extension that also ships code
 * (`main` / `browser`) can still be installed for its data, but its code never
 * runs — there is no extension host here.
 */

/** Where extensions are found. Open VSX, because Microsoft's marketplace is licensed to its own products. */
export const OPEN_VSX_URL = "https://open-vsx.org";

export interface IdeExtensionSearchEntry {
	/** `namespace.name`, the id VS Code uses. */
	id: string;
	namespace: string;
	name: string;
	displayName: string;
	description: string;
	version: string;
	downloadCount: number;
	verified: boolean;
	/** A `data:` URL, fetched by main — the page cannot load remote images. */
	iconDataUrl: string | null;
}

export interface IdeExtensionSearchResult {
	entries: IdeExtensionSearchEntry[];
	total: number;
}

export interface IdeThemeContribution {
	/** Unique within the extension; what the theme picker stores. */
	id: string;
	label: string;
	/** `vs` light, `vs-dark` dark, `hc-black`/`hc-light` high contrast. */
	uiTheme: string;
	/** Extension-relative path of the theme JSON. */
	path: string;
}

export interface IdeGrammarContribution {
	language?: string;
	scopeName: string;
	path: string;
	embeddedLanguages?: Record<string, string>;
	/** Scopes this grammar injects into, for injection grammars. */
	injectTo?: string[];
}

export interface IdeLanguageContribution {
	id: string;
	extensions?: string[];
	filenames?: string[];
	aliases?: string[];
	/** Extension-relative path of `language-configuration.json`. */
	configuration?: string;
}

export interface IdeSnippetContribution {
	language: string;
	path: string;
}

export interface IdeInstalledExtension {
	id: string;
	displayName: string;
	description: string;
	publisher: string;
	version: string;
	enabled: boolean;
	iconDataUrl: string | null;
	themes: IdeThemeContribution[];
	grammars: IdeGrammarContribution[];
	languages: IdeLanguageContribution[];
	snippets: IdeSnippetContribution[];
	/** It ships code (`main`/`browser`) that the IDE will not run. */
	hasCode: boolean;
	/** Contribution points it declares that the IDE does not apply, e.g. `commands`, `iconThemes`. */
	unsupported: string[];
}

export interface IdeExtensionsSnapshot {
	installed: IdeInstalledExtension[];
}

/** Contribution points the IDE applies; the rest are listed as unsupported. */
export const SUPPORTED_CONTRIBUTIONS = ["themes", "grammars", "languages", "snippets"] as const;

/**
 * JSON with comments and trailing commas, as VS Code reads theme and language
 * configuration files. Comments are removed outside strings only; a trailing
 * comma before `}` or `]` is dropped.
 */
export function parseJsonc(text: string): unknown {
	let out = "";
	let index = 0;
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	while (index < source.length) {
		const char = source[index]!;
		const next = source[index + 1];
		if (char === '"') {
			let end = index + 1;
			while (end < source.length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
			out += source.slice(index, end + 1);
			index = end + 1;
		} else if (char === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") index++;
		} else if (char === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
		} else {
			out += char;
			index++;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
