import { describe, expect, test } from "bun:test";
import { codexWebSearch, geminiWebSearch, readSseJson } from "../../src/main/native-search";

function sse(events: unknown[], split = false): Response {
	const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	// Split mid-event to prove the reader reassembles chunk boundaries.
	const chunks = split ? [text.slice(0, 17), text.slice(17)] : [text];
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A JWT with a ChatGPT account id in it; the signature is never checked. */
const TOKEN = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.y`;

describe("server-sent events", () => {
	test("events split across chunks come out whole, and [DONE] ends quietly", async () => {
		const response = sse([{ a: 1 }, { b: 2 }], true);
		const events: unknown[] = [];
		for await (const event of readSseJson(response.body!)) events.push(event);
		expect(events).toEqual([{ a: 1 }, { b: 2 }]);
	});
});

describe("Codex search", () => {
	test("sends the pinned client identity and the account, and reads sources and citations", async () => {
		let sent: RequestInit | undefined;
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			sent = init;
			return sse([
				{ type: "response.web_search_call.in_progress" },
				{ type: "response.output_item.done", item: { type: "web_search_call", action: { sources: [{ url: "https://a.example/x?utm_source=openai", title: "A" }] } } },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						content: [
							{
								type: "output_text",
								text: "Answer citing B.",
								annotations: [{ type: "url_citation", url: "https://b.example/", title: "B", start_index: 0, end_index: 6 }],
							},
						],
					},
				},
			]);
		}) as typeof fetch;
		const outcome = await codexWebSearch({ query: "q", limit: 5 }, { accessToken: TOKEN, model: "gpt-6-luna" }, fetchImpl);
		const headers = sent?.headers as Record<string, string>;
		expect(headers.originator).toBe("codex-tui");
		expect(headers["chatgpt-account-id"]).toBe("acct-1");
		expect(JSON.parse(String(sent?.body))).toMatchObject({ model: "gpt-6-luna", tool_choice: { type: "web_search" }, store: false });
		expect(outcome.answer).toBe("Answer citing B.");
		expect(outcome.results.map((result) => result.url)).toEqual(["https://a.example/x", "https://b.example/"]);
	});

	test("an answer given without searching is refused", async () => {
		const fetchImpl = (async () =>
			sse([{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "From memory." }] } }])) as unknown as typeof fetch;
		await expect(codexWebSearch({ query: "q", limit: 5 }, { accessToken: TOKEN, model: "m" }, fetchImpl)).rejects.toThrow(/without searching/);
	});
});

describe("Gemini search", () => {
	test("asks for Google Search grounding and reads the answer and grounding sources", async () => {
		let payload: Record<string, unknown> | undefined;
		const outcome = await geminiWebSearch(
			{ query: "q", limit: 5 },
			{
				projectId: "proj",
				model: "gemini-3-flash",
				send: async (body) => {
					payload = body as Record<string, unknown>;
					return sse([
						{ response: { candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "Grounded " }] } }] } },
						{
							response: {
								candidates: [
									{ content: { parts: [{ text: "answer." }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://g.example", title: "g.example" } }] } },
								],
							},
						},
					]);
				},
			},
		);
		expect(payload).toMatchObject({ project: "proj", model: "gemini-3-flash", request: { tools: [{ googleSearch: {} }] } });
		expect(outcome.answer).toBe("Grounded answer.");
		expect(outcome.results).toEqual([{ title: "g.example", url: "https://g.example" }]);
	});
});
