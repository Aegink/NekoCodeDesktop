import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { selectFastContextModel } from "../../src/main/workflow-runtime";
import type { resolveFusion } from "../../src/main/fusion-config";

const model = (provider: string, id: string) => ({ provider, id }) as Model<Api>;
const parent = model("anthropic", "lead");
const sidekick = model("zai", "side");
const fusion = {
	config: {
		leadModelKey: "anthropic/lead", leadThinkingLevel: "high",
		sidekickModelKey: "zai/side", sidekickThinkingLevel: "medium",
	},
	lead: parent, sidekick,
} as Awaited<ReturnType<typeof resolveFusion>>;

describe("selectFastContextModel", () => {
	test("uses the Fusion Sidekick when Fusion is on", () => {
		const pick = selectFastContextModel(parent, "high", fusion);
		expect(pick.model).toBe(sidekick);
		expect(pick.requestedThinkingLevel).toBe("medium");
	});
	test("otherwise follows the session's model and thinking level", () => {
		const pick = selectFastContextModel(parent, "high", null);
		expect(pick.model).toBe(parent);
		expect(pick.requestedThinkingLevel).toBe("high");
	});
});
