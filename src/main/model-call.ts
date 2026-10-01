import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

/**
 * One request to a model picked by its `provider/model` key, for the small
 * side jobs code intelligence runs: a completion, a query rewrite, a rerank.
 * Whatever provider it is — OpenAI or Anthropic format, an API key or a
 * sign-in — the runtime already knows how to reach it.
 */

/** What these calls need of the model runtime. */
export interface ModelCallRuntime {
	getModel(providerId: string, modelId: string): Model<Api> | undefined;
	/** Waits out a pending refresh, so a provider registered a moment ago is there. */
	getAvailable(): Promise<readonly Model<Api>[]>;
	completeSimple(
		model: Model<Api>,
		context: { systemPrompt?: string; messages: { role: "user"; content: string; timestamp: number }[] },
		options: { maxTokens?: number; signal?: AbortSignal; reasoning?: "minimal" },
	): Promise<AssistantMessage>;
}

export interface ModelCallOptions {
	/** Output cap for a model that answers directly. */
	maxTokens: number;
	/** Output cap for a reasoning model, whose thinking counts against it. */
	reasoningMaxTokens: number;
	timeoutMs: number;
	signal?: AbortSignal;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/** Ask `modelKey` one question; the answer's text, or an error saying why there is none. */
export async function askModel(
	runtime: ModelCallRuntime,
	modelKey: string,
	systemPrompt: string,
	prompt: string,
	options: ModelCallOptions,
): Promise<string> {
	// Provider ids have no slash; model ids may (`BAAI/bge-m3`), so split at the first.
	const slash = modelKey.indexOf("/");
	const [provider, id] = [modelKey.slice(0, slash), modelKey.slice(slash + 1)];
	let model = slash > 0 ? runtime.getModel(provider, id) : undefined;
	if (!model && slash > 0) {
		await runtime.getAvailable().catch(() => []);
		model = runtime.getModel(provider, id);
	}
	if (!model) throw new Error(`Model ${modelKey} is no longer available under Providers and models`);
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const message = await runtime.completeSimple(
		model,
		{ systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
		{
			maxTokens: Math.min(model.maxTokens || options.reasoningMaxTokens, model.reasoning ? options.reasoningMaxTokens : options.maxTokens),
			signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
			// Thinking cannot be switched off portably; the lowest level is the next best.
			...(model.reasoning ? { reasoning: "minimal" as const } : {}),
		},
	);
	if (message.stopReason === "error") throw new Error(message.errorMessage ?? "Model request failed");
	if (message.stopReason === "aborted") throw new Error(timeout.aborted ? "Model request timed out" : "Model request cancelled");
	return assistantText(message);
}
