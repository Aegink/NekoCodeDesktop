/**
 * The agent's web access: `web_search` and `web_fetch`.
 *
 * Shared between main, which runs the tools and keeps the keys, and the
 * settings page, which only ever sees whether a key is set — never the key.
 */

/**
 * The one engine that answers without an account, and the fallback behind
 * every other. Only reachable through a proxy from mainland China — and it is
 * the only one of its kind kept: Bing and the like serve scrapers unrelated
 * results rather than refusing them, which is worse than no answer.
 */
export const KEYLESS_SEARCH_ENGINE = "duckduckgo";
/** Engines that need an API key. Bocha and Zhipu answer from mainland China. */
export const KEYED_SEARCH_ENGINES = ["tavily", "bocha", "zhipu", "exa", "brave", "jina", "perplexity", "kagi", "firecrawl"] as const;
/**
 * Engines that search with an account already signed in under Models, rather
 * than a key: the model searches the web itself and answers with citations.
 * `codex` is the OpenAI Codex sign-in, `gemini` the Antigravity one.
 */
export const ACCOUNT_SEARCH_ENGINES = ["codex", "gemini"] as const;
/** Every engine, plus SearXNG, which needs the address of an instance instead of a key. */
export const SEARCH_ENGINES = [KEYLESS_SEARCH_ENGINE, ...ACCOUNT_SEARCH_ENGINES, ...KEYED_SEARCH_ENGINES, "searxng"] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number];
export type KeyedSearchEngineId = (typeof KEYED_SEARCH_ENGINES)[number];
export type AccountSearchEngineId = (typeof ACCOUNT_SEARCH_ENGINES)[number];

export function isAccountSearchEngine(value: string): value is AccountSearchEngineId {
	return (ACCOUNT_SEARCH_ENGINES as readonly string[]).includes(value);
}

export function isSearchEngineId(value: unknown): value is SearchEngineId {
	return typeof value === "string" && (SEARCH_ENGINES as readonly string[]).includes(value);
}

export function isKeyedSearchEngine(value: string): value is KeyedSearchEngineId {
	return (KEYED_SEARCH_ENGINES as readonly string[]).includes(value);
}

/** What the settings page is told. */
export interface WebToolsStatus {
	/** Off removes both tools from every session started after. */
	enabled: boolean;
	provider: SearchEngineId;
	/** Which engines have a key saved; the keys themselves stay in main. */
	keys: Record<KeyedSearchEngineId, boolean>;
	/** Which account engines have their sign-in in place. */
	accounts: Record<AccountSearchEngineId, boolean>;
	searxngUrl: string | null;
	/** False when the OS keyring is unavailable, so a key cannot be saved safely. */
	canStoreKeys: boolean;
}

/**
 * A change from the settings page. A key of `null` removes it; an absent key
 * leaves it as it is, which is what lets the dialog save without echoing keys.
 */
export interface WebToolsUpdate {
	enabled?: boolean;
	provider?: SearchEngineId;
	keys?: Partial<Record<KeyedSearchEngineId, string | null>>;
	searxngUrl?: string | null;
}

export const MAX_SEARCH_KEY_LENGTH = 512;
