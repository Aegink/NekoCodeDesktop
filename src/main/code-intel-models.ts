import { looksLikeEmbeddingModel, type CodeIntelModelOption } from "../shared/code-intel";

/**
 * The models code intelligence can use, read from Settings → Providers and
 * models rather than configured a second time.
 *
 * Custom API providers come straight from their saved profiles, not from the
 * model runtime's availability snapshot: that snapshot is refreshed in the
 * background after a provider is registered, so reading it right after
 * startup or a save would leave them out. Accounts signed in to (OAuth) have
 * no profile and are read from the runtime.
 */

/** The runtime's provider id for a custom API profile. */
export const customProviderId = (profileId: string) => `nekocode-${profileId}`;

export function codeIntelModelList(
	profiles: readonly { id: string; name: string; modelIds: readonly string[] }[],
	available: readonly { provider: string; id: string; name?: string }[],
	providerName: (provider: string) => string,
): CodeIntelModelOption[] {
	const custom = profiles.flatMap((profile) =>
		profile.modelIds
			.filter((id) => !looksLikeEmbeddingModel(id))
			.map((id) => ({ key: `${customProviderId(profile.id)}/${id}`, label: `${profile.name} / ${id}`, group: "custom" as const })),
	);
	const customIds = new Set(profiles.map((profile) => customProviderId(profile.id)));
	const account = available
		.filter((model) => !customIds.has(model.provider) && !model.provider.startsWith("nekocode-") && !looksLikeEmbeddingModel(model.id))
		.map((model) => ({
			key: `${model.provider}/${model.id}`,
			label: `${providerName(model.provider)} / ${model.name || model.id}`,
			group: "account" as const,
		}));
	return [...custom, ...account];
}
