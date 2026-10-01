/**
 * What a chat model adds to a keyword search: it knows that "where are stale
 * sessions cleaned up" may be written `purgeExpired`, and that a Chinese
 * question is answered by English identifiers; and it can read candidates and
 * say which ones answer the question. It needs nothing but a chat endpoint —
 * no embeddings — so any model under Providers and models will do.
 *
 * Both steps are optional to the search: a failure in either leaves the
 * keyword ranking standing.
 */

/** A chat call with a system prompt and one user message, answered in text. */
export type AskModel = (systemPrompt: string, prompt: string, signal?: AbortSignal) => Promise<string>;

export interface SearchAssistant {
	/** `provider/model`, for the result's header. */
	model: string;
	ask: AskModel;
}

const MAX_TERMS = 16;
/** Lines of each candidate shown to the reranker, and its whole budget. */
const RERANK_LINES = 18;
const RERANK_CHARS = 14_000;

export const EXPAND_SYSTEM = [
	"You help search a codebase with a keyword index.",
	"Turn the user's question into the words that would literally appear in the code that answers it:",
	"likely function, class, variable and file names (in camelCase, snake_case or PascalCase as the language would use), API names, and key domain words.",
	"Code is usually written in English; translate questions asked in other languages.",
	'Reply with JSON only, no prose: {"terms": ["..."]} with at most 16 terms.',
].join("\n");

export function expandPrompt(query: string): string {
	return `Question: ${query}`;
}

/** The first JSON object in a reply, which models like to wrap in prose or fences. */
function firstJsonObject(text: string): Record<string, unknown> | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const value: unknown = JSON.parse(text.slice(start, end + 1));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Search terms from the model's reply; tolerant of a list without the JSON around it. */
export function parseTerms(reply: string): string[] {
	const json = firstJsonObject(reply);
	const raw = Array.isArray(json?.terms)
		? json.terms.filter((term): term is string => typeof term === "string")
		: reply.replace(/```\w*/g, "").split(/[\n,，、]+/);
	const terms = raw.map((term) => term.trim().replace(/^[-*•\d.\s"'`]+|["'`]+$/g, "")).filter((term) => term.length >= 2 && term.length <= 60);
	return [...new Set(terms)].slice(0, MAX_TERMS);
}

export interface RerankCandidate {
	path: string;
	startLine: number;
	endLine: number;
	symbol: string | null;
	text: string;
}

export const RERANK_SYSTEM = [
	"You rank code search results for a developer's question.",
	"Read the numbered code snippets and pick the ones that help answer the question: the code that implements, defines or directly uses what is asked about.",
	'Reply with JSON only, no prose: {"ranked": [numbers, most relevant first]}. Leave out snippets that do not help. An empty list is a valid answer.',
].join("\n");

export function rerankPrompt(query: string, candidates: readonly RerankCandidate[]): string {
	const blocks: string[] = [];
	let used = 0;
	for (const [index, candidate] of candidates.entries()) {
		const lines = candidate.text.split("\n");
		const body = lines.slice(0, RERANK_LINES).join("\n") + (lines.length > RERANK_LINES ? "\n…" : "");
		const block = `[${index + 1}] ${candidate.path}:${candidate.startLine}-${candidate.endLine}${candidate.symbol ? ` (${candidate.symbol})` : ""}\n${body}`;
		if (used + block.length > RERANK_CHARS) break;
		used += block.length;
		blocks.push(block);
	}
	return `Question: ${query}\n\n${blocks.join("\n\n")}`;
}

/**
 * Candidate indexes (0-based) in the model's order, or null when the reply
 * cannot be read — which is different from an empty list, a considered "none".
 */
export function parseRanking(reply: string, count: number): number[] | null {
	const json = firstJsonObject(reply);
	let numbers: unknown[] | null = Array.isArray(json?.ranked) ? json.ranked : null;
	if (!numbers) {
		const bare = /\[([\d\s,]*)\]/.exec(reply);
		if (!bare) return null;
		numbers = bare[1].split(",").map((part) => Number(part.trim())).filter((value) => !Number.isNaN(value));
	}
	const order: number[] = [];
	for (const value of numbers) {
		const index = Number(value) - 1;
		if (Number.isInteger(index) && index >= 0 && index < count && !order.includes(index)) order.push(index);
	}
	return order;
}
