import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ConflictHistory,
	parseBulkDirectives,
	readConflictUri,
	registerFileConflicts,
	scanConflictLines,
	writeConflictUri,
} from "../../src/main/conflicts";

const TWO_CONFLICTS = [
	"function a() {",
	"<<<<<<< HEAD",
	"  return 1;",
	"=======",
	"  return 2;",
	">>>>>>> feature",
	"}",
	"",
	"const b = [",
	"<<<<<<< HEAD",
	"  'x',",
	"||||||| base",
	"=======",
	"  'y',",
	">>>>>>> feature",
	"];",
	"",
].join("\n");

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "neko-conflict-"));
	file = join(dir, "code.ts");
	writeFileSync(file, TWO_CONFLICTS);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("detection", () => {
	test("finds complete blocks with labels and a diff3 base, and ignores look-alikes", () => {
		const blocks = scanConflictLines(TWO_CONFLICTS.split("\n"));
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toMatchObject({ startLine: 2, endLine: 6, oursLabel: "HEAD", theirsLabel: "feature", oursLines: ["  return 1;"] });
		expect(blocks[1].baseLines).toEqual([]);
		expect(scanConflictLines(["<<<<<<<< not a marker", "=======", ">>>>>>> x"])).toHaveLength(0);
		expect(scanConflictLines(["<<<<<<< HEAD", "a", "======="])).toHaveLength(0);
	});

	test("a read registers the blocks and returns a footer naming them", async () => {
		const history = new ConflictHistory();
		const footer = await registerFileConflicts(history, file, dir);
		expect(footer).toContain("2 unresolved merge conflicts");
		expect(footer).toContain("#1  L2-6");
		expect(footer).toContain("- ours = HEAD");
		// Reading again keeps the ids rather than minting new ones.
		await registerFileConflicts(history, file, dir);
		expect(history.entries().map((entry) => entry.id)).toEqual([1, 2]);
		expect(readConflictUri(history, "conflict://1/theirs")).toContain("  return 2;");
	});
});

describe("resolution", () => {
	test("writing a side replaces only the block, and the other id stays usable", async () => {
		const history = new ConflictHistory();
		await registerFileConflicts(history, file, dir);
		const reported: string[] = [];
		const result = await writeConflictUri(history, "conflict://1", "@theirs", {
			onBeforeWrite: (path, before) => {
				reported.push(path);
				expect(before.toString()).toBe(TWO_CONFLICTS);
			},
		});
		expect(result).toContain("Resolved conflict #1");
		expect(result).toContain("Still unresolved in this file: #2");
		expect(reported).toEqual([file]);
		expect(readFileSync(file, "utf8")).toContain("function a() {\n  return 2;\n}");

		await writeConflictUri(history, "conflict://2", "@both");
		expect(readFileSync(file, "utf8")).toBe("function a() {\n  return 2;\n}\n\nconst b = [\n  'x',\n  'y',\n];\n");
		expect(history.entries()).toEqual([]);
	});

	test("context the model pasted around its resolution is not duplicated", async () => {
		const history = new ConflictHistory();
		await registerFileConflicts(history, file, dir);
		const result = await writeConflictUri(history, "conflict://1", "function a() {\n  return 3;\n}");
		expect(result).toContain("dropped 2 line(s)");
		expect(readFileSync(file, "utf8")).toStartWith("function a() {\n  return 3;\n}\n\nconst b");
	});

	test("conflict://* takes per-id sides in one call, and refuses a half-directive block", async () => {
		expect(() => parseBulkDirectives("1: @ours\nsome code")).toThrow(/Malformed/);
		const history = new ConflictHistory();
		await registerFileConflicts(history, file, dir);
		await writeConflictUri(history, "conflict://*", "1: @ours\n2: @theirs");
		expect(readFileSync(file, "utf8")).toBe("function a() {\n  return 1;\n}\n\nconst b = [\n  'y',\n];\n");
	});

	test("a CRLF file stays CRLF", async () => {
		writeFileSync(file, TWO_CONFLICTS.replace(/\n/g, "\r\n"));
		const history = new ConflictHistory();
		await registerFileConflicts(history, file, dir);
		await writeConflictUri(history, "conflict://*", "@ours");
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain("<<<<<<<");
		expect(text.split("\n").slice(0, -1).every((line) => line.endsWith("\r"))).toBe(true);
	});

	test("a file changed behind the register's back is refused, and a write check runs first", async () => {
		const history = new ConflictHistory();
		await registerFileConflicts(history, file, dir);
		expect(writeConflictUri(history, "conflict://1", "@ours", { assertWritable: () => { throw new Error("owned by a worker"); } })).rejects.toThrow(
			/owned by a worker/,
		);
		writeFileSync(file, "nothing to see");
		await expect(writeConflictUri(history, "conflict://1", "@ours")).rejects.toThrow(/no longer in/);
		await expect(writeConflictUri(history, "conflict://1/ours", "x")).rejects.toThrow(/read-only/);
	});
});
