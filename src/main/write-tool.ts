import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isConflictUri, writeConflictUri, type ConflictHistory } from "./conflicts";
import { reportPreimage } from "./file-journal";
import type { PiCodingAgentModule } from "./pi";

/**
 * pi's `write`, plus `conflict://<N>` and `conflict://*` targets that resolve
 * merge conflicts the `read` tool registered (see `conflicts.ts`).
 *
 * Every other path goes to pi's implementation untouched. A conflict write
 * names no file in its arguments, so the two things that normally key off the
 * path are done here instead: the caller's write check runs against each real
 * file, and each file's previous contents are reported to the checkpoint
 * journal, the way `ast_edit` reports the files a codemod touched.
 */

const EXTRA_DESCRIPTION =
	" To resolve a merge conflict that `read` reported, write to `conflict://<N>` (replaces only that marker block; a line of `@ours` / `@theirs` / `@base` / `@both` expands to the recorded side) or to `conflict://*` for every registered block.";

export function createWriteTool(
	pi: PiCodingAgentModule,
	cwd: string,
	conflicts: ConflictHistory,
	options: { assertWritable?: (absolutePath: string) => void } = {},
): ToolDefinition {
	const base = pi.createWriteToolDefinition(cwd) as unknown as ToolDefinition;
	return {
		...base,
		description: base.description + EXTRA_DESCRIPTION,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path, content } = params as { path: string; content: string };
			if (!isConflictUri(path)) return base.execute(toolCallId, params, signal, onUpdate, ctx);
			if (signal?.aborted) throw new Error("Operation aborted");
			const text = await writeConflictUri(conflicts, path, content, {
				assertWritable: options.assertWritable,
				onBeforeWrite: (absolutePath, before) => reportPreimage(toolCallId, { tool: "write", path: absolutePath, before }),
			});
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}
