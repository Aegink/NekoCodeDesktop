import { describe, expect, test } from "bun:test";
import type { AgentCell, AgentSnapshot } from "../../src/shared/agent";
import type { CheckpointSummary } from "../../src/shared/checkpoints";
import { activeTaskCount, sortTaskBoard, taskBoardEntry, type TaskBoardEntry } from "../../src/shared/task-board";

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
	return {
		session: { id: "s1", cwd: "/p", sessionFile: "/s/s1.jsonl", title: "Dark mode", titlePending: false, preview: "", createdAt: 1, updatedAt: 1, messageCount: 2 },
		cells: [], checkpoints: [], workflow: { request: null, todos: [], tasks: [] }, streaming: false,
		models: [], modelKey: null, thinkingLevel: "off", thinkingLevels: ["off"], mode: "auto", workMode: "agent", agentPhase: "execute",
		...overrides,
	};
}

const prompt: AgentCell = { id: "u1", type: "user", text: "add dark mode", timestamp: 1000 };

function checkpoint(additions: number, deletions: number, paths: string[]): CheckpointSummary {
	return {
		id: `c${additions}`, sessionId: "s1", createdAt: 1, label: "", cellId: null, conversationRestorable: true, codeRestorable: true,
		fileCount: paths.length, files: paths.map((path) => ({ path, additions: 0, deletions: 0 })), additions, deletions, shellRuns: 0,
	};
}

describe("task board entry", () => {
	test("a running task reports the tool it is in and has no end", () => {
		const entry = taskBoardEntry(snapshot({
			streaming: true,
			cells: [prompt, { id: "t1", type: "tool", toolCallId: "c1", toolName: "edit", args: { path: "Settings.tsx" }, output: "", status: "running", startedAt: 1200, timestamp: 1200 }],
		}));
		expect(entry.status).toBe("running");
		expect(entry.activity).toEqual({ kind: "tool", toolName: "edit", subject: "Settings.tsx", since: 1200 });
		expect(entry.startedAt).toBe(1000);
		expect(entry.endedAt).toBeNull();
		expect(entry.summary).toBeNull();
	});

	test("a finished task is summarised by the first line of its answer, and its edits are totalled", () => {
		const entry = taskBoardEntry(
			snapshot({
				cells: [prompt, { id: "a1", type: "assistant", text: "## Done\nAdded a toggle.", thinking: "", streaming: false, timestamp: 5000 }],
				checkpoints: [checkpoint(20, 3, ["a.ts", "b.ts"]), checkpoint(4, 0, ["a.ts"])],
			}),
			{ run: { startedAt: 900, endedAt: 5100 }, worktree: { branch: "nekocode/task-1", base: "main" } },
		);
		expect(entry.status).toBe("done");
		expect(entry.summary).toBe("Done");
		expect(entry.endedAt).toBe(5100);
		expect([entry.additions, entry.deletions, entry.files]).toEqual([24, 3, 2]);
		expect(entry.worktree?.branch).toBe("nekocode/task-1");
	});

	test("a turn that ended on an error is failed, with the error as its summary", () => {
		const entry = taskBoardEntry(snapshot({
			cells: [prompt, { id: "a1", type: "assistant", text: "", thinking: "", streaming: false, error: "429 rate limited", timestamp: 2000 }],
		}));
		expect(entry.status).toBe("failed");
		expect(entry.summary).toBe("429 rate limited");
	});

	test("a question outranks running", () => {
		const entry = taskBoardEntry(snapshot({
			streaming: true,
			cells: [prompt],
			workflow: { request: { id: "q" } as never, todos: [], tasks: [] },
		}));
		expect(entry.status).toBe("question");
	});
});

describe("task board order", () => {
	const entry = (sessionId: string, status: TaskBoardEntry["status"], startedAt: number) =>
		({ sessionId, status, startedAt }) as TaskBoardEntry;

	test("what needs the user, then what is moving, then what is done — newest first within each", () => {
		const sorted = sortTaskBoard([
			entry("done-old", "done", 1), entry("run-old", "running", 2), entry("ask", "question", 3),
			entry("run-new", "running", 4), entry("failed", "failed", 5), entry("done-new", "done", 6),
		]);
		expect(sorted.map((e) => e.sessionId)).toEqual(["ask", "run-new", "run-old", "failed", "done-new", "done-old"]);
		expect(activeTaskCount(sorted)).toBe(3);
	});
});
