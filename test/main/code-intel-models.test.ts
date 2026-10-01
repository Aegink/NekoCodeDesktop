import { expect, test } from "bun:test";
import { looksLikeEmbeddingModel } from "../../src/shared/code-intel";
import { codeIntelModelList } from "../../src/main/code-intel-models";

test("embedding and rerank models are told apart from chat models by name", () => {
	for (const id of ["BAAI/bge-m3", "embedding-3", "text-embedding-3-small", "jina-embeddings-v3", "nomic-embed-text", "intfloat/multilingual-e5-large", "BAAI/bge-reranker-v2-m3"]) {
		expect(looksLikeEmbeddingModel(id), id).toBe(true);
	}
	for (const id of ["deepseek-chat", "gpt-5", "Qwen/Qwen2.5-Coder-7B-Instruct", "glm-4.6", "claude-sonnet-5", "kimi-k2"]) {
		expect(looksLikeEmbeddingModel(id), id).toBe(false);
	}
});

const names: Record<string, string> = { "openai-codex": "OpenAI Codex", xai: "xAI" };
const providerName = (provider: string) => names[provider] ?? provider;

test("custom API models come first, from their profiles, whatever API they speak", () => {
	const profiles = [
		{ id: "a1", name: "token", modelIds: ["deepseek-flash", "BAAI/bge-m3"] },
		{ id: "b2", name: "kiro", modelIds: ["claude-opus-5.5"] },
	];
	const available = [
		{ provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
		{ provider: "xai", id: "grok-4.7", name: "Grok 4.7" },
	];
	expect(codeIntelModelList(profiles, available, providerName)).toEqual([
		{ key: "nekocode-a1/deepseek-flash", label: "token / deepseek-flash", group: "custom" },
		{ key: "nekocode-b2/claude-opus-5.5", label: "kiro / claude-opus-5.5", group: "custom" },
		{ key: "openai-codex/gpt-5.5", label: "OpenAI Codex / GPT-5.5", group: "account" },
		{ key: "xai/grok-4.7", label: "xAI / Grok 4.7", group: "account" },
	]);
});

test("custom models are listed even before the runtime's snapshot has caught up with them", () => {
	// The snapshot still holds only the account models — the race this guards against.
	const list = codeIntelModelList([{ id: "a1", name: "token", modelIds: ["deepseek-flash"] }], [{ provider: "xai", id: "grok-4.7" }], providerName);
	expect(list.map((option) => option.key)).toEqual(["nekocode-a1/deepseek-flash", "xai/grok-4.7"]);
});

test("a custom model the snapshot does have is not listed twice", () => {
	const list = codeIntelModelList(
		[{ id: "a1", name: "token", modelIds: ["deepseek-flash"] }],
		[{ provider: "nekocode-a1", id: "deepseek-flash" }, { provider: "nekocode-gone", id: "old-model" }],
		providerName,
	);
	expect(list).toEqual([{ key: "nekocode-a1/deepseek-flash", label: "token / deepseek-flash", group: "custom" }]);
});
