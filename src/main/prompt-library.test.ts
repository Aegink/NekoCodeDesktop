import { describe, expect, test } from "bun:test";
import { AGENT_PHASES, WORK_MODES } from "../shared/workflow";
import { buildModePrompt, FAST_CONTEXT_PROMPT, toolsForMode, type PromptContext } from "./prompt-library";

const base = { permission: "auto", interactive: true } as const;

describe("code_search availability", () => {
	test("every interactive mode and agent phase offers it", () => {
		for (const mode of WORK_MODES) {
			const context: PromptContext = { ...base, mode };
			expect(toolsForMode(context), mode).toContain("code_search");
		}
		for (const phase of AGENT_PHASES) {
			const context: PromptContext = { ...base, mode: "agent", phase };
			expect(toolsForMode(context), phase).toContain("code_search");
		}
	});

	test("child and helper sessions cannot reach it", () => {
		const child: PromptContext = { ...base, mode: "agent", child: true };
		expect(toolsForMode(child)).not.toContain("code_search");
		const subagent: PromptContext = { ...base, mode: "subagent" };
		expect(toolsForMode(subagent)).not.toContain("code_search");
	});

	test("it survives read-only permission", () => {
		const context: PromptContext = { mode: "agent", permission: "read-only", interactive: true };
		expect(toolsForMode(context)).toContain("code_search");
	});
});

describe("fast context prompts", () => {
	test("the explorer helper gets the explorer discipline", () => {
		const prompt = buildModePrompt({
			mode: "subagent", permission: "read-only", child: true, fastContext: true,
		});
		expect(prompt).toContain(FAST_CONTEXT_PROMPT);
	});

	test("parents are told when to prefer code_search", () => {
		const prompt = buildModePrompt({ mode: "agent", permission: "auto", interactive: true });
		expect(prompt).toContain("code_search");
	});
});

describe("browser_screenshot policy", () => {
	test("a writable parent with the tool is told the image comes back attached", () => {
		const prompt = buildModePrompt({
			mode: "agent",
			permission: "auto",
			interactive: true,
			pluginTools: ["browser_screenshot"],
		});
		expect(prompt).toContain("browser_screenshot 既保存 PNG");
	});

	test("the policy is absent without the tool", () => {
		const prompt = buildModePrompt({ mode: "agent", permission: "auto", interactive: true });
		expect(prompt).not.toContain("browser_screenshot 既保存 PNG");
	});
});

describe("web tool availability", () => {
	test("every mode and agent phase offers them when switched on, read-only ones included", () => {
		for (const mode of WORK_MODES) {
			const tools = toolsForMode({ ...base, mode, permission: "read-only", webTools: true });
			expect(tools, mode).toContain("web_search");
			expect(tools, mode).toContain("web_fetch");
		}
		for (const phase of AGENT_PHASES) {
			expect(toolsForMode({ ...base, mode: "agent", phase, webTools: true }), phase).toContain("web_fetch");
		}
	});

	test("they are gone when switched off, or when nobody said", () => {
		expect(toolsForMode({ ...base, mode: "agent", webTools: false })).not.toContain("web_search");
		expect(toolsForMode({ ...base, mode: "agent" })).not.toContain("web_fetch");
	});

	test("the prompt warns that web content is data, only when they are present", () => {
		expect(buildModePrompt({ ...base, mode: "agent", webTools: true })).toContain("web_search / web_fetch 访问公网");
		expect(buildModePrompt({ ...base, mode: "agent" })).not.toContain("web_search / web_fetch 访问公网");
	});
});

describe("structural and GitHub tool guidance", () => {
	const guidance = {
		ast_grep: "ast_grep 按语法结构找代码",
		ast_edit: "ast_edit 是跨文件的结构化改写",
		github: "github 工具直接读取 GitHub",
	};

	test("a phase that can write gets all three", () => {
		const prompt = buildModePrompt({ ...base, mode: "agent", phase: "execute" });
		for (const line of Object.values(guidance)) expect(prompt).toContain(line);
	});

	test("a read-only mode gets search and GitHub guidance but no rewrite guidance", () => {
		const prompt = buildModePrompt({ ...base, mode: "ask" });
		expect(prompt).toContain(guidance.ast_grep);
		expect(prompt).toContain(guidance.github);
		expect(prompt).not.toContain(guidance.ast_edit);
	});

	test("a tool the session cannot call is never described", () => {
		// Fast Context explorers are limited to local read tools.
		const prompt = buildModePrompt({ ...base, mode: "subagent", child: true, fastContext: true, permission: "read-only" });
		const tools = toolsForMode({ ...base, mode: "subagent", child: true, fastContext: true, permission: "read-only" });
		for (const [name, line] of Object.entries(guidance)) expect(prompt.includes(line)).toBe(tools.includes(name));
		expect(tools).not.toContain("github");
		expect(prompt).toContain(guidance.ast_grep);
	});
});
