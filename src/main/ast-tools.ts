import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { DynamicLangRegistrations, SgNode } from "@ast-grep/napi";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { reportPreimage } from "./file-journal";
import { pi } from "./pi";
import { resolveWorkspacePath } from "./workflow-paths";

/**
 * Structural search and rewrite with ast-grep.
 *
 * `grep` and `edit` see text; these see syntax, so a call is found whatever its
 * line breaks, and a rewrite cannot land inside a string that merely looks like
 * code. The native module and the extra grammars load on the first call, not at
 * startup — most sessions never make one.
 */

export const AST_GREP_TOOL_NAME = "ast_grep";
export const AST_EDIT_TOOL_NAME = "ast_edit";

/** Built into @ast-grep/napi, under its own names. */
const BUILTIN = { typescript: "TypeScript", tsx: "Tsx", javascript: "JavaScript", html: "Html", css: "Css" } as const;

/** Grammars shipped as separate packages, each a prebuilt tree-sitter parser. */
const DYNAMIC = {
	python: () => import("@ast-grep/lang-python"),
	go: () => import("@ast-grep/lang-go"),
	rust: () => import("@ast-grep/lang-rust"),
	java: () => import("@ast-grep/lang-java"),
	c: () => import("@ast-grep/lang-c"),
	cpp: () => import("@ast-grep/lang-cpp"),
	json: () => import("@ast-grep/lang-json"),
	yaml: () => import("@ast-grep/lang-yaml"),
	bash: () => import("@ast-grep/lang-bash"),
} as const;

export const AST_LANGUAGES = [...Object.keys(BUILTIN), ...Object.keys(DYNAMIC)] as (keyof typeof BUILTIN | keyof typeof DYNAMIC)[];
export type AstLanguage = (typeof AST_LANGUAGES)[number];

/** File extension → language, for a call that names a single file and no language. */
const EXTENSIONS: Record<string, AstLanguage> = {
	".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
	".html": "html", ".htm": "html", ".css": "css",
	".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust", ".java": "java",
	".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
	".json": "json", ".yaml": "yaml", ".yml": "yaml", ".sh": "bash", ".bash": "bash",
};

export function inferLanguage(path: string): AstLanguage | undefined {
	return EXTENSIONS[extname(path).toLowerCase()];
}

type Napi = typeof import("@ast-grep/napi");
let napi: Promise<Napi> | null = null;

/**
 * A prebuilt parser's path, as the native side can open it. Packaged, the
 * packages sit in `app.asar.unpacked`, but `require` reports them inside
 * `app.asar` — a path Electron fakes for JavaScript and the dynamic loader
 * cannot open.
 */
function unpacked(path: string): string {
	return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

/**
 * Why each grammar that did not load failed. A search in one of these languages
 * reports this, rather than an empty result that reads as "no such code".
 */
const grammarErrors = new Map<string, string>();
/** The placeholder each grammar parses metavariables as, where `$` is not an identifier character. */
const expandoChars = new Map<string, string>();

/**
 * The ast-grep module with every grammar that could be registered.
 *
 * Each parser file is checked before registration, because ast-grep does not
 * report a missing one: it panics, and the panic aborts the process — here,
 * the whole app. A missing parser is what a broken package or a wrong
 * unpacked path produces, so it is the one case worth guarding.
 */
function loadNapi(): Promise<Napi> {
	napi ??= (async () => {
		const module = await import("@ast-grep/napi");
		const registrations: DynamicLangRegistrations = {};
		const fail = (name: string, error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			grammarErrors.set(name, reason);
			console.error(`ast-grep: could not load the ${name} grammar:`, reason);
		};
		for (const [name, load] of Object.entries(DYNAMIC)) {
			try {
				const loaded = (await load()) as { default?: unknown };
				const lang = (loaded.default ?? loaded) as {
					libraryPath: string;
					extensions: string[];
					languageSymbol?: string;
					expandoChar?: string;
				};
				const libraryPath = unpacked(lang.libraryPath);
				if (!existsSync(libraryPath)) throw new Error(`parser not found at ${libraryPath}`);
				registrations[name] = { libraryPath, extensions: lang.extensions, languageSymbol: lang.languageSymbol, expandoChar: lang.expandoChar };
				if (lang.expandoChar) expandoChars.set(name, lang.expandoChar);
			} catch (error) {
				fail(name, error);
			}
		}
		// All in one call: only the first registration takes effect, and later
		// calls are silently ignored, so grammars cannot be added one by one.
		try {
			module.registerDynamicLanguage(registrations);
		} catch (error) {
			for (const name of Object.keys(registrations)) fail(name, error);
		}
		return module;
	})();
	napi.catch(() => {
		napi = null;
	});
	return napi;
}

/** The module, refusing a language whose grammar did not load. */
async function napiFor(lang: AstLanguage): Promise<Napi> {
	const module = await loadNapi();
	const failure = grammarErrors.get(lang);
	if (failure)
		throw new Error(`The ${lang} grammar could not be loaded (${failure}). This is an installation problem, not an absence of matches; ${lang} cannot be searched until it is fixed.`);
	return module;
}

function napiLanguage(lang: AstLanguage): string {
	return lang in BUILTIN ? BUILTIN[lang as keyof typeof BUILTIN] : lang;
}

interface Target {
	/** As the model wrote it, for messages. */
	input: string;
	/** Absolute, original case — what is scanned and shown. */
	absolute: string;
	isFile: boolean;
}

async function resolveTarget(cwd: string, path: string | undefined): Promise<Target> {
	const input = path?.trim() || ".";
	// Checked against the workspace (symlinks resolved), then used as written:
	// the check's canonical form is lower-cased on Windows.
	resolveWorkspacePath(cwd, input);
	const absolute = resolve(cwd, input);
	const info = await stat(absolute).catch(() => null);
	if (!info) throw new Error(`No such file or directory: ${input}`);
	return { input, absolute, isFile: info.isFile() };
}

function pickLanguage(lang: AstLanguage | undefined, target: Target): AstLanguage {
	if (lang) return lang;
	const inferred = target.isFile ? inferLanguage(target.absolute) : undefined;
	if (!inferred) throw new Error(`Set lang: it cannot be inferred for ${target.input}. Supported: ${AST_LANGUAGES.join(", ")}.`);
	return inferred;
}

/** Every file under the target with at least one match, and its matches. */
async function findMatches(
	lang: AstLanguage,
	pattern: string,
	target: Target,
	signal?: AbortSignal,
): Promise<Map<string, SgNode[]>> {
	const sg = await napiFor(lang);
	const language = napiLanguage(lang);
	const byFile = new Map<string, SgNode[]>();
	if (target.isFile) {
		const source = await readFile(target.absolute, "utf8");
		const nodes = sg.parse(language, source).root().findAll(pattern);
		if (nodes.length) byFile.set(target.absolute, nodes);
		return byFile;
	}
	// The walk honours .gitignore. Its callbacks are queued from native threads
	// and may trail the promise, so the tally waits until every file reported.
	let reported = 0;
	let settle: () => void = () => {};
	let expected = Number.POSITIVE_INFINITY;
	const done = new Promise<void>((resolveDone) => {
		settle = resolveDone;
	});
	let failure: Error | null = null;
	const count = await sg.findInFiles(
		language,
		{ paths: [target.absolute], matcher: { rule: { pattern } } },
		(error, nodes) => {
			reported++;
			if (error) failure ??= error;
			else if (nodes.length) byFile.set(nodes[0].getRoot().filename(), nodes);
			if (reported >= expected) settle();
		},
	);
	expected = count;
	if (reported >= expected) settle();
	await Promise.race([done, new Promise((resolveWait) => setTimeout(resolveWait, 2000))]);
	if (signal?.aborted) throw new Error("Search cancelled");
	if (failure) throw failure;
	return byFile;
}

function display(cwd: string, absolute: string): string {
	const path = relative(cwd, absolute);
	return (path && !path.startsWith("..") ? path : absolute).split(sep).join("/");
}

function clipText(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Whether a stretch of pattern is nothing but metavariables and separators.
 *
 * `$$$` stands where the grammar wants a list — a class body, a block's
 * statements — and read as plain code it is a stray identifier there. The
 * parser flags that, but ast-grep matches it fine, so a complaint about it
 * would send the caller to fix a pattern that is not broken.
 */
function onlyMetavariables(text: string, expando: string): boolean {
	const e = expando.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const meta = new RegExp(`${e}${e}${e}[A-Z0-9_]*|${e}[A-Z_][A-Z0-9_]*|${e}_`, "g");
	return text.replace(meta, "").replace(/[\s;,]/g, "") === "";
}

/** The first token the parser had to invent to finish the tree, if any, ignoring what a metavariable explains. */
function missingToken(node: SgNode, expando: string): string | null {
	for (const child of node.children()) {
		const range = child.range();
		if (child.isLeaf() && range.start.index === range.end.index) {
			// `$$$BODY` read as a statement "lacks" its semicolon; that is not a real gap.
			const before = child.prev();
			if (!(before && onlyMetavariables(before.text(), expando))) return String(child.kind());
			continue;
		}
		const inner = missingToken(child, expando);
		if (inner) return inner;
	}
	return null;
}

/**
 * What is wrong with a pattern as code of `lang`, or null when it parses.
 *
 * Parsed as ast-grep parses it: grammars where `$` is not an identifier
 * character read metavariables through a placeholder, so the pattern is
 * checked with that placeholder in. HTML and CSS are not checked — no
 * metavariable is valid markup, so every pattern would look broken.
 */
export async function patternProblem(lang: AstLanguage, pattern: string): Promise<string | null> {
	if (lang === "html" || lang === "css") return null;
	const sg = await napiFor(lang);
	const expando = expandoChars.get(lang);
	const substituted = expando && expando !== "$" ? pattern.replaceAll("$", expando) : pattern;
	const restore = (text: string) => (expando === "µ" ? text.replaceAll("µ", "$") : text);
	const root = sg.parse(napiLanguage(lang), substituted).root();
	const marker = expando ?? "$";
	const error = root.findAll({ rule: { kind: "ERROR" } }).find((node) => !onlyMetavariables(node.text(), marker));
	if (error) return `syntax error near \`${restore(clipText(error.text()))}\``;
	const missing = missingToken(root, marker);
	return missing ? `it is incomplete — the parser had to supply a missing \`${missing}\`` : null;
}

/** File counts by language under a directory, from git's view of it; null outside a repository. */
function languagesUnder(dir: string): Promise<Map<AstLanguage, number> | null> {
	return new Promise((resolveCounts) => {
		execFile(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ cwd: dir, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout) => {
				if (error) return resolveCounts(null);
				const counts = new Map<AstLanguage, number>();
				for (const file of stdout.split("\0")) {
					const lang = file ? inferLanguage(file) : undefined;
					if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
				}
				resolveCounts(counts);
			},
		);
	});
}

/**
 * Why a search found nothing, as far as the tool can tell.
 *
 * Three causes look identical from outside — a pattern that does not parse,
 * the wrong language for the files, and code whose shape differs — and only
 * the last is about the code. The first two are checked and named; what is
 * left is said to be the third.
 */
async function explainNoMatches(lang: AstLanguage, pattern: string, target: Target): Promise<string> {
	const problem = await patternProblem(lang, pattern).catch(() => null);
	if (problem)
		return `The pattern does not parse as ${lang}: ${problem}. A pattern that does not parse matches nothing, so this says nothing about the code — fix the pattern and search again.`;
	if (target.isFile) {
		const actual = inferLanguage(target.absolute);
		if (actual && actual !== lang) return `${target.input} is a ${actual} file but was parsed as ${lang}; search it with lang: ${actual}.`;
	} else {
		const counts = await languagesUnder(target.absolute);
		if (counts && !counts.get(lang)) {
			const present = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
			return `${target.input} has no ${lang} files${present.length ? `; it has ${present.map(([name, count]) => `${count} ${name}`).join(", ")}` : ""}. Search again with the language of the files you mean.`;
		}
	}
	return `The pattern parses as ${lang} and there are ${lang} files here, so either the code is absent or its shape differs from the pattern: every part of it must match, including modifiers (Java/C#/Kotlin \`public\`, \`static\`), type annotations, and whether it is a declaration, method or arrow function. Loosen the pattern (e.g. a bare identifier) before concluding it is absent.`;
}

/** Drop matches nested in an earlier one: rewriting both would overlap. */
function outermost(nodes: SgNode[]): SgNode[] {
	const sorted = [...nodes].sort((a, b) => a.range().start.index - b.range().start.index || b.range().end.index - a.range().end.index);
	const kept: SgNode[] = [];
	let end = -1;
	for (const node of sorted) {
		const range = node.range();
		if (range.start.index < end) continue;
		kept.push(node);
		end = range.end.index;
	}
	return kept;
}

/**
 * Fill a rewrite template from one match.
 *
 * `$$$NAME` takes the source text spanning every node it captured, so the
 * separators between them — commas, line breaks — survive as written;
 * `$NAME` takes its single node. An unbound name becomes empty, as in the
 * ast-grep CLI.
 */
export function fillTemplate(template: string, match: SgNode, source: string): string {
	return template.replace(/\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g, (_, multi: string | undefined, single: string | undefined) => {
		if (multi) {
			const nodes = match.getMultipleMatches(multi);
			if (nodes.length === 0) return "";
			return source.slice(nodes[0].range().start.index, nodes[nodes.length - 1].range().end.index);
		}
		return match.getMatch(single as string)?.text() ?? "";
	});
}

const PATTERN_DOC =
	"ast-grep pattern: code with metavariables. $NAME matches one node, $$$NAME zero or more, $_ matches without binding. Names are UPPERCASE and stand for whole nodes. The pattern must parse as one node of the language.";

/** Where patterns most often fail to match code that is there. */
const LANGUAGE_NOTES =
	"Language notes: every token in the pattern must match, so Java, C# and Kotlin declarations need the modifiers the code has (`public class $C extends $B { $$$ }` matches `public class Main extends Base {}`; without `public` it does not). TypeScript declarations need their annotations or a metavariable for them (`function $F($$$A): $R { $$$B }`). TypeScript and TSX are separate languages — .tsx files only parse as tsx.";

const langSchema = Type.Optional(
	Type.Union(
		AST_LANGUAGES.map((name) => Type.Literal(name)),
		{ description: "Language to parse as. Required for a directory; inferred from a single file's extension. TypeScript and TSX are separate: search .tsx with tsx." },
	),
);

const grepSchema = Type.Object(
	{
		pattern: Type.String({ minLength: 1, maxLength: 4000, description: PATTERN_DOC }),
		lang: langSchema,
		path: Type.Optional(Type.String({ description: "File or directory to search, workspace-relative. Defaults to the workspace; narrow it when you can." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Matches to show. Defaults to 100." })),
	},
	{ additionalProperties: false },
);

const MAX_MATCH_CHARS = 200;

function preview(node: SgNode): string {
	const text = node.text();
	const lines = text.split("\n");
	const first = lines[0].trim();
	const clipped = first.length > MAX_MATCH_CHARS ? `${first.slice(0, MAX_MATCH_CHARS)}…` : first;
	return lines.length > 1 ? `${clipped} …(+${lines.length - 1} lines)` : clipped;
}

export function createAstGrepTool(cwd: string): ToolDefinition {
	return {
		name: AST_GREP_TOOL_NAME,
		label: AST_GREP_TOOL_NAME,
		description:
			`Structural code search with ast-grep: find code by syntax shape rather than text — calls, declarations, constructs — regardless of formatting. ${PATTERN_DOC} Examples: \`console.log($$$ARGS)\`, \`useEffect($FN, [])\`, \`async function $NAME($$$) { $$$ }\`, \`def $F($$$): $$$\`. One language per call. ${LANGUAGE_NOTES} When nothing matches, the result says whether the pattern failed to parse or the path holds no files of that language. Use grep for plain text.`,
		promptSnippet: "ast_grep(pattern, lang, path) finds code by syntax shape (metavariables $X, $$$ARGS); use grep for plain text.",
		parameters: grepSchema,
		executionMode: "parallel",
		async execute(_id, params, signal) {
			const input = params as Static<typeof grepSchema>;
			const target = await resolveTarget(cwd, input.path);
			const lang = pickLanguage(input.lang, target);
			const byFile = await findMatches(lang, input.pattern, target, signal);
			const limit = input.limit ?? 100;
			const files = [...byFile.keys()].sort();
			const total = files.reduce((sum, file) => sum + (byFile.get(file)?.length ?? 0), 0);
			if (total === 0) {
				const why = await explainNoMatches(lang, input.pattern, target);
				return {
					content: [{ type: "text", text: `No ${lang} matches for \`${input.pattern}\` in ${target.input}. ${why}` }],
					details: { lang, total, files: 0 },
				};
			}
			const lines: string[] = [];
			// Files the limit left out entirely, or only partly listed, with what is missing.
			const unshown: string[] = [];
			let shown = 0;
			for (const file of files) {
				const nodes = byFile.get(file) ?? [];
				const room = limit - shown;
				if (room <= 0) {
					unshown.push(`${display(cwd, file)} (${nodes.length})`);
					continue;
				}
				lines.push(`${display(cwd, file)} (${nodes.length})`);
				for (const node of nodes.slice(0, room)) {
					const { line, column } = node.range().start;
					lines.push(`  ${line + 1}:${column + 1}  ${preview(node)}`);
				}
				shown += Math.min(room, nodes.length);
				if (nodes.length > room) unshown.push(`${display(cwd, file)} (${nodes.length - room} more)`);
			}
			const header = `${total} match${total === 1 ? "" : "es"} in ${files.length} file${files.length === 1 ? "" : "s"}${shown < total ? ` (showing ${shown}; raise limit or narrow path for the rest)` : ""}:`;
			const tail = unshown.length
				? `\n\nNot shown: ${unshown.slice(0, 20).join(", ")}${unshown.length > 20 ? `, and ${unshown.length - 20} more files` : ""}`
				: "";
			const text = `${header}\n\n${lines.join("\n")}${tail}`;
			return { content: [{ type: "text", text }], details: { lang, total, files: files.length } };
		},
	};
}

const editSchema = Type.Object(
	{
		pattern: Type.String({ minLength: 1, maxLength: 4000, description: PATTERN_DOC }),
		rewrite: Type.String({
			maxLength: 20000,
			description: "Replacement for each match. Metavariables from the pattern are substituted ($A, $$$ARGS). Empty deletes the match.",
		}),
		lang: langSchema,
		path: Type.Optional(Type.String({ description: "File or directory to rewrite, workspace-relative. Defaults to the workspace." })),
		dryRun: Type.Optional(Type.Boolean({ description: "Report what would change without writing. Use it first on a broad path." })),
	},
	{ additionalProperties: false },
);

export interface AstEditOptions {
	/**
	 * Refuse a file the session may not write, by throwing. Checked for every
	 * file before any is written, so a refusal changes nothing.
	 */
	assertWritable?: (absolutePath: string) => void;
}

/** Files one call may rewrite. A codemod wider than this should be split by path. */
const MAX_EDIT_FILES = 200;
const MAX_DIFF_LINES = 6;

function changePreview(before: string, after: string): string[] {
	const clip = (text: string) => {
		const lines = text.split("\n");
		const head = lines.slice(0, MAX_DIFF_LINES).map((line) => (line.length > MAX_MATCH_CHARS ? `${line.slice(0, MAX_MATCH_CHARS)}…` : line));
		return lines.length > MAX_DIFF_LINES ? [...head, `…(+${lines.length - MAX_DIFF_LINES} lines)`] : head;
	};
	return [...clip(before).map((line) => `    - ${line}`), ...(after ? clip(after).map((line) => `    + ${line}`) : ["    + (deleted)"])];
}

export function createAstEditTool(cwd: string, options: AstEditOptions = {}): ToolDefinition {
	return {
		name: AST_EDIT_TOOL_NAME,
		label: AST_EDIT_TOOL_NAME,
		description:
			`Structural rewrite with ast-grep: replace every match of a pattern, across files, by syntax rather than text. ${PATTERN_DOC} The rewrite substitutes the pattern's metavariables, e.g. pattern \`oldApi($A, $B)\` → rewrite \`newApi({ a: $A, b: $B })\`. Substitution is 1:1 — captures cannot be split. Nested matches are rewritten outermost only. Run with dryRun first on a directory. ${LANGUAGE_NOTES} For a one-off change in one place, use edit instead.`,
		promptSnippet: "ast_edit(pattern, rewrite, lang, path, dryRun) is a syntax-aware codemod across files; dry-run first, use edit for one-off changes.",
		parameters: editSchema,
		async execute(toolCallId, params, signal) {
			const input = params as Static<typeof editSchema>;
			const target = await resolveTarget(cwd, input.path);
			const lang = pickLanguage(input.lang, target);
			const byFile = await findMatches(lang, input.pattern, target, signal);
			const files = [...byFile.keys()].sort();
			if (files.length === 0)
				return {
					content: [{ type: "text", text: `No ${lang} matches for \`${input.pattern}\` in ${target.input}; nothing changed. ${await explainNoMatches(lang, input.pattern, target)}` }],
					details: { lang, files: 0, replacements: 0, dryRun: !!input.dryRun },
				};
			if (files.length > MAX_EDIT_FILES)
				throw new Error(`${files.length} files match; narrow path to at most ${MAX_EDIT_FILES} per call.`);

			const sg = await napiFor(lang);
			// Everything is worked out before anything is written: a refused file or
			// a failed parse must not leave the codemod half applied.
			const plans: { file: string; before: Buffer; after: string; samples: string[]; count: number }[] = [];
			for (const file of files) {
				if (signal?.aborted) throw new Error("Edit cancelled");
				const before = await readFile(file);
				const source = before.toString("utf8");
				// Parsed afresh: the search's nodes came from the walk's own read of the file.
				const root = sg.parse(napiLanguage(lang), source).root();
				const matches = outermost(root.findAll(input.pattern));
				if (matches.length === 0) continue;
				const edits = matches.map((node) => node.replace(fillTemplate(input.rewrite, node, source)));
				const after = root.commitEdits(edits);
				if (after === source) continue;
				const samples = changePreview(matches[0].text(), edits[0].insertedText);
				plans.push({ file, before, after, samples, count: matches.length });
			}
			for (const plan of plans) options.assertWritable?.(plan.file);

			const replacements = plans.reduce((sum, plan) => sum + plan.count, 0);
			if (!input.dryRun) {
				// The queue `edit` and `write` share, so a codemod and an edit of the
				// same file in one turn cannot interleave.
				const { withFileMutationQueue } = await pi();
				for (const plan of plans) {
					if (signal?.aborted) throw new Error("Edit cancelled after writing some files; check git status.");
					await withFileMutationQueue(plan.file, () => writeFile(plan.file, plan.after, "utf8"));
					// After the write, so the undo covers exactly the files that changed.
					reportPreimage(toolCallId, { tool: AST_EDIT_TOOL_NAME, path: plan.file, before: plan.before });
				}
			}
			const summary = plans.map((plan) => [`${display(cwd, plan.file)}  (${plan.count})`, ...plan.samples].join("\n"));
			const verb = input.dryRun ? "Would rewrite" : "Rewrote";
			const text = plans.length
				? `${verb} ${replacements} match${replacements === 1 ? "" : "es"} in ${plans.length} file${plans.length === 1 ? "" : "s"}${input.dryRun ? " (dry run, nothing written)" : ""}:\n\n${summary.join("\n\n")}`
				: "Every match already reads as the rewrite; nothing changed.";
			return {
				content: [{ type: "text", text }],
				details: { lang, files: plans.length, replacements, dryRun: !!input.dryRun, paths: plans.map((plan) => display(cwd, plan.file)) },
			};
		},
	};
}
