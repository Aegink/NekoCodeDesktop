import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchPattern } from "../shared/ide";
import {
	createEntry,
	deletableTarget,
	globToRegExp,
	readTextFile,
	renameEntry,
	searchProject,
	searchText,
	statFiles,
	writeTextFile,
} from "./workspace-files";

const root = mkdtempSync(join(tmpdir(), "nekocode-ide-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readTextFile and writeTextFile", () => {
	test("round-trips text, keeping a byte-order mark the file had", async () => {
		writeFileSync(join(root, "bom.txt"), "﻿hello\r\nworld");
		const read = await readTextFile(root, "bom.txt");
		expect(read).toMatchObject({ kind: "text", text: "hello\r\nworld", bom: true, relPath: "bom.txt" });
		if (read.kind !== "text") throw new Error("expected text");
		const written = await writeTextFile({ cwd: root, relPath: "bom.txt", text: "changed", bom: true, expectedMtimeMs: read.mtimeMs });
		expect(written.ok).toBe(true);
		expect(readFileSync(join(root, "bom.txt"), "utf8")).toBe("﻿changed");
	});

	test("refuses to write over a file that changed on disk since it was read", async () => {
		writeFileSync(join(root, "race.ts"), "one");
		const read = await readTextFile(root, "race.ts");
		if (read.kind !== "text") throw new Error("expected text");
		// The agent writes the file after the editor read it.
		writeFileSync(join(root, "race.ts"), "agent");
		utimesSync(join(root, "race.ts"), new Date(), new Date(read.mtimeMs + 5000));
		const refused = await writeTextFile({ cwd: root, relPath: "race.ts", text: "mine", expectedMtimeMs: read.mtimeMs });
		expect(refused.ok).toBe(false);
		expect(readFileSync(join(root, "race.ts"), "utf8")).toBe("agent");
		const forced = await writeTextFile({ cwd: root, relPath: "race.ts", text: "mine", expectedMtimeMs: read.mtimeMs, force: true });
		expect(forced.ok).toBe(true);
		expect(readFileSync(join(root, "race.ts"), "utf8")).toBe("mine");
	});

	test("reports binaries instead of decoding them", async () => {
		writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
		expect((await readTextFile(root, "blob.bin")).kind).toBe("binary");
	});

	test("refuses paths outside the project", async () => {
		await expect(readTextFile(root, "../outside.txt")).rejects.toThrow(/escapes project root/);
		await expect(writeTextFile({ cwd: root, relPath: "../x.txt", text: "" })).rejects.toThrow(/escapes project root/);
		expect(() => deletableTarget(root, ".")).toThrow();
	});
});

describe("createEntry and renameEntry", () => {
	test("creates nested files and folders, and refuses to clobber", async () => {
		expect(await createEntry({ cwd: root, relPath: "src/deep/new.ts", kind: "file" })).toBe("src/deep/new.ts");
		expect(readFileSync(join(root, "src", "deep", "new.ts"), "utf8")).toBe("");
		await expect(createEntry({ cwd: root, relPath: "src/deep/new.ts", kind: "file" })).rejects.toThrow(/Already exists/);
		expect(await createEntry({ cwd: root, relPath: "assets", kind: "dir" })).toBe("assets");
	});

	test("renames, refusing to land on an existing file", async () => {
		writeFileSync(join(root, "src", "other.ts"), "x");
		await expect(renameEntry({ cwd: root, from: "src/deep/new.ts", to: "src/other.ts" })).rejects.toThrow(/Already exists/);
		expect(await renameEntry({ cwd: root, from: "src/deep/new.ts", to: "src/renamed.ts" })).toBe("src/renamed.ts");
		const [gone, moved] = await statFiles(root, ["src/deep/new.ts", "src/renamed.ts"]);
		expect(gone?.mtimeMs).toBeNull();
		expect(moved?.mtimeMs).toBeNumber();
	});
});

describe("globToRegExp", () => {
	test("treats slashless patterns as any-depth and slashed ones as anchored", () => {
		expect(globToRegExp("*.ts")!.test("a/b/c.ts")).toBe(true);
		expect(globToRegExp("*.ts")!.test("a/b/c.tsx")).toBe(false);
		expect(globToRegExp("src/**")!.test("src/a/b.ts")).toBe(true);
		expect(globToRegExp("src/**")!.test("lib/src/b.ts")).toBe(false);
		expect(globToRegExp("src/**/*.test.ts")!.test("src/x.test.ts")).toBe(true);
		expect(globToRegExp("node_modules")!.test("pkg/node_modules/x/index.js")).toBe(true);
		expect(globToRegExp("  ")).toBeNull();
	});
});

describe("search", () => {
	test("finds matches with 1-based positions and a preview window", () => {
		const matches = searchText("const a = 1;\n  let b = a + a;\n", searchPattern({ query: "a" , wholeWord: true }), 100);
		expect(matches.map((match) => [match.line, match.column])).toEqual([
			[1, 7],
			[2, 11],
			[2, 15],
		]);
		const second = matches[1]!;
		expect(second.preview.slice(second.previewColumn, second.previewColumn + second.length)).toBe("a");
		// Leading indentation is trimmed from the preview.
		expect(second.preview.startsWith("let")).toBe(true);
	});

	test("honours case, regex and the include/exclude globs across files", async () => {
		mkdirSync(join(root, "lib"), { recursive: true });
		writeFileSync(join(root, "lib", "one.ts"), "Foo foo FOO\n");
		writeFileSync(join(root, "lib", "two.md"), "foo\n");
		writeFileSync(join(root, "lib", "skip.ts"), "foo\n");
		const files = ["lib/one.ts", "lib/two.md", "lib/skip.ts"];
		const insensitive = await searchProject(files, { cwd: root, query: "foo", include: "*.ts", exclude: "skip.ts" });
		expect(insensitive.files.map((file) => file.relPath)).toEqual(["lib/one.ts"]);
		expect(insensitive.matchCount).toBe(3);
		const sensitive = await searchProject(files, { cwd: root, query: "foo", caseSensitive: true });
		expect(sensitive.matchCount).toBe(3);
		const regex = await searchProject(files, { cwd: root, query: "F[oO]+", regex: true, caseSensitive: true });
		expect(regex.matchCount).toBe(2);
		await expect(searchProject(files, { cwd: root, query: "(", regex: true })).rejects.toThrow();
	});
});
