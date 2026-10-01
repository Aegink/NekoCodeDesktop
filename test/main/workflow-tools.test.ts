import { describe, expect, test } from "bun:test";
import { createWorkflowTools, type WorkflowToolHost } from "../../src/main/workflow-tools";

const tools = createWorkflowTools({} as WorkflowToolHost);

describe("workflow tool execution modes", () => {
	test("code_search fans out in parallel", () => {
		expect(tools.find((tool) => tool.name === "code_search")?.executionMode).toBe("parallel");
	});

	test("the session-steering tools stay sequential", () => {
		for (const tool of tools.filter((entry) => entry.name !== "code_search"))
			expect(tool.executionMode, tool.name).toBe("sequential");
	});
});
