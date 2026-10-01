import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictHistory } from "../../src/main/conflicts";
import { parseLineSelector, createReadTool } from "../../src/main/read-tool";
import { createWriteTool } from "../../src/main/write-tool";

/**
 * The read and write tools end to end, over pi's real implementations: the
 * wrappers must leave plain reads alone and add only what they claim to.
 */

let dir: string;
let pi: typeof import("@earendil-works/pi-coding-agent");

beforeAll(async () => {
	pi = await import("@earendil-works/pi-coding-agent");
	dir = mkdtempSync(join(tmpdir(), "neko-readtool-"));
	writeFileSync(join(dir, "lines.txt"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
	writeFileSync(join(dir, "merge.ts"), "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nb\n");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function read(tool: ReturnType<typeof createReadTool>, params: Record<string, unknown>): Promise<string> {
	const result = await tool.execute("call", params as never, undefined, undefined, { cwd: dir } as never);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("line selectors", () => {
	test("parse the forms the description advertises", () => {
		expect(parseLineSelector("a.ts:10")).toEqual({ path: "a.ts", selector: { kind: "ranges", ranges: [{ start: 10 }] } });
		expect(parseLineSelector("a.ts:10-20,40+5")).toEqual({
			path: "a.ts",
			selector: { kind: "ranges", ranges: [{ start: 10, end: 20 }, { start: 40, end: 45 }] },
		});
		expect(parseLineSelector("C:\\p\\a.ts:-5")).toEqual({ path: "C:\\p\\a.ts", selector: { kind: "tail", count: 5 } });
		expect(parseLineSelector("a.ts:conflicts")?.selector).toEqual({ kind: "conflicts" });
		expect(parseLineSelector("a.ts")).toBeNull();
	});

	test("a range, several ranges and the tail read what they say", async () => {
		const tool = createReadTool(pi, dir, new ConflictHistory());
		expect(await read(tool, { path: "lines.txt:3-4" })).toStartWith("line 3\nline 4");
		const several = await read(tool, { path: "lines.txt:1-2,29-30" });
		expect(several).toContain("── lines 1-2 of 30 ──\nline 1\nline 2");
		expect(several).toContain("── lines 29-30 of 30 ──\nline 29\nline 30");
		expect(await read(tool, { path: "lines.txt:-2" })).toContain("line 29\nline 30");
	});
});

describe("conflicts through the tools", () => {
	test("read reports the block, write resolves it by id, and the file comes out clean", async () => {
		const conflicts = new ConflictHistory();
		const reader = createReadTool(pi, dir, conflicts);
		const writer = createWriteTool(pi, dir, conflicts);
		const shown = await read(reader, { path: "merge.ts" });
		expect(shown).toContain("⚠ 1 unresolved merge conflict detected");
		expect(await read(reader, { path: "merge.ts:conflicts" })).toContain("#1  L2-6");
		await writer.execute("call", { path: "conflict://1", content: "@theirs" } as never, undefined, undefined, { cwd: dir } as never);
		expect(readFileSync(join(dir, "merge.ts"), "utf8")).toBe("a\ntheirs\nb\n");
	});

	test("an ordinary write still goes to pi", async () => {
		const writer = createWriteTool(pi, dir, new ConflictHistory());
		await writer.execute("call", { path: "fresh.txt", content: "hello" } as never, undefined, undefined, { cwd: dir } as never);
		expect(readFileSync(join(dir, "fresh.txt"), "utf8")).toBe("hello");
	});
});
