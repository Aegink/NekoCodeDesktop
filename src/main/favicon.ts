import { load } from "cheerio/slim";
import { BROWSER_USER_AGENT } from "./web-search";

/**
 * Site icons for the web sources under an answer.
 *
 * Fetched here rather than by the renderer because the renderer's CSP does not
 * load remote images, and should not: a page the agent read could otherwise
 * plant an image URL in an answer and learn, from the request, that — and
 * with what in the query string — it was shown. Main fetches the icon through
 * the app's proxy and hands the window a data URL.
 */

const TIMEOUT_MS = 6_000;
/** An icon is a few kilobytes; past this it is not an icon. */
const MAX_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const CACHE_ENTRIES = 500;

/** By origin: every page of a site shares its icon. Failures are cached too, as null. */
const cache = new Map<string, Promise<string | null>>();

async function readCapped(response: Response, cap: number): Promise<Buffer | null> {
	if (Number(response.headers.get("content-length")) > cap) return null;
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

function request(url: string, accept: string): Promise<Response> {
	return fetch(url, {
		redirect: "follow",
		headers: { "User-Agent": BROWSER_USER_AGENT, Accept: accept },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
}

/** The icon a page declares, preferring the largest small one. */
export function declaredIcon(html: string, pageUrl: string): string | null {
	const $ = load(html);
	const candidates = $("link[rel][href]")
		.toArray()
		.filter((element) => /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(element.attribs.rel ?? ""))
		.map((element) => {
			const size = Number.parseInt(/(\d+)x\d+/.exec(element.attribs.sizes ?? "")?.[1] ?? "0", 10);
			const apple = /apple-touch-icon/i.test(element.attribs.rel ?? "");
			// A 32px icon renders crisply at 16; a 180px touch icon is a download for nothing.
			return { href: element.attribs.href, score: apple ? 1 : size === 0 ? 2 : size <= 64 ? 3 : 1.5 };
		})
		.sort((a, b) => b.score - a.score);
	for (const candidate of candidates) {
		try {
			return new URL(candidate.href, pageUrl).toString();
		} catch {
			// A malformed href; try the next.
		}
	}
	return null;
}

async function iconData(url: string): Promise<string | null> {
	const response = await request(url, "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5");
	if (!response.ok) {
		await response.body?.cancel();
		return null;
	}
	const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	// SVG is script-capable; an <img> will not run it, but there is no reason to carry it either.
	if (!type.startsWith("image/") || type === "image/svg+xml") {
		await response.body?.cancel();
		return null;
	}
	const bytes = await readCapped(response, MAX_BYTES);
	return bytes && bytes.byteLength > 0 ? `data:${type};base64,${bytes.toString("base64")}` : null;
}

async function resolve(origin: string): Promise<string | null> {
	try {
		const page = await request(`${origin}/`, "text/html");
		if (page.ok && (page.headers.get("content-type") ?? "").includes("html")) {
			const html = await readCapped(page, MAX_HTML_BYTES);
			const declared = html ? declaredIcon(html.toString("utf8"), page.url || `${origin}/`) : null;
			if (declared) {
				const data = await iconData(declared).catch(() => null);
				if (data) return data;
			}
		} else {
			await page.body?.cancel();
		}
	} catch {
		// Unreachable home page: the conventional path may still answer.
	}
	return iconData(`${origin}/favicon.ico`).catch(() => null);
}

/** A data URL for the site's icon, or null when it has none the window can show. */
export function faviconFor(pageUrl: string): Promise<string | null> {
	let origin: string;
	try {
		const url = new URL(pageUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return Promise.resolve(null);
		origin = url.origin;
	} catch {
		return Promise.resolve(null);
	}
	const hit = cache.get(origin);
	if (hit) return hit;
	const pending = resolve(origin);
	cache.set(origin, pending);
	while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
	return pending;
}
