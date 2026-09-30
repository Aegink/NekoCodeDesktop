import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
	OPEN_VSX_URL,
	SUPPORTED_CONTRIBUTIONS,
	parseJsonc,
	type IdeExtensionSearchEntry,
	type IdeExtensionSearchResult,
	type IdeExtensionsSnapshot,
	type IdeGrammarContribution,
	type IdeInstalledExtension,
	type IdeLanguageContribution,
	type IdeSnippetContribution,
	type IdeThemeContribution,
} from "../shared/ide-extensions";
import { isUnsafeZipPath, readZip } from "./zip";

/**
 * VS Code extensions for the IDE layout: found on Open VSX, installed as
 * folders under the app's data directory, and described to the renderer by
 * what their manifests contribute.
 *
 * Nothing here runs extension code. The renderer applies the declarative
 * contributions — themes, grammars, languages, snippets — to Monaco.
 */

const REQUEST_TIMEOUT_MS = 20_000;
const ICON_TIMEOUT_MS = 6_000;
const MAX_ICON_BYTES = 256 * 1024;
const MAX_VSIX_BYTES = 200 * 1024 * 1024;
/** Text files an extension contributes; nothing it declares should be bigger. */
const MAX_CONTRIBUTED_FILE_BYTES = 8 * 1024 * 1024;

const ICON_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".webp": "image/webp",
};

interface StoredExtension {
	id: string;
	version: string;
	/** Folder name under the store root. */
	folder: string;
	enabled: boolean;
}

interface StoredState {
	extensions: StoredExtension[];
}

type Manifest = Record<string, unknown> & {
	name?: string;
	publisher?: string;
	displayName?: string;
	description?: string;
	version?: string;
	icon?: string;
	main?: string;
	browser?: string;
	contributes?: Record<string, unknown>;
};

/** `ns.name`, the only shape an id may have — it also names folders. */
export function parseExtensionId(id: string): { namespace: string; name: string } {
	const match = /^([a-z0-9][\w-]*)\.([a-z0-9][\w.-]*)$/i.exec(id.trim());
	if (!match) throw new Error(`Invalid extension id: ${id}`);
	return { namespace: match[1]!, name: match[2]! };
}

function stripDotSlash(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * `%key%` placeholders resolved from `package.nls.json`, overlaid with the
 * locale's own file when the extension ships one.
 */
export function localizeManifest(manifest: Manifest, nls: Record<string, unknown>): Manifest {
	const lookup = (value: unknown): unknown => {
		if (typeof value === "string") {
			const match = /^%(.+)%$/.exec(value);
			if (!match) return value;
			const entry = nls[match[1]!];
			if (typeof entry === "string") return entry;
			// Newer bundles store `{ message, comment }`.
			if (entry && typeof entry === "object" && typeof (entry as { message?: unknown }).message === "string") {
				return (entry as { message: string }).message;
			}
			return value;
		}
		if (Array.isArray(value)) return value.map(lookup);
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, lookup(inner)]));
		}
		return value;
	};
	return lookup(manifest) as Manifest;
}

function asArray(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object") : [];
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

/** What a manifest contributes that the IDE can apply, and what it cannot. */
export function readContributions(manifest: Manifest) {
	const contributes = manifest.contributes ?? {};
	const themes: IdeThemeContribution[] = asArray(contributes.themes)
		.filter((theme) => typeof theme.path === "string")
		.map((theme, index) => ({
			id: typeof theme.id === "string" ? theme.id : typeof theme.label === "string" ? theme.label : `theme-${index}`,
			label: typeof theme.label === "string" ? theme.label : `Theme ${index + 1}`,
			uiTheme: typeof theme.uiTheme === "string" ? theme.uiTheme : "vs-dark",
			path: stripDotSlash(theme.path as string),
		}));
	const grammars: IdeGrammarContribution[] = asArray(contributes.grammars)
		.filter((grammar) => typeof grammar.path === "string" && typeof grammar.scopeName === "string")
		.map((grammar) => ({
			...(typeof grammar.language === "string" ? { language: grammar.language } : {}),
			scopeName: grammar.scopeName as string,
			path: stripDotSlash(grammar.path as string),
			...(grammar.embeddedLanguages && typeof grammar.embeddedLanguages === "object"
				? { embeddedLanguages: grammar.embeddedLanguages as Record<string, string> }
				: {}),
			...(strings(grammar.injectTo) ? { injectTo: strings(grammar.injectTo)! } : {}),
		}));
	const languages: IdeLanguageContribution[] = asArray(contributes.languages)
		.filter((language) => typeof language.id === "string")
		.map((language) => ({
			id: language.id as string,
			...(strings(language.extensions) ? { extensions: strings(language.extensions)! } : {}),
			...(strings(language.filenames) ? { filenames: strings(language.filenames)! } : {}),
			...(strings(language.aliases) ? { aliases: strings(language.aliases)! } : {}),
			...(typeof language.configuration === "string" ? { configuration: stripDotSlash(language.configuration) } : {}),
		}));
	const snippets: IdeSnippetContribution[] = asArray(contributes.snippets)
		.filter((snippet) => typeof snippet.language === "string" && typeof snippet.path === "string")
		.map((snippet) => ({ language: snippet.language as string, path: stripDotSlash(snippet.path as string) }));
	const supported = new Set<string>(SUPPORTED_CONTRIBUTIONS);
	return {
		themes,
		grammars,
		languages,
		snippets,
		hasCode: typeof manifest.main === "string" || typeof manifest.browser === "string",
		unsupported: Object.keys(contributes).filter((key) => !supported.has(key)),
	};
}

function iconDataUrl(bytes: Buffer, path: string): string | null {
	const mime = ICON_MIME[extname(path).toLowerCase()];
	if (!mime || bytes.length > MAX_ICON_BYTES) return null;
	return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, timeout = REQUEST_TIMEOUT_MS): Promise<Response> {
	const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeout), headers: { Accept: "application/json" } });
	if (!response.ok) throw new Error(`Open VSX 请求失败（${response.status}）：${url}`);
	return response;
}

export class IdeExtensionStore {
	private locale = "en";

	constructor(
		private readonly root: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	private get statePath(): string {
		return join(this.root, "extensions.json");
	}

	private readState(): StoredState {
		try {
			const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<StoredState>;
			return { extensions: Array.isArray(raw.extensions) ? raw.extensions : [] };
		} catch {
			return { extensions: [] };
		}
	}

	private writeState(state: StoredState): void {
		mkdirSync(this.root, { recursive: true });
		writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
	}

	/** The locale `%placeholders%` resolve in; the renderer's language, not the OS's. */
	setLocale(locale: string): void {
		this.locale = locale.toLowerCase();
	}

	private folderOf(id: string): string {
		const stored = this.readState().extensions.find((entry) => entry.id.toLowerCase() === id.toLowerCase());
		if (!stored) throw new Error(`Extension not installed: ${id}`);
		return join(this.root, stored.folder);
	}

	/** A file inside an installed extension, refusing anything outside its folder. */
	readFile(id: string, relPath: string): string {
		const folder = resolve(this.folderOf(id));
		const target = resolve(folder, stripDotSlash(relPath));
		const rel = relative(folder, target);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(`Path escapes the extension: ${relPath}`);
		}
		if (statSync(target).size > MAX_CONTRIBUTED_FILE_BYTES) throw new Error(`File too large: ${relPath}`);
		return readFileSync(target, "utf8");
	}

	private manifestOf(folder: string): Manifest {
		const manifest = parseJsonc(readFileSync(join(folder, "package.json"), "utf8")) as Manifest;
		const readNls = (file: string): Record<string, unknown> => {
			try {
				return parseJsonc(readFileSync(join(folder, file), "utf8")) as Record<string, unknown>;
			} catch {
				return {};
			}
		};
		const base = readNls("package.nls.json");
		const localized = this.locale.startsWith("zh")
			? { ...readNls("package.nls.zh-cn.json"), ...readNls(`package.nls.${this.locale}.json`) }
			: readNls(`package.nls.${this.locale}.json`);
		return localizeManifest(manifest, { ...base, ...localized });
	}

	private describe(stored: StoredExtension): IdeInstalledExtension | null {
		const folder = join(this.root, stored.folder);
		let manifest: Manifest;
		try {
			manifest = this.manifestOf(folder);
		} catch {
			return null;
		}
		let icon: string | null = null;
		if (typeof manifest.icon === "string") {
			try {
				icon = iconDataUrl(readFileSync(join(folder, stripDotSlash(manifest.icon))), manifest.icon);
			} catch {
				// no icon
			}
		}
		return {
			id: stored.id,
			displayName: manifest.displayName || manifest.name || stored.id,
			description: manifest.description ?? "",
			publisher: manifest.publisher ?? stored.id.split(".")[0] ?? "",
			version: manifest.version ?? stored.version,
			enabled: stored.enabled,
			iconDataUrl: icon,
			...readContributions(manifest),
		};
	}

	snapshot(): IdeExtensionsSnapshot {
		return {
			installed: this.readState()
				.extensions.map((entry) => this.describe(entry))
				.filter((entry): entry is IdeInstalledExtension => entry !== null)
				.sort((a, b) => a.displayName.localeCompare(b.displayName)),
		};
	}

	async search(query: string, size = 30): Promise<IdeExtensionSearchResult> {
		const params = new URLSearchParams({
			query: query.trim(),
			size: String(size),
			offset: "0",
			sortBy: query.trim() ? "relevance" : "downloadCount",
			sortOrder: "desc",
		});
		// Nothing typed: the most installed themes. The most installed
		// extensions overall are language servers, which this IDE cannot run.
		if (!query.trim()) params.set("category", "Themes");
		const response = await fetchWithTimeout(this.fetchImpl, `${OPEN_VSX_URL}/api/-/search?${params}`);
		const body = (await response.json()) as { extensions?: Array<Record<string, any>>; totalSize?: number };
		const raw = (body.extensions ?? []).filter(
			(entry) =>
				typeof entry.namespace === "string" &&
				typeof entry.name === "string" &&
				// The Themes category holds file icon themes too, which this IDE
				// cannot apply; the suggestions leave them out. A search still finds them.
				(query.trim() !== "" || !/icon/i.test(`${entry.name} ${entry.displayName ?? ""}`)),
		);
		const entries: IdeExtensionSearchEntry[] = await Promise.all(
			raw.map(async (entry) => ({
				id: `${entry.namespace}.${entry.name}`,
				namespace: entry.namespace,
				name: entry.name,
				displayName: entry.displayName || entry.name,
				description: entry.description ?? "",
				version: entry.version ?? "",
				downloadCount: Number(entry.downloadCount) || 0,
				verified: entry.verified === true,
				iconDataUrl: typeof entry.files?.icon === "string" ? await this.fetchIcon(entry.files.icon) : null,
			})),
		);
		return { entries, total: body.totalSize ?? entries.length };
	}

	private async fetchIcon(url: string): Promise<string | null> {
		try {
			const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });
			if (!response.ok) return null;
			const bytes = Buffer.from(await response.arrayBuffer());
			return iconDataUrl(bytes, new URL(url).pathname);
		} catch {
			return null;
		}
	}

	/** Install the latest version from Open VSX, checking the download against its published hash. */
	async install(id: string): Promise<IdeExtensionsSnapshot> {
		const { namespace, name } = parseExtensionId(id);
		const response = await fetchWithTimeout(
			this.fetchImpl,
			`${OPEN_VSX_URL}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
		);
		const detail = (await response.json()) as { files?: { download?: string; sha256?: string } };
		const download = detail.files?.download;
		if (!download) throw new Error(`Open VSX 上没有 ${id} 的下载`);
		const vsixResponse = await this.fetchImpl(download, { signal: AbortSignal.timeout(5 * 60_000) });
		if (!vsixResponse.ok) throw new Error(`下载失败（${vsixResponse.status}）`);
		const bytes = Buffer.from(await vsixResponse.arrayBuffer());
		if (detail.files?.sha256) {
			const expected = (await (await fetchWithTimeout(this.fetchImpl, detail.files.sha256)).text()).trim().split(/\s+/)[0]?.toLowerCase();
			const actual = createHash("sha256").update(bytes).digest("hex");
			if (expected && expected !== actual) throw new Error(`${id} 的下载校验失败，已放弃安装`);
		}
		return this.installVsix(bytes);
	}

	/** Install from a `.vsix` archive — downloaded, or picked from disk. */
	installVsix(bytes: Buffer): IdeExtensionsSnapshot {
		if (bytes.length > MAX_VSIX_BYTES) throw new Error("VSIX 文件过大");
		const entries = readZip(bytes);
		const manifestEntry = entries.find((entry) => entry.name === "extension/package.json");
		if (!manifestEntry) throw new Error("这不是一个 VS Code 扩展包（缺少 extension/package.json）");
		const manifest = parseJsonc(manifestEntry.read().toString("utf8")) as Manifest;
		if (typeof manifest.publisher !== "string" || typeof manifest.name !== "string") {
			throw new Error("扩展清单缺少 publisher 或 name");
		}
		const id = `${manifest.publisher}.${manifest.name}`;
		parseExtensionId(id);
		const version = typeof manifest.version === "string" ? manifest.version.replace(/[^\w.+-]/g, "") : "0.0.0";
		const folder = `${id.toLowerCase()}-${version}`;
		const staging = join(this.root, `.staging-${folder}-${Date.now()}`);

		mkdirSync(staging, { recursive: true });
		try {
			for (const entry of entries) {
				if (!entry.name.startsWith("extension/") || entry.isDirectory) continue;
				const rel = entry.name.slice("extension/".length);
				if (!rel || isUnsafeZipPath(rel)) throw new Error(`扩展包里有不安全的路径：${entry.name}`);
				const target = join(staging, ...rel.split("/"));
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, entry.read());
			}
			const state = this.readState();
			const previous = state.extensions.find((entry) => entry.id.toLowerCase() === id.toLowerCase());
			const destination = join(this.root, folder);
			if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
			renameSync(staging, destination);
			if (previous && previous.folder !== folder) rmSync(join(this.root, previous.folder), { recursive: true, force: true });
			this.writeState({
				extensions: [
					...state.extensions.filter((entry) => entry !== previous),
					{ id, version, folder, enabled: previous?.enabled ?? true },
				],
			});
		} finally {
			if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
		}
		return this.snapshot();
	}

	uninstall(id: string): IdeExtensionsSnapshot {
		const state = this.readState();
		const stored = state.extensions.find((entry) => entry.id.toLowerCase() === id.toLowerCase());
		if (stored) {
			rmSync(join(this.root, stored.folder), { recursive: true, force: true });
			this.writeState({ extensions: state.extensions.filter((entry) => entry !== stored) });
		}
		return this.snapshot();
	}

	setEnabled(id: string, enabled: boolean): IdeExtensionsSnapshot {
		const state = this.readState();
		this.writeState({
			extensions: state.extensions.map((entry) => (entry.id.toLowerCase() === id.toLowerCase() ? { ...entry, enabled } : entry)),
		});
		return this.snapshot();
	}

	/** Folders left behind by an interrupted install. */
	cleanStaging(): void {
		try {
			for (const entry of readdirSync(this.root)) {
				if (entry.startsWith(".staging-")) rmSync(join(this.root, entry), { recursive: true, force: true });
			}
		} catch {
			// nothing installed yet
		}
	}
}
