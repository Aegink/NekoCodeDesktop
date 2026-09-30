import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { isSqliteFile, parseSqlitePathCandidates, readSqlite } from "./sqlite-reader";
import { readZip, type ZipEntry } from "./zip";

/**
 * The files `read` turns into text before showing them: SQLite databases,
 * archives and their members, PDFs, Jupyter notebooks and Office documents.
 *
 * pi's own read handles text and images. Everything here would otherwise come
 * back as mojibake — a PDF read as UTF-8 is a page of noise the model then
 * tries to reason about — so each format is rendered to what a person would
 * want to see of it, and paged like any other text afterwards.
 *
 * Ideas and path syntax follow oh-my-pi's read tool (MIT); see
 * docs/oh-my-pi-porting-checklist.md.
 */

export type SpecialRead =
	| { kind: "sqlite"; path: string; subPath: string; queryString: string }
	| { kind: "archive"; path: string; member?: string }
	| { kind: "document"; path: string; format: DocumentFormat; pages?: { from: number; to: number } };

export type DocumentFormat = "pdf" | "ipynb" | "docx" | "xlsx" | "pptx";

const DOCUMENT_FORMATS: Record<string, DocumentFormat> = {
	".pdf": "pdf",
	".ipynb": "ipynb",
	".docx": "docx",
	".xlsx": "xlsx",
	".pptx": "pptx",
};

const ARCHIVE_PATH = /^(.*?\.(?:zip|jar|war|ear|apk|aar|vsix|nupkg|whl|crx|xpi|tar|tgz|tar\.gz))(?::(.*))?$/i;
const PDF_PAGES = /^(.*\.pdf):(\d+)(?:-(\d+))?$/i;

/** Largest archive or document loaded into memory to be read. */
const MAX_CONTAINER_BYTES = 256 * 1024 * 1024;
/** Largest archive member shown as text. */
const MAX_MEMBER_BYTES = 8 * 1024 * 1024;
const MAX_LISTED_ENTRIES = 2000;
const MAX_SHEET_ROWS = 200;
const MAX_SHEET_COLUMNS = 40;
const MAX_NOTEBOOK_OUTPUT = 4000;

/** How pi resolves a path the model wrote: `~` is home, a leading `@` is a mention marker. */
export function resolveModelPath(raw: string, cwd: string): string {
	let path = raw.trim().replace(/^@/, "");
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || path.startsWith("~\\")) path = homedir() + path.slice(1);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/**
 * Whether `raw` names something this module renders, and if so what.
 *
 * The container part of the path is resolved; the selector after it — a table,
 * an archive member, a page range, a query — is kept exactly as written, since
 * resolving it as a path would turn the `/` in `?q=SELECT a/b` into `\` on
 * Windows. A plain file whose name only looks like `a.zip:b` still reads as
 * itself: a special reading is only chosen when the container really exists.
 */
export async function detectSpecialRead(raw: string, cwd: string): Promise<SpecialRead | null> {
	const trimmed = raw.trim();
	if (await isFile(resolveModelPath(trimmed, cwd))) {
		const whole = resolveModelPath(trimmed, cwd);
		if (await isSqliteFile(whole)) return { kind: "sqlite", path: whole, subPath: "", queryString: "" };
		const format = DOCUMENT_FORMATS[extname(whole).toLowerCase()];
		if (format) return { kind: "document", path: whole, format };
		if (ARCHIVE_PATH.test(trimmed) && !ARCHIVE_PATH.exec(trimmed)?.[2]) return { kind: "archive", path: whole };
		return null;
	}

	for (const candidate of parseSqlitePathCandidates(trimmed)) {
		const path = resolveModelPath(candidate.sqlitePath, cwd);
		if ((await isFile(path)) && (await isSqliteFile(path)))
			return { kind: "sqlite", path, subPath: candidate.subPath, queryString: candidate.queryString };
	}

	const pdf = PDF_PAGES.exec(trimmed);
	if (pdf) {
		const path = resolveModelPath(pdf[1], cwd);
		if (await isFile(path)) {
			const from = Number(pdf[2]);
			return { kind: "document", path, format: "pdf", pages: { from, to: pdf[3] ? Number(pdf[3]) : from } };
		}
	}

	const archive = ARCHIVE_PATH.exec(trimmed);
	if (archive) {
		const path = resolveModelPath(archive[1], cwd);
		if (await isFile(path)) return { kind: "archive", path, member: archive[2]?.replace(/^[/\\]+/, "") || undefined };
	}
	return null;
}

async function loadContainer(path: string): Promise<Buffer> {
	const size = (await stat(path)).size;
	if (size > MAX_CONTAINER_BYTES)
		throw new Error(`File is ${formatBytes(size)}; reading archives and documents is limited to ${formatBytes(MAX_CONTAINER_BYTES)}`);
	return readFile(path);
}

export async function renderSpecialRead(target: SpecialRead): Promise<string> {
	switch (target.kind) {
		case "sqlite":
			return readSqlite(target.path, target.subPath, target.queryString);
		case "archive":
			return renderArchive(target.path, await loadContainer(target.path), target.member);
		case "document":
			return renderDocument(target.format, await loadContainer(target.path), target.pages);
	}
}

// ── Archives ────────────────────────────────────────────────────────────────

interface ArchiveEntry {
	name: string;
	isDirectory: boolean;
	size: number;
	read(): Buffer;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isTar(path: string): boolean {
	return /\.(?:tar|tgz|tar\.gz)$/i.test(path);
}

function parseOctal(buffer: Buffer, start: number, length: number): number {
	const text = buffer.toString("latin1", start, start + length).replace(/\0.*$/s, "").trim();
	return text ? Number.parseInt(text, 8) : 0;
}

/** ustar with the GNU long-name and PAX `path` extensions — what tar and npm pack write. */
export function readTar(data: Buffer): ArchiveEntry[] {
	const entries: ArchiveEntry[] = [];
	let offset = 0;
	let longName: string | null = null;
	while (offset + 512 <= data.length) {
		const header = data.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const size = parseOctal(header, 124, 12);
		const type = String.fromCharCode(header[156] || 48);
		const bodyStart = offset + 512;
		const body = data.subarray(bodyStart, bodyStart + size);
		offset = bodyStart + Math.ceil(size / 512) * 512;
		if (type === "L") {
			longName = body.toString("utf8").replace(/\0+$/, "");
			continue;
		}
		if (type === "x") {
			const match = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
			if (match) longName = match[1];
			continue;
		}
		if (type === "g") continue;
		const magic = header.toString("latin1", 257, 262);
		const prefix = magic === "ustar" ? header.toString("utf8", 345, 500).replace(/\0.*$/s, "") : "";
		const base = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
		const name = longName ?? (prefix ? `${prefix}/${base}` : base);
		longName = null;
		const data_ = Buffer.from(body);
		entries.push({ name, isDirectory: type === "5" || name.endsWith("/"), size, read: () => data_ });
	}
	return entries;
}

function readArchive(path: string, data: Buffer): ArchiveEntry[] {
	if (isTar(path)) {
		const tar = /\.(?:tgz|tar\.gz)$/i.test(path) ? gunzipSync(data, { maxOutputLength: MAX_CONTAINER_BYTES }) : data;
		return readTar(tar);
	}
	// Members are read one at a time, each under its own cap; the archive's
	// total size says nothing about what reading one of them costs.
	return readZip(data, { maxTotalBytes: Number.MAX_SAFE_INTEGER, maxEntries: 200_000 }) satisfies ZipEntry[];
}

/** Whether a buffer is text worth showing, rather than bytes read as UTF-8. */
export function looksBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, 8000);
	if (sample.includes(0)) return true;
	let control = 0;
	for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) control++;
	return sample.length > 0 && control / sample.length > 0.1;
}

async function renderArchive(path: string, data: Buffer, member?: string): Promise<string> {
	const entries = readArchive(path, data);
	if (!member) {
		const files = entries.filter((entry) => !entry.isDirectory);
		const total = files.reduce((sum, entry) => sum + entry.size, 0);
		const shown = files.slice(0, MAX_LISTED_ENTRIES);
		const lines = shown.map((entry) => `${entry.name}  (${formatBytes(entry.size)})`);
		if (files.length > shown.length) lines.push(`[${files.length - shown.length} more entries]`);
		return [
			`Archive — ${files.length} files, ${formatBytes(total)} uncompressed. Read <archive>:<member path> to open one.`,
			...lines,
		].join("\n");
	}

	const wanted = member.replace(/\\/g, "/");
	const entry = entries.find((candidate) => candidate.name === wanted || candidate.name === `${wanted}/`);
	if (!entry) {
		const inside = entries.filter((candidate) => candidate.name.startsWith(`${wanted.replace(/\/$/, "")}/`));
		if (inside.length === 0) throw new Error(`No entry '${member}' in archive`);
		return [`Directory '${wanted}' in archive:`, ...inside.slice(0, MAX_LISTED_ENTRIES).map((e) => `${e.name}  (${formatBytes(e.size)})`)].join("\n");
	}
	if (entry.isDirectory) {
		const inside = entries.filter((candidate) => candidate.name.startsWith(entry.name) && candidate !== entry);
		return [`Directory '${entry.name}' in archive:`, ...inside.slice(0, MAX_LISTED_ENTRIES).map((e) => `${e.name}  (${formatBytes(e.size)})`)].join("\n");
	}
	if (entry.size > MAX_MEMBER_BYTES)
		throw new Error(`'${entry.name}' is ${formatBytes(entry.size)}; archive members are shown up to ${formatBytes(MAX_MEMBER_BYTES)}`);
	const content = entry.read();
	const format = DOCUMENT_FORMATS[extname(entry.name).toLowerCase()];
	if (format) return renderDocument(format, content);
	if (looksBinary(content)) return `[Binary file '${entry.name}', ${formatBytes(content.length)} — not shown as text]`;
	return content.toString("utf8");
}

// ── Documents ───────────────────────────────────────────────────────────────

export async function renderDocument(
	format: DocumentFormat,
	data: Buffer,
	pages?: { from: number; to: number },
): Promise<string> {
	switch (format) {
		case "pdf":
			return renderPdf(data, pages);
		case "ipynb":
			return renderNotebook(data.toString("utf8"));
		case "docx":
			return renderDocx(data);
		case "xlsx":
			return renderXlsx(data);
		case "pptx":
			return renderPptx(data);
	}
}

async function renderPdf(data: Buffer, pages?: { from: number; to: number }): Promise<string> {
	// ESM-only, and pdf.js is a few megabytes: loaded on the first PDF read.
	const { extractText, getDocumentProxy } = await import("unpdf");
	const document = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 } as never);
	try {
		const { totalPages, text } = await extractText(document, { mergePages: false });
		const from = pages ? Math.max(1, pages.from) : 1;
		const to = pages ? Math.min(totalPages, Math.max(pages.to, from)) : totalPages;
		if (from > totalPages) throw new Error(`Page ${from} is beyond the end of the PDF (${totalPages} pages)`);
		const blank: number[] = [];
		const parts = [
			`PDF — ${totalPages} pages${pages ? `, showing ${from === to ? `page ${from}` : `pages ${from}-${to}`}` : ""}. Read <file>.pdf:<page> or :<from>-<to> for specific pages.`,
		];
		for (let page = from; page <= to; page++) {
			const content = (text[page - 1] ?? "").trim();
			if (!content) blank.push(page);
			parts.push(`\n## Page ${page}\n\n${content || "(no extractable text)"}`);
		}
		if (blank.length)
			parts.push(`\n[No text layer on page${blank.length > 1 ? "s" : ""} ${blank.join(", ")} — likely scanned images; open the PDF in the browser panel to view them.]`);
		return parts.join("\n");
	} finally {
		// pdf.js has it at runtime; unpdf's trimmed typings leave it out.
		await (document as unknown as { destroy?: () => Promise<void> }).destroy?.();
	}
}

interface NotebookCell {
	cell_type?: string;
	source?: string | string[];
	execution_count?: number | null;
	outputs?: Array<{
		output_type?: string;
		text?: string | string[];
		data?: Record<string, string | string[]>;
		ename?: string;
		evalue?: string;
	}>;
}

function joinSource(source: string | string[] | undefined): string {
	return Array.isArray(source) ? source.join("") : (source ?? "");
}

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}\n[… ${text.length - limit} more characters]` : text;
}

export function renderNotebook(json: string): string {
	let notebook: { cells?: NotebookCell[]; metadata?: { kernelspec?: { language?: string; name?: string } } };
	try {
		notebook = JSON.parse(json);
	} catch {
		throw new Error("Not a valid Jupyter notebook (the file is not JSON)");
	}
	const cells = notebook.cells ?? [];
	const language = notebook.metadata?.kernelspec?.language ?? notebook.metadata?.kernelspec?.name ?? "";
	const parts = [`Jupyter notebook${language ? ` · ${language}` : ""} · ${cells.length} cells`];
	cells.forEach((cell, index) => {
		const type = cell.cell_type ?? "code";
		const count = type === "code" && cell.execution_count ? ` · In [${cell.execution_count}]` : "";
		parts.push(`\n# %% [${type}] cell ${index + 1}${count}\n${joinSource(cell.source)}`);
		const outputs: string[] = [];
		for (const output of cell.outputs ?? []) {
			if (output.output_type === "stream") outputs.push(joinSource(output.text));
			else if (output.output_type === "error") outputs.push(`${output.ename ?? "Error"}: ${output.evalue ?? ""}`);
			else if (output.data) {
				const plain = output.data["text/plain"];
				const media = Object.keys(output.data).filter((key) => key.startsWith("image/"));
				if (plain) outputs.push(joinSource(plain));
				for (const kind of media) outputs.push(`[${kind} output]`);
			}
		}
		if (outputs.length) parts.push(`## Output\n${clip(outputs.join("\n").trimEnd(), MAX_NOTEBOOK_OUTPUT)}`);
	});
	return parts.join("\n");
}

// Office documents are zips of XML. Only the text is wanted, so a few regular
// expressions over the XML do the job a full DOM would.

function decodeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&amp;/g, "&");
}

function zipFiles(data: Buffer): Map<string, ZipEntry> {
	return new Map(readZip(data, { maxTotalBytes: 1024 * 1024 * 1024, maxEntries: 50_000 }).map((entry) => [entry.name, entry]));
}

function zipText(files: Map<string, ZipEntry>, name: string): string | null {
	return files.get(name)?.read().toString("utf8") ?? null;
}

function markdownTable(rows: string[][]): string {
	const width = Math.max(...rows.map((row) => row.length));
	if (!rows.length || width === 0) return "";
	const cell = (value: string | undefined) => (value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
	const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => cell(row[index])).join(" | ")} |`;
	return [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

function docxParagraph(xml: string): string {
	let text = "";
	for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g)) {
		if (match[1] !== undefined) text += decodeXml(match[1]);
		else text += match[0].startsWith("<w:tab") ? "\t" : "\n";
	}
	return text;
}

export function renderDocx(data: Buffer): string {
	const document = zipText(zipFiles(data), "word/document.xml");
	if (!document) throw new Error("Not a Word document: word/document.xml is missing");
	const blocks: string[] = [];
	for (const match of document.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g)) {
		const block = match[0];
		if (block.startsWith("<w:tbl")) {
			const rows = [...block.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map((row) =>
				[...row[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((cellMatch) =>
					[...cellMatch[0].matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map((p) => docxParagraph(p[0])).join(" ").trim(),
				),
			);
			const table = markdownTable(rows);
			if (table) blocks.push(table);
			continue;
		}
		const text = docxParagraph(block).trim();
		if (!text) continue;
		const style = /<w:pStyle w:val="([^"]+)"/.exec(block)?.[1] ?? "";
		const heading = /^(?:Heading|heading|标题)\s*(\d)$/.exec(style)?.[1];
		if (style === "Title") blocks.push(`# ${text}`);
		else if (heading) blocks.push(`${"#".repeat(Math.min(6, Number(heading) + 1))} ${text}`);
		else if (block.includes("<w:numPr>")) blocks.push(`- ${text}`);
		else blocks.push(text);
	}
	return blocks.join("\n\n") || "(the document has no text)";
}

function columnIndex(reference: string): number {
	let index = 0;
	for (const char of reference.replace(/\d+$/, "").toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
	return index - 1;
}

export function renderXlsx(data: Buffer): string {
	const files = zipFiles(data);
	const workbook = zipText(files, "xl/workbook.xml");
	if (!workbook) throw new Error("Not an Excel workbook: xl/workbook.xml is missing");
	const shared = [...(zipText(files, "xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
		[...si[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeXml(t[1])).join(""),
	);
	const relations = new Map(
		[...(zipText(files, "xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)].map((rel) => [
			/Id="([^"]+)"/.exec(rel[0])?.[1] ?? "",
			/Target="([^"]+)"/.exec(rel[0])?.[1] ?? "",
		]),
	);
	const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((sheet) => ({
		name: decodeXml(/name="([^"]*)"/.exec(sheet[0])?.[1] ?? "Sheet"),
		target: relations.get(/r:id="([^"]+)"/.exec(sheet[0])?.[1] ?? "") ?? "",
	}));
	const parts = [`Excel workbook — ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}: ${sheets.map((s) => s.name).join(", ")}`];
	for (const sheet of sheets) {
		const path = sheet.target.startsWith("/") ? sheet.target.slice(1) : `xl/${sheet.target.replace(/^\.\//, "")}`;
		const xml = zipText(files, path);
		if (!xml) continue;
		const rows: string[][] = [];
		let totalRows = 0;
		let widest = 0;
		for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
			totalRows++;
			if (rows.length >= MAX_SHEET_ROWS) continue;
			const cells: string[] = [];
			for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
				const attributes = cell[1];
				const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1];
				const index = reference ? columnIndex(reference) : cells.length;
				widest = Math.max(widest, index + 1);
				if (index >= MAX_SHEET_COLUMNS) continue;
				const type = /t="([^"]+)"/.exec(attributes)?.[1];
				const body = cell[2] ?? "";
				const value = /<v>([^<]*)<\/v>/.exec(body)?.[1];
				let text = "";
				if (type === "s" && value !== undefined) text = shared[Number(value)] ?? "";
				else if (type === "inlineStr") text = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeXml(t[1])).join("");
				else if (type === "b") text = value === "1" ? "TRUE" : "FALSE";
				else if (value !== undefined) text = decodeXml(value);
				cells[index] = text;
			}
			rows.push(Array.from({ length: cells.length }, (_, index) => cells[index] ?? ""));
		}
		parts.push(`\n## ${sheet.name}\n`);
		parts.push(markdownTable(rows) || "(empty sheet)");
		if (totalRows > rows.length) parts.push(`[${totalRows - rows.length} more rows not shown]`);
		if (widest > MAX_SHEET_COLUMNS) parts.push(`[${widest - MAX_SHEET_COLUMNS} more columns not shown]`);
	}
	return parts.join("\n");
}

function slideText(xml: string): string {
	return [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
		.map((p) => [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decodeXml(t[1])).join(""))
		.filter((line) => line.trim())
		.join("\n");
}

export function renderPptx(data: Buffer): string {
	const files = zipFiles(data);
	const slides = [...files.keys()]
		.map((name) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => Number(match[1]))
		.sort((a, b) => a - b);
	if (!slides.length) throw new Error("Not a PowerPoint deck: no slides found");
	const parts = [`PowerPoint deck — ${slides.length} slides`];
	for (const number of slides) {
		parts.push(`\n## Slide ${number}\n\n${slideText(zipText(files, `ppt/slides/slide${number}.xml`) ?? "") || "(no text)"}`);
		const notes = slideText(zipText(files, `ppt/notesSlides/notesSlide${number}.xml`) ?? "");
		if (notes) parts.push(`\nNotes: ${notes}`);
	}
	return parts.join("\n");
}
