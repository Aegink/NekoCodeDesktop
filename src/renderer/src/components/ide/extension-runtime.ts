import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import { INITIAL, parseRawGrammar, Registry, type StateStack } from "vscode-textmate";
import { parseJsonc, type IdeExtensionsSnapshot, type IdeInstalledExtension } from "../../../../shared/ide-extensions";
import { api, errorMessage } from "../../api";
import { convertTheme, parseSnippets, pickScope, toLanguageConfiguration, type RawTheme, type Snippet } from "./extension-convert";
import { applyIdeTheme, languageForPath, monaco, themeRuleTokens, type ConvertedTheme } from "./monaco-setup";

/**
 * Installed VS Code extensions, applied to Monaco: languages and their
 * settings, TextMate grammars, snippets, and the chosen color theme.
 *
 * Everything is rebuilt from the installed list on every change — an enable,
 * an install — which keeps undoing a contribution as simple as disposing it.
 */

const THEME_STORAGE_KEY = "nekocode:ide-color-theme";
/** Longest line tokenized; past this a line is data, and tokenizing it would stall the editor. */
const MAX_TOKENIZED_LINE = 20_000;
const TOKENIZE_TIME_LIMIT_MS = 500;

export interface ThemeChoice {
	/** `extensionId::themeId`, what is stored. */
	key: string;
	label: string;
	extension: string;
	uiTheme: string;
}

class TextMateState implements monaco.languages.IState {
	constructor(readonly stack: StateStack) {}
	clone(): TextMateState {
		return new TextMateState(this.stack);
	}
	equals(other: monaco.languages.IState): boolean {
		return other instanceof TextMateState && other.stack.equals(this.stack);
	}
}

let onig: Promise<void> | null = null;

/** Oniguruma, the regex engine TextMate grammars are written for, as wasm. */
function loadOniguruma(): Promise<void> {
	// From main rather than fetched: the packaged app's page is a `file://`
	// URL, which `fetch` refuses to read.
	onig ??= api.ideExtensionsOniguruma().then((bytes) => loadWASM(bytes));
	// A failed load is retried on the next grammar rather than remembered.
	onig.catch(() => {
		onig = null;
	});
	return onig;
}

function readJson(extensionId: string, path: string): Promise<unknown> {
	return api.ideExtensionsReadFile(extensionId, path).then(parseJsonc);
}

function parentOf(path: string): string {
	const at = path.lastIndexOf("/");
	return at < 0 ? "" : path.slice(0, at + 1);
}

/** A theme file with its `include` chain folded in, the included one underneath. */
async function loadTheme(extensionId: string, path: string, depth = 0): Promise<RawTheme> {
	const raw = (await readJson(extensionId, path)) as RawTheme & { include?: unknown };
	if (typeof raw.include !== "string" || depth > 5) return raw;
	const included = await loadTheme(extensionId, parentOf(path) + raw.include.replace(/^\.\//, ""), depth + 1);
	return {
		colors: { ...(included.colors ?? {}), ...(raw.colors ?? {}) },
		tokenColors: [
			...(Array.isArray(included.tokenColors) ? included.tokenColors : []),
			...(Array.isArray(raw.tokenColors) ? raw.tokenColors : []),
		],
	};
}

class ExtensionRuntime {
	snapshot: IdeExtensionsSnapshot = { installed: [] };
	themeKey: string;
	/** Per extension, what failed to apply — a grammar that did not parse, say. */
	errors = new Map<string, string>();
	version = 0;

	private dark = false;
	private generation = 0;
	private disposables: monaco.IDisposable[] = [];
	private listeners = new Set<() => void>();
	private scopeCache = new Map<string, string>();
	private themeCache = new Map<string, ConvertedTheme>();

	constructor() {
		let stored: string | null = null;
		try {
			stored = localStorage.getItem(THEME_STORAGE_KEY);
		} catch {
			// no storage
		}
		this.themeKey = stored ?? "";
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	private emit(): void {
		this.version++;
		for (const listener of this.listeners) listener();
	}

	get themes(): ThemeChoice[] {
		return this.snapshot.installed
			.filter((extension) => extension.enabled)
			.flatMap((extension) =>
				extension.themes.map((theme) => ({
					key: `${extension.id}::${theme.id}`,
					label: theme.label,
					extension: extension.displayName,
					uiTheme: theme.uiTheme,
				})),
			);
	}

	setDark(dark: boolean): void {
		this.dark = dark;
		void this.applyTheme();
	}

	setTheme(key: string): void {
		this.themeKey = key;
		try {
			localStorage.setItem(THEME_STORAGE_KEY, key);
		} catch {
			// not persisted
		}
		void this.applyTheme();
		this.emit();
	}

	private async applyTheme(): Promise<void> {
		const [extensionId, themeId] = this.themeKey.split("::");
		const extension = this.snapshot.installed.find((entry) => entry.enabled && entry.id === extensionId);
		const theme = extension?.themes.find((entry) => entry.id === themeId);
		let converted: ConvertedTheme | null = null;
		if (extension && theme) {
			const cacheKey = `${extension.id}@${extension.version}::${theme.id}`;
			converted = this.themeCache.get(cacheKey) ?? null;
			if (!converted) {
				try {
					converted = convertTheme(await loadTheme(extension.id, theme.path), theme.uiTheme);
					this.themeCache.set(cacheKey, converted);
				} catch (cause) {
					this.errors.set(extension.id, errorMessage(cause));
					this.emit();
				}
			}
		}
		applyIdeTheme(this.dark, converted);
		// Which scope a token is colored by depends on the theme's rules.
		this.scopeCache.clear();
	}

	/** Rebuild every contribution from the installed list. */
	async apply(snapshot: IdeExtensionsSnapshot): Promise<void> {
		const generation = ++this.generation;
		this.snapshot = snapshot;
		for (const disposable of this.disposables) disposable.dispose();
		this.disposables = [];
		this.errors.clear();
		this.themeCache.clear();
		const enabled = snapshot.installed.filter((extension) => extension.enabled);

		this.registerLanguages(enabled);
		this.registerGrammars(enabled);
		await Promise.all([this.registerLanguageConfigurations(enabled, generation), this.registerSnippets(enabled, generation)]);
		if (generation !== this.generation) return;
		this.relanguageModels();
		await this.applyTheme();
		this.emit();
	}

	private registerLanguages(extensions: IdeInstalledExtension[]): void {
		// Registering an id Monaco already knows adds the extension's file names to it.
		for (const extension of extensions) {
			for (const language of extension.languages) {
				monaco.languages.register({
					id: language.id,
					...(language.extensions ? { extensions: language.extensions } : {}),
					...(language.filenames ? { filenames: language.filenames } : {}),
					...(language.aliases ? { aliases: language.aliases } : {}),
				});
			}
		}
	}

	private async registerLanguageConfigurations(extensions: IdeInstalledExtension[], generation: number): Promise<void> {
		await Promise.all(
			extensions.flatMap((extension) =>
				extension.languages
					.filter((language) => language.configuration)
					.map(async (language) => {
						try {
							const raw = (await readJson(extension.id, language.configuration!)) as Record<string, unknown>;
							if (generation !== this.generation) return;
							this.disposables.push(monaco.languages.setLanguageConfiguration(language.id, toLanguageConfiguration(raw)));
						} catch (cause) {
							this.errors.set(extension.id, errorMessage(cause));
						}
					}),
			),
		);
	}

	private registerGrammars(extensions: IdeInstalledExtension[]): void {
		const byScope = new Map<string, { extensionId: string; path: string }>();
		const injections = new Map<string, string[]>();
		const byLanguage = new Map<string, { scopeName: string; extensionId: string }>();
		for (const extension of extensions) {
			for (const grammar of extension.grammars) {
				byScope.set(grammar.scopeName, { extensionId: extension.id, path: grammar.path });
				if (grammar.language) byLanguage.set(grammar.language, { scopeName: grammar.scopeName, extensionId: extension.id });
				for (const target of grammar.injectTo ?? []) {
					injections.set(target, [...(injections.get(target) ?? []), grammar.scopeName]);
				}
			}
		}
		if (byLanguage.size === 0) return;

		const registry = new Registry({
			onigLib: loadOniguruma().then(() => ({ createOnigScanner, createOnigString })),
			loadGrammar: async (scopeName) => {
				const source = byScope.get(scopeName);
				if (!source) return null;
				return parseRawGrammar(await api.ideExtensionsReadFile(source.extensionId, source.path), source.path);
			},
			getInjections: (scopeName) => injections.get(scopeName),
		});

		for (const [languageId, { scopeName, extensionId }] of byLanguage) {
			const provider = registry.loadGrammar(scopeName).then((grammar): monaco.languages.TokensProvider => {
				if (!grammar) throw new Error(`Grammar not found: ${scopeName}`);
				return {
					getInitialState: () => new TextMateState(INITIAL),
					tokenize: (line, state) => {
						if (line.length > MAX_TOKENIZED_LINE) return { tokens: [{ startIndex: 0, scopes: "" }], endState: state };
						const result = grammar.tokenizeLine(line, (state as TextMateState).stack, TOKENIZE_TIME_LIMIT_MS);
						return {
							endState: new TextMateState(result.ruleStack),
							tokens: result.tokens.map((token) => ({ startIndex: token.startIndex, scopes: this.tokenName(token.scopes) })),
						};
					},
				};
			});
			provider.catch((cause: unknown) => {
				this.errors.set(extensionId, errorMessage(cause));
				this.emit();
			});
			this.disposables.push(monaco.languages.setTokensProvider(languageId, provider));
		}
		this.disposables.push({ dispose: () => registry.dispose() });
	}

	private tokenName(scopes: string[]): string {
		const key = scopes.join(" ");
		let name = this.scopeCache.get(key);
		if (name === undefined) {
			name = pickScope(scopes, themeRuleTokens());
			this.scopeCache.set(key, name);
		}
		return name;
	}

	private async registerSnippets(extensions: IdeInstalledExtension[], generation: number): Promise<void> {
		const byLanguage = new Map<string, Snippet[]>();
		await Promise.all(
			extensions.flatMap((extension) =>
				extension.snippets.map(async (contribution) => {
					try {
						const snippets = parseSnippets(await readJson(extension.id, contribution.path));
						byLanguage.set(contribution.language, [...(byLanguage.get(contribution.language) ?? []), ...snippets]);
					} catch (cause) {
						this.errors.set(extension.id, errorMessage(cause));
					}
				}),
			),
		);
		if (generation !== this.generation) return;
		for (const [language, snippets] of byLanguage) {
			this.disposables.push(
				monaco.languages.registerCompletionItemProvider(language, {
					provideCompletionItems: (model, position) => {
						const word = model.getWordUntilPosition(position);
						const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
						return {
							suggestions: snippets.flatMap((snippet) =>
								snippet.prefixes.map((prefix) => ({
									label: { label: prefix, description: snippet.name },
									kind: monaco.languages.CompletionItemKind.Snippet,
									detail: snippet.description ?? snippet.name,
									documentation: { value: `\`\`\`\n${snippet.body}\n\`\`\`` },
									insertText: snippet.body,
									insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
									range,
								})),
							),
						};
					},
				}),
			);
		}
	}

	/** Files opened as plain text before an extension taught Monaco their language. */
	private relanguageModels(): void {
		for (const model of monaco.editor.getModels()) {
			if (model.getLanguageId() !== "plaintext") continue;
			const language = languageForPath(model.uri.path);
			if (language !== "plaintext") monaco.editor.setModelLanguage(model, language);
		}
	}
}

/** One runtime for the window: Monaco's registries are global. */
export const extensionRuntime = new ExtensionRuntime();
