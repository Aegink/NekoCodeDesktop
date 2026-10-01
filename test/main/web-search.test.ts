import { describe, expect, test } from "bun:test";
import { parseDuckDuckGoResults, searchChain, unwrapDuckDuckGoUrl, webSearch } from "../../src/main/web-search";

const DDG_PAGE = `
	<div class="result results_links result--ad"><a class="result__a" href="https://ads.example.com">Ad</a></div>
	<div class="result results_links"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=1">Example <b>A</b></a></h2>
		<a class="result__snippet">First &amp; best.</a></div>
	<div class="result results_links"><a class="result__a" href="https://example.org/b">B</a></div>`;

const NO_CREDENTIALS = { keys: {}, searxngUrl: null };

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "content-type": "text/html" } });
}

/** A fetch that records what it was asked and answers with `reply`. */
function recordingFetch(reply: (url: string) => Response) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return reply(String(url));
	}) as typeof fetch;
	return { calls, fetchImpl };
}

describe("DuckDuckGo parsing", () => {
	test("unwraps redirect links and skips ads", () => {
		expect(unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2F")).toBe("https://a.com/");
		expect(parseDuckDuckGoResults(DDG_PAGE)).toEqual([
			{ title: "Example A", url: "https://example.com/a?x=1", snippet: "First & best." },
			{ title: "B", url: "https://example.org/b", snippet: undefined },
		]);
	});
});

describe("webSearch", () => {
	test("the chosen engine leads and DuckDuckGo backs it up", () => {
		expect(searchChain("tavily")).toEqual(["tavily", "duckduckgo"]);
		expect(searchChain("duckduckgo")).toEqual(["duckduckgo"]);
	});

	test("sends the key to Tavily and maps its results", async () => {
		const { calls, fetchImpl } = recordingFetch(() =>
			Response.json({ results: [{ title: "T", url: "https://t.example", content: "c", published_date: "2026-01-01" }] }),
		);
		const outcome = await webSearch({ query: "q", limit: 3, recency: "week" }, "tavily", { keys: { tavily: "tvly-key" }, searxngUrl: null }, fetchImpl);
		expect(outcome).toEqual({
			engine: "tavily",
			results: [{ title: "T", url: "https://t.example", snippet: "c", published: "2026-01-01" }],
			skipped: [],
		});
		expect(calls[0].url).toBe("https://api.tavily.com/search");
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tvly-key");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ query: "q", max_results: 3, search_depth: "basic", time_range: "week" });
	});

	test("reads Bocha's enveloped, Bing-shaped answer", async () => {
		const { calls, fetchImpl } = recordingFetch(() =>
			Response.json({
				code: 200,
				data: { webPages: { value: [{ name: "博查", url: "https://b.example", snippet: "短", summary: "长摘要", datePublished: "2026-02-01" }] } },
			}),
		);
		const outcome = await webSearch({ query: "q", limit: 5, recency: "month" }, "bocha", { keys: { bocha: "sk-b" }, searxngUrl: null }, fetchImpl);
		expect(outcome.results).toEqual([{ title: "博查", url: "https://b.example", snippet: "长摘要", published: "2026-02-01" }]);
		expect(calls[0].url).toBe("https://api.bochaai.com/v1/web-search");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ query: "q", count: 5, summary: true, freshness: "oneMonth" });
	});

	test("reports a Bocha error code even on HTTP 200", async () => {
		const { fetchImpl } = recordingFetch((url) =>
			url.includes("bochaai") ? Response.json({ code: 403, msg: "余额不足" }) : htmlResponse(DDG_PAGE),
		);
		const outcome = await webSearch({ query: "q", limit: 5 }, "bocha", { keys: { bocha: "sk-b" }, searxngUrl: null }, fetchImpl);
		expect(outcome.engine).toBe("duckduckgo");
		expect(outcome.skipped).toEqual([{ engine: "bocha", reason: "Bocha error 403: 余额不足" }]);
	});

	test("trims the query to Zhipu's limit and maps its results", async () => {
		const { calls, fetchImpl } = recordingFetch(() =>
			Response.json({ search_result: [{ title: "智谱", link: "https://z.example", content: "内容", publish_date: "" }] }),
		);
		const outcome = await webSearch({ query: "x".repeat(100), limit: 4 }, "zhipu", { keys: { zhipu: "zk" }, searxngUrl: null }, fetchImpl);
		expect(outcome.results).toEqual([{ title: "智谱", url: "https://z.example", snippet: "内容", published: undefined }]);
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			search_query: "x".repeat(70),
			search_engine: "search_std",
			count: 4,
			search_recency_filter: "noLimit",
		});
	});

	test("falls through a missing key to DuckDuckGo", async () => {
		const { fetchImpl } = recordingFetch(() => htmlResponse(DDG_PAGE));
		const outcome = await webSearch({ query: "q", limit: 5 }, "brave", NO_CREDENTIALS, fetchImpl);
		expect(outcome.engine).toBe("duckduckgo");
		expect(outcome.results).toHaveLength(2);
		expect(outcome.skipped).toEqual([{ engine: "brave", reason: "no brave API key is configured" }]);
	});

	test("an empty answer stands when no engine fails outright", async () => {
		const { fetchImpl } = recordingFetch(() => htmlResponse("<html><body>No results</body></html>"));
		const outcome = await webSearch({ query: "zzzz", limit: 5 }, "duckduckgo", NO_CREDENTIALS, fetchImpl);
		expect(outcome).toEqual({ engine: "duckduckgo", results: [], skipped: [] });
	});

	test("Jina, Kagi and Firecrawl map their results; Kagi's related-search rows are dropped", async () => {
		const { calls, fetchImpl } = recordingFetch((url) => {
			if (url.startsWith("https://s.jina.ai")) return Response.json({ code: 200, data: [{ title: "J", url: "https://j.example", description: "jd" }] });
			if (url.startsWith("https://kagi.com"))
				return Response.json({ data: [{ t: 0, url: "https://k.example", title: "K", snippet: "ks" }, { t: 1, list: ["related"] }] });
			return Response.json({ data: { web: [{ url: "https://f.example", title: "F", description: "fd" }] } });
		});
		const jina = await webSearch({ query: "q", limit: 3 }, "jina", { keys: { jina: "jk" }, searxngUrl: null }, fetchImpl);
		expect(jina.results).toEqual([{ title: "J", url: "https://j.example", snippet: "jd", published: undefined }]);
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer jk");
		const kagi = await webSearch({ query: "q", limit: 3 }, "kagi", { keys: { kagi: "kk" }, searxngUrl: null }, fetchImpl);
		expect(kagi.results.map((result) => result.url)).toEqual(["https://k.example"]);
		expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe("Bot kk");
		const firecrawl = await webSearch({ query: "q", limit: 3, recency: "day" }, "firecrawl", { keys: { firecrawl: "fk" }, searxngUrl: null }, fetchImpl);
		expect(firecrawl.results[0]).toEqual({ title: "F", url: "https://f.example", snippet: "fd" });
		expect(JSON.parse(String(calls[2].init?.body)).tbs).toBe("qdr:d");
	});

	test("Perplexity comes back with its answer as well as the pages it used", async () => {
		const { fetchImpl } = recordingFetch(() =>
			Response.json({
				choices: [{ message: { content: "Bun 1.4 shipped in June." } }],
				search_results: [{ title: "Release", url: "https://bun.sh/blog", date: "2026-06-01" }],
				citations: ["https://bun.sh/blog", "https://github.com/oven-sh/bun"],
			}),
		);
		const outcome = await webSearch({ query: "bun release", limit: 5 }, "perplexity", { keys: { perplexity: "pk" }, searxngUrl: null }, fetchImpl);
		expect(outcome.answer).toBe("Bun 1.4 shipped in June.");
		expect(outcome.results.map((result) => result.url)).toEqual(["https://bun.sh/blog", "https://github.com/oven-sh/bun"]);
	});

	test("an account engine runs through main's hook, and without a sign-in falls back", async () => {
		const { fetchImpl } = recordingFetch(() => htmlResponse(DDG_PAGE));
		const signedIn = await webSearch({ query: "q", limit: 5 }, "codex", {
			...NO_CREDENTIALS,
			native: { codex: async () => ({ results: [{ title: "C", url: "https://c.example" }], answer: "From Codex." }) },
		}, fetchImpl);
		expect(signedIn).toMatchObject({ engine: "codex", answer: "From Codex." });
		const signedOut = await webSearch({ query: "q", limit: 5 }, "gemini", NO_CREDENTIALS, fetchImpl);
		expect(signedOut.engine).toBe("duckduckgo");
		expect(signedOut.skipped[0]).toEqual({ engine: "gemini", reason: "Antigravity is not signed in" });
	});

	test("fails with every engine's reason when all of them fail", async () => {
		const { fetchImpl } = recordingFetch(() => htmlResponse("<div class='anomaly-modal'></div>"));
		await expect(webSearch({ query: "q", limit: 5 }, "exa", NO_CREDENTIALS, fetchImpl)).rejects.toThrow(
			"Every search engine failed: exa: no exa API key is configured; duckduckgo: DuckDuckGo answered with a bot check instead of results",
		);
	});
});
