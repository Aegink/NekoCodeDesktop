import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { safeStorage } from "electron";
import {
	KEYED_SEARCH_ENGINES,
	MAX_SEARCH_KEY_LENGTH,
	KEYLESS_SEARCH_ENGINE,
	isSearchEngineId,
	type KeyedSearchEngineId,
	type SearchEngineId,
	type WebToolsStatus,
	type WebToolsUpdate,
} from "../shared/web-tools";
import type { WebToolsSettings } from "./web-tools";

interface StoredFile {
	version: 1;
	enabled: boolean;
	provider: SearchEngineId;
	searxngUrl: string | null;
	/** Encrypted with `safeStorage`, base64. */
	keys: Partial<Record<KeyedSearchEngineId, string>>;
}

const FILE = "web-tools.json";
const DEFAULTS: StoredFile = { version: 1, enabled: true, provider: KEYLESS_SEARCH_ENGINE, searxngUrl: null, keys: {} };

type Encryption = Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString" | "getSelectedStorageBackend">;

/** An http(s) base URL, or null for an empty field. Anything else is refused. */
export function normalizeSearxngUrl(raw: string | null | undefined): string | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
	} catch {
		throw new Error(`Not a valid SearXNG address: ${trimmed}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A SearXNG address must be http or https");
	return url.toString();
}

/**
 * The web tools' settings, and the search API keys, in one file in app data.
 *
 * Keys are encrypted with the OS keyring and never leave main: the settings
 * page learns only whether each one is set. On a machine with no keyring
 * (a bare Linux session) keys cannot be saved at all, rather than being
 * written in the clear.
 */
export class WebToolsStore {
	private readonly path: string;
	private file: StoredFile | null = null;

	constructor(
		private readonly userDataDir: string,
		private readonly encryption: Encryption,
	) {
		this.path = join(userDataDir, FILE);
	}

	private canEncrypt(): boolean {
		return (
			this.encryption.isEncryptionAvailable() &&
			!(process.platform === "linux" && this.encryption.getSelectedStorageBackend() === "basic_text")
		);
	}

	private load(): StoredFile {
		if (this.file) return this.file;
		let parsed: Partial<StoredFile> = {};
		if (existsSync(this.path)) {
			try {
				const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
				if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Partial<StoredFile>;
			} catch {
				// Corrupt: defaults, and the next save replaces it.
			}
		}
		const keys: StoredFile["keys"] = {};
		for (const engine of KEYED_SEARCH_ENGINES) {
			const value = parsed.keys?.[engine];
			if (typeof value === "string" && value) keys[engine] = value;
		}
		this.file = {
			version: 1,
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULTS.enabled,
			provider: isSearchEngineId(parsed.provider) ? parsed.provider : DEFAULTS.provider,
			searxngUrl: typeof parsed.searxngUrl === "string" && parsed.searxngUrl ? parsed.searxngUrl : null,
			keys,
		};
		return this.file;
	}

	private persist(next: StoredFile): void {
		mkdirSync(this.userDataDir, { recursive: true });
		const temporary = `${this.path}.tmp-${process.pid}`;
		try {
			writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
		this.file = next;
	}

	private decrypt(value: string): string | null {
		if (!this.canEncrypt()) return null;
		try {
			return this.encryption.decryptString(Buffer.from(value, "base64")).trim() || null;
		} catch {
			// Encrypted under another OS account or a reset keyring: as good as unset.
			return null;
		}
	}

	status(): WebToolsStatus {
		const file = this.load();
		return {
			enabled: file.enabled,
			provider: file.provider,
			keys: Object.fromEntries(KEYED_SEARCH_ENGINES.map((engine) => [engine, !!file.keys[engine]])) as WebToolsStatus["keys"],
			// Sign-ins live with the model accounts, not here; main fills these in.
			accounts: { codex: false, gemini: false },
			searxngUrl: file.searxngUrl,
			canStoreKeys: this.canEncrypt(),
		};
	}

	/** What the tools run with, keys decrypted. Main only. */
	settings(): WebToolsSettings {
		const file = this.load();
		const keys: WebToolsSettings["keys"] = {};
		for (const engine of KEYED_SEARCH_ENGINES) {
			const stored = file.keys[engine];
			const key = stored ? this.decrypt(stored) : null;
			if (key) keys[engine] = key;
		}
		return { enabled: file.enabled, provider: file.provider, searxngUrl: file.searxngUrl, keys };
	}

	/** Apply a change from the settings page. It arrives over IPC, so each field is checked. */
	update(patch: WebToolsUpdate): WebToolsStatus {
		const current = this.load();
		const next: StoredFile = { ...current, keys: { ...current.keys } };
		if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
		if (patch.provider !== undefined) {
			if (!isSearchEngineId(patch.provider)) throw new Error(`Unknown search provider: ${String(patch.provider)}`);
			next.provider = patch.provider;
		}
		if (patch.searxngUrl !== undefined) next.searxngUrl = normalizeSearxngUrl(patch.searxngUrl);
		for (const engine of KEYED_SEARCH_ENGINES) {
			const value = patch.keys?.[engine];
			if (value === undefined) continue;
			const key = typeof value === "string" ? value.trim() : "";
			if (!key) {
				delete next.keys[engine];
				continue;
			}
			if (key.length > MAX_SEARCH_KEY_LENGTH) throw new Error("That API key is too long");
			if (!this.canEncrypt()) throw new Error("The system keyring is unavailable, so the API key cannot be saved securely");
			next.keys[engine] = this.encryption.encryptString(key).toString("base64");
		}
		this.persist(next);
		return this.status();
	}
}
