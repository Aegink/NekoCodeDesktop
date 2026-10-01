import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverForeignRules, foreignRuleContextFiles, isForeignRulePath, parseFrontmatter } from "../../src/main/foreign-rules";

let root: string;

function put(path: string, content: string): void {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neko-rules-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("frontmatter", () => {
	test("reads the flat YAML rule headers use", () => {
		const { data, body } = parseFrontmatter(
			'---\ndescription: "API conventions"\nglobs: src/api/**/*.ts, src/routes/*.ts\nalwaysApply: false\npaths:\n  - "a/**"\n  - b/*\n---\n\n# Body\n',
		);
		expect(data).toEqual({ description: "API conventions", globs: "src/api/**/*.ts, src/routes/*.ts", alwaysApply: false, paths: ["a/**", "b/*"] });
		expect(body).toBe("# Body");
		expect(parseFrontmatter("no header").body).toBe("no header");
	});
});

describe("discovery", () => {
	test("each tool's rules are read with that tool's semantics", () => {
		put(".cursor/rules/always.mdc", "---\nalwaysApply: true\n---\nUse tabs.");
		put(".cursor/rules/api.mdc", "---\ndescription: API rules\nglobs: src/api/**\n---\nReturn JSON.");
		put(".cursor/rules/manual.mdc", "---\nalwaysApply: false\n---\nOnly when mentioned.");
		put(".windsurf/rules/tests.md", "---\ntrigger: glob\nglobs: '**/*.test.ts'\n---\nUse bun test.");
		put(".windsurf/rules/hidden.md", "---\ntrigger: manual\n---\nNever automatic.");
		put(".clinerules", "Keep commits small.");
		put(".github/copilot-instructions.md", "Prefer composition.");
		put(".github/instructions/css.instructions.md", "---\napplyTo: '**/*.css'\n---\nUse CSS variables.");
		put(".github/instructions/all.instructions.md", "---\napplyTo: '**'\n---\nWrite in English.");
		put("GEMINI.md", "Gemini notes.");

		const rules = discoverForeignRules(root, root);
		const byName = Object.fromEntries(rules.map((rule) => [rule.name, rule]));
		expect(byName.always.alwaysApply).toBe(true);
		expect(byName.api).toMatchObject({ alwaysApply: false, globs: ["src/api/**"], description: "API rules" });
		expect(byName.tests).toMatchObject({ alwaysApply: false, globs: ["**/*.test.ts"] });
		expect(byName.hidden).toBeUndefined();
		expect(byName.clinerules.alwaysApply).toBe(true);
		expect(byName["copilot-instructions"].alwaysApply).toBe(true);
		expect(byName.css).toMatchObject({ alwaysApply: false, globs: ["**/*.css"] });
		expect(byName.all.alwaysApply).toBe(true);
		expect(byName.GEMINI.content).toBe("Gemini notes.");

		const files = foreignRuleContextFiles(rules, root);
		const index = files.find((file) => file.path.endsWith("rule-index"));
		expect(index?.content).toContain('Cursor rule "api" (src/api/**): API rules — .cursor/rules/api.mdc');
		expect(index?.content).toContain('Copilot rule "css" (**/*.css)');
		// A rule that applies nowhere automatically and says nothing about when is left out.
		expect(files.some((file) => file.content.includes("Only when mentioned"))).toBe(false);
		expect(files.find((file) => file.path.endsWith("always.mdc"))?.content).toBe("Use tabs.");
	});

	test("a CLAUDE.md beside AGENTS.md is read unless it is a copy", () => {
		put("AGENTS.md", "Shared rules.");
		put("CLAUDE.md", "Shared rules.\n");
		expect(discoverForeignRules(root, root).map((rule) => rule.name)).not.toContain("CLAUDE");
		put("CLAUDE.md", "Claude-only rules.");
		expect(discoverForeignRules(root, root).map((rule) => rule.name)).toContain("CLAUDE");
	});

	test("always-apply rules past the budget drop to the index instead of bloating the prompt", () => {
		for (let i = 0; i < 5; i++) put(`.cursor/rules/big${i}.mdc`, "x".repeat(30 * 1024));
		const files = foreignRuleContextFiles(discoverForeignRules(root, root), root);
		expect(files.filter((file) => !file.path.endsWith("rule-index"))).toHaveLength(3);
		expect(files.find((file) => file.path.endsWith("rule-index"))?.content).toContain("left out of the prompt for length");
	});

	test("editing a rule file is noticed, so the prompt is rebuilt", () => {
		expect(isForeignRulePath("C:\\p\\.cursor\\rules\\api.mdc")).toBe(true);
		expect(isForeignRulePath("/p/.github/instructions/css.instructions.md")).toBe(true);
		expect(isForeignRulePath(".windsurfrules")).toBe(true);
		expect(isForeignRulePath("src/rules/index.ts")).toBe(false);
	});
});
