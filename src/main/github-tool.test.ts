import { describe, expect, test } from "bun:test";
import { diffForFile, logTail, scopedQuery } from "./github-tool";

const DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 1..2 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1 +1 @@",
	"-old",
	"+new",
	"diff --git a/docs/b.md b/docs/b.md",
	"--- a/docs/b.md",
	"+++ b/docs/b.md",
	"@@ -1 +1 @@",
	"-x",
	"+y",
	"",
].join("\n");

describe("github tool helpers", () => {
	test("picks one file's section out of a PR diff", () => {
		expect(diffForFile(DIFF, "docs/b.md")).toStartWith("diff --git a/docs/b.md b/docs/b.md");
		expect(diffForFile(DIFF, "src/a.ts")).not.toContain("docs/b.md");
		expect(diffForFile(DIFF, "missing.ts")).toBeNull();
	});

	test("keeps the tail of a job log without GitHub's timestamps", () => {
		const log = Array.from({ length: 5 }, (_, i) => `2026-09-27T10:00:0${i}.1234567Z line ${i}`).join("\r\n") + "\r\n\r\n";
		expect(logTail(log, 2)).toBe("…(3 earlier lines)\nline 3\nline 4");
	});

	test("scopes a search to the repository unless the query names a scope", () => {
		const id = { owner: "o", repo: "r", host: "github.com" };
		expect(scopedQuery("crash on start", "issues", id)).toBe("crash on start is:issue repo:o/r");
		expect(scopedQuery("fix is:pr", "prs", id)).toBe("fix is:pr repo:o/r");
		expect(scopedQuery("parser org:acme", "code", id)).toBe("parser org:acme");
		expect(scopedQuery("electron", "repos", id)).toBe("electron");
	});
});
