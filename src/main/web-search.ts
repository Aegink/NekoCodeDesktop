import { load } from "cheerio/slim";
import {
	KEYLESS_SEARCH_ENGINE,
	type AccountSearchEngineId,
	type KeyedSearchEngineId,
	type SearchEngineId,
} from "../shared/web-tools";

/**
 * Web search behind the `web_search` tool.
 *
 * The chosen engine is tried first and DuckDuckGo backs it up, so a lapsed
 * key degrades the answer instead of losing it. Keyless scraping is kept to
 * DuckDuckGo on purpose: Bing, asked the same way, answers a query about a
 * TypeScript library with a college football schedule — it poisons scrapers
 * rather than refusing them, and a confident wrong answer is worse than none.
 */

export type SearchRecency = "day" | "week" | "month" | "year";

export interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
	published?: string;
}

export interface SearchRequest {
	query: string;
	limit: number;
	recency?: SearchRecency;
	signal?: AbortSignal;
}

/** What an engine returns: the results, and for the account engines the answer they wrote from them. */
export interface EngineAnswer {
	results: SearchResult[];
	answer?: string;
}

export interface SearchCredentials {
	keys: Partial<Record<KeyedSearchEngineId, string>>;
	searxngUrl: string | null;
	/**
	 * The account engines, supplied by main where the sign-ins are. Absent in
	 * the WebUI-less tests and wherever no account can be reached.
	 */
	native?: Partial<Record<AccountSearchEngineId, (request: SearchRequest) => Promise<EngineAnswer>>>;
}

export interface SearchOutcome {
	engine: SearchEngineId;
	results: SearchResult[];
	/** An account engine's written answer, citing `results`. */
	answer?: string;
	/** Engines tried before this one, and why each was passed over. */
	skipped: { engine: SearchEngineId; reason: string }[];
}

type Fetch = typeof fetch;

/** An engine that ran and said no, as distinct from a bug. */
export class SearchEngineError extends Error {}

/** Per engine: a slow one is abandoned for the next rather than holding the call. */
const ENGINE_TIMEOUT_MS = 15_000;
const MAX_SNIPPET = 400;

export const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

function acceptLanguage(query: string): string {
	return CJK.test(query) ? "zh-CN,zh;q=0.9,en;q=0.8" : "en-US,en;q=0.9";
}

function clean(text: string | undefined | null, max = MAX_SNIPPET): string | undefined {
	if (!text) return undefined;
	const collapsed = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

function engineSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(ENGINE_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function failure(engine: string, response: Response): Promise<SearchEngineError> {
	const body = clean(await response.text().catch(() => ""), 200);
	if (response.status === 401 || response.status === 403)
		return new SearchEngineError(`${engine} rejected the API key (${response.status})${body ? `: ${body}` : ""}`);
	if (response.status === 429) return new SearchEngineError(`${engine} rate limit reached (429)`);
	return new SearchEngineError(`${engine} returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

// --- DuckDuckGo ---------------------------------------------------------

/** DuckDuckGo's HTML frontend wraps outbound links as `//duckduckgo.com/l/?uddg=<encoded>`. */
export function unwrapDuckDuckGoUrl(href: string): string | null {
	const wrapped = /[?&]uddg=([^&]+)/.exec(href);
	if (wrapped) {
		try {
			const decoded = decodeURIComponent(wrapped[1]);
			return isHttpUrl(decoded) ? decoded : null;
		} catch {
			return null;
		}
	}
	if (href.startsWith("//")) return `https:${href}`;
	return isHttpUrl(href) ? href : null;
}

export function parseDuckDuckGoResults(html: string): SearchResult[] {
	const $ = load(html);
	const results: SearchResult[] = [];
	$(".result").each((_, element) => {
		const item = $(element);
		if (item.hasClass("result--ad")) return;
		const link = item.find("a.result__a").first();
		const title = clean(link.text(), 200);
		const url = unwrapDuckDuckGoUrl(link.attr("href") ?? "");
		if (!title || !url) return;
		results.push({ title, url, snippet: clean(item.find(".result__snippet").first().text()) });
	});
	return results;
}

const DDG_RECENCY: Record<SearchRecency, string> = { day: "d", week: "w", month: "m", year: "y" };

async function searchDuckDuckGo(request: SearchRequest, fetchImpl: Fetch): Promise<SearchResult[]> {
	const form = new URLSearchParams({ q: request.query, b: "" });
	if (request.recency) form.set("df", DDG_RECENCY[request.recency]);
	const response = await fetchImpl("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: {
			"User-Agent": BROWSER_USER_AGENT,
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "text/html",
			"Accept-Language": acceptLanguage(request.query),
			Referer: "https://html.duckduckgo.com/",
		},
		body: form.toString(),
		signal: engineSignal(request.signal),
	});
	if (!response.ok) throw await failure("DuckDuckGo", response);
	const html = await response.text();
	if (html.includes("anomaly-modal") || html.includes("anomaly.js"))
		throw new SearchEngineError("DuckDuckGo answered with a bot check instead of results");
	return parseDuckDuckGoResults(html).slice(0, request.limit);
}

// --- Keyed APIs ---------------------------------------------------------

async function searchTavily(request: SearchRequest, key: string, fetchImpl: Fetch): Promise<SearchResult[]> {
	const response = await fetchImpl("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({
			query: request.query,
			max_results: request.limit,
			search_depth: "basic",
			...(request.recency ? { time_range: request.recency } : {}),
		}),
		signal: engineSignal(request.signal),
	});
	if (!response.ok) throw await failure("Tavily", response);
	const data = (await response.json()) as { results?: { title?: string; url?: string; content?: string; published_date?: string }[] };
	return (data.results ?? []).flatMap((entry) =>
		entry.url && isHttpUrl(entry.url)
			? [{ title: clean(entry.title, 200) ?? entry.url, url: entry.url, snippet: clean(entry.content), published: entry.published_date }]
			: [],
	);
}

/** Bocha and Zhipu share the same recency vocabulary. */
const CN_RECENCY: Record<SearchRecency, string> = { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" };

interface BochaPage {
	name?: string;
	url?: string;
	snippet?: string;
	summary?: string;
	datePublished?: string;
}

async function searchBocha(request: SearchRequest, key: string, fetchImpl: Fetch): Promise<SearchResult[]> {
	const response = await fetchImpl("https://api.bochaai.com/v1/web-search", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({
			query: request.query,
			count: request.limit,
			summary: true,
			freshness: request.recency ? CN_RECENCY[request.recency] : "noLimit",
		}),
		signal: engineSignal(request.signal),
	});
	if (!response.ok) throw await failure("Bocha", response);
	// Bing-shaped, inside an envelope: `{ code, data: { webPages: { value } } }`.
	const data = (await response.json()) as { code?: number | string; msg?: string; data?: { webPages?: { value?: BochaPage[] } }; webPages?: { value?: BochaPage[] } };
	if (data.code !== undefined && Number(data.code) !== 200) throw new SearchEngineError(`Bocha error ${data.code}${data.msg ? `: ${data.msg}` : ""}`);
	return ((data.data ?? data).webPages?.value ?? []).flatMap((entry) =>
		entry.url && isHttpUrl(entry.url)
			? [{ title: clean(entry.name, 200) ?? entry.url, url: entry.url, snippet: clean(entry.summary ?? entry.snippet), published: entry.datePublished }]
			: [],
	);
}

/** Zhipu rejects longer queries outright rather than truncating them. */
const ZHIPU_MAX_QUERY = 70;

async function searchZhipu(request: SearchRequest, key: string, fetchImpl: Fetch): Promise<SearchResult[]> {
	const response = await fetchImpl("https://open.bigmodel.cn/api/paas/v4/web_search", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({
			search_query: request.query.slice(0, ZHIPU_MAX_QUERY),
			search_engine: "search_std",
			count: request.limit,
			search_recency_filter: request.recency ? CN_RECENCY[request.recency] : "noLimit",
		}),
		signal: engineSignal(request.signal),
	});
	if (!response.ok) throw await failure("Zhipu", response);
	const data = (await response.json()) as { search_result?: { title?: string; link?: string; content?: string; publish_date?: string }[] };
	return (data.search_result ?? []).flatMap((entry) =>
		entry.link && isHttpUrl(entry.link)
			? [{ title: clean(entry.title, 200) ?? entry.link, url: entry.link, snippet: clean(entry.content), published: entry.publish_date || undefined }]
			: [],
	);
}

const BRAVE_RECENCY: Record<SearchRecency, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

async function searchBrave(request: SearchRequest, key: string, fetchImpl: Fetch): Promise<SearchResult[]> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", request.query);
	url.searchParams.set("count", String(Math.min(request.limit, 20)));
	if (request.recency) url.searchParams.set("freshness", BRAVE_RECENCY[request.recency]);
	const response = await fetchImpl(url, {
		headers: { Accept: "application/json", "X-Subscription-Token": key },
		signal: engineSignal(request.signal),
	});
	if (!response.ok) throw await failure("Brave", response);
	const data = (await response.json()) as {
		web?: { results?: { title?: string; url?: string; description?: string; page_age?: string; age?: string }[] };
	};
	return (data.web?.results ?? []).flatMap((entry) =>
		entry.url && isHttpUrl(entry.url)
			? [{ title: clean(entry.title, 200) ?? entry.url, url: entry.url, snippet: clean(entry.description), published: entry.page_age ?? entry.age }]
			: [],
	);
}

const RECENCY_DAYS: Record<SearchRecency, number> = { day: 1, week: 7, month: 31, year: 365 };

async function searchExa(request: SearchRequest, key: string, fetchImpl: Fetch): Promise<SearchResult[]> {
	const response = await fetchImpl("https://api.exa.ai/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": key },
		body: JSON.stringify({
			query: request.query,
			numResults: request.limit,
			type: "auto",
			contents: { text: { maxCharacters: MAX_SNIPPET } },
			...(request.recency
				? { startPublishedDate: new Date(Date.now() - RECENCY_DAYS[request.recency] * 86_400_000).toISOString() }
				: {}),
		}),
		signal: engineSignal(request.signal),
	});
	if (!response.ok) throw await failure("Exa", response);
	const data = (await response.json()) as { results?: { title?: string; url?: string; text?: string; publishedDate?: string }[] };
	return (data.results ?? []).flatMap((entry) =>
		entry.url && isHttpUrl(entry.url)
			? [{ title: clean(entry.title, 200) ?? entry.url, url: entry.url, snippet: clean(entry.text), published: entry.publishedDate }]
			: [],
	);
}

async function searchJina(request: SearchRequest, key: string, fetchImpl: Fetch): Promise<SearchResult[]> {
	const url = new URL("https://s.jina.ai/");
	url.searchParams.set("q", request.query);
	url.searchParams.set("count", String(Math.min(request.limit, 20)));
	const response = await fetchImpl(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${key}`,
			// Titles and descriptions only; Jina otherwise reads every result page.
			"X-Respond-With": "no-content",
			"X-Retain-Images": "none",
		},
		signal: engineSignal(request.signal),
	});
	if (!response.ok) throw await failure("Jina", response);
	const data = (await response.json()) as {
		code?: number;
		status?: number;
		data?: { title?: string; url?: string; description?: string | null; content?: string | null; date?: string }[];
	};
	if (typeof data.code === "number" && data.code !== 200) throw new SearchEngineError(`Jina error ${data.code}`);
	return (data.data ?? []).flatMap((entry) =>
		entry.url && isHttpUrl(entry.url)
			? [{ title: clean(entry.title, 200) ?? entry.url, url: entry.url, snippet: clean(entry.description ?? entry.content), published: entry.date }]
			: [],
	);
}

/**
 * Perplexity's Sonar API: an answer written from a live search, with the
 * pages it used. Returns both, like the account engines.
 */
async function searchPerplexity(request: SearchRequest, key: string, fetchImpl: Fetch): Promise<EngineAnswer> {
	const response = await fetchImpl("https://api.perplexity.ai/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({
			model: "sonar",
			messages: [{ role: "user", content: request.query }],
			...(request.recency ? { search_recency_filter: request.recency } : {}),
		}),
		signal: engineSignal(request.signal),
	});
	if (!response.ok) throw await failure("Perplexity", response);
	const data = (await response.json()) as {
		choices?: { message?: { content?: string } }[];
		search_results?: { title?: string; url?: string; date?: string; snippet?: string }[];
		citations?: string[];
	};
	const results: SearchResult[] = (data.search_results ?? []).flatMap((entry) =>
		entry.url && isHttpUrl(entry.url)
			? [{ title: clean(entry.title, 200) ?? entry.url, url: entry.url, snippet: clean(entry.snippet), published: entry.date }]
			: [],
	);
	for (const url of data.citations ?? []) {
		if (isHttpUrl(url) && !results.some((result) => result.url === url)) results.push({ title: url, url });
	}
	return { results: results.slice(0, request.limit), answer: data.choices?.[0]?.message?.content?.trim() || undefined };
}

async function searchKagi(request: SearchRequest, key: string, fetchImpl: Fetch): Promise<SearchResult[]> {
	const url = new URL("https://kagi.com/api/v0/search");
	url.searchParams.set("q", request.query);
	url.searchParams.set("limit", String(request.limit));
	const response = await fetchImpl(url, { headers: { Accept: "application/json", Authorization: `Bot ${key}` }, signal: engineSignal(request.signal) });
	if (!response.ok) throw await failure("Kagi", response);
	// `t: 0` is a search result; `t: 1` is a list of related searches.
	const data = (await response.json()) as { data?: { t?: number; url?: string; title?: string; snippet?: string; published?: string }[] };
	return (data.data ?? []).flatMap((entry) =>
		entry.t === 0 && entry.url && isHttpUrl(entry.url)
			? [{ title: clean(entry.title, 200) ?? entry.url, url: entry.url, snippet: clean(entry.snippet), published: entry.published }]
			: [],
	);
}

const FIRECRAWL_RECENCY: Record<SearchRecency, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };

async function searchFirecrawl(request: SearchRequest, key: string, fetchImpl: Fetch): Promise<SearchResult[]> {
	const response = await fetchImpl("https://api.firecrawl.dev/v2/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({
			query: request.query,
			limit: request.limit,
			sources: [{ type: "web" }],
			...(request.recency ? { tbs: FIRECRAWL_RECENCY[request.recency] } : {}),
		}),
		signal: engineSignal(request.signal),
	});
	if (!response.ok) throw await failure("Firecrawl", response);
	type Entry = { url?: string; title?: string; description?: string | null };
	// v2 nests results by source; v1 answered with a flat list.
	const data = (await response.json()) as { data?: Entry[] | { web?: Entry[] } };
	const entries = Array.isArray(data.data) ? data.data : (data.data?.web ?? []);
	return entries.flatMap((entry) =>
		entry.url && isHttpUrl(entry.url) ? [{ title: clean(entry.title, 200) ?? entry.url, url: entry.url, snippet: clean(entry.description) }] : [],
	);
}

/** SearXNG has no week range; a month is the nearest it can do without losing the week. */
const SEARXNG_RECENCY: Record<SearchRecency, string> = { day: "day", week: "month", month: "month", year: "year" };

async function searchSearxng(request: SearchRequest, base: string, fetchImpl: Fetch): Promise<SearchResult[]> {
	const url = new URL("search", base.endsWith("/") ? base : `${base}/`);
	url.searchParams.set("q", request.query);
	url.searchParams.set("format", "json");
	if (request.recency) url.searchParams.set("time_range", SEARXNG_RECENCY[request.recency]);
	const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: engineSignal(request.signal) });
	if (response.status === 403)
		throw new SearchEngineError("SearXNG refused the JSON API (403); enable `json` under `search.formats` in the instance's settings.yml");
	if (!response.ok) throw await failure("SearXNG", response);
	const data = (await response.json()) as { results?: { title?: string; url?: string; content?: string; publishedDate?: string }[] };
	return (data.results ?? [])
		.flatMap((entry) =>
			entry.url && isHttpUrl(entry.url)
				? [{ title: clean(entry.title, 200) ?? entry.url, url: entry.url, snippet: clean(entry.content), published: entry.publishedDate ?? undefined }]
				: [],
		)
		.slice(0, request.limit);
}

// --- Chain --------------------------------------------------------------

/** The engines to try, in order: the chosen one, then DuckDuckGo. */
export function searchChain(provider: SearchEngineId): SearchEngineId[] {
	return [...new Set<SearchEngineId>([provider, KEYLESS_SEARCH_ENGINE])];
}

async function runEngine(
	engine: SearchEngineId,
	request: SearchRequest,
	credentials: SearchCredentials,
	fetchImpl: Fetch,
): Promise<EngineAnswer> {
	const listed = async (results: Promise<SearchResult[]>): Promise<EngineAnswer> => ({ results: await results });
	switch (engine) {
		case "duckduckgo":
			return listed(searchDuckDuckGo(request, fetchImpl));
		case "searxng":
			if (!credentials.searxngUrl) throw new SearchEngineError("no SearXNG address is configured");
			return listed(searchSearxng(request, credentials.searxngUrl, fetchImpl));
		case "codex":
		case "gemini": {
			const native = credentials.native?.[engine];
			if (!native) throw new SearchEngineError(`${engine === "codex" ? "OpenAI Codex" : "Antigravity"} is not signed in`);
			return native(request);
		}
		default: {
			const key = credentials.keys[engine];
			if (!key) throw new SearchEngineError(`no ${engine} API key is configured`);
			switch (engine) {
				case "tavily":
					return listed(searchTavily(request, key, fetchImpl));
				case "bocha":
					return listed(searchBocha(request, key, fetchImpl));
				case "zhipu":
					return listed(searchZhipu(request, key, fetchImpl));
				case "brave":
					return listed(searchBrave(request, key, fetchImpl));
				case "exa":
					return listed(searchExa(request, key, fetchImpl));
				case "jina":
					return listed(searchJina(request, key, fetchImpl));
				case "perplexity":
					return searchPerplexity(request, key, fetchImpl);
				case "kagi":
					return listed(searchKagi(request, key, fetchImpl));
				case "firecrawl":
					return listed(searchFirecrawl(request, key, fetchImpl));
			}
		}
	}
}

function reason(error: unknown): string {
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timed out";
	if (error instanceof Error) {
		// undici hides the useful part — DNS failure, reset, TLS — in `cause`.
		const cause = (error as { cause?: unknown }).cause;
		const detail = cause instanceof Error ? cause.message : undefined;
		return detail && detail !== error.message ? `${error.message} (${detail})` : error.message;
	}
	return String(error);
}

/**
 * Search, walking the chain until an engine returns results.
 *
 * An engine that answers with nothing is passed over too: an empty page from
 * one index is a reason to ask another, not an answer. Only when every engine
 * has failed is it an error; when they all merely came back empty, the empty
 * answer stands.
 */
export async function webSearch(
	request: SearchRequest,
	provider: SearchEngineId,
	credentials: SearchCredentials,
	fetchImpl: Fetch = fetch,
): Promise<SearchOutcome> {
	const skipped: SearchOutcome["skipped"] = [];
	let empty: SearchEngineId | null = null;
	for (const engine of searchChain(provider)) {
		if (request.signal?.aborted) throw new Error("Search cancelled");
		try {
			const { results, answer } = await runEngine(engine, request, credentials, fetchImpl);
			// An answer with no listed pages still answers; an empty page does not.
			if (results.length > 0 || answer) return { engine, results, skipped, ...(answer ? { answer } : {}) };
			empty ??= engine;
			skipped.push({ engine, reason: "no results" });
		} catch (error) {
			if (request.signal?.aborted) throw new Error("Search cancelled");
			skipped.push({ engine, reason: reason(error) });
		}
	}
	if (empty) return { engine: empty, results: [], skipped: skipped.filter((entry) => entry.engine !== empty) };
	throw new SearchEngineError(`Every search engine failed: ${skipped.map((entry) => `${entry.engine}: ${entry.reason}`).join("; ")}`);
}
