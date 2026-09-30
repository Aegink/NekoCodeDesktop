/**
 * The IDE layout's contract with main: whole-file reads and writes for the
 * editor, the explorer's file operations, and project search.
 *
 * Paths are project-relative (either separator) and resolved by main against
 * the project root; anything that escapes the root is refused, as for the dock's
 * Files pane.
 */

/** The editor opens files up to this size; past it the file is shown as too large. */
export const IDE_EDIT_MAX_BYTES = 10 * 1024 * 1024;

export type IdeReadResult =
	| {
			kind: "text";
			relPath: string;
			text: string;
			/** The file's mtime when read — what a save checks against. */
			mtimeMs: number;
			size: number;
			/** The file started with a UTF-8 byte-order mark; a save writes it back. */
			bom: boolean;
	  }
	| { kind: "binary"; relPath: string; size: number }
	| { kind: "tooLarge"; relPath: string; size: number };

export interface IdeWriteRequest {
	cwd: string;
	relPath: string;
	text: string;
	bom?: boolean;
	/**
	 * The mtime the editor's copy was read at. When the file on disk has moved on
	 * since — the agent edited it, say — the write is refused as a conflict
	 * unless `force` is set. Null for a file the editor created.
	 */
	expectedMtimeMs?: number | null;
	force?: boolean;
}

export type IdeWriteResult = { ok: true; mtimeMs: number } | { ok: false; conflict: true; mtimeMs: number };

export interface IdeCreateRequest {
	cwd: string;
	relPath: string;
	kind: "file" | "dir";
}

export interface IdeRenameRequest {
	cwd: string;
	from: string;
	to: string;
}

export interface IdeStatEntry {
	relPath: string;
	/** Null when the file is gone. */
	mtimeMs: number | null;
	size: number;
}

export interface IdeSearchRequest {
	cwd: string;
	query: string;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	regex?: boolean;
	/** Comma-separated globs a file must match, e.g. `src/**, *.ts`. */
	include?: string;
	/** Comma-separated globs a file must not match. */
	exclude?: string;
}

/**
 * The query as a global regular expression — the one main searches with and
 * the one Replace All rewrites with, so the two can never disagree.
 */
export function searchPattern(request: Pick<IdeSearchRequest, "query" | "caseSensitive" | "wholeWord" | "regex">): RegExp {
	const body = request.regex ? request.query : request.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const source = request.wholeWord ? `\\b(?:${body})\\b` : body;
	try {
		return new RegExp(source, request.caseSensitive ? "gm" : "gim");
	} catch (error) {
		throw new Error(`无效的正则表达式：${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The replacement as `String.replace` takes it: literal unless the query is a regex. */
export function replacementText(replace: string, regex: boolean | undefined): string {
	return regex ? replace : replace.replace(/\$/g, "$$$$");
}

export interface IdeSearchMatch {
	/** 1-based, as the editor counts. */
	line: number;
	column: number;
	length: number;
	/** The line, trimmed to a window around the match. */
	preview: string;
	/** Where the match starts inside `preview`. */
	previewColumn: number;
}

export interface IdeSearchFile {
	relPath: string;
	matches: IdeSearchMatch[];
}

export interface IdeSearchResult {
	files: IdeSearchFile[];
	matchCount: number;
	/** Stopped at the result cap; there is more than is shown. */
	truncated: boolean;
}
