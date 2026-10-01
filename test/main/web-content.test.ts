import { describe, expect, test } from "bun:test";
import { decodeBody, detectCharset, htmlToMarkdown } from "../../src/main/web-content";

describe("htmlToMarkdown", () => {
	test("keeps the article and drops the chrome around it", () => {
		const { title, markdown } = htmlToMarkdown(
			`<html><head><title>Docs · Example</title><style>p{}</style></head><body>
				<nav><a href="/">Home</a> <a href="/blog">Blog</a></nav>
				<article>
					<header><h1>Getting  started</h1></header>
					<p>Install the <strong>package</strong> and read <a href="/guide">the guide</a>.</p>
					<p>It works with <code>node  22</code> and later.</p>
					<script>track()</script>
				</article>
				<footer>© 2026</footer>
			</body></html>`,
			"https://example.com/docs/start",
		);
		expect(title).toBe("Docs · Example");
		expect(markdown).toBe(
			"# Getting started\n\nInstall the **package** and read [the guide](https://example.com/guide).\n\nIt works with `node 22` and later.",
		);
	});

	test("falls back to the body when no article holds the page", () => {
		const { markdown } = htmlToMarkdown(
			`<body><header>Site</header><article><p>teaser</p></article><div><p>${"The real content. ".repeat(20)}</p></div></body>`,
		);
		expect(markdown).not.toContain("Site");
		expect(markdown).toContain("teaser");
		expect(markdown).toContain("The real content.");
	});

	test("keeps code blocks verbatim, with their language", () => {
		const { markdown } = htmlToMarkdown(
			`<body><p>Run:</p><pre><code class="language-ts">const a  = 1;\n\n\n  return a;</code></pre></body>`,
		);
		expect(markdown).toBe("Run:\n\n```ts\nconst a  = 1;\n\n\n  return a;\n```");
	});

	test("renders nested lists, quotes and tables", () => {
		const { markdown } = htmlToMarkdown(`<body>
			<ol start="3"><li>one<ul><li>inner</li></ul></li><li>two</li></ol>
			<blockquote><p>quoted</p><p>twice</p></blockquote>
			<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a|b</td><td>1</td></tr></tbody></table>
		</body>`);
		expect(markdown).toBe(
			[
				"3. one",
				"     - inner",
				"4. two",
				"",
				"> quoted",
				">",
				"> twice",
				"",
				"| Name | Value |",
				"| --- | --- |",
				"| a\\|b | 1 |",
			].join("\n"),
		);
	});

	test("skips links and images that carry nothing readable", () => {
		const { markdown } = htmlToMarkdown(
			`<body><p><a href="javascript:void(0)">menu</a> <a href="#top">top</a> <img src="/a.png"> <img src="/b.png" alt="Diagram"></p></body>`,
			"https://example.com/",
		);
		expect(markdown).toBe("menu top ![Diagram](https://example.com/b.png)");
	});
});

describe("charset", () => {
	test("prefers the header, then the page's meta tag", () => {
		const head = new TextEncoder().encode('<html><head><meta charset="gbk"></head>');
		expect(detectCharset("text/html; charset=Shift_JIS", head)).toBe("shift_jis");
		expect(detectCharset("text/html", head)).toBe("gbk");
		expect(detectCharset(null, new Uint8Array())).toBe("utf-8");
	});

	test("decodes GBK pages and survives an unknown charset", () => {
		// "中文" in GBK.
		expect(decodeBody(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), "gbk")).toBe("中文");
		expect(decodeBody(new TextEncoder().encode("ok"), "no-such-charset")).toBe("ok");
	});
});
