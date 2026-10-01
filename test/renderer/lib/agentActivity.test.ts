import { describe, expect, test } from "bun:test";
import type { AgentCell } from "../../../src/shared/agent";
import { mainActivity, subagentActivity, summarizeTurn, toolSubject } from "../../../src/renderer/src/lib/agentActivity";

const user = (id: string, timestamp: number): AgentCell => ({ id, type: "user", text: "do it", timestamp });
const tool = (id: string, toolName: string, args: unknown, status: "running" | "done" | "error", timestamp: number): AgentCell => ({
	id,
	type: "tool",
	toolCallId: id,
	toolName,
	args,
	output: "",
	status,
	timestamp,
	startedAt: timestamp,
});
const assistant = (fields: Partial<Extract<AgentCell, { type: "assistant" }>>): AgentCell => ({
	id: "a",
	type: "assistant",
	text: "",
	thinking: "",
	streaming: true,
	timestamp: 50,
	...fields,
});

describe("mainActivity", () => {
	test("a pending question and an idle session come first", () => {
		expect(mainActivity([], true, true)).toEqual({ kind: "question" });
		expect(mainActivity([user("u", 1)], false, false)).toEqual({ kind: "idle" });
	});

	test("a running tool of this turn is what it is doing", () => {
		const cells = [user("u0", 1), tool("old", "bash", { command: "ls" }, "running", 2), user("u1", 10), tool("t", "grep", { pattern: "TODO" }, "running", 11), assistant({ text: "Looking", timestamp: 12 })];
		expect(mainActivity(cells, true, false)).toEqual({ kind: "tool", toolName: "grep", subject: "TODO", since: 11 });
	});

	test("otherwise the streaming reply: reasoning, then text, then waiting", () => {
		expect(mainActivity([user("u", 1), assistant({ thinkingStartedAt: 5 })], true, false)).toEqual({ kind: "thinking", since: 5 });
		expect(mainActivity([user("u", 1), assistant({ thinkingStartedAt: 5, thinkingEndedAt: 8, text: "Here" })], true, false)).toEqual({ kind: "replying", since: 8 });
		expect(mainActivity([user("u", 1), tool("t", "read", { path: "a" }, "done", 3)], true, false)).toEqual({ kind: "waiting", since: 3 });
	});
});

describe("summarizeTurn", () => {
	test("counts only the current turn and keeps its latest calls", () => {
		const cells = [user("u0", 1), tool("x", "bash", {}, "error", 2), user("u1", 10), tool("a", "read", { path: "a.ts" }, "done", 11), tool("b", "edit", { path: "b.ts" }, "error", 12), tool("c", "grep", { pattern: "p" }, "running", 13)];
		const turn = summarizeTurn(cells, 2);
		expect(turn).toMatchObject({ startedAt: 10, toolCalls: 3, errors: 1 });
		expect(turn.recent.map((call) => [call.toolName, call.subject, call.status])).toEqual([
			["edit", "b.ts", "error"],
			["grep", "p", "running"],
		]);
	});
});

describe("toolSubject", () => {
	test("picks the argument that says what the call is about", () => {
		expect(toolSubject("bash", { command: "bun test\n  --watch", timeout: 5 })).toBe("bun test --watch");
		expect(toolSubject("stat", { paths: ["a.ts", "b.ts", "c.ts"] })).toBe("a.ts +2");
		expect(toolSubject("github", { op: "pr_view", number: 12 })).toBe("pr_view · #12");
		expect(toolSubject("mystery", { url: "https://x.dev" })).toBe("https://x.dev");
		expect(toolSubject("read", {})).toBeNull();
	});
});

describe("subagentActivity", () => {
	test("reads a worker's newest step", () => {
		expect(subagentActivity({ status: "completed", steps: [] })).toEqual({ kind: "finished" });
		expect(subagentActivity({ status: "running", steps: [] })).toEqual({ kind: "starting" });
		expect(
			subagentActivity({
				status: "running",
				steps: [
					{ kind: "tool", id: "1", toolName: "read", args: "a.ts", status: "running", startedAt: 5 },
					{ kind: "message", id: "m", text: "Reading the config", startedAt: 6 },
				],
			}),
		).toEqual({ kind: "tool", toolName: "read", subject: "a.ts", since: 5 });
		expect(subagentActivity({ status: "running", steps: [{ kind: "message", id: "m", text: "Almost\ndone", startedAt: 6 }] })).toEqual({ kind: "said", text: "Almost done" });
		expect(subagentActivity({ status: "running", steps: [{ kind: "thinking", id: "t", text: "hm", startedAt: 7 }] })).toEqual({ kind: "thinking", since: 7 });
	});
});
