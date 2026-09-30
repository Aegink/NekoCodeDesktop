import { randomUUID } from "node:crypto";
import { CODEX_CLIENT_HEADERS, readCodexClaims } from "./openai-codex";
import type { EngineAnswer, SearchRequest, SearchResult } from "./web-search";

/**
 * Web search through a model account the user already signed in with.
 *
 * The model runs its provider's own search tool — OpenAI's `web_search` on the
 * Codex backend, Google Search grounding on Antigravity — and hands back an
 * answer plus the pages it used. No search key to buy, and the index is the
 * provider's. Shapes follow oh-my-pi's codex and gemini search providers (MIT).
 */

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const SEARCH_TIMEOUT_MS = 60_000;
const INSTRUCTIONS =
	"Search the web to answer the user's query accurately. Answer concisely from what the sources say, and cite them.";

type Fetch = typeof fetch;

/** Server-sent events as parsed JSON objects; non-JSON lines are skipped. */
export async function* readSseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";
	const parse = (event: string) => {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") return null;
		try {
			const value: unknown = JSON.parse(data);
			return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let boundary = /\r?\n\r?\n/.exec(buffer);
		while (boundary) {
			const event = parse(buffer.slice(0, boundary.index));
			buffer = buffer.slice(boundary.index + boundary[0].length);
			if (event) yield event;
			boundary = /\r?\n\r?\n/.exec(buffer);
		}
	}
	const last = parse(buffer);
	if (last) yield last;
}

function timeoutSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function addResult(results: SearchResult[], url: string | undefined, title?: string, snippet?: string): void {
	if (!url || !/^https?:\/\//i.test(url)) return;
	// OpenAI tags every cited link; the tag is noise to whoever reads it next.
	const clean = url.replace(/([?&])utm_source=openai(&|$)/, (_, lead: string, tail: string) => (tail ? lead : "")).replace(/[?&]$/, "");
	const existing = results.find((result) => result.url === clean);
	if (existing) {
		if (existing.title === existing.url && title) existing.title = title;
		if (!existing.snippet && snippet) existing.snippet = snippet;
		return;
	}
	results.push({ title: title?.trim() || clean, url: clean, ...(snippet ? { snippet } : {}) });
}

/** The prose around a citation, for the result's snippet. */
function citationSnippet(text: string, start?: number, end?: number): string | undefined {
	if (start === undefined || end === undefined) return undefined;
	const around = text.slice(Math.max(0, start - 120), Math.min(text.length, end + 120)).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
	return around ? (around.length > 300 ? `${around.slice(0, 299)}…` : around) : undefined;
}

export interface CodexSearchAuth {
	accessToken: string;
	/** The model the search runs on; one the account can use. */
	model: string;
}

interface CodexItem {
	type?: string;
	action?: { sources?: { url?: string; title?: string }[] };
	content?: { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string; start_index?: number; end_index?: number }[] }[];
}

/** One search on the Codex backend, forced to use the hosted `web_search` tool. */
export async function codexWebSearch(request: SearchRequest, auth: CodexSearchAuth, fetchImpl: Fetch = fetch): Promise<EngineAnswer> {
	const { accountId } = readCodexClaims(auth.accessToken);
	const response = await fetchImpl(CODEX_RESPONSES_URL, {
		method: "POST",
		headers: {
			...CODEX_CLIENT_HEADERS,
			Authorization: `Bearer ${auth.accessToken}`,
			...(accountId ? { "chatgpt-account-id": accountId } : {}),
			"OpenAI-Beta": "responses=experimental",
			session_id: randomUUID(),
			Accept: "text/event-stream",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: auth.model,
			instructions: INSTRUCTIONS,
			input: [{ type: "message", role: "user", content: [{ type: "input_text", text: request.query }] }],
			tools: [{ type: "web_search", search_context_size: "medium" }],
			tool_choice: { type: "web_search" },
			include: ["web_search_call.action.sources"],
			parallel_tool_calls: true,
			stream: true,
			store: false,
		}),
		signal: timeoutSignal(request.signal),
	});
	if (!response.ok || !response.body) {
		const body = (await response.text().catch(() => "")).slice(0, 300);
		throw new Error(`Codex search returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
	}

	const results: SearchResult[] = [];
	const answer: string[] = [];
	let searched = false;
	for await (const event of readSseJson(response.body)) {
		const type = typeof event.type === "string" ? event.type : "";
		if (type.startsWith("response.web_search_call")) searched = true;
		if (type === "response.failed" || type === "error") {
			const error = (event.response as { error?: { message?: string } } | undefined)?.error ?? (event.error as { message?: string } | undefined);
			throw new Error(`Codex search failed: ${error?.message ?? (event.message as string | undefined) ?? "unknown error"}`);
		}
		if (type !== "response.output_item.done") continue;
		const item = event.item as CodexItem | undefined;
		if (item?.type === "web_search_call") {
			searched = true;
			for (const source of item.action?.sources ?? []) addResult(results, source.url, source.title);
		}
		if (item?.type === "message") {
			for (const part of item.content ?? []) {
				if (part.type !== "output_text" || !part.text) continue;
				answer.push(part.text);
				for (const note of part.annotations ?? []) {
					if (note.type === "url_citation") addResult(results, note.url, note.title, citationSnippet(part.text, note.start_index, note.end_index));
				}
			}
		}
	}
	// An answer from the model's own memory is not a search result.
	if (!searched) throw new Error("Codex answered without searching the web");
	return { results: results.slice(0, Math.max(request.limit, 1) * 2), answer: answer.join("\n\n").trim() || undefined };
}

export interface GeminiSearchAuth {
	projectId: string;
	model: string;
	/** Sends a Cloud Code `streamGenerateContent` payload as the signed-in account. */
	send: (payload: unknown) => Promise<Response>;
}

interface GeminiChunk {
	response?: {
		candidates?: {
			content?: { parts?: { text?: string; thought?: boolean }[] };
			groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
		}[];
	};
}

/** One search through Antigravity, grounded on Google Search. */
export async function geminiWebSearch(request: SearchRequest, auth: GeminiSearchAuth): Promise<EngineAnswer> {
	const response = await auth.send({
		project: auth.projectId,
		model: auth.model,
		userAgent: "antigravity",
		requestType: "agent",
		requestId: `agent-${randomUUID()}`,
		request: {
			contents: [{ role: "user", parts: [{ text: request.query }] }],
			systemInstruction: { role: "user", parts: [{ text: INSTRUCTIONS }] },
			tools: [{ googleSearch: {} }],
		},
	});
	if (!response.ok || !response.body) {
		const body = (await response.text().catch(() => "")).slice(0, 300);
		throw new Error(`Gemini search returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
	}
	const results: SearchResult[] = [];
	const answer: string[] = [];
	for await (const event of readSseJson(response.body)) {
		for (const candidate of (event as GeminiChunk).response?.candidates ?? []) {
			for (const part of candidate.content?.parts ?? []) if (part.text && !part.thought) answer.push(part.text);
			// Grounding URIs are Google redirect links; web_fetch follows them to the page.
			for (const chunk of candidate.groundingMetadata?.groundingChunks ?? []) addResult(results, chunk.web?.uri, chunk.web?.title);
		}
	}
	if (!results.length && !answer.length) throw new Error("Gemini returned neither an answer nor sources");
	return { results: results.slice(0, Math.max(request.limit, 1) * 2), answer: answer.join("").trim() || undefined };
}
