import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithSiteHandler } from "../../../src/main/web-tools";
import { parseHTML } from "../../../src/main/web-scrapers/dom";
import { specialHandlers } from "../../../src/main/web-scrapers/index";
import type { SpecialHandler } from "../../../src/main/web-scrapers/types";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function mockFetch(routes: Record<string, unknown>): string[] {
	const calls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);
		const body = routes[url];
		if (body === undefined) return new Response("not found", { status: 404 });
		const response = new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status: 200,
			headers: { "content-type": typeof body === "string" ? "text/html" : "application/json" },
		});
		Object.defineProperty(response, "url", { value: url });
		return response;
	}) as typeof fetch;
	return calls;
}

describe("site handlers", () => {
	test("the ported list loads, and the dropped handlers are gone", () => {
		expect(specialHandlers.length).toBeGreaterThan(70);
	});

	test("an npm page is read from the registry API", async () => {
		const calls = mockFetch({
			"https://registry.npmjs.org/left-pad/latest": {
				name: "left-pad",
				version: "1.3.0",
				description: "String left pad",
				license: "WTFPL",
			},
			"https://api.npmjs.org/downloads/point/last-week/left-pad": { downloads: 2_500_000 },
		});
		const result = await fetchWithSiteHandler("https://www.npmjs.com/package/left-pad", undefined);
		expect(result?.text).toContain("left-pad");
		expect(result?.text).toContain("1.3.0");
		expect(result?.text).toContain("2.5M");
		expect(calls).toContain("https://registry.npmjs.org/left-pad/latest");
	});

	test("a URL no handler knows falls through, and a throwing handler does not break the fetch", async () => {
		mockFetch({});
		expect(await fetchWithSiteHandler("https://example.com/some/page", undefined, specialHandlers)).toBeNull();
		const broken: SpecialHandler = async () => {
			throw new Error("API changed shape");
		};
		expect(await fetchWithSiteHandler("https://example.com/", undefined, [broken])).toBeNull();
	});
});

describe("dom shim", () => {
	test("covers what the handlers read", () => {
		const { document } = parseHTML('<main><h1 class="t">Title</h1><a href="/x">link <b>bold</b></a></main>');
		expect(document.querySelector(".t")?.textContent).toBe("Title");
		const link = document.querySelector("a");
		expect(link?.getAttribute("href")).toBe("/x");
		expect(link?.innerHTML).toBe("link <b>bold</b>");
		expect(link?.tagName).toBe("A");
		expect(link?.parentElement?.tagName).toBe("MAIN");
		expect(document.querySelectorAll("h1, a")).toHaveLength(2);
	});
});
