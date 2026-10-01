import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { SemanticIndexService } from "./semantic-index/service";

/**
 * `semantic_search`: find code by what it does rather than what it is called.
 *
 * `grep` needs the word the code uses; a question rarely has it. The index
 * ranks chunks by code-aware keywords, and with a search model picked in
 * settings the question is rewritten into code terms and the results reranked
 * by relevance — so the tool always answers, and the result says how.
 */

export const SEMANTIC_SEARCH_TOOL_NAME = "semantic_search";

interface SemanticToolSource {
	enabled: () => boolean;
	service: () => SemanticIndexService | null;
}

let source: SemanticToolSource = { enabled: () => false, service: () => null };

/** Point the tool at the index service. Called once at startup, like the web tools. */
export function configureSemanticSearch(next: SemanticToolSource): void {
	source = next;
}

/** Whether a session starting now gets the tool. */
export function semanticSearchEnabled(): boolean {
	return source.enabled() && source.service() !== null;
}

/** Start indexing a project before its first search needs it. */
export function warmSemanticIndex(cwd: string): void {
	if (semanticSearchEnabled()) source.service()?.warm(cwd);
}

const schema = Type.Object(
	{
		query: Type.String({
			minLength: 2,
			maxLength: 500,
			description:
				"What the code does, in plain words — e.g. \"where expired sessions are cleaned up\", \"retry logic for HTTP requests\". Include likely identifiers if you know them.",
		}),
		path: Type.Optional(Type.String({ description: "Narrow to a workspace-relative directory or file." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Results to return. Defaults to 8." })),
	},
	{ additionalProperties: false },
);

/** Lines of each hit shown; the rest is a `read` away. */
const PREVIEW_LINES = 24;

export function formatHits(result: Awaited<ReturnType<SemanticIndexService["search"]>>): string {
	if (!result.hits.length) {
		return `No matches.${result.note ? ` ${result.note}` : ""} Try other words for the same idea, or grep for an exact name.`;
	}
	const blocks = result.hits.map((hit, index) => {
		const lines = hit.text.split("\n");
		const shown = lines.slice(0, PREVIEW_LINES);
		const more = lines.length > shown.length ? `\n  … ${lines.length - shown.length} more lines` : "";
		const body = shown.map((line, at) => `${String(hit.startLine + at).padStart(5)}  ${line}`).join("\n");
		return `${index + 1}. ${hit.path}:${hit.startLine}-${hit.endLine}${hit.symbol ? ` (${hit.symbol})` : ""}\n${body}${more}`;
	});
	const ranking = result.mode === "assisted" ? "keyword recall + model rerank" : "keyword ranking";
	const header = `${result.hits.length} result${result.hits.length === 1 ? "" : "s"} (${ranking}):`;
	return `${header}${result.note ? `\n${result.note}` : ""}\n\n${blocks.join("\n\n")}`;
}

export function createSemanticSearchTool(cwd: string): ToolDefinition {
	warmSemanticIndex(cwd);
	return {
		name: SEMANTIC_SEARCH_TOOL_NAME,
		label: SEMANTIC_SEARCH_TOOL_NAME,
		description:
			"Search this workspace's code by meaning: describe behaviour or a concept and get the most relevant code chunks with file paths and line numbers. Use it to find where something is implemented when you do not know the exact names; use grep for exact strings and identifiers you already know. Results are previews — read the file before editing.",
		promptSnippet: "semantic_search(query) finds code by meaning (where/how X is done); grep for exact names.",
		parameters: schema,
		executionMode: "parallel",
		async execute(_id, params, signal) {
			const input = params as Static<typeof schema>;
			const service = source.service();
			if (!service) throw new Error("The code index is not available");
			const result = await service.search(cwd, input.query, { limit: input.limit ?? 8, path: input.path, signal });
			return {
				content: [{ type: "text", text: formatHits(result) }],
				details: { mode: result.mode, results: result.hits.length },
			};
		},
	};
}
