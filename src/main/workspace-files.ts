import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	IDE_EDIT_MAX_BYTES,
	type IdeCreateRequest,
	type IdeReadResult,
	type IdeRenameRequest,
	type IdeSearchFile,
	type IdeSearchRequest,
	type IdeSearchResult,
	type IdeStatEntry,
	type IdeWriteRequest,
	type IdeWriteResult,
	searchPattern,
} from "../shared/ide";
import { resolveUnderRoot } from "./project-paths";

/**
 * File work for the IDE layout: the editor's whole-file reads and writes, the
 * explorer's create/rename, and project search.
 *
 * Every path goes through {@link resolveUnderRoot}, so nothing here reads or
 * writes outside the project the window has open.
 */

/** A NUL in the head of a file is the usual tell of a binary, and good enough here. */
const SNIFF_BYTES = 8192;
/** Search skips files past this: they are data, not source, and slow to scan. */
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
const SEARCH_MAX_MATCHES = 5_000;
const SEARCH_MAX_MATCHES_PER_LINE = 50;
const SEARCH_PREVIEW_CHARS = 240;
/** Files read at once while searching. */
const SEARCH_CONCURRENCY = 24;
/** Two mtimes this close are the same write, reported through different clocks. */
const MTIME_SLACK_MS = 1;

const UTF8_BOM = String.fromCharCode(0xfeff);

function isBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, SNIFF_BYTES).includes(0);
}

export async function readTextFile(cwd: string, relPath: string): Promise<IdeReadResult> {
	const resolved = resolveUnderRoot(cwd, relPath);
	const info = await stat(resolved.target);
	if (!info.isFile()) throw new Error(`Not a file: ${relPath}`);
	const rel = resolved.relPath;
	if (info.size > IDE_EDIT_MAX_BYTES) return { kind: "tooLarge", relPath: rel, size: info.size };
	const buffer = await readFile(resolved.target);
	if (isBinary(buffer)) return { kind: "binary", relPath: rel, size: info.size };
	let text = buffer.toString("utf8");
	const bom = text.startsWith(UTF8_BOM);
	if (bom) text = text.slice(1);
	return { kind: "text", relPath: rel, text, mtimeMs: info.mtimeMs, size: info.size, bom };
}

async function mtimeOf(path: string): Promise<number | null> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Save the editor's copy of a file.
 *
 * Refused as a conflict when the file changed on disk after the editor read it
 * — in an app where an agent edits the same files, silently writing over its
 * work is the failure that matters. The editor then offers to overwrite or to
 * take the disk's version.
 */
export async function writeTextFile(request: IdeWriteRequest): Promise<IdeWriteResult> {
	const { target } = resolveUnderRoot(request.cwd, request.relPath);
	if (!request.force && request.expectedMtimeMs != null) {
		const current = await mtimeOf(target);
		if (current !== null && Math.abs(current - request.expectedMtimeMs) > MTIME_SLACK_MS) {
			return { ok: false, conflict: true, mtimeMs: current };
		}
	}
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, (request.bom ? UTF8_BOM : "") + request.text, "utf8");
	return { ok: true, mtimeMs: (await stat(target)).mtimeMs };
}

export async function createEntry(request: IdeCreateRequest): Promise<string> {
	const resolved = resolveUnderRoot(request.cwd, request.relPath);
	if (!resolved.relPath) throw new Error("Name required");
	if ((await mtimeOf(resolved.target)) !== null) throw new Error(`Already exists: ${resolved.relPath}`);
	if (request.kind === "dir") {
		await mkdir(resolved.target, { recursive: true });
	} else {
		await mkdir(dirname(resolved.target), { recursive: true });
		// `wx`: a file that appeared since the check above is not truncated.
		const handle = await open(resolved.target, "wx");
		await handle.close();
	}
	return resolved.relPath;
}

export async function renameEntry(request: IdeRenameRequest): Promise<string> {
	const from = resolveUnderRoot(request.cwd, request.from);
	const to = resolveUnderRoot(request.cwd, request.to);
	if (!from.relPath || !to.relPath) throw new Error("Cannot rename the project root");
	// A case-only rename is the same file on Windows and macOS; let it through.
	if (from.target.toLowerCase() !== to.target.toLowerCase() && (await mtimeOf(to.target)) !== null) {
		throw new Error(`Already exists: ${to.relPath}`);
	}
	await mkdir(dirname(to.target), { recursive: true });
	await rename(from.target, to.target);
	return to.relPath;
}

/** The absolute path to hand to the trash, refusing the root itself. */
export function deletableTarget(cwd: string, relPath: string): string {
	const resolved = resolveUnderRoot(cwd, relPath);
	if (!resolved.relPath) throw new Error("Cannot delete the project root");
	return resolved.target;
}

/** What the editor polls to notice files changing under its open tabs. */
export async function statFiles(cwd: string, relPaths: readonly string[]): Promise<IdeStatEntry[]> {
	return Promise.all(
		relPaths.map(async (relPath) => {
			try {
				const info = await stat(resolveUnderRoot(cwd, relPath).target);
				return { relPath, mtimeMs: info.isFile() ? info.mtimeMs : null, size: info.size };
			} catch {
				return { relPath, mtimeMs: null, size: 0 };
			}
		}),
	);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * A glob as the search box takes it. `*.ts` matches at any depth, the way
 * editors treat a pattern without a slash; `src/**` is anchored at the root; a
 * bare name matches a file or folder of that name anywhere.
 */
export function globToRegExp(glob: string): RegExp | null {
	let pattern = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (!pattern) return null;
	if (pattern.endsWith("/")) pattern += "**";
	const anchored = pattern.includes("/");
	let source = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index]!;
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				if (pattern[index + 2] === "/") {
					source += "(?:.*/)?";
					index += 2;
				} else {
					source += ".*";
					index += 1;
				}
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(anchored ? `^${source}(?:/.*)?$` : `(?:^|/)${source}(?:/.*)?$`, "i");
}

function globList(value: string | undefined): RegExp[] {
	return (value ?? "")
		.split(",")
		.map(globToRegExp)
		.filter((entry): entry is RegExp => entry !== null);
}

/** Matches of `pattern` in one file's text, 1-based, with a preview per match. */
export function searchText(text: string, pattern: RegExp, budget: number): IdeSearchFile["matches"] {
	const matches: IdeSearchFile["matches"] = [];
	const lines = text.split(/\r\n|\r|\n/);
	for (let index = 0; index < lines.length && matches.length < budget; index++) {
		const line = lines[index]!;
		pattern.lastIndex = 0;
		let perLine = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(line)) !== null) {
			if (match[0].length === 0) {
				pattern.lastIndex++;
				continue;
			}
			const column = match.index;
			// A window around the match, so a minified line still reads as one row.
			let start = line.length > SEARCH_PREVIEW_CHARS ? Math.max(0, column - 60) : 0;
			const leading = line.slice(start).match(/^\s*/)?.[0].length ?? 0;
			if (start + leading <= column) start += leading;
			matches.push({
				line: index + 1,
				column: column + 1,
				length: match[0].length,
				preview: line.slice(start, start + SEARCH_PREVIEW_CHARS),
				previewColumn: column - start,
			});
			if (++perLine >= SEARCH_MAX_MATCHES_PER_LINE || matches.length >= budget) break;
		}
	}
	return matches;
}

/**
 * Search the project's files — the list comes from the caller, which already
 * knows what git ignores — for a text or pattern.
 */
export async function searchProject(files: readonly string[], request: IdeSearchRequest): Promise<IdeSearchResult> {
	if (!request.query) return { files: [], matchCount: 0, truncated: false };
	const pattern = searchPattern(request);
	const include = globList(request.include);
	const exclude = globList(request.exclude);
	const candidates = files.filter(
		(file) => (include.length === 0 || include.some((glob) => glob.test(file))) && !exclude.some((glob) => glob.test(file)),
	);

	const results: IdeSearchFile[] = [];
	let matchCount = 0;
	let truncated = false;
	for (let at = 0; at < candidates.length && !truncated; at += SEARCH_CONCURRENCY) {
		const batch = candidates.slice(at, at + SEARCH_CONCURRENCY);
		const texts = await Promise.all(
			batch.map(async (relPath) => {
				try {
					const { target } = resolveUnderRoot(request.cwd, relPath);
					const info = await stat(target);
					if (!info.isFile() || info.size > SEARCH_MAX_FILE_BYTES) return null;
					const buffer = await readFile(target);
					return isBinary(buffer) ? null : buffer.toString("utf8");
				} catch {
					return null;
				}
			}),
		);
		for (let index = 0; index < batch.length; index++) {
			const text = texts[index];
			if (text == null) continue;
			// Each file gets its own copy: a shared global regex carries `lastIndex`.
			const matches = searchText(text, new RegExp(pattern.source, pattern.flags), SEARCH_MAX_MATCHES - matchCount);
			if (matches.length === 0) continue;
			results.push({ relPath: batch[index]!, matches });
			matchCount += matches.length;
			if (matchCount >= SEARCH_MAX_MATCHES) {
				truncated = true;
				break;
			}
		}
	}
	return { files: results, matchCount, truncated };
}
