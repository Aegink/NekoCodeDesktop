import { readFile, stat } from "node:fs/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isConflictUri, readConflictUri, registerFileConflicts, type ConflictHistory } from "./conflicts";
import type { PiCodingAgentModule } from "./pi";
import { detectSpecialRead, renderSpecialRead, resolveModelPath } from "./read-formats";

/**
 * pi's `read`, taught the formats in `read-formats.ts`.
 *
 * Registered under the same name, so it replaces the built-in everywhere — the
 * mode manifests, the permission gate, the file journal and the transcript all
 * keep seeing `read`. Plain files still go through pi's own implementation
 * untouched; only a path this module recognises is rendered here, and then
 * paged with pi's limits and pi's continuation notices so the model sees one
 * consistent tool.
 */

const EXTRA_DESCRIPTION =
	" Also reads SQLite databases (`app.db` lists tables; `app.db:table` shows schema and sample rows; `app.db:table:42` one row by primary key; " +
	"`app.db:table?limit=20&offset=40&order=col:desc&where=…` a page; `app.db?q=SELECT …` a read-only query), " +
	"archives (`x.zip` / `.tar` / `.tgz` / `.jar` / `.whl` … lists entries; `x.zip:path/inside` reads one), " +
	"PDFs as text (`doc.pdf:3` or `doc.pdf:2-5` for pages), Jupyter notebooks, and Word / Excel / PowerPoint files (.docx/.xlsx/.pptx) as Markdown. " +
	"Lines can be picked in the path itself: `file.ts:120` (from line 120), `file.ts:120-180`, `file.ts:120+40`, `file.ts:-50` (last 50 lines), " +
	"several at once with `file.ts:10-20,80-95`; `file.ts:conflicts` lists a file's merge conflicts.";

const EXTRA_GUIDELINES = [
	"Use read, not bash, for PDFs, notebooks, Office files, SQLite databases and archives — read renders them as text; cat or python one-liners only produce noise or require extra packages.",
];

export type LineSelector =
	| { kind: "conflicts" }
	| { kind: "tail"; count: number }
	| { kind: "ranges"; ranges: { start: number; end?: number }[] };

const RANGE = String.raw`\d+(?:-\d*|\+\d+)?`;
const SELECTOR = new RegExp(String.raw`^(.+):((?:${RANGE})(?:,(?:${RANGE}))*|-\d+|conflicts)$`, "i");

/** The line selector at the end of `path`, if there is one: `a.ts:10-20`, `a.ts:-50`, `a.ts:conflicts`. */
export function parseLineSelector(path: string): { path: string; selector: LineSelector } | null {
	const match = SELECTOR.exec(path.trim());
	if (!match) return null;
	const [, file, spec] = match;
	if (spec.toLowerCase() === "conflicts") return { path: file, selector: { kind: "conflicts" } };
	if (spec.startsWith("-")) return { path: file, selector: { kind: "tail", count: Number(spec.slice(1)) } };
	const ranges = spec.split(",").map((part) => {
		const [, from, op, to] = /^(\d+)(?:([-+])(\d*))?$/.exec(part) ?? [];
		const start = Math.max(1, Number(from));
		if (op === "+") return { start, end: start + Number(to) };
		if (op === "-") return to ? { start, end: Math.max(start, Number(to)) } : { start };
		return { start };
	});
	return { path: file, selector: { kind: "ranges", ranges } };
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/** Several ranges, or the tail, of a file, each block headed by where it is. */
function renderSelection(text: string, selector: Exclude<LineSelector, { kind: "conflicts" }>): string {
	const lines = text.split("\n");
	const ranges = selector.kind === "tail" ? [{ start: Math.max(1, lines.length - selector.count + 1), end: lines.length }] : selector.ranges;
	return ranges
		.map(({ start, end }) => {
			if (start > lines.length) return `── line ${start}: beyond the end (${lines.length} lines) ──`;
			const last = Math.min(end ?? lines.length, lines.length);
			return `── lines ${start}-${last} of ${lines.length} ──\n${lines.slice(start - 1, last).join("\n")}`;
		})
		.join("\n\n");
}

export function pageText(
	pi: Pick<PiCodingAgentModule, "truncateHead" | "formatSize" | "DEFAULT_MAX_BYTES">,
	text: string,
	offset: number | undefined,
	limit: number | undefined,
): string {
	const lines = text.split("\n");
	const start = offset ? Math.max(0, offset - 1) : 0;
	if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of output (${lines.length} lines total)`);
	const end = limit !== undefined ? Math.min(start + limit, lines.length) : lines.length;
	const truncation = pi.truncateHead(lines.slice(start, end).join("\n"));
	const first = start + 1;
	if (truncation.firstLineExceedsLimit) {
		return `[Line ${first} is ${pi.formatSize(Buffer.byteLength(lines[start], "utf-8"))}, over the ${pi.formatSize(pi.DEFAULT_MAX_BYTES)} limit.]`;
	}
	if (truncation.truncated) {
		const last = first + truncation.outputLines - 1;
		return `${truncation.content}\n\n[Showing lines ${first}-${last} of ${lines.length}. Use offset=${last + 1} to continue.]`;
	}
	if (end < lines.length) {
		return `${truncation.content}\n\n[${lines.length - end} more lines. Use offset=${end + 1} to continue.]`;
	}
	return truncation.content;
}

/**
 * `conflicts` is the session's merge-conflict register: reading a file with
 * conflict markers adds its blocks there, and `conflict://<N>` reads one back.
 * The `write` tool resolves them against the same register.
 */
export function createReadTool(pi: PiCodingAgentModule, cwd: string, conflicts?: ConflictHistory): ToolDefinition {
	const base = pi.createReadToolDefinition(cwd) as unknown as ToolDefinition;
	type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;
	/**
	 * Append the conflict footer when the file has conflict markers. Scanned
	 * whole rather than in the window shown: a block cut in half by a range
	 * would otherwise go unnoticed until someone edits into it.
	 */
	const withConflictFooter = async (result: Result, absolutePath: string, root: string): Promise<Result> => {
		if (!conflicts) return result;
		const footer = await registerFileConflicts(conflicts, absolutePath, root);
		const last = result.content[result.content.length - 1];
		if (!footer || last?.type !== "text") return result;
		return { ...result, content: [...result.content.slice(0, -1), { ...last, text: `${last.text}\n${footer}` }] };
	};
	return {
		...base,
		description: base.description + EXTRA_DESCRIPTION,
		promptGuidelines: [...(base.promptGuidelines ?? []), ...EXTRA_GUIDELINES],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path, offset, limit } = params as { path: string; offset?: number; limit?: number };
			const root = ctx?.cwd || cwd;
			if (conflicts && isConflictUri(path)) {
				return { content: [{ type: "text", text: readConflictUri(conflicts, path) }], details: undefined };
			}
			const target = await detectSpecialRead(path, root);
			if (target) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const text = await renderSpecialRead(target);
				if (signal?.aborted) throw new Error("Operation aborted");
				return { content: [{ type: "text", text: pageText(pi, text, offset, limit) }], details: undefined };
			}

			// A selector counts only when the path without it is a file and the path
			// with it is not: `notes:1-2` could be a file's real name.
			const selected = parseLineSelector(path);
			const selectedFile = selected ? resolveModelPath(selected.path, root) : null;
			if (selected && selectedFile && !(await isFile(resolveModelPath(path, root))) && (await isFile(selectedFile))) {
				const { selector } = selected;
				if (selector.kind === "conflicts") {
					const footer = conflicts ? await registerFileConflicts(conflicts, selectedFile, root) : "";
					return { content: [{ type: "text", text: footer.trim() || `No merge conflicts in ${selected.path}.` }], details: undefined };
				}
				if (selector.kind === "ranges" && selector.ranges.length === 1) {
					const [{ start, end }] = selector.ranges;
					const narrowed = { path: selected.path, offset: start, ...(end ? { limit: end - start + 1 } : {}) };
					return withConflictFooter(await base.execute(toolCallId, narrowed, signal, onUpdate, ctx), selectedFile, root);
				}
				const text = renderSelection(await readFile(selectedFile, "utf8"), selector);
				return withConflictFooter({ content: [{ type: "text", text: pageText(pi, text, undefined, undefined) }], details: undefined }, selectedFile, root);
			}

			return withConflictFooter(await base.execute(toolCallId, params, signal, onUpdate, ctx), resolveModelPath(path, root), root);
		},
	};
}
