import { resolve } from "node:path";
import type { IndexStatus } from "../../shared/code-intel";
import {
	EXPAND_SYSTEM,
	expandPrompt,
	parseRanking,
	parseTerms,
	RERANK_SYSTEM,
	rerankPrompt,
	type SearchAssistant,
} from "./assist";
import { fuseRankings, ProjectIndex, type Ranked, type SearchHit } from "./project-index";

/**
 * The code index for every project in use: scanned on first use and kept
 * current on every search. It ranks by keywords on its own; with a search
 * model from Providers and models, the question is first rewritten into the
 * terms code would use and the candidates are then reranked by relevance.
 */

export interface SemanticIndexOptions {
	/** The model that sharpens searches, or null for keywords alone. */
	getAssistant: () => SearchAssistant | null;
	onStatus?: (status: IndexStatus) => void;
}

export interface SearchOptions {
	limit?: number;
	/** Narrow to a project-relative directory or file. */
	path?: string;
	signal?: AbortSignal;
}

export interface SearchResult {
	hits: SearchHit[];
	/** `assisted` when a model rewrote the query or reranked the results. */
	mode: "lexical" | "assisted";
	/** The search model in use, if any. */
	model: string | null;
	/** What went wrong with the model's part, for whoever reads the result. */
	note: string | null;
}

/** A search re-checks files changed since a scan this old. */
const SEARCH_REFRESH_MS = 5_000;
/** Projects kept in memory at once; the least recently used is dropped. */
const MAX_PROJECTS = 6;
/** Keyword candidates the reranker chooses from. */
const CANDIDATES = 30;
/** Extra candidates read, in case some drop out because their file changed. */
const SPARE_HITS = 5;

interface Project {
	index: ProjectIndex;
	usedAt: number;
	state: IndexStatus["state"];
	error: string | null;
	scan: Promise<void> | null;
}

function failure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class SemanticIndexService {
	private readonly projects = new Map<string, Project>();

	constructor(private readonly options: SemanticIndexOptions) {}

	private project(cwd: string): Project {
		const key = resolve(cwd);
		let project = this.projects.get(key);
		if (!project) {
			project = { index: new ProjectIndex(key), usedAt: Date.now(), state: "idle", error: null, scan: null };
			this.projects.set(key, project);
			if (this.projects.size > MAX_PROJECTS) {
				const oldest = [...this.projects.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
				if (oldest) this.projects.delete(oldest[0]);
			}
		}
		project.usedAt = Date.now();
		return project;
	}

	status(cwd: string): IndexStatus {
		const key = resolve(cwd);
		const project = this.projects.get(key);
		if (!project) return { cwd: key, state: "idle", files: 0, chunks: 0, error: null, updatedAt: null };
		return {
			cwd: key,
			state: project.state,
			files: project.index.fileCount,
			chunks: project.index.chunks().length,
			error: project.error,
			updatedAt: project.index.lastScan || null,
		};
	}

	private emit(project: Project): void {
		this.options.onStatus?.(this.status(project.index.cwd));
	}

	/** Bring the project's chunks up to date, reporting the scan as it goes. */
	private refresh(project: Project, maxAgeMs: number): Promise<void> {
		if (project.scan) return project.scan;
		if (!project.index.lastScan || maxAgeMs === 0) {
			project.state = "scanning";
			this.emit(project);
		}
		project.scan = project.index
			.refresh(maxAgeMs)
			.then(() => {
				project.state = "ready";
				project.error = null;
			})
			.catch((error: unknown) => {
				project.state = "error";
				project.error = failure(error);
			})
			.finally(() => {
				project.scan = null;
				this.emit(project);
			});
		return project.scan;
	}

	/** Scan the project in the background, before its first search needs it. */
	warm(cwd: string): void {
		void this.refresh(this.project(cwd), SEARCH_REFRESH_MS);
	}

	/** Start over: forget the project's chunks and scan from scratch. */
	async rebuild(cwd: string): Promise<IndexStatus> {
		const key = resolve(cwd);
		await this.projects.get(key)?.scan;
		this.projects.delete(key);
		await this.refresh(this.project(key), 0);
		return this.status(key);
	}

	async search(cwd: string, query: string, options: SearchOptions = {}): Promise<SearchResult> {
		const limit = options.limit ?? 10;
		const project = this.project(cwd);
		await this.refresh(project, SEARCH_REFRESH_MS);
		const assistant = this.options.getAssistant();
		const notes: string[] = [];

		// 1. The words the answer is written in, which the question often is not.
		const lists: Ranked[][] = [project.index.lexical(query, CANDIDATES, options.path)];
		let assisted = false;
		if (assistant) {
			try {
				const terms = parseTerms(await assistant.ask(EXPAND_SYSTEM, expandPrompt(query), options.signal));
				if (terms.length) {
					lists.push(project.index.lexical(terms.join(" "), CANDIDATES, options.path));
					assisted = true;
				}
			} catch (error) {
				if (options.signal?.aborted) throw error;
				notes.push(`query rewrite failed (${failure(error)})`);
			}
		}
		const candidates = await withText(project.index, fuseRankings(lists, CANDIDATES + SPARE_HITS, 3), CANDIDATES);

		// 2. Which of those actually answer it.
		let hits = candidates;
		if (assistant && candidates.length > 1) {
			try {
				const order = parseRanking(await assistant.ask(RERANK_SYSTEM, rerankPrompt(query, candidates), options.signal), candidates.length);
				if (order === null) notes.push("its rerank reply could not be read");
				else {
					// The model's picks first; the rest keep their keyword order behind them.
					const picked = new Set(order);
					hits = [...order.map((index) => candidates[index]), ...candidates.filter((_, index) => !picked.has(index))];
					assisted = true;
				}
			} catch (error) {
				if (options.signal?.aborted) throw error;
				notes.push(`rerank failed (${failure(error)})`);
			}
		}
		return {
			hits: hits.slice(0, limit),
			mode: assisted ? "assisted" : "lexical",
			model: assistant?.model ?? null,
			note: notes.length ? `Search model: ${notes.join("; ")}; keyword ranking used there instead.` : null,
		};
	}

	/**
	 * Keyword-only neighbours of some code, for Tab completion's context: no
	 * model call, and no waiting on a project that has not been scanned yet.
	 */
	async related(cwd: string, text: string, excludePath: string, limit: number): Promise<SearchHit[]> {
		const project = this.projects.get(resolve(cwd));
		if (!project) {
			this.warm(cwd);
			return [];
		}
		void this.refresh(project, SEARCH_REFRESH_MS * 6);
		const ranked = project.index
			.lexical(text, limit * 3)
			.filter(({ chunk }) => chunk.path !== excludePath)
			.slice(0, limit + SPARE_HITS);
		return withText(project.index, ranked, limit);
	}

	dispose(): void {
		this.projects.clear();
	}
}

/** Ranked chunks with their text read back; one whose file changed since the scan drops out. */
async function withText(index: ProjectIndex, ranked: readonly Ranked[], limit: number): Promise<SearchHit[]> {
	const texts = await index.texts(ranked.map(({ chunk }) => chunk));
	const hits: SearchHit[] = [];
	for (const { chunk, score } of ranked) {
		const text = texts.get(chunk);
		if (text === undefined) continue;
		hits.push({ path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, symbol: chunk.symbol, text, score });
		if (hits.length >= limit) break;
	}
	return hits;
}
