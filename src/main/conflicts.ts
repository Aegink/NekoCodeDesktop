// Adapted from oh-my-pi (MIT, © Mario Zechner, Can Bölük, Stencil Labs):
// packages/coding-agent/src/tools/conflict-detect.ts, conflict-uri.ts and
// packages/tui/src/tools/conflict-detect.ts. Hashline and LSP hooks dropped.
import { readFile, stat, writeFile } from "node:fs/promises";
import { relative } from "node:path";

/**
 * Git merge conflicts as addressable regions.
 *
 * `read` on a file with conflict markers registers each complete
 * `<<<<<<<`/`=======`/`>>>>>>>` block under a numeric id and appends a short
 * footer naming them. The agent then resolves a block by writing to
 * `conflict://<id>` — the marker block and nothing else is replaced — with
 * `@ours` / `@theirs` / `@base` / `@both` lines as shorthand for a recorded
 * side. `conflict://*` resolves every registered block at once.
 *
 * Resolving this way instead of with `edit` avoids the two ways models get
 * conflicts wrong: re-typing a side slightly differently, and leaving a stray
 * marker behind because the old text did not match exactly.
 */

const OURS_PREFIX = "<<<<<<<";
const BASE_PREFIX = "|||||||";
const SEPARATOR = "=======";
const THEIRS_PREFIX = ">>>>>>>";
const SCAN_MAX_BYTES = 10 * 1024 * 1024;
const PREVIEW_SIDE_LINES = 6;
/** Blocks shown in full in a read footer; the rest are listed by id. */
const PREVIEW_BLOCKS = 8;
const MAX_ECHO_LINES = 12;

export interface ConflictBlock {
	/** 1-indexed line of the `<<<<<<<` marker. */
	startLine: number;
	/** 1-indexed line of the `=======` separator. */
	separatorLine: number;
	/** 1-indexed line of the `>>>>>>>` marker. */
	endLine: number;
	/** 1-indexed line of the `|||||||` base marker (diff3 only). */
	baseLine?: number;
	oursLabel?: string;
	baseLabel?: string;
	theirsLabel?: string;
	oursLines: string[];
	baseLines?: string[];
	theirsLines: string[];
}

export interface ConflictEntry extends ConflictBlock {
	id: number;
	absolutePath: string;
	displayPath: string;
}

export type ConflictScope = "ours" | "theirs" | "base";

function stripTrailingCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The label after a column-0 marker, "" for a bare marker, null when the line is not one. */
function matchMarker(line: string, prefix: string): string | null {
	if (!line.startsWith(prefix)) return null;
	if (line.length === prefix.length) return "";
	if (line.charCodeAt(prefix.length) !== 32) return null;
	return line.slice(prefix.length + 1);
}

/**
 * Complete conflict blocks in `lines`. `firstLineNumber` is the 1-indexed line
 * of `lines[0]`. A block missing its closer is dropped rather than guessed at.
 */
export function scanConflictLines(lines: readonly string[], firstLineNumber = 1): ConflictBlock[] {
	const blocks: ConflictBlock[] = [];
	let phase: "idle" | "ours" | "base" | "theirs" = "idle";
	let partial: {
		startLine: number;
		oursLabel?: string;
		oursLines: string[];
		baseLine?: number;
		baseLabel?: string;
		baseLines?: string[];
		separatorLine?: number;
		theirsLines?: string[];
	} | null = null;

	for (let index = 0; index < lines.length; index++) {
		const line = stripTrailingCr(lines[index]);
		const number = firstLineNumber + index;
		const oursLabel = matchMarker(line, OURS_PREFIX);
		if (oursLabel !== null) {
			partial = { startLine: number, oursLabel: oursLabel || undefined, oursLines: [] };
			phase = "ours";
			continue;
		}
		if (phase === "idle" || partial === null) continue;

		const baseLabel = matchMarker(line, BASE_PREFIX);
		if (baseLabel !== null) {
			if (phase !== "ours") {
				partial = null;
				phase = "idle";
				continue;
			}
			partial.baseLine = number;
			partial.baseLabel = baseLabel || undefined;
			partial.baseLines = [];
			phase = "base";
			continue;
		}
		if (line === SEPARATOR) {
			if (phase === "ours" || phase === "base") {
				partial.separatorLine = number;
				partial.theirsLines = [];
				phase = "theirs";
			} else {
				partial = null;
				phase = "idle";
			}
			continue;
		}
		const theirsLabel = matchMarker(line, THEIRS_PREFIX);
		if (theirsLabel !== null) {
			if (phase === "theirs" && partial.separatorLine !== undefined && partial.theirsLines) {
				blocks.push({
					startLine: partial.startLine,
					separatorLine: partial.separatorLine,
					endLine: number,
					baseLine: partial.baseLine,
					oursLabel: partial.oursLabel,
					baseLabel: partial.baseLabel,
					theirsLabel: theirsLabel || undefined,
					oursLines: partial.oursLines,
					baseLines: partial.baseLines,
					theirsLines: partial.theirsLines,
				});
			}
			partial = null;
			phase = "idle";
			continue;
		}
		if (phase === "ours") partial.oursLines.push(line);
		else if (phase === "base") partial.baseLines?.push(line);
		else partial.theirsLines?.push(line);
	}
	return blocks;
}

/** Scan a whole file, reading at most 10 MB of it. */
export async function scanFileForConflicts(absolutePath: string): Promise<{ blocks: ConflictBlock[]; truncated: boolean }> {
	const info = await stat(absolutePath);
	if (!info.isFile()) return { blocks: [], truncated: false };
	const buffer = await readFile(absolutePath);
	const truncated = buffer.length > SCAN_MAX_BYTES;
	const text = buffer.subarray(0, SCAN_MAX_BYTES).toString("utf8");
	// Cheap test first: nearly every file read has no conflict at all.
	if (!text.includes(OURS_PREFIX)) return { blocks: [], truncated };
	return { blocks: scanConflictLines(text.split("\n")), truncated };
}

/** One session's registered conflicts. Ids are stable across re-reads of the same block. */
export class ConflictHistory {
	private nextId = 1;
	private readonly entries_ = new Map<number, ConflictEntry>();

	register(input: Omit<ConflictEntry, "id">): ConflictEntry {
		for (const existing of this.entries_.values()) {
			if (existing.absolutePath === input.absolutePath && existing.startLine === input.startLine) {
				const merged = { ...input, id: existing.id };
				this.entries_.set(existing.id, merged);
				return merged;
			}
		}
		const entry = { ...input, id: this.nextId++ };
		this.entries_.set(entry.id, entry);
		return entry;
	}

	get(id: number): ConflictEntry | undefined {
		return this.entries_.get(id);
	}

	entries(): ConflictEntry[] {
		return [...this.entries_.values()];
	}

	invalidate(id: number): void {
		this.entries_.delete(id);
	}

	/** Forget a file's blocks — it was rewritten, so their line numbers mean nothing now. */
	invalidatePath(absolutePath: string): void {
		for (const [id, entry] of this.entries_) if (entry.absolutePath === absolutePath) this.entries_.delete(id);
	}
}

export function isConflictUri(path: string): boolean {
	return /(?:^|:)conflict:\/\//.test(path.trim());
}

export interface ParsedConflictUri {
	id: number | "*";
	scope?: ConflictScope;
}

export function parseConflictUri(raw: string): ParsedConflictUri {
	// `file.ts:conflict://3` mixes a read selector into the URI; the URI alone is meant.
	const trimmed = raw.trim().replace(/^.+:(conflict:\/\/.+)$/, "$1");
	const match = /^conflict:\/\/(.+)$/.exec(trimmed);
	if (!match) throw new Error(`Invalid conflict URI '${raw}': must be 'conflict://<N>', 'conflict://<N>/<scope>', or 'conflict://*'.`);
	const [idPart, scopePart] = match[1].split("/", 2);
	if (idPart === "*") {
		if (scopePart !== undefined) throw new Error(`Invalid conflict URI '${raw}': 'conflict://*' takes no scope.`);
		return { id: "*" };
	}
	if (!/^\d+$/.test(idPart) || Number(idPart) < 1)
		throw new Error(`Invalid conflict URI '${raw}': N must be a positive id surfaced by a prior read.`);
	if (scopePart !== undefined && !["ours", "theirs", "base"].includes(scopePart))
		throw new Error(`Invalid conflict URI '${raw}': scope must be 'ours', 'theirs' or 'base'.`);
	return { id: Number(idPart), scope: scopePart as ConflictScope | undefined };
}

function markerLine(prefix: string, label: string | undefined): string {
	return label ? `${prefix} ${label}` : prefix;
}

/** The marker block as it stands in the file. */
function recordedRegion(entry: ConflictBlock): string[] {
	const out = [markerLine(OURS_PREFIX, entry.oursLabel), ...entry.oursLines];
	if (entry.baseLines !== undefined) out.push(markerLine(BASE_PREFIX, entry.baseLabel), ...entry.baseLines);
	out.push(SEPARATOR, ...entry.theirsLines, markerLine(THEIRS_PREFIX, entry.theirsLabel));
	return out;
}

function sectionsEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((line, index) => line === b[index]);
}

export function conflictRegionsEqual(a: ConflictBlock, b: ConflictBlock): boolean {
	return sectionsEqual(recordedRegion(a), recordedRegion(b));
}

/** The lines `conflict://<N>` or `conflict://<N>/<scope>` shows, and the file line the first one is on. */
export function renderConflictRegion(entry: ConflictEntry, scope?: ConflictScope): { lines: string[]; startLine: number } {
	if (scope === "ours") return { lines: [...entry.oursLines], startLine: entry.startLine + 1 };
	if (scope === "theirs") return { lines: [...entry.theirsLines], startLine: entry.separatorLine + 1 };
	if (scope === "base") {
		if (entry.baseLines === undefined || entry.baseLine === undefined)
			throw new Error(`Conflict #${entry.id} has no base section (2-way merge); /base is only valid for diff3 conflicts.`);
		return { lines: [...entry.baseLines], startLine: entry.baseLine + 1 };
	}
	return { lines: recordedRegion(entry), startLine: entry.startLine };
}

function matchesAt(lines: readonly string[], start: number, expected: readonly string[]): boolean {
	if (start < 0 || start + expected.length > lines.length) return false;
	return expected.every((line, index) => stripTrailingCr(lines[start + index]) === line);
}

/** Where the recorded block is now, preferring the position it was recorded at. */
function locateRegion(lines: readonly string[], expected: readonly string[], preferred: number): { start: number; end: number } | null {
	if (matchesAt(lines, preferred, expected)) return { start: preferred, end: preferred + expected.length - 1 };
	let best: number | null = null;
	for (let index = 0; index + expected.length <= lines.length; index++) {
		if (matchesAt(lines, index, expected) && (best === null || Math.abs(index - preferred) < Math.abs(best - preferred))) best = index;
	}
	return best === null ? null : { start: best, end: best + expected.length - 1 };
}

/** Net `{}`/`()`/`[]` count — crude, only ever used to corroborate a one-line echo trim. */
function delimiterBalance(lines: readonly string[]): number {
	let balance = 0;
	for (const line of lines) {
		for (const char of line) {
			if (char === "{" || char === "(" || char === "[") balance++;
			else if (char === "}" || char === ")" || char === "]") balance--;
		}
	}
	return balance;
}

/**
 * Drop replacement lines that repeat the file lines around the block. Models
 * often paste the whole resolved function, context included, and splicing that
 * verbatim would duplicate the context. Two or more echoed lines are always
 * trimmed; a single line only when trimming it is what restores the sides'
 * delimiter balance.
 */
function trimBoundaryEcho(
	replacement: string[],
	fileLines: readonly string[],
	match: { start: number; end: number },
	entry: ConflictBlock,
): { lines: string[]; trimmed: number } {
	const ours = delimiterBalance(entry.oursLines);
	const expected = ours === delimiterBalance(entry.theirsLines) ? ours : null;
	const singleJustified = (lines: string[], without: string[]) =>
		expected !== null && delimiterBalance(lines) !== expected && delimiterBalance(without) === expected;

	let lines = replacement;
	let trimmed = 0;
	const after = fileLines.slice(match.end + 1, match.end + 1 + MAX_ECHO_LINES).map(stripTrailingCr);
	for (let k = Math.min(after.length, lines.length - 1); k >= 1; k--) {
		if (!after.slice(0, k).every((line, index) => lines[lines.length - k + index] === line)) continue;
		if (k >= 2 || singleJustified(lines, lines.slice(0, -1))) {
			trimmed += k;
			lines = lines.slice(0, lines.length - k);
		}
		break;
	}
	const before = fileLines.slice(Math.max(0, match.start - MAX_ECHO_LINES), match.start).map(stripTrailingCr);
	// The whole enclosing construct pasted back: one echoed line at each end,
	// e.g. `function a() {` … `}`. Balanced as a whole, so neither end justifies
	// itself alone, but the pair together is as clear an echo as two lines.
	if (
		trimmed === 0 &&
		lines.length >= 3 &&
		lines[0] === before[before.length - 1] &&
		lines[lines.length - 1] === after[0] &&
		expected !== null &&
		delimiterBalance(lines.slice(1, -1)) === expected
	) {
		return { lines: lines.slice(1, -1), trimmed: 2 };
	}
	for (let k = Math.min(before.length, lines.length - 1); k >= 1; k--) {
		if (!before.slice(before.length - k).every((line, index) => lines[index] === line)) continue;
		if (k >= 2 || singleJustified(lines, lines.slice(1))) {
			trimmed += k;
			lines = lines.slice(k);
		}
		break;
	}
	return { lines, trimmed };
}

/** Replace the recorded block in `text` — markers and all sides — with `replacement`. */
export function spliceConflict(text: string, entry: ConflictEntry, replacement: string): { text: string; trimmed: number } {
	const lines = text.split("\n");
	const match = locateRegion(lines, recordedRegion(entry), entry.startLine - 1);
	if (!match)
		throw new Error(
			`Conflict #${entry.id} is no longer in '${entry.displayPath}': the file changed since it was read. Read it again to re-register its conflicts.`,
		);
	const body = replacement.replace(/\r?\n$/, "");
	const echo = trimBoundaryEcho(body.split("\n").map(stripTrailingCr), lines, match, entry);
	let replacementLines = echo.lines;
	// A CRLF file gets CRLF back; the last spliced line only carries one when
	// something follows it.
	if (lines[match.start].endsWith("\r")) {
		const following = match.end + 1 < lines.length;
		replacementLines = replacementLines.map((line, index) => (index < replacementLines.length - 1 || following ? `${line}\r` : line));
	}
	return { text: [...lines.slice(0, match.start), ...replacementLines, ...lines.slice(match.end + 1)].join("\n"), trimmed: echo.trimmed };
}

/** Expand whole-line `@ours` / `@theirs` / `@base` / `@both` tokens against the recorded sides. */
export function expandContentTokens(content: string, entry: ConflictEntry): string {
	const out: string[] = [];
	for (const raw of content.split("\n")) {
		switch (stripTrailingCr(raw)) {
			case "@ours":
				out.push(...entry.oursLines);
				break;
			case "@theirs":
				out.push(...entry.theirsLines);
				break;
			case "@base":
				if (!entry.baseLines) throw new Error(`Conflict #${entry.id} has no base section (2-way merge); @base is only valid for diff3 conflicts.`);
				out.push(...entry.baseLines);
				break;
			case "@both":
				out.push(...entry.oursLines, ...entry.theirsLines);
				break;
			default:
				out.push(raw);
		}
	}
	return out.join("\n");
}

const DIRECTIVE = /^#?(\d+)\s*[:=]\s*(@ours|@theirs|@base|@both)$/;

/**
 * `conflict://*` content made only of `<id>: @side` lines resolves each listed
 * block with its own side. Null when no line is a directive (uniform mode);
 * an error when directives are mixed with other lines, which would otherwise
 * paste the directive text into every block.
 */
export function parseBulkDirectives(content: string): Map<number, string> | null {
	const map = new Map<number, string>();
	const stray: string[] = [];
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const match = DIRECTIVE.exec(line);
		if (!match) {
			stray.push(line);
			continue;
		}
		const id = Number(match[1]);
		if (map.has(id)) throw new Error(`Bulk directive lists conflict #${id} twice.`);
		map.set(id, match[2]);
	}
	if (map.size === 0) return null;
	if (stray.length)
		throw new Error(
			`Malformed conflict://* block: '${stray[0].slice(0, 60)}' is not an '<id>: @side' line. Per-id bulk only takes @ours/@theirs/@base/@both; write literal resolutions to conflict://<N> one by one.`,
		);
	return map;
}

function formatBody(out: string[], section: readonly string[]): void {
	if (section.length === 0) {
		out.push("(empty)");
		return;
	}
	out.push(...section.slice(0, PREVIEW_SIDE_LINES));
	const hidden = section.length - PREVIEW_SIDE_LINES;
	if (hidden > 0) out.push(`… (${hidden} more line${hidden === 1 ? "" : "s"})`);
}

/** The footer a read of a conflicted file ends with. */
export function formatConflictWarning(entries: readonly ConflictEntry[], truncated = false): string {
	if (entries.length === 0) return "";
	const out = ["", `⚠ ${entries.length} unresolved merge conflict${entries.length === 1 ? "" : "s"} detected`];
	if (truncated) out.push("- note: only the first 10 MB were scanned; more conflicts may follow.");
	const ours = entries.find((entry) => entry.oursLabel)?.oursLabel;
	const theirs = entries.find((entry) => entry.theirsLabel)?.theirsLabel;
	if (ours) out.push(`- ours = ${ours}`);
	if (theirs) out.push(`- theirs = ${theirs}`);
	out.push(
		'Resolve with `write({ path: "conflict://<N>", content })` — it replaces ONLY the marker block, so never repeat the lines around it. A content line that is exactly `@ours` / `@theirs` / `@base` / `@both` expands to that side (`@both` = ours then theirs; only for additive conflicts, never for competing edits of the same lines). Read `conflict://<N>` (or `/ours`, `/theirs`, `/base`) to inspect one block.',
		'Many pick-a-side blocks: `write({ path: "conflict://*", content: "1: @ours\\n2: @theirs" })` resolves each listed id in one call; plain `content` for `conflict://*` applies to every block. Keep one side or combine them faithfully — never invent code that is in neither side.',
	);
	for (const entry of entries.slice(0, PREVIEW_BLOCKS)) {
		out.push("", `──── #${entry.id}  L${entry.startLine}-${entry.endLine} ────`, "<<< ours");
		formatBody(out, entry.oursLines);
		if (entry.baseLines !== undefined) {
			if (sectionsEqual(entry.baseLines, entry.oursLines)) out.push("=== base ≡ ours");
			else if (sectionsEqual(entry.baseLines, entry.theirsLines)) out.push("=== base ≡ theirs");
			else {
				out.push("=== base");
				formatBody(out, entry.baseLines);
			}
		}
		if (sectionsEqual(entry.theirsLines, entry.oursLines)) out.push(">>> theirs ≡ ours");
		else {
			out.push(">>> theirs");
			formatBody(out, entry.theirsLines);
		}
	}
	const rest = entries.slice(PREVIEW_BLOCKS);
	if (rest.length) out.push("", `Also: ${rest.map((entry) => `#${entry.id} L${entry.startLine}-${entry.endLine}`).join(", ")}`);
	return out.join("\n");
}

/** Register every block in a file and return its footer, or "" when it has none. */
export async function registerFileConflicts(history: ConflictHistory, absolutePath: string, cwd: string): Promise<string> {
	let scan: Awaited<ReturnType<typeof scanFileForConflicts>>;
	try {
		scan = await scanFileForConflicts(absolutePath);
	} catch {
		return "";
	}
	if (!scan.blocks.length) return "";
	const displayPath = relative(cwd, absolutePath).split("\\").join("/") || absolutePath;
	const entries = scan.blocks.map((block) => history.register({ ...block, absolutePath, displayPath }));
	return formatConflictWarning(entries, scan.truncated);
}

export function readConflictUri(history: ConflictHistory, raw: string): string {
	const target = parseConflictUri(raw);
	if (target.id === "*") throw new Error("conflict://* is write-only; read conflict://<N> to inspect one block.");
	const entry = history.get(target.id);
	if (!entry) throw new Error(`Conflict #${target.id} not found. Ids are registered when read shows a conflicted file; read it again.`);
	const region = renderConflictRegion(entry, target.scope);
	const width = String(region.startLine + region.lines.length).length;
	return [
		`${entry.displayPath}, conflict #${entry.id}${target.scope ? ` (${target.scope})` : ""}:`,
		...region.lines.map((line, index) => `${String(region.startLine + index).padStart(width)}│${line}`),
	].join("\n");
}

export interface ConflictWriteOptions {
	/** Refuse a file the caller may not write, before anything is changed. */
	assertWritable?: (absolutePath: string) => void;
	/** Called with a file's contents before it is first rewritten — for the checkpoint journal. */
	onBeforeWrite?: (absolutePath: string, before: Buffer) => void;
}

async function applyToFile(
	history: ConflictHistory,
	absolutePath: string,
	entries: ConflictEntry[],
	contentFor: (entry: ConflictEntry) => string,
	options: ConflictWriteOptions,
): Promise<{ resolved: number; trimmed: number }> {
	options.assertWritable?.(absolutePath);
	const before = await readFile(absolutePath);
	let text = before.toString("utf8");
	let trimmed = 0;
	const resolved: ConflictEntry[] = [];
	// Bottom-up, so each splice leaves the line numbers above it valid.
	for (const entry of [...entries].sort((a, b) => b.startLine - a.startLine)) {
		try {
			const splice = spliceConflict(text, entry, expandContentTokens(contentFor(entry), entry));
			text = splice.text;
			trimmed += splice.trimmed;
			resolved.push(entry);
		} catch (error) {
			// A stale twin of a block already spliced in this pass is resolved, not missing.
			if (resolved.some((done) => conflictRegionsEqual(done, entry))) continue;
			throw error;
		}
	}
	options.onBeforeWrite?.(absolutePath, before);
	await writeFile(absolutePath, text, "utf8");
	// The other blocks' ids stay valid: a splice finds its block by content, so
	// lines moving above it do not matter.
	for (const entry of resolved) history.invalidate(entry.id);
	// A re-read after lines shifted can register the same block twice; the twin
	// of a block just spliced away is gone too. A distinct block that happens to
	// be byte-identical is still in the file and stays.
	const normalized = text.replace(/\r\n/g, "\n");
	for (const other of history.entries()) {
		if (
			other.absolutePath === absolutePath &&
			resolved.some((entry) => conflictRegionsEqual(entry, other)) &&
			!normalized.includes(recordedRegion(other).join("\n"))
		)
			history.invalidate(other.id);
	}
	return { resolved: resolved.length, trimmed };
}

/** Apply a write to `conflict://<N>` or `conflict://*`. Returns the text for the tool result. */
export async function writeConflictUri(
	history: ConflictHistory,
	raw: string,
	content: string,
	options: ConflictWriteOptions = {},
): Promise<string> {
	const target = parseConflictUri(raw);
	if (target.scope)
		throw new Error(`conflict://${target.id}/${target.scope} is read-only; write conflict://${target.id} with content '@${target.scope}' instead.`);
	const echoNote = (trimmed: number) =>
		trimmed ? `\nNote: dropped ${trimmed} line(s) that repeated the code around the block — writes replace only the marker block.` : "";

	if (target.id !== "*") {
		const entry = history.get(target.id);
		if (!entry) throw new Error(`Conflict #${target.id} not found. Ids are registered when read shows a conflicted file; read it again.`);
		const result = await applyToFile(history, entry.absolutePath, [entry], () => content, options);
		const remaining = history.entries().filter((other) => other.absolutePath === entry.absolutePath).map((other) => `#${other.id}`);
		const left = remaining.length ? ` Still unresolved in this file: ${remaining.join(", ")}.` : "";
		return `Resolved conflict #${entry.id} (lines ${entry.startLine}-${entry.endLine}) in ${entry.displayPath}.${left}${echoNote(result.trimmed)}`;
	}

	const all = history.entries();
	if (all.length === 0) throw new Error("conflict://* has nothing to resolve: no conflicts are registered. Read the conflicted files first.");
	const directives = parseBulkDirectives(content);
	if (directives) {
		const unknown = [...directives.keys()].filter((id) => !history.get(id));
		if (unknown.length)
			throw new Error(`Unknown conflict id(s) ${unknown.map((id) => `#${id}`).join(", ")}; registered: ${all.map((e) => `#${e.id}`).join(", ")}.`);
	}
	const selected = directives ? all.filter((entry) => directives.has(entry.id)) : all;
	const byFile = new Map<string, ConflictEntry[]>();
	for (const entry of selected) byFile.set(entry.absolutePath, [...(byFile.get(entry.absolutePath) ?? []), entry]);

	const done: string[] = [];
	const failed: string[] = [];
	let trimmed = 0;
	for (const [path, entries] of byFile) {
		try {
			const result = await applyToFile(history, path, entries, (entry) => directives?.get(entry.id) ?? content, options);
			trimmed += result.trimmed;
			done.push(`  ${entries[0].displayPath}: ${result.resolved}`);
		} catch (error) {
			failed.push(`  ${entries[0].displayPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const lines: string[] = [];
	if (done.length) lines.push(`Resolved conflicts in ${done.length} file(s):`, ...done);
	if (failed.length) lines.push(`Left ${failed.length} file(s) untouched:`, ...failed);
	if (!done.length) throw new Error(lines.join("\n"));
	return lines.join("\n") + echoNote(trimmed);
}
