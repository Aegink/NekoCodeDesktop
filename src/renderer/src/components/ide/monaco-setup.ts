import * as monaco from "monaco-editor";
import CssWorker from "monaco-editor/language/css/css.worker?worker&inline";
import EditorWorker from "monaco-editor/editor/editor.worker?worker&inline";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker&inline";
import JsonWorker from "monaco-editor/language/json/json.worker?worker&inline";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker&inline";

/**
 * Monaco, configured once for the IDE layout.
 *
 * This module is only ever reached through the lazily loaded IDE chunk, so the
 * editor — several megabytes with its language workers — costs nothing until
 * someone switches to the IDE.
 *
 * The workers are inlined and started from blob URLs: the packaged app loads
 * its page from `file://`, where a worker script fetched by URL is refused as
 * cross-origin, and a blob is not.
 */

declare global {
	interface Window {
		MonacoEnvironment?: monaco.Environment;
	}
}

window.MonacoEnvironment = {
	getWorker(_workerId: string, label: string) {
		switch (label) {
			case "json":
				return new JsonWorker();
			case "css":
			case "scss":
			case "less":
				return new CssWorker();
			case "html":
			case "handlebars":
			case "razor":
				return new HtmlWorker();
			case "typescript":
			case "javascript":
				return new TsWorker();
			default:
				return new EditorWorker();
		}
	},
};

// The editor sees the files that are open, not the project: semantic checks
// would flag every import it cannot follow. Syntax errors are still reported,
// and completions still draw on everything that is open.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
	defaults.setCompilerOptions({
		target: monaco.typescript.ScriptTarget.ESNext,
		module: monaco.typescript.ModuleKind.ESNext,
		moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
		jsx: monaco.typescript.JsxEmit.ReactJSX,
		allowJs: true,
		allowNonTsExtensions: true,
		esModuleInterop: true,
		skipLibCheck: true,
	});
	defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
	defaults.setEagerModelSync(true);
}

let probe: CanvasRenderingContext2D | null = null;

/**
 * A theme token as an actual color. `getPropertyValue` on a custom property
 * returns its text unresolved — `var(--color-white)`, a `color-mix(…)` — which
 * nothing downstream can parse, so the token is applied to a real element and
 * read back computed.
 */
function resolveToken(token: string): string {
	const element = document.createElement("span");
	element.style.display = "none";
	element.style.color = `var(${token})`;
	document.body.appendChild(element);
	const color = getComputedStyle(element).color;
	element.remove();
	return color;
}

/**
 * A resolved color as the `#rrggbbaa` Monaco wants, drawn over `base` first
 * when one is given — which makes it opaque, as anything floating over code
 * has to be.
 */
function toHex(color: string, base?: string): string {
	probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	if (!probe) return base ?? "#00000000";
	probe.clearRect(0, 0, 1, 1);
	if (base) {
		probe.fillStyle = base;
		probe.fillRect(0, 0, 1, 1);
	}
	probe.fillStyle = "#0000";
	probe.fillStyle = color;
	probe.fillRect(0, 0, 1, 1);
	const [r = 0, g = 0, b = 0, a = 255] = probe.getImageData(0, 0, 1, 1).data;
	return `#${[r, g, b, a].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Token names Monaco's own `vs`/`vs-dark` themes color — what its Monarch
 * tokenizers emit. Listed so a TextMate token can be steered toward a scope the
 * active theme knows how to color.
 */
const BASE_THEME_TOKENS = [
	"comment", "string", "keyword", "number", "regexp", "type", "delimiter", "tag", "attribute.name",
	"attribute.value", "variable", "variable.predefined", "constant", "key", "string.key", "string.value",
	"annotation", "metatag", "operator", "emphasis", "strong", "invalid",
];

/**
 * VS Code's Light+/Dark+ colors for the TextMate scopes extension grammars
 * emit and Monaco's themes have no rule for. Only scopes the built-in
 * tokenizers never produce, so the languages Monaco already highlights look
 * exactly as they did.
 */
const TEXTMATE_RULES: Record<"light" | "dark", monaco.editor.ITokenThemeRule[]> = {
	light: [
		{ token: "constant.numeric", foreground: "098658" },
		{ token: "constant.language", foreground: "0000ff" },
		{ token: "constant.character.escape", foreground: "ee0000" },
		{ token: "storage", foreground: "0000ff" },
		{ token: "storage.type", foreground: "0000ff" },
		{ token: "keyword.control", foreground: "af00db" },
		{ token: "keyword.operator", foreground: "000000" },
		{ token: "entity.name.function", foreground: "795e26" },
		{ token: "support.function", foreground: "795e26" },
		{ token: "entity.name.type", foreground: "267f99" },
		{ token: "entity.name.class", foreground: "267f99" },
		{ token: "support.type", foreground: "267f99" },
		{ token: "support.class", foreground: "267f99" },
		{ token: "entity.name.tag", foreground: "800000" },
		{ token: "entity.other.attribute-name", foreground: "e50000" },
		{ token: "variable.parameter", foreground: "001080" },
		{ token: "variable.other", foreground: "001080" },
		{ token: "punctuation.definition.string", foreground: "a31515" },
		{ token: "punctuation.definition.comment", foreground: "008000" },
		{ token: "string.regexp", foreground: "811f3f" },
		{ token: "markup.heading", foreground: "800000", fontStyle: "bold" },
		{ token: "markup.bold", fontStyle: "bold" },
		{ token: "markup.italic", fontStyle: "italic" },
		{ token: "markup.inline.raw", foreground: "800000" },
	],
	dark: [
		{ token: "constant.numeric", foreground: "b5cea8" },
		{ token: "constant.language", foreground: "569cd6" },
		{ token: "constant.character.escape", foreground: "d7ba7d" },
		{ token: "storage", foreground: "569cd6" },
		{ token: "storage.type", foreground: "569cd6" },
		{ token: "keyword.control", foreground: "c586c0" },
		{ token: "keyword.operator", foreground: "d4d4d4" },
		{ token: "entity.name.function", foreground: "dcdcaa" },
		{ token: "support.function", foreground: "dcdcaa" },
		{ token: "entity.name.type", foreground: "4ec9b0" },
		{ token: "entity.name.class", foreground: "4ec9b0" },
		{ token: "support.type", foreground: "4ec9b0" },
		{ token: "support.class", foreground: "4ec9b0" },
		{ token: "entity.name.tag", foreground: "569cd6" },
		{ token: "entity.other.attribute-name", foreground: "9cdcfe" },
		{ token: "variable.parameter", foreground: "9cdcfe" },
		{ token: "variable.other", foreground: "9cdcfe" },
		{ token: "punctuation.definition.string", foreground: "ce9178" },
		{ token: "punctuation.definition.comment", foreground: "6a9955" },
		{ token: "string.regexp", foreground: "d16969" },
		{ token: "markup.heading", foreground: "569cd6", fontStyle: "bold" },
		{ token: "markup.bold", fontStyle: "bold" },
		{ token: "markup.italic", fontStyle: "italic" },
		{ token: "markup.inline.raw", foreground: "ce9178" },
	],
};

/** A VS Code color theme converted for Monaco. */
export interface ConvertedTheme {
	base: monaco.editor.BuiltinTheme;
	rules: monaco.editor.ITokenThemeRule[];
	colors: Record<string, string>;
}

let activeRuleTokens = new Set<string>(BASE_THEME_TOKENS);

/** The token names the active theme has rules for. */
export function themeRuleTokens(): ReadonlySet<string> {
	return activeRuleTokens;
}

/**
 * A Monaco theme drawn from the app's own tokens, so the editor sits on the
 * same surface as everything around it. The editor background stays
 * transparent — the pane behind it provides the surface — while everything
 * that floats over the code (menus, suggestions, hovers, the command palette)
 * gets the app's popover surface made opaque.
 *
 * With `override`, an extension's color theme is used instead, as its author
 * drew it — background included.
 */
export function applyIdeTheme(dark: boolean, override?: ConvertedTheme | null): void {
	if (override) {
		monaco.editor.defineTheme("nekocode-extension", { ...override, inherit: true });
		activeRuleTokens = new Set([...BASE_THEME_TOKENS, ...override.rules.map((rule) => rule.token)]);
		monaco.editor.setTheme("nekocode-extension");
		return;
	}
	const textmate = TEXTMATE_RULES[dark ? "dark" : "light"];
	activeRuleTokens = new Set([...BASE_THEME_TOKENS, ...textmate.map((rule) => rule.token)]);
	const surface = toHex(resolveToken("--popover"), dark ? "#252525" : "#ffffff");
	const foreground = toHex(resolveToken("--popover-foreground"), surface);
	const hover = toHex(resolveToken("--color-background-button-secondary-hover"), surface);
	const accent = toHex(resolveToken("--color-text-accent"), surface);
	const border = toHex(resolveToken("--border"));
	const muted = toHex(resolveToken("--muted-foreground"), surface);
	const name = dark ? "nekocode-dark" : "nekocode-light";
	monaco.editor.defineTheme(name, {
		base: dark ? "vs-dark" : "vs",
		inherit: true,
		rules: textmate,
		colors: {
			"editor.background": "#00000000",
			"editorGutter.background": "#00000000",
			"minimap.background": "#00000000",
			// Left undefined, Monaco fills the overview ruler beside a right-hand
			// minimap with the tokenizer's default background — solid gray here,
			// since the editor's own background is transparent.
			"editorOverviewRuler.background": "#00000000",
			"editorStickyScroll.background": surface,
			"editorStickyScrollHover.background": hover,
			"editorWidget.background": surface,
			"editorWidget.foreground": foreground,
			"editorSuggestWidget.background": surface,
			"editorSuggestWidget.foreground": foreground,
			"editorSuggestWidget.selectedBackground": hover,
			"editorHoverWidget.background": surface,
			"editorHoverWidget.foreground": foreground,
			"editorWidget.border": border,
			"editorSuggestWidget.border": border,
			"editorHoverWidget.border": border,
			// The right-click menu and the command palette take their own tokens,
			// not the editor widget ones.
			"menu.background": surface,
			"menu.foreground": foreground,
			"menu.selectionBackground": hover,
			"menu.selectionForeground": foreground,
			"menu.separatorBackground": border,
			"menu.border": border,
			"quickInput.background": surface,
			"quickInput.foreground": foreground,
			"quickInputList.focusBackground": hover,
			"quickInputList.focusForeground": foreground,
			"widget.border": border,
			"editorLineNumber.foreground": `${muted.slice(0, 7)}99`,
			"editorLineNumber.activeForeground": muted,
			"editorCursor.foreground": accent,
			"focusBorder": `${accent.slice(0, 7)}66`,
			"diffEditor.insertedTextBackground": dark ? "#2ea04333" : "#2ea04326",
			"diffEditor.removedTextBackground": dark ? "#f8514933" : "#f8514926",
		},
	});
	monaco.editor.setTheme(name);
}

/** The Monaco language for a path, by file name first and extension second. */
export function languageForPath(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
	let byExtension: string | null = null;
	for (const language of monaco.languages.getLanguages()) {
		if (language.filenames?.some((file) => file.toLowerCase() === name)) return language.id;
		if (!byExtension && extension && language.extensions?.some((ext) => ext.toLowerCase() === extension)) {
			byExtension = language.id;
		}
	}
	return byExtension ?? "plaintext";
}

/** The display name Monaco has for a language id. */
export function languageLabel(id: string): string {
	const language = monaco.languages.getLanguages().find((entry) => entry.id === id);
	return language?.aliases?.[0] ?? id;
}

export { monaco };
