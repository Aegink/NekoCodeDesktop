import { createContext, useContext } from "react";
import type { AgentCell } from "../../../shared/agent";

/**
 * Web sources in answers: where a link opens, what a cited page is called, and
 * which pages an answer cites.
 */

export type OpenLink = (url: string) => void;

/** Outside the desktop window's dock — the WebUI, the IDE layout — a link opens in a browser. */
export const openLinkExternally: OpenLink = (url) => {
	window.open(url, "_blank", "noopener,noreferrer");
};

/**
 * Where a link in an answer opens. The desktop app points this at the dock's
 * browser; a plain `<a href>` would navigate the app window itself.
 */
export const LinkOpenerContext = createContext<OpenLink>(openLinkExternally);

export function useOpenLink(): OpenLink {
	return useContext(LinkOpenerContext);
}

export function isWebUrl(href: string | undefined): href is string {
	return !!href && /^https?:\/\//i.test(href);
}

/** One key for the spellings of a URL a model and a search engine disagree on. */
export function sourceKey(url: string): string {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : "";
		return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${path}${parsed.search}`;
	} catch {
		return url;
	}
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Page titles the session's web tools have seen, by {@link sourceKey}.
 *
 * Read from the tools' structured details rather than their text, so a title
 * is exactly what the search engine or the page said.
 */
export function collectWebTitles(cells: readonly AgentCell[]): Map<string, string> {
	const titles = new Map<string, string>();
	for (const cell of cells) {
		if (cell.type !== "tool") continue;
		const details = record(cell.details);
		if (!details) continue;
		if (cell.toolName === "web_search" && Array.isArray(details.results)) {
			for (const entry of details.results) {
				const result = record(entry);
				if (typeof result?.url === "string" && typeof result.title === "string" && result.title)
					titles.set(sourceKey(result.url), result.title);
			}
		} else if (cell.toolName === "web_fetch" && typeof details.title === "string" && details.title) {
			// What the page calls itself beats the engine's truncated listing.
			for (const url of [details.url, details.finalUrl])
				if (typeof url === "string") titles.set(sourceKey(url), details.title);
		}
	}
	return titles;
}

export const WebTitlesContext = createContext<ReadonlyMap<string, string>>(new Map());

export function useWebTitle(url: string): string | undefined {
	return useContext(WebTitlesContext).get(sourceKey(url));
}

/** A citation marker's text: a bare number, as the prompt asks the model to write it. */
export function isCitationLabel(text: string): boolean {
	return /^\d{1,3}$/.test(text.trim());
}

export interface Citation {
	label: string;
	url: string;
}

/**
 * The pages an answer cites, in the order it first cites them.
 *
 * A citation is a markdown link whose text is a number — `[1](https://…)`.
 * Fenced and inline code are skipped: an example of the syntax is not a source.
 */
export function extractCitations(markdown: string): Citation[] {
	const prose = markdown.replace(/```[\s\S]*?(```|$)/g, "").replace(/`[^`\n]*`/g, "");
	const seen = new Set<string>();
	const citations: Citation[] = [];
	for (const match of prose.matchAll(/\[(\d{1,3})\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
		const key = sourceKey(match[2]);
		if (seen.has(key)) continue;
		seen.add(key);
		citations.push({ label: match[1], url: match[2] });
	}
	return citations;
}
