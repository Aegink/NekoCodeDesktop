import { load, type CheerioAPI } from "cheerio/slim";
import type { AnyNode, Element } from "domhandler";

/**
 * Turning a fetched web page into something a model can read.
 *
 * Deliberately small: headings, paragraphs, links, lists, code, quotes and
 * tables survive; layout, scripts and chrome do not. The point is to hand the
 * model the article, not to reproduce the page — a faithful converter would
 * spend the context window on navigation menus.
 */

/** Never content, wherever they appear. */
const ALWAYS_DROP =
	"script,style,noscript,template,svg,canvas,iframe,object,embed,form,button,input,select,textarea,dialog,link,meta,[hidden],[aria-hidden=true]";

/** Site chrome. Dropped outright when the whole body is the root. */
const CHROME = "nav,aside,footer,header,[role=navigation],[role=banner],[role=contentinfo]";

/**
 * A candidate root must hold at least this share of the body's text to be
 * trusted over the body. A lone `<article>` teaser card on a listing page is
 * not the page.
 */
const ROOT_MIN_SHARE = 0.3;

const BLOCK_TAGS = new Set([
	"p", "div", "section", "article", "main", "figure", "figcaption", "details", "summary",
	"dl", "dt", "dd", "address", "center", "body", "html",
]);

interface Context {
	base: URL | null;
	/** Code blocks are parked here so whitespace clean-up cannot touch them. */
	code: string[];
	listDepth: number;
}

export interface PageContent {
	title: string | null;
	markdown: string;
}

function absolute(href: string | undefined, base: URL | null): string | null {
	if (!href) return null;
	const trimmed = href.trim();
	if (!trimmed || trimmed.startsWith("#") || /^(javascript|data|mailto|tel):/i.test(trimmed)) return null;
	try {
		return new URL(trimmed, base ?? undefined).toString();
	} catch {
		return null;
	}
}

function textLength($: CheerioAPI, node: Element): number {
	return $(node).text().replace(/\s+/g, "").length;
}

/** The part of the page that is the page: the main article when one stands out, else the body. */
function pickRoot($: CheerioAPI): { root: Element | null; isBody: boolean } {
	const body = $("body").get(0) ?? null;
	const bodyLength = body ? textLength($, body) : 0;
	let best: Element | null = null;
	let bestLength = 0;
	for (const candidate of $("article, main, [role=main]").toArray()) {
		const length = textLength($, candidate);
		if (length > bestLength) {
			best = candidate;
			bestLength = length;
		}
	}
	if (best && bodyLength > 0 && bestLength / bodyLength >= ROOT_MIN_SHARE) return { root: best, isBody: false };
	return { root: body, isBody: true };
}

function codeLanguage(node: Element): string {
	const classes = [node.attribs?.class ?? "", ...node.children.map((child) => (child as Element).attribs?.class ?? "")].join(" ");
	return /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1] ?? "";
}

function inline(text: string): string {
	return text.replace(/\s+/g, " ");
}

function children(node: Element, ctx: Context): string {
	return node.children.map((child) => render(child, ctx)).join("");
}

function block(content: string): string {
	const trimmed = content.trim();
	return trimmed ? `\n\n${trimmed}\n\n` : "";
}

function renderList(node: Element, ctx: Context): string {
	const ordered = node.name === "ol";
	const start = Number.parseInt(node.attribs?.start ?? "1", 10) || 1;
	const indent = "  ".repeat(ctx.listDepth);
	ctx.listDepth++;
	const items: string[] = [];
	let index = start;
	for (const child of node.children) {
		if (child.type !== "tag" || (child as Element).name !== "li") continue;
		const marker = ordered ? `${index++}. ` : "- ";
		const body = children(child as Element, ctx)
			.trim()
			.replace(/\n{2,}/g, "\n")
			// Continuation lines line up under the item's text.
			.replace(/\n/g, `\n${indent}${" ".repeat(marker.length)}`);
		if (body) items.push(`${indent}${marker}${body}`);
	}
	ctx.listDepth--;
	const list = items.join("\n");
	return ctx.listDepth > 0 ? `\n${list}\n` : block(list);
}

function cell(node: Element, ctx: Context): string {
	return children(node, ctx).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function renderTable(node: Element, ctx: Context): string {
	const rows = tableRows(node)
		.map((row) => row.children.filter((c): c is Element => c.type === "tag" && (c.name === "td" || c.name === "th")))
		.filter((row) => row.length > 0);
	if (rows.length === 0) return "";
	const width = Math.max(...rows.map((row) => row.length));
	const lines = rows.map((row) => {
		const cells = row.map((c) => cell(c, ctx));
		while (cells.length < width) cells.push("");
		return `| ${cells.join(" | ")} |`;
	});
	lines.splice(1, 0, `|${" --- |".repeat(width)}`);
	return block(lines.join("\n"));
}

/** Rows of a table in document order, not descending into nested tables. */
function tableRows(table: Element): Element[] {
	const rows: Element[] = [];
	const walk = (node: Element) => {
		for (const child of node.children) {
			if (child.type !== "tag") continue;
			const element = child as Element;
			if (element.name === "tr") rows.push(element);
			else if (element.name !== "table") walk(element);
		}
	};
	walk(table);
	return rows;
}

/** The raw text under a node, whitespace untouched — what code needs. */
function textOf(node: AnyNode): string {
	if (node.type === "text") return (node as unknown as { data: string }).data;
	if (node.type !== "tag") return "";
	const element = node as Element;
	return element.name === "br" ? "\n" : element.children.map(textOf).join("");
}

function render(node: AnyNode, ctx: Context): string {
	if (node.type === "text") return inline(textOf(node));
	if (node.type !== "tag") return "";
	const element = node as Element;
	const tag = element.name;
	switch (tag) {
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6": {
			const text = inline(children(element, ctx)).trim();
			return text ? `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n` : "";
		}
		case "br":
			return "\n";
		case "hr":
			return "\n\n---\n\n";
		case "a": {
			const text = inline(children(element, ctx)).trim();
			if (!text) return "";
			const href = absolute(element.attribs?.href, ctx.base);
			return href && href !== text ? `[${text}](${href})` : text;
		}
		case "img": {
			const alt = inline(element.attribs?.alt ?? "").trim();
			const src = absolute(element.attribs?.src, ctx.base);
			// An image with no alt text says nothing a reader of text can use.
			return alt && src ? `![${alt}](${src})` : "";
		}
		case "strong":
		case "b": {
			const text = children(element, ctx).trim();
			return text ? `**${text}**` : "";
		}
		case "em":
		case "i": {
			const text = children(element, ctx).trim();
			return text ? `*${text}*` : "";
		}
		case "del":
		case "s": {
			const text = children(element, ctx).trim();
			return text ? `~~${text}~~` : "";
		}
		case "code": {
			const text = textOf(element);
			return text ? `\`${text.replace(/\s+/g, " ")}\`` : "";
		}
		case "pre": {
			const text = textOf(element).replace(/^\n+|\s+$/g, "");
			if (!text) return "";
			ctx.code.push(`\`\`\`${codeLanguage(element)}\n${text}\n\`\`\``);
			return `\n\n\u0000${ctx.code.length - 1}\u0000\n\n`;
		}
		case "ul":
		case "ol":
			return renderList(element, ctx);
		case "blockquote": {
			const text = children(element, ctx).trim().replace(/\n{3,}/g, "\n\n");
			return text ? block(text.replace(/^/gm, "> ")) : "";
		}
		case "table":
			return renderTable(element, ctx);
		case "li":
			// Outside a list, which malformed pages do produce.
			return block(`- ${children(element, ctx).trim()}`);
		default:
			return BLOCK_TAGS.has(tag) ? block(children(element, ctx)) : children(element, ctx);
	}
}

function tidy(markdown: string, code: readonly string[]): string {
	return markdown
		.split("\n")
		// Dropped inline elements leave their neighbours' spaces doubled; leading
		// indentation is list structure and stays.
		.map((line) => line.replace(/[ \t]+$/g, "").replace(/(\S) {2,}/g, "$1 "))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)] ?? "")
		.trim();
}

/** Readable markdown and the title of an HTML page. */
export function htmlToMarkdown(html: string, url?: string): PageContent {
	const $ = load(html);
	const title =
		$("meta[property='og:title']").attr("content")?.trim() ||
		$("title").first().text().replace(/\s+/g, " ").trim() ||
		null;
	$(ALWAYS_DROP).remove();
	const { root, isBody } = pickRoot($);
	if (!root) return { title, markdown: "" };
	// Inside a chosen article a `<header>` usually holds its headline, so only
	// the unambiguous chrome goes; on the whole body everything of the kind does.
	$(root).find(isBody ? CHROME : "nav,aside,footer,[role=navigation]").remove();
	let base: URL | null = null;
	try {
		const declared = $("base[href]").attr("href");
		base = url ? new URL(declared ?? url, url) : declared ? new URL(declared) : null;
	} catch {
		base = null;
	}
	const ctx: Context = { base, code: [], listDepth: 0 };
	return { title, markdown: tidy(render(root, ctx), ctx.code) };
}

/**
 * The charset a response declares, from its header or, failing that, the
 * page's own `<meta>`. A lot of the Chinese web is still GBK, and decoding it
 * as UTF-8 hands the model mojibake.
 */
export function detectCharset(contentType: string | null, head: Uint8Array): string {
	const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
	if (fromHeader) return fromHeader.toLowerCase();
	const sniff = new TextDecoder("latin1").decode(head.subarray(0, 4096));
	const fromMeta =
		/<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1] ??
		/<\?xml[^>]+encoding=["']([\w-]+)/i.exec(sniff)?.[1];
	return (fromMeta ?? "utf-8").toLowerCase();
}

/** Decode with the declared charset, falling back to UTF-8 for one the runtime does not know. */
export function decodeBody(bytes: Uint8Array, charset: string): string {
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}
