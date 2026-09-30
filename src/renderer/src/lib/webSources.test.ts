import { describe, expect, test } from "bun:test";
import type { AgentCell } from "../../../shared/agent";
import { collectWebTitles, extractCitations, isCitationLabel, sourceKey } from "./webSources";

function tool(toolName: string, details: unknown): AgentCell {
	return { id: toolName, type: "tool", toolCallId: toolName, toolName, args: {}, output: "", details, status: "done", timestamp: 0 };
}

describe("extractCitations", () => {
	test("lists cited pages once each, in first-cited order", () => {
		const text = [
			"It was deprecated[2](https://b.example/x) in v3[1](https://a.example/).",
			"Confirmed again[2](https://b.example/x/).",
			"A [normal link](https://c.example) is not a citation.",
		].join("\n");
		expect(extractCitations(text)).toEqual([
			{ label: "2", url: "https://b.example/x" },
			{ label: "1", url: "https://a.example/" },
		]);
	});

	test("ignores the syntax inside code", () => {
		expect(extractCitations("Write `[1](https://a.example)` or\n```\n[2](https://b.example)\n```")).toEqual([]);
	});
});

describe("titles", () => {
	test("matches URL spellings that differ only cosmetically", () => {
		expect(sourceKey("https://www.Example.com/docs/#top")).toBe(sourceKey("http://example.com/docs"));
		expect(sourceKey("https://example.com/a?x=1")).not.toBe(sourceKey("https://example.com/a?x=2"));
	});

	test("reads titles from search results, preferring what a fetched page calls itself", () => {
		const titles = collectWebTitles([
			tool("web_search", { results: [{ title: "Listing title…", url: "https://a.example/page" }, { title: "B", url: "https://b.example" }] }),
			tool("web_fetch", { url: "https://a.example/page", finalUrl: "https://a.example/page/", title: "The page's own title" }),
			tool("read", { title: "not web" }),
		]);
		expect(titles.get(sourceKey("https://a.example/page"))).toBe("The page's own title");
		expect(titles.get(sourceKey("https://b.example/"))).toBe("B");
		expect(titles.size).toBe(2);
	});

	test("a citation label is a bare number", () => {
		expect(isCitationLabel("12")).toBe(true);
		expect(isCitationLabel("v2")).toBe(false);
		expect(isCitationLabel("1234")).toBe(false);
	});
});
