import { describe, expect, test } from "bun:test";
import { modelLabel, modelName } from "../../src/shared/agent";

const configured = (provider: string, id: string) => ({ provider, providerName: "relay", id, name: id });

describe("modelName", () => {
	test("trims a configured model's vendor prefix", () => {
		const model = configured("p", "zai-org/glm-4.6");
		expect(modelName(model, [model])).toBe("glm-4.6");
		expect(modelLabel(model, [model])).toBe("relay/glm-4.6");
	});

	test("keeps the prefix when it is all that tells two models of one provider apart", () => {
		const a = configured("p", "channel-a/claude-sonnet-4.5");
		const b = configured("p", "channel-b/claude-sonnet-4.5");
		const models = [a, b];
		expect(modelName(a, models)).toBe("channel-a/claude-sonnet-4.5");
		expect(modelLabel(b, models)).toBe("relay/channel-b/claude-sonnet-4.5");
	});

	test("trims when the look-alike belongs to another provider", () => {
		const a = configured("p", "channel-a/glm-4.6");
		const b = configured("q", "channel-b/glm-4.6");
		expect(modelName(a, [a, b])).toBe("glm-4.6");
	});

	test("a written-out name wins", () => {
		const model = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" };
		expect(modelName(model, [model])).toBe("Claude Sonnet 4.5");
	});
});
