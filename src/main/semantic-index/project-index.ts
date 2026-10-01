import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { listProjectFiles } from "../mentions";
import { chunkFile, chunkHash, fileLines, isIndexable, looksMinified, MAX_INDEXED_FILE_BYTES, sliceLines, type Chunk } from "./chunker";
import { termFrequencies, tokenize } from "./tokenize";

/**
 * One project's chunks, ranked by BM25 over code-aware words. It needs nothing
 * configured; a chat model can sharpen it from outside (see assist.ts). Chunks live in memory
 * as line ranges and term counts — their text is read back from the files when
 * a hit is shown — and are rebuilt from the files on startup: cutting text is
 * cheap, and keeping nothing on disk means nothing goes stale there.
 */

/**
 * Term → small integer, one per project, so that a chunk's terms are two typed
 * arrays instead of a Map: a Map entry costs over a hundred bytes, and a large
 * project has millions of them.
 */
export class TermDictionary {
	private readonly ids = new Map<string, number>();

	id(term: string): number {
		let id = this.ids.get(term);
		if (id === undefined) {
			id = this.ids.size;
			this.ids.set(term, id);
		}
		return id;
	}

	lookup(term: string): number | undefined {
		return this.ids.get(term);
	}
}

export interface IndexedChunk extends Omit<Chunk, "text"> {
	/** The chunk's term ids, ascending, with each one's count at the same position. */
	termIds: Uint32Array;
	termCounts: Uint16Array;
	/** Terms in all, repeats included: BM25's document length. */
	length: number;
}

interface FileEntry {
	mtimeMs: number;
	size: number;
	chunks: IndexedChunk[];
}

export interface SearchHit {
	path: string;
	startLine: number;
	endLine: number;
	symbol: string | null;
	text: string;
	score: number;
}

export interface Ranked {
	chunk: IndexedChunk;
	score: number;
}

/** Projects larger than this are indexed in part; the files git lists first win. */
export const MAX_INDEXED_FILES = 20_000;
const READ_CONCURRENCY = 32;
/** BM25's usual constants. */
const K1 = 1.2;
const B = 0.75;
/** Reciprocal rank fusion's damping: the standard 60. */
const RRF_K = 60;
/** Path and declaration name count this many times over the body. */
const NAME_WEIGHT = 3;

async function readIndexable(path: string, size: number): Promise<string | null> {
	if (size > MAX_INDEXED_FILE_BYTES) return null;
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(size);
		const { bytesRead } = await handle.read(buffer, 0, size, 0);
		const bytes = buffer.subarray(0, bytesRead);
		// A NUL early on is a binary file wearing a text extension.
		if (bytes.subarray(0, 8_192).includes(0)) return null;
		const text = bytes.toString("utf8");
		return looksMinified(text) ? null : text;
	} finally {
		await handle.close();
	}
}

export function indexChunk(chunk: Chunk, dictionary: TermDictionary): IndexedChunk {
	const terms = tokenize(chunk.text);
	const names = tokenize(`${chunk.path} ${chunk.symbol ?? ""}`);
	for (let i = 0; i < NAME_WEIGHT; i++) terms.push(...names);
	const entries = [...termFrequencies(terms)]
		.map(([term, count]) => [dictionary.id(term), count] as const)
		.sort((a, b) => a[0] - b[0]);
	const { text: _text, ...located } = chunk;
	return {
		...located,
		termIds: Uint32Array.from(entries, ([id]) => id),
		termCounts: Uint16Array.from(entries, ([, count]) => Math.min(count, 0xffff)),
		length: terms.length,
	};
}

/** How often a term occurs in a chunk: a binary search of its sorted ids. */
export function termCount(chunk: IndexedChunk, id: number): number {
	const ids = chunk.termIds;
	let low = 0;
	let high = ids.length - 1;
	while (low <= high) {
		const middle = (low + high) >>> 1;
		const value = ids[middle];
		if (value === id) return chunk.termCounts[middle];
		if (value < id) low = middle + 1;
		else high = middle - 1;
	}
	return 0;
}

/** Rank chunks against query terms with BM25. */
export function rankLexical(chunks: readonly IndexedChunk[], query: string, limit: number, dictionary: TermDictionary): Ranked[] {
	// A word no chunk has ever contained cannot score; it is dropped here.
	const queryIds = [...new Set(tokenize(query))]
		.map((term) => dictionary.lookup(term))
		.filter((id): id is number => id !== undefined);
	if (!queryIds.length || !chunks.length) return [];
	const average = chunks.reduce((sum, chunk) => sum + chunk.length, 0) / chunks.length || 1;
	// Counts per chunk, gathered once and reused for both document frequency and score.
	const counts: (number[] | null)[] = chunks.map((chunk) => {
		let any = false;
		const found = queryIds.map((id) => {
			const count = termCount(chunk, id);
			if (count) any = true;
			return count;
		});
		return any ? found : null;
	});
	const n = chunks.length;
	const idf = queryIds.map((_, at) => {
		let df = 0;
		for (const found of counts) if (found?.[at]) df++;
		return Math.log(1 + (n - df + 0.5) / (df + 0.5));
	});
	const ranked: Ranked[] = [];
	chunks.forEach((chunk, index) => {
		const found = counts[index];
		if (!found) return;
		let score = 0;
		const norm = K1 * (1 - B + (B * chunk.length) / average);
		found.forEach((tf, at) => {
			if (tf) score += idf[at] * ((tf * (K1 + 1)) / (tf + norm));
		});
		ranked.push({ chunk, score });
	});
	return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Merge ranked lists by reciprocal rank: a chunk near the top of either list
 * rises, one near the top of both rises most. Scores from different queries are
 * on different scales, so ranks are all that is compared.
 */
export function fuseRankings(lists: readonly (readonly Ranked[])[], limit: number, perFile = 2): Ranked[] {
	const fused = new Map<IndexedChunk, number>();
	for (const list of lists) {
		list.forEach(({ chunk }, rank) => fused.set(chunk, (fused.get(chunk) ?? 0) + 1 / (RRF_K + rank + 1)));
	}
	const ordered = [...fused.entries()].sort((a, b) => b[1] - a[1]);
	// A few chunks per file first, so one long file cannot fill the page; the
	// rest only if the page is not full without them.
	const picked: Ranked[] = [];
	const perPath = new Map<string, number>();
	const overflow: Ranked[] = [];
	for (const [chunk, score] of ordered) {
		const count = perPath.get(chunk.path) ?? 0;
		if (count < perFile) {
			picked.push({ chunk, score });
			perPath.set(chunk.path, count + 1);
		} else overflow.push({ chunk, score });
		if (picked.length >= limit) break;
	}
	return [...picked, ...overflow].slice(0, limit);
}

/** Whether a project-relative path is under the directory or file a search was narrowed to. */
export function withinScope(path: string, scope: string | undefined): boolean {
	if (!scope) return true;
	const clean = scope.replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/+$/, "");
	if (!clean) return true;
	return path === clean || path.startsWith(`${clean}/`);
}

export class ProjectIndex {
	readonly cwd: string;
	/** Grows with every term seen; removed files leave theirs, which is bounded by the vocabulary. */
	private readonly terms = new TermDictionary();
	private files = new Map<string, FileEntry>();
	private allChunks: IndexedChunk[] | null = null;
	private scanning: Promise<void> | null = null;
	private scannedAt = 0;
	private readonly listFiles: (cwd: string) => Promise<string[]>;

	constructor(cwd: string, options: { listFiles?: (cwd: string) => Promise<string[]> } = {}) {
		this.cwd = resolve(cwd);
		this.listFiles = options.listFiles ?? listProjectFiles;
	}

	get fileCount(): number {
		return this.files.size;
	}

	get lastScan(): number {
		return this.scannedAt;
	}

	chunks(): IndexedChunk[] {
		this.allChunks ??= [...this.files.values()].flatMap((entry) => entry.chunks);
		return this.allChunks;
	}

	/**
	 * Bring the chunks up to date with the files: new and changed files are
	 * re-cut, deleted ones dropped. Concurrent calls share one scan, and a scan
	 * younger than `maxAgeMs` is trusted as is.
	 */
	refresh(maxAgeMs = 0): Promise<void> {
		if (this.scanning) return this.scanning;
		if (maxAgeMs > 0 && this.scannedAt && Date.now() - this.scannedAt < maxAgeMs) return Promise.resolve();
		this.scanning = this.scan().finally(() => {
			this.scanning = null;
		});
		return this.scanning;
	}

	private async scan(): Promise<void> {
		const listed = (await this.listFiles(this.cwd)).filter(isIndexable).slice(0, MAX_INDEXED_FILES);
		const seen = new Set(listed);
		let changed = false;
		for (const path of [...this.files.keys()]) {
			if (!seen.has(path)) {
				this.files.delete(path);
				changed = true;
			}
		}
		for (let i = 0; i < listed.length; i += READ_CONCURRENCY) {
			const batch = listed.slice(i, i + READ_CONCURRENCY);
			const updates = await Promise.all(
				batch.map(async (path): Promise<[string, FileEntry | null] | null> => {
					const absolute = resolve(this.cwd, path);
					try {
						const info = await stat(absolute);
						const known = this.files.get(path);
						if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return null;
						const text = info.isFile() ? await readIndexable(absolute, info.size) : null;
						const chunks = text === null ? [] : chunkFile(path, text).map((chunk) => indexChunk(chunk, this.terms));
						return [path, { mtimeMs: info.mtimeMs, size: info.size, chunks }];
					} catch {
						// Gone between the listing and the read.
						return [path, null];
					}
				}),
			);
			for (const update of updates) {
				if (!update) continue;
				const [path, entry] = update;
				if (entry) this.files.set(path, entry);
				else this.files.delete(path);
				changed = true;
			}
		}
		if (changed) this.allChunks = null;
		this.scannedAt = Date.now();
	}

	/**
	 * The text of each chunk, read back from its file. A chunk whose file has
	 * changed since the scan reads differently from what was hashed, and is left
	 * out rather than shown under the wrong lines.
	 */
	async texts(chunks: readonly IndexedChunk[]): Promise<Map<IndexedChunk, string>> {
		const byPath = new Map<string, IndexedChunk[]>();
		for (const chunk of chunks) {
			const list = byPath.get(chunk.path);
			if (list) list.push(chunk);
			else byPath.set(chunk.path, [chunk]);
		}
		const out = new Map<IndexedChunk, string>();
		const paths = [...byPath.keys()];
		for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
			await Promise.all(
				paths.slice(i, i + READ_CONCURRENCY).map(async (path) => {
					const absolute = resolve(this.cwd, path);
					let text: string | null = null;
					try {
						text = await readIndexable(absolute, (await stat(absolute)).size);
					} catch {
						// Gone since the scan.
					}
					if (text === null) return;
					const lines = fileLines(text);
					for (const chunk of byPath.get(path) ?? []) {
						const body = sliceLines(lines, chunk.startLine, chunk.endLine);
						if (chunkHash(chunk.path, chunk.symbol, body) === chunk.hash) out.set(chunk, body);
					}
				}),
			);
		}
		return out;
	}

	/** Lexical candidates, narrowed to a path when one is given. */
	lexical(query: string, limit: number, scope?: string): Ranked[] {
		const chunks = scope ? this.chunks().filter((chunk) => withinScope(chunk.path, scope)) : this.chunks();
		return rankLexical(chunks, query, limit, this.terms);
	}
}
