import { describe, expect, test } from "bun:test";
import type { TaskStep } from "../../../src/shared/workflow";
import { explorerStats, groupTurns, inlineCode, locationRange, parseReportLocations, stepSubject, type ToolStep } from "../../../src/renderer/src/lib/fastContext";

function tool(id: string, toolName: string, args: string, startedAt: number, status: ToolStep["status"] = "done"): ToolStep {
	return { kind: "tool", id, toolName, args, status, startedAt };
}

describe("step subjects", () => {
	test("read shows the file and its line window, search the pattern and where", () => {
		expect(stepSubject(tool("1", "read", '{"path":"src/main/auth/token.ts","offset":40,"limit":20}', 0))).toEqual({
			kind: "read",
			text: "token.ts",
			detail: "L40–59",
			path: "src/main/auth/token.ts",
		});
		expect(stepSubject(tool("2", "grep", '{"pattern":"refresh\\\\(","path":"src/main"}', 0))).toMatchObject({
			kind: "search",
			text: "refresh\\(",
			detail: "src/main",
		});
		expect(stepSubject(tool("3", "ls", '{"path":"."}', 0))).toMatchObject({ kind: "list", text: "./" });
	});

	test("a preview cut off mid-value still yields the part that arrived", () => {
		expect(stepSubject(tool("4", "grep", '{"pattern":"a very long pattern that was cu', 0)).text).toBe("a very long pattern that was cu");
	});
});

describe("turns", () => {
	test("calls started together form one turn; a later one opens the next", () => {
		const steps: TaskStep[] = [
			{ kind: "thinking", id: "t", text: "hm", startedAt: 0 },
			tool("a", "grep", "{}", 1000),
			tool("b", "grep", "{}", 1040),
			tool("c", "find", "{}", 1100),
			tool("d", "read", '{"path":"x.ts"}', 3200),
			tool("e", "read", '{"path":"y.ts"}', 3230),
			tool("f", "read", '{"path":"x.ts","offset":10}', 6000),
		];
		expect(groupTurns(steps).map((turn) => turn.steps.map((step) => step.id))).toEqual([["a", "b", "c"], ["d", "e"], ["f"]]);
		expect(explorerStats(steps)).toEqual({ searches: 3, files: 2, turns: 3 });
	});
});

describe("report locations", () => {
	test("reads the explorer's `path:start-end` — why lines and leaves prose and symbols alone", () => {
		const report = [
			"## Findings",
			"- `src/main/auth/token.ts:12-48` — refreshes the token before expiry.",
			"- `src/main/auth/client.ts:90` — **retries** once on 401.",
			"* `src/shared/auth.ts` — the types.",
			"- `refreshToken` — a symbol, not a place.",
			"Follow-up symbols: `refreshToken`",
			"- `src/main/auth/token.ts:12-48` — duplicate.",
		].join("\n");
		expect(parseReportLocations(report)).toEqual([
			{ path: "src/main/auth/token.ts", start: 12, end: 48, note: "refreshes the token before expiry." },
			{ path: "src/main/auth/client.ts", start: 90, note: "retries once on 401." },
			{ path: "src/shared/auth.ts", note: "the types." },
		]);
		// Two places on one line both become rows, sharing the note.
		expect(parseReportLocations("- `src/preload/index.ts:287-288` and `src/renderer/src/hooks/useTaskBoard.ts:11-25` — the bridge.")).toEqual([
			{ path: "src/preload/index.ts", start: 287, end: 288, note: "the bridge." },
			{ path: "src/renderer/src/hooks/useTaskBoard.ts", start: 11, end: 25, note: "the bridge." },
		]);
		// A sentence instead of a dash: the first token is the place, the rest the note.
		expect(parseReportLocations("- `src/main/index.ts:220-228` defines `pushTaskBoard()`: it schedules a push.")).toEqual([
			{ path: "src/main/index.ts", start: 220, end: 228, note: "defines `pushTaskBoard()`: it schedules a push." },
		]);
		expect(inlineCode("calls `push()` then `send`")).toEqual([
			{ code: false, text: "calls " },
			{ code: true, text: "push()" },
			{ code: false, text: " then " },
			{ code: true, text: "send" },
		]);
		expect(locationRange({ start: 12, end: 48 })).toBe("L12–48");
		expect(locationRange({ start: 90 })).toBe("L90");
		expect(locationRange({})).toBeNull();
	});
});
