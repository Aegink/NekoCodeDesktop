import { describe, expect, test } from "bun:test";
import { formatHits } from "../../src/main/semantic-search-tool";

describe("formatHits", () => {
	test("lists each hit with its location, symbol and numbered lines, and says how it was ranked", () => {
		const text = formatHits({
			mode: "assisted",
			model: "ds/deepseek-chat",
			note: null,
			hits: [{ path: "src/a.ts", startLine: 10, endLine: 11, symbol: "load", text: "function load() {\n}", score: 1 }],
		});
		expect(text).toContain("1 result (keyword recall + model rerank):");
		expect(text).toContain("1. src/a.ts:10-11 (load)");
		expect(text).toContain("   10  function load() {");
		expect(text).toContain("   11  }");
	});

	test("clips long hits and passes the note on", () => {
		const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const text = formatHits({
			mode: "lexical",
			model: "ds/deepseek-chat",
			note: "Search model ds/deepseek-chat: rerank failed (timeout).",
			hits: [{ path: "b.py", startLine: 1, endLine: 40, symbol: null, text: long, score: 1 }],
		});
		expect(text).toContain("(keyword ranking)");
		expect(text).toContain("rerank failed");
		expect(text).toContain("… 16 more lines");
	});

	test("says what to try when nothing matched", () => {
		expect(formatHits({ mode: "lexical", model: null, note: null, hits: [] })).toContain("grep for an exact name");
	});
});
