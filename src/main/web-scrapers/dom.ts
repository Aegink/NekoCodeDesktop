import { load, type CheerioAPI } from "cheerio";
import type { AnyNode, Element as CheerioNode } from "domhandler";

/**
 * The slice of the DOM the site handlers read — `querySelector(All)`,
 * `textContent`, `innerHTML`, `getAttribute`, `parentElement`, `tagName` —
 * over cheerio, which web_fetch already uses. Upstream parsed with a full
 * DOM; nothing here writes to the tree, so a read-only wrapper is enough.
 */
export class DomElement {
	constructor(
		private readonly $: CheerioAPI,
		private readonly node: AnyNode,
	) {}

	querySelector(selector: string): DomElement | null {
		const found = this.$(this.node).find(selector).get(0);
		return found ? new DomElement(this.$, found) : null;
	}

	querySelectorAll(selector: string): DomElement[] {
		return this.$(this.node)
			.find(selector)
			.toArray()
			.map((node) => new DomElement(this.$, node));
	}

	get textContent(): string {
		return this.$(this.node).text();
	}

	get innerHTML(): string {
		return this.$(this.node).html() ?? "";
	}

	get tagName(): string {
		return ((this.node as CheerioNode).tagName ?? "").toUpperCase();
	}

	get parentElement(): DomElement | null {
		const parent = this.node.parent;
		return parent && parent.type === "tag" ? new DomElement(this.$, parent) : null;
	}

	getAttribute(name: string): string | null {
		return this.$(this.node).attr(name) ?? null;
	}
}

export type Element = DomElement;
export type HTMLElement = DomElement;

export function parseHTML(html: string): { document: DomElement } {
	const $ = load(html);
	return { document: new DomElement($, $.root().get(0) as AnyNode) };
}
