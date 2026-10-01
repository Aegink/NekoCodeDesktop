import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAstEditTool, createAstGrepTool, inferLanguage } from "../../src/main/ast-tools";
import { takeReportedPreimages } from "../../src/main/file-journal";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function workspace(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-ast-"));
	dirs.push(dir);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

async function run(tool: ReturnType<typeof createAstGrepTool>, params: Record<string, unknown>, id = "call-1") {
	const result = await tool.execute(id, params as never, undefined, undefined, undefined as never);
	return { text: (result.content[0] as { text: string }).text, details: result.details as Record<string, unknown> };
}

describe("ast_grep", () => {
	test("finds calls by shape across a directory, honouring .gitignore", async () => {
		const cwd = workspace({
			".gitignore": "dist/\n",
			"src/a.ts": 'const 名 = "x";\nconsole.log(名,\n  1);\nfoo(console.log(2));\n',
			"src/b.ts": "console.warn(3);\n",
			"dist/c.ts": "console.log(4);\n",
		});
		// The walk reads .gitignore only inside a repository, as git itself does.
		execFileSync("git", ["init", "-q"], { cwd });
		const { text, details } = await run(createAstGrepTool(cwd), { pattern: "console.log($$$ARGS)", lang: "typescript" });
		expect(details).toEqual({ lang: "typescript", total: 2, files: 1 });
		expect(text).toContain("src/a.ts");
		expect(text).toContain("2:1  console.log(名, …(+1 lines)");
		expect(text).not.toContain("dist/");
	});

	test("infers the language of a single file and parses a dynamic grammar", async () => {
		const cwd = workspace({ "app.py": "def f(x):\n    print(x, 1)\n    print(x)\n" });
		const { details } = await run(createAstGrepTool(cwd), { pattern: "print($A, $B)", path: "app.py" });
		expect(details).toEqual({ lang: "python", total: 1, files: 1 });
		expect(inferLanguage("x.tsx")).toBe("tsx");
	});

	test("asks for a language it cannot infer, and refuses paths outside the workspace", async () => {
		const cwd = workspace({ "a.ts": "" });
		await expect(run(createAstGrepTool(cwd), { pattern: "x" })).rejects.toThrow("Set lang");
		await expect(run(createAstGrepTool(cwd), { pattern: "x", lang: "typescript", path: ".." })).rejects.toThrow("outside the workspace");
	});
});

describe("ast_edit", () => {
	const files = {
		"src/a.ts": "oldApi(1, 2);\nconst y = oldApi(a, oldApi(b, c));\n",
		"src/b.ts": "call(x,\n     y, z);\n",
	};

	test("a dry run reports the rewrite and writes nothing", async () => {
		const cwd = workspace(files);
		const { text, details } = await run(createAstEditTool(cwd), {
			pattern: "oldApi($A, $B)",
			rewrite: "newApi({ a: $A, b: $B })",
			lang: "typescript",
			dryRun: true,
		});
		expect(details).toMatchObject({ files: 1, replacements: 2, dryRun: true });
		expect(text).toContain("Would rewrite 2 matches in 1 file");
		expect(readFileSync(join(cwd, "src/a.ts"), "utf8")).toBe(files["src/a.ts"]);
	});

	test("rewrites outermost matches, keeps $$$ separators, and reports pre-images for undo", async () => {
		const cwd = workspace(files);
		const edit = createAstEditTool(cwd);
		await run(edit, { pattern: "oldApi($A, $B)", rewrite: "newApi($B, $A)", lang: "typescript" }, "call-a");
		expect(readFileSync(join(cwd, "src/a.ts"), "utf8")).toBe("newApi(2, 1);\nconst y = newApi(oldApi(b, c), a);\n");
		await run(edit, { pattern: "call($$$ARGS)", rewrite: "invoke($$$ARGS)", path: "src/b.ts" }, "call-b");
		expect(readFileSync(join(cwd, "src/b.ts"), "utf8")).toBe("invoke(x,\n     y, z);\n");
		const reported = takeReportedPreimages("call-a");
		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatchObject({ tool: "ast_edit", path: join(cwd, "src", "a.ts") });
		expect(reported[0].before?.toString()).toBe(files["src/a.ts"]);
	});

	test("a refused file stops the whole codemod before anything is written", async () => {
		const cwd = workspace({ "a.ts": "oldApi(1, 2);\n", "b.ts": "oldApi(3, 4);\n" });
		const edit = createAstEditTool(cwd, {
			assertWritable: (path) => {
				if (path.endsWith("b.ts")) throw new Error("A worker owns this write scope");
			},
		});
		await expect(run(edit, { pattern: "oldApi($A, $B)", rewrite: "x", lang: "typescript" }, "call-c")).rejects.toThrow("A worker owns");
		expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("oldApi(1, 2);\n");
		expect(takeReportedPreimages("call-c")).toEqual([]);
	});

	test("an empty rewrite deletes the match", async () => {
		const cwd = workspace({ "a.js": "debugger;\nrun();\n" });
		await run(createAstEditTool(cwd), { pattern: "debugger", rewrite: "", path: "a.js" }, "call-d");
		expect(readFileSync(join(cwd, "a.js"), "utf8")).toBe(";\nrun();\n");
	});
});

describe("why nothing matched", () => {
	test("patterns that parse are not blamed, including $$$ where the grammar wants a list", async () => {
		const { patternProblem } = await import("../../src/main/ast-tools");
		for (const [lang, pattern] of [
			["typescript", "function $F($$$A): $R { $$$B }"],
			["python", "def $F($$$ARGS): $$$BODY"],
			["java", "public class $C extends $B { $$$ }"],
			["c", "int $F($$$A) { $$$B }"],
			["rust", "impl $T for $S { $$$ }"],
		] as const)
			expect(await patternProblem(lang, pattern), `${lang} ${pattern}`).toBeNull();
		expect(await patternProblem("typescript", "foo(")).toBe("syntax error near `foo(`");
		expect(await patternProblem("typescript", "function $F() {")).toContain("missing `}`");
	});

	test("says so when the pattern does not parse", async () => {
		const cwd = workspace({ "a.ts": "foo(1);\n" });
		const { text } = await run(createAstGrepTool(cwd), { pattern: "foo(", path: "a.ts" });
		expect(text).toContain("The pattern does not parse as typescript: syntax error near `foo(`");
	});

	test("names the language the files actually are", async () => {
		const cwd = workspace({ "ui/a.tsx": "useEffect(f, []);\n", "ui/b.tsx": "x;\n", "pi.ts": "foo();\n" });
		execFileSync("git", ["init", "-q"], { cwd });
		const dir = await run(createAstGrepTool(cwd), { pattern: "useEffect($F, [])", lang: "typescript", path: "ui" });
		expect(dir.text).toContain("ui has no typescript files; it has 2 tsx");
		const file = await run(createAstGrepTool(cwd), { pattern: "print($A)", lang: "python", path: "pi.ts" });
		expect(file.text).toContain("pi.ts is a typescript file but was parsed as python; search it with lang: typescript");
	});

	test("otherwise points at the shape of the code, modifiers included", async () => {
		const cwd = workspace({ "Main.java": "public class Main extends Base {}\n" });
		const edit = await run(createAstGrepTool(cwd), { pattern: "class $C extends $B { $$$ }", path: "Main.java" });
		expect(edit.text).toContain("The pattern parses as java");
		expect(edit.text).toContain("modifiers");
		const fixed = await run(createAstGrepTool(cwd), { pattern: "public class $C extends $B { $$$ }", path: "Main.java" });
		expect(fixed.details).toMatchObject({ total: 1 });
	});
});

describe("ast_grep output", () => {
	test("counts matches per file and lists what the limit left out", async () => {
		const cwd = workspace({ "a.ts": "f(1);\nf(2);\nf(3);\n", "b.ts": "f(4);\n", "c.ts": "f(5);\nf(6);\n" });
		const { text } = await run(createAstGrepTool(cwd), { pattern: "f($A)", lang: "typescript", limit: 2 });
		expect(text).toStartWith("6 matches in 3 files (showing 2; raise limit or narrow path for the rest):");
		expect(text).toContain("a.ts (3)\n  1:1  f(1)\n  2:1  f(2)");
		expect(text).toContain("Not shown: a.ts (1 more), b.ts (1), c.ts (2)");
	});
});
