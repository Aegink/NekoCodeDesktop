import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter as parseRuleFrontmatter } from "../foreign-rules";

/**
 * The handful of oh-my-pi utilities the site handlers in this directory use,
 * reimplemented so the handlers can be carried over verbatim — see NOTICE.
 * Each keeps the signature the handlers call it with.
 */

export const USER_AGENT = "NekoCode (+https://github.com/moraxs)";

/** Reads process.env; kept as a name because the handlers look tokens up through it. */
export const $env = process.env;

export function tryParseJson<T = unknown>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isEnoent(error: unknown): boolean {
	return (error as { code?: string } | null)?.code === "ENOENT";
}

export const logger = {
	warn: (message: string, ...rest: unknown[]) => console.warn(`[web-scrapers] ${message}`, ...rest),
};

export const ptree = {
	/** The caller's signal and a timeout in milliseconds, whichever fires first. */
	combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
		const timeout = AbortSignal.timeout(timeoutMs);
		return signal ? AbortSignal.any([signal, timeout]) : timeout;
	},
};

export class ToolAbortError extends Error {
	constructor(message = "Operation aborted") {
		super(message);
		this.name = "ToolAbortError";
	}
}

/** No session storage is handed to the handlers; the parameter stays for their signature. */
export type AgentStorage = never;

function trim1(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

/** 1234 → "1.2K", 12_345_678 → "12M". */
export function formatNumber(n: number): string {
	if (n < 1_000) return n.toString();
	if (n < 10_000) return `${trim1(n / 1_000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
	if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
	return `${Math.round(n / 1_000_000_000)}B`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

/** Dotted versions compared numerically part by part; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
	const split = (version: string) => {
		const [core, pre] = version.replace(/^v/i, "").split("-", 2);
		return { core: core.split(/[.+]/).map((part) => Number.parseInt(part, 10) || 0), pre };
	};
	const left = split(a);
	const right = split(b);
	for (let index = 0; index < Math.max(left.core.length, right.core.length); index++) {
		const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
		if (difference !== 0) return difference;
	}
	if (left.pre && !right.pre) return -1;
	if (!left.pre && right.pre) return 1;
	return (left.pre ?? "").localeCompare(right.pre ?? "");
}

/**
 * Where docs.rs rustdoc JSON is cached between fetches. A cache the OS may
 * clear is the right home: losing it costs one download.
 */
export function getDocsRsCacheDir(): string {
	return join(tmpdir(), "nekocode-web-cache", "docs-rs");
}

export function parseFrontmatter(
	content: string,
	_options?: { source?: string },
): { frontmatter: Record<string, unknown>; body: string } {
	const { data, body } = parseRuleFrontmatter(content);
	return { frontmatter: data, body };
}
