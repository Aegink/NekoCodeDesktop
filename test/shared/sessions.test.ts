import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../../src/shared/agent";
import { groupSessionsByWorkspace, workspaceKey } from "../../src/shared/sessions";

function session(id: string, cwd: string): SessionSummary {
	return { id, sessionFile: `${id}.jsonl`, cwd, title: id, preview: "", updatedAt: 1, messageCount: 1 } as SessionSummary;
}

describe("groupSessionsByWorkspace", () => {
	test("leaves a removed workspace out, sessions and all, even when it is the current one", () => {
		const groups = groupSessionsByWorkspace([session("a", "D:\\Work\\Removed"), session("b", "D:\\Work\\Kept")], {
			workspaces: ["D:\\Work\\Removed", "D:\\Work\\Kept"],
			currentCwd: "D:\\Work\\Removed",
			hidden: [workspaceKey("d:/work/removed")],
		});
		expect(groups.map((group) => group.cwd)).toEqual(["D:\\Work\\Kept"]);
	});

	test("never hides the unassigned group", () => {
		const groups = groupSessionsByWorkspace([session("a", "")], { hidden: [""] });
		expect(groups.map((group) => group.sessions.length)).toEqual([1]);
	});
});
