import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openShellChanges, parsePatch, pathKey, WorkspaceSnapshots } from "../../../src/main/acp/workspace-changes";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "nk-shell-"));
	roots.push(root);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
	git("init", "-q");
	writeFileSync(join(root, "app.py"), "def greet(name):\n    return name\n\n\nprint(greet('x'))\n");
	writeFileSync(join(root, "old.txt"), "gone soon\n");
	writeFileSync(join(root, ".gitignore"), "build/\n");
	git("add", ".");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	return root;
}

describe("parsePatch", () => {
	test("reads a git patch file by file, in the edit card's line format", () => {
		const patch = [
			"diff --git a/src/a.ts b/src/a.ts",
			"index 1..2 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,3 +1,3 @@",
			" one",
			"-two",
			"+TWO",
			" three",
			"@@ -10,1 +10,2 @@",
			" ten",
			"+eleven",
			"\\ No newline at end of file",
			"diff --git a/新.txt b/新.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/新.txt",
			"@@ -0,0 +1,2 @@",
			"+hello\r",
			"+world",
			"diff --git a/img.png b/img.png",
			"Binary files a/img.png and b/img.png differ",
			"",
		].join("\n");
		const changes = parsePatch(patch, "/p");
		expect(changes).toEqual([
			{ path: resolve("/p", "src/a.ts"), kind: "update", diff: " 1 one\n-2 two\n+2 TWO\n 3 three\n ...\n 10 ten\n+11 eleven" },
			{ path: resolve("/p", "新.txt"), kind: "add", diff: "+1 hello\n+2 world", content: "hello\nworld" },
		]);
	});
});

describe("WorkspaceSnapshots", () => {
	test("sees what a command changed, without touching the user's index", async () => {
		const root = repo();
		const indexBefore = readFileSync(join(root, ".git", "index"));
		const snapshots = (await WorkspaceSnapshots.open(root))!;
		expect(snapshots).not.toBeNull();
		const before = await snapshots.snapshot();
		writeFileSync(join(root, "app.py"), "def say_hello(name):\n    return name\n\n\nprint(say_hello('x'))\n");
		writeFileSync(join(root, "new.txt"), "from shell\n");
		rmSync(join(root, "old.txt"));
		mkdirSync(join(root, "build"));
		writeFileSync(join(root, "build", "out.js"), "ignored\n");
		const after = await snapshots.snapshot();
		const changes = await snapshots.changes(before, after);
		expect(changes.map((change) => [change.path, change.kind])).toEqual([
			[join(root, "app.py"), "update"],
			[join(root, "new.txt"), "add"],
			[join(root, "old.txt"), "delete"],
		]);
		expect(changes[0].diff).toContain("-1 def greet(name):");
		expect(changes[0].diff).toContain("+1 def say_hello(name):");
		expect(changes[1].content).toBe("from shell");
		expect(changes[2].diff).toBe("-1 gone soon");
		expect(readFileSync(join(root, ".git", "index"))).toEqual(indexBefore);
		snapshots.dispose();
	});

	test("is not offered outside a git work tree", async () => {
		const plain = mkdtempSync(join(tmpdir(), "nk-plain-"));
		roots.push(plain);
		expect(await WorkspaceSnapshots.open(plain)).toBeNull();
	});
});

describe("ShellChangeTracker", () => {
	test("each command gets what changed since the last, minus files its edit tools showed", async () => {
		const root = repo();
		const tracker = (await openShellChanges(root))!;
		// Outside a turn, nothing is attributed.
		writeFileSync(join(root, "before.txt"), "user's own\n");
		expect(await tracker.settle()).toEqual([]);

		await tracker.begin();
		// The agent's edit tool changed app.py and said so; a command wrote new.txt.
		tracker.noteEdit("edit-1", [join(root, "app.py")], true);
		writeFileSync(join(root, "app.py"), "patched\n");
		writeFileSync(join(root, "new.txt"), "one\n");
		const first = await tracker.settle();
		expect(first.map((change) => change.path)).toEqual([join(root, "new.txt")]);

		// The next command only owns what happened after the first.
		writeFileSync(join(root, "new.txt"), "one\ntwo\n");
		writeFileSync(join(root, "app.py"), "patched\nby formatter\n");
		const second = await tracker.settle();
		expect(second.map((change) => [change.path, change.diff])).toEqual([
			[join(root, "app.py"), " 1 patched\n+2 by formatter"],
			[join(root, "new.txt"), " 1 one\n+2 two"],
		]);
		expect(await tracker.settle()).toEqual([]);

		await tracker.end();
		writeFileSync(join(root, "later.txt"), "x\n");
		expect(await tracker.settle()).toEqual([]);
		tracker.dispose();
	});

	test("compares paths the way the file system does", () => {
		expect(pathKey("C:\\Repo\\A.ts", "win32")).toBe(pathKey("c:/repo/a.ts", "win32"));
	});
});
