import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { FILE_MUTATION_ENTRY, reportPreimage, unpackPreimage, type FileMutationData } from "./file-journal";
import { FileJournalRecorder } from "./file-journal-recorder";

function fakeSession() {
	const entries: FileMutationData[] = [];
	const session = {
		sessionManager: {
			appendCustomEntry: (type: string, data: FileMutationData) => {
				if (type === FILE_MUTATION_ENTRY) entries.push(data);
			},
		},
	} as unknown as AgentSession;
	return { session, entries };
}

describe("FileJournalRecorder with reported pre-images", () => {
	test("records every file a multi-file tool reported, even when the call then failed", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nekocode-journal-"));
		try {
			writeFileSync(join(cwd, "a.ts"), "after a\n");
			writeFileSync(join(cwd, "b.ts"), "after b\nmore\n");
			reportPreimage("call-1", { tool: "ast_edit", path: join(cwd, "a.ts"), before: Buffer.from("before a\n") });
			reportPreimage("call-1", { tool: "ast_edit", path: join(cwd, "b.ts"), before: Buffer.from("before b\n") });
			// Outside the workspace: never recorded, so a restore can never write there.
			reportPreimage("call-1", { tool: "ast_edit", path: join(tmpdir(), "elsewhere.ts"), before: Buffer.from("x") });
			const { session, entries } = fakeSession();
			await new FileJournalRecorder(cwd).afterTool(session, "call-1", true);
			expect(entries.map((entry) => [entry.path, entry.tool, entry.additions, entry.deletions])).toEqual([
				["a.ts", "ast_edit", 1, 1],
				["b.ts", "ast_edit", 2, 1],
			]);
			expect(unpackPreimage(entries[0].before as string).toString()).toBe("before a\n");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a conflict:// write is recorded by the file it changed, not by its URI", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nekocode-journal-"));
		try {
			writeFileSync(join(cwd, "code.ts"), "resolved\n");
			const recorder = new FileJournalRecorder(cwd);
			await recorder.beforeTool("call-2", "write", { path: "conflict://1", content: "@ours" });
			const before = Buffer.from("<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n");
			reportPreimage("call-2", { tool: "write", path: join(cwd, "code.ts"), before });
			const { session, entries } = fakeSession();
			await recorder.afterTool(session, "call-2", false);
			expect(entries.map((entry) => entry.path)).toEqual(["code.ts"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
