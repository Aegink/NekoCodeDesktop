import { describe, expect, test } from "bun:test";
import type { AgentCell } from "../../src/shared/agent";
import { foldSettledTurns, groupTranscriptRows, type TranscriptRow } from "../../src/shared/transcript";

const user = (id: string, timestamp = 0): AgentCell => ({ id, type: "user", text: id, timestamp });
const say = (id: string, text: string, timestamp = 0, thinking = ""): AgentCell => ({
	id,
	type: "assistant",
	text,
	thinking,
	streaming: false,
	timestamp,
});
const tool = (id: string, timestamp = 0): AgentCell => ({
	id,
	type: "tool",
	toolCallId: id,
	toolName: "bash",
	args: {},
	output: "",
	status: "done",
	timestamp,
});

const shape = (rows: TranscriptRow[]) =>
	rows.map((row) => (row.kind === "work" ? `${row.id}[${row.items.map((item) => `${item.kind}:${item.id}`).join(",")}]` : `${row.kind}:${row.id}`));

const fold = (cells: AgentCell[], streaming = false) => shape(foldSettledTurns(groupTranscriptRows(cells), streaming));

describe("foldSettledTurns", () => {
	const turn = [
		user("u1"),
		say("a1", "Let me look.", 1, "plan"),
		tool("t1", 2),
		say("a2", "Found it, fixing.", 3),
		tool("t2", 4),
		say("a3", "Done: the bug was X.", 5),
	];

	test("folds a finished turn's work and remarks above its answer", () => {
		expect(fold(turn)).toEqual([
			"user:u1",
			"turn-u1[thinking:a1-thinking,message:a1-message,tool:t1,message:a2-message,tool:t2]",
			"message:a3-message",
		]);
	});

	test("folds the remark that shared a cell with the opening thought", () => {
		// a1 both thought and spoke: its text is a remark like any other.
		expect(fold([user("u1"), say("a1", "Checking.", 1, "plan"), tool("t1", 2), say("a2", "Answer.", 3)])).toEqual([
			"user:u1",
			"turn-u1[thinking:a1-thinking,message:a1-message,tool:t1]",
			"message:a2-message",
		]);
	});

	test("leaves the running turn as it streams, but folds the ones before it", () => {
		const rows = fold([...turn, user("u2", 6), tool("t3", 7), say("a4", "partial", 8)], true);
		expect(rows.slice(0, 3)).toEqual([
			"user:u1",
			"turn-u1[thinking:a1-thinking,message:a1-message,tool:t1,message:a2-message,tool:t2]",
			"message:a3-message",
		]);
		expect(rows.slice(3)).toEqual(["user:u2", "work-u2-0[tool:t3]", "message:a4-message"]);
	});

	test("leaves a turn that ended without an answer", () => {
		expect(fold([user("u1"), say("a1", "Trying.", 1), tool("t1", 2)])).toEqual([
			"user:u1",
			"message:a1-message",
			"work-u1-0[tool:t1]",
		]);
	});

	test("leaves a turn that called no tool", () => {
		expect(fold([user("u1"), say("a1", "Answer.", 1, "hmm")])).toEqual(["user:u1", "thinking:a1-thinking", "message:a1-message"]);
	});

	test("spans the folded group from the first step to the answer", () => {
		const [, folded] = foldSettledTurns(groupTranscriptRows(turn), false);
		expect(folded.kind === "work" && [folded.startedAt, folded.endedAt]).toEqual([1, 5]);
	});
});
