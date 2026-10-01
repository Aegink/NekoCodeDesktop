import { describe, expect, test } from "bun:test";
import { type ModelCallRuntime } from "../../src/main/model-call";
import { buildPrompt, cleanCompletion, contextQuery, TabCompletionService } from "../../src/main/tab-completion";

const request = {
	id: "r1",
	cwd: "/p",
	relPath: "src/math.ts",
	languageId: "typescript",
	prefix: "export function add(a: number, b: number) {\n\treturn ",
	suffix: "\n}\n",
};

describe("cleanCompletion", () => {
	test("keeps a plain answer as it is", () => {
		expect(cleanCompletion("a + b;", request.prefix, request.suffix)).toBe("a + b;");
	});

	test("unwraps a fence and drops an echo of the line", () => {
		expect(cleanCompletion("```ts\nreturn a + b;\n```", request.prefix, request.suffix)).toBe("a + b;");
		expect(cleanCompletion("\treturn a + b;", request.prefix, request.suffix)).toBe("a + b;");
	});

	test("stops where the model starts repeating the code after the cursor", () => {
		const prefix = "function f() {\n";
		const suffix = "\n\tcleanup();\n}\n";
		expect(cleanCompletion("\tsetup();\n\twork();\n\tcleanup();\n}", prefix, suffix)).toBe("\tsetup();\n\twork();");
	});

	test("in the middle of a line, offers only the rest of that line", () => {
		const prefix = "const total = sum(";
		const suffix = ");\nconsole.log(total);";
		expect(cleanCompletion("items, 0);\nconsole.log(total);", prefix, suffix)).toBe("items, 0");
		expect(cleanCompletion("items)", prefix, suffix)).toBe("items");
		// Its own brackets, balanced, are left alone.
		expect(cleanCompletion("map(items)", prefix, suffix)).toBe("map(items)");
	});

	test("caps long answers and treats whitespace as nothing", () => {
		const long = Array.from({ length: 40 }, (_, i) => `line${i}();`).join("\n");
		expect(cleanCompletion(long, "x\n", "").split("\n")).toHaveLength(16);
		expect(cleanCompletion("   \n  ", "x", "")).toBe("");
	});
});

describe("prompts", () => {
	test("mark the cursor and carry related code", () => {
		const prompt = buildPrompt(request, [{ path: "src/util.ts", text: "export const ZERO = 0;" }]);
		expect(prompt).toContain("--- src/util.ts\nexport const ZERO = 0;");
		expect(prompt).toContain("File: src/math.ts (typescript)");
		expect(prompt).toContain("return <CURSOR>\n}");
	});

	test("the context query is the identifiers near the cursor", () => {
		expect(contextQuery("import { loadConfig } from './config';\nconst cfg = loadConfig(")).toBe("import loadConfig from config const cfg");
	});
});

/** A runtime with one model whose answers the test decides. */
function fakeRuntime(answer: (prompt: string, signal?: AbortSignal) => Promise<string>, reasoning = false) {
	const calls: { prompt: string; options: Record<string, unknown> }[] = [];
	const runtime = {
		getModel: (provider: string, id: string) => (provider === "p" && id === "fast" ? { provider, id, maxTokens: 8192, reasoning } : undefined),
		getAvailable: async () => [],
		completeSimple: async (_model: unknown, context: { messages: { content: string }[] }, options: { signal?: AbortSignal }) => {
			calls.push({ prompt: context.messages[0].content, options });
			return { content: [{ type: "text", text: await answer(context.messages[0].content, options.signal) }], stopReason: "stop" };
		},
	} as unknown as ModelCallRuntime;
	return { runtime, calls };
}

describe("TabCompletionService", () => {
	test("asks the chosen model with related code, and cleans its answer", async () => {
		const { runtime, calls } = fakeRuntime(async () => "```\nreturn a + b;\n```");
		const service = new TabCompletionService({
			settings: () => ({ enabled: true, modelKey: "p/fast" }),
			getRuntime: async () => runtime,
			related: async () => [{ path: "src/util.ts", startLine: 1, endLine: 1, symbol: null, text: "export const ZERO = 0;", score: 1 }],
		});
		expect(await service.complete(request)).toEqual({ text: "a + b;" });
		expect(calls[0].prompt).toContain("--- src/util.ts");
		expect(calls[0].options.maxTokens).toBe(256);
		expect(calls[0].options.reasoning).toBeUndefined();
	});

	test("gives a reasoning model room to think, at the lowest level", async () => {
		const { runtime, calls } = fakeRuntime(async () => "a + b;", true);
		const service = new TabCompletionService({ settings: () => ({ enabled: true, modelKey: "p/fast" }), getRuntime: async () => runtime });
		await service.complete(request);
		expect(calls[0].options).toMatchObject({ maxTokens: 2048, reasoning: "minimal" });
	});

	test("does nothing while switched off", async () => {
		const { runtime, calls } = fakeRuntime(async () => "x");
		const service = new TabCompletionService({ settings: () => ({ enabled: false, modelKey: "p/fast" }), getRuntime: async () => runtime });
		expect(await service.complete(request)).toEqual({ text: "" });
		expect(calls).toHaveLength(0);
	});

	test("says so when the model is not chosen or has been removed", async () => {
		const { runtime } = fakeRuntime(async () => "x");
		const none = new TabCompletionService({ settings: () => ({ enabled: true, modelKey: null }), getRuntime: async () => runtime });
		await expect(none.complete(request)).rejects.toThrow(/no model is selected/);
		const gone = new TabCompletionService({ settings: () => ({ enabled: true, modelKey: "p/removed" }), getRuntime: async () => runtime });
		await expect(gone.complete(request)).rejects.toThrow(/no longer available/);
	});

	test("a newer request cancels the one still out", async () => {
		const { runtime } = fakeRuntime(
			(_prompt, signal) =>
				new Promise<string>((resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")));
					setTimeout(() => resolve("late"), 50);
				}),
		);
		const service = new TabCompletionService({ settings: () => ({ enabled: true, modelKey: "p/fast" }), getRuntime: async () => runtime });
		const first = service.complete({ ...request, id: "a" });
		const second = service.complete({ ...request, id: "b" });
		expect(await first).toEqual({ text: "" });
		expect(await second).toEqual({ text: "late" });
	});
});
