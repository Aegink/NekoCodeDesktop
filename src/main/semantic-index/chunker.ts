import { createHash } from "node:crypto";
import { extname } from "node:path";
import { extractSymbols } from "../mentions";

/**
 * Files cut into the pieces the index ranks.
 *
 * A piece should be one thing — a function, a class, a block of config — so
 * that matching it means something and showing it costs little. Cuts land on
 * declarations where the language is known, otherwise on a blank line before
 * unindented code, and only fall back to a hard cut inside a block too long to
 * keep whole.
 */

export interface Chunk {
	/** Project-relative, `/`-separated. */
	path: string;
	/** 1-based, inclusive. */
	startLine: number;
	endLine: number;
	/** The declaration the chunk starts in, when one is known. */
	symbol: string | null;
	text: string;
	/** Of the chunk's location and text: read-back text that hashes differently has changed since the scan. */
	hash: string;
}

/** Below this a chunk is merged into the next rather than cut off. */
const MIN_LINES = 12;
/** Past this a chunk is cut at the next boundary. */
const TARGET_LINES = 60;
/** Past this it is cut wherever it is. */
const MAX_LINES = 120;
const MAX_CHARS = 6_000;

/** Text worth indexing: source, config and prose — not data dumps or binaries. */
const INDEXED_EXTENSIONS = new Set([
	".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro",
	".py", ".pyi", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".swift", ".dart", ".cs", ".fs",
	".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".m", ".mm", ".zig", ".nim",
	".rb", ".php", ".lua", ".pl", ".ex", ".exs", ".erl", ".clj", ".hs", ".ml", ".r", ".jl",
	".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd",
	".sql", ".graphql", ".gql", ".proto", ".prisma",
	".html", ".htm", ".css", ".scss", ".less", ".sass",
	".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".gradle",
	".md", ".mdx", ".rst", ".txt", ".tex",
]);

const INDEXED_NAMES = new Set(["dockerfile", "makefile", "justfile", "rakefile", "gemfile", "procfile", "cmakelists.txt"]);

/** Written by tools, read by nobody: lockfiles and the like. */
const SKIPPED_NAMES = new Set([
	"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "cargo.lock", "poetry.lock",
	"composer.lock", "gemfile.lock", "go.sum", "uv.lock", "pipfile.lock",
]);

export const MAX_INDEXED_FILE_BYTES = 512 * 1024;

/** Whether a project-relative path is the kind of file the index reads. */
export function isIndexable(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	if (SKIPPED_NAMES.has(name)) return false;
	if (/\.min\.(?:js|css)$|\.map$|\.snap$|\.d\.ts\.map$/.test(name)) return false;
	return INDEXED_EXTENSIONS.has(extname(name)) || INDEXED_NAMES.has(name);
}

/** Minified or generated text: lines so long that no cut makes a readable chunk. */
export function looksMinified(text: string): boolean {
	if (text.length < 2_000) return false;
	const lines = text.split("\n").length;
	return text.length / lines > 300;
}

function indentOf(line: string): number {
	const match = /^[ \t]*/.exec(line);
	return match ? match[0].replace(/\t/g, "    ").length : 0;
}

export function chunkHash(path: string, symbol: string | null, text: string): string {
	return createHash("sha1").update(`${path}${symbol ? ` · ${symbol}` : ""}\n${text}`).digest("hex");
}

/** A file's lines as the chunker sees them. */
export function fileLines(text: string): string[] {
	return text.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * A chunk's text from its file's lines. The index keeps only line ranges and
 * reads text back when it needs it, so both sides cut it here, the same way.
 */
export function sliceLines(lines: readonly string[], startLine: number, endLine: number): string {
	const body = lines.slice(startLine - 1, endLine).join("\n");
	return body.length > MAX_CHARS ? body.slice(0, MAX_CHARS) : body;
}

/** Cut one file's text into chunks. `path` is project-relative. */
export function chunkFile(path: string, text: string): Chunk[] {
	const normalized = text.replace(/\r\n?/g, "\n");
	const lines = fileLines(normalized);
	if (lines.length && lines[lines.length - 1] === "") lines.pop();
	if (!lines.length || !normalized.trim()) return [];

	// Declarations by line, from the same matchers the @-mention symbol search uses.
	const symbols = new Map<number, string>();
	for (const symbol of extractSymbols(path, normalized)) {
		if (!symbols.has(symbol.line - 1)) symbols.set(symbol.line - 1, symbol.name);
	}
	const isBoundary = (index: number): boolean => {
		if (symbols.has(index)) return true;
		const line = lines[index];
		if (!line.trim() || indentOf(line) > 0) return false;
		return index > 0 && !lines[index - 1].trim();
	};

	const chunks: Chunk[] = [];
	let start = 0;
	let chars = 0;
	let currentSymbol: string | null = null;
	let chunkSymbol: string | null = null;
	const emit = (end: number) => {
		// Drop the blank lines a cut leaves at either edge.
		let from = start;
		let to = end;
		while (from < to && !lines[from].trim()) from++;
		while (to > from && !lines[to].trim()) to--;
		const clipped = sliceLines(lines, from + 1, to + 1);
		if (clipped.trim()) {
			chunks.push({
				path,
				startLine: from + 1,
				endLine: to + 1,
				symbol: chunkSymbol,
				text: clipped,
				hash: chunkHash(path, chunkSymbol, clipped),
			});
		}
		start = end + 1;
		chars = 0;
		chunkSymbol = currentSymbol;
	};

	for (let index = 0; index < lines.length; index++) {
		const size = index - start;
		if (index > start && isBoundary(index) && size >= MIN_LINES && (size >= TARGET_LINES || symbols.has(index))) {
			emit(index - 1);
		} else if (size >= MAX_LINES || chars >= MAX_CHARS) {
			// Too long to keep whole: back up to a blank line if there is one nearby.
			let cut = index - 1;
			for (let back = index - 1; back > index - 20 && back > start; back--) {
				if (!lines[back].trim()) {
					cut = back;
					break;
				}
			}
			emit(cut);
			index = cut;
			continue;
		}
		const named = symbols.get(index);
		if (named) {
			currentSymbol = named;
			if (index === start || chunkSymbol === null) chunkSymbol = named;
		}
		chars += lines[index].length + 1;
	}
	if (start < lines.length) emit(lines.length - 1);
	return chunks;
}
