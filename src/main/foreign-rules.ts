import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

/**
 * Rules a project already wrote for other coding tools, read where they are.
 *
 * pi loads one of AGENTS.override.md / AGENTS.md / CLAUDE.md per directory.
 * Teams often have their conventions somewhere else — Cursor's `.cursor/rules`,
 * Windsurf, Cline, Copilot's instruction files, GEMINI.md — and asking them to
 * copy those into AGENTS.md is asking them to keep two copies in sync. So they
 * are read in their native shape, the way oh-my-pi does (see
 * docs/oh-my-pi-porting-checklist.md), and fed to the session beside AGENTS.md.
 *
 * A rule that always applies goes in whole. One that only applies to some
 * files or some situations cannot be decided when the prompt is built, so it
 * goes in as one line of an index — name, scope, description, path — and the
 * model reads the file when its work turns that way.
 */

export interface ForeignRule {
	name: string;
	/** Absolute. */
	path: string;
	/** Which tool wrote it, for the index and the settings page. */
	source: string;
	content: string;
	alwaysApply: boolean;
	globs?: string[];
	description?: string;
}

/** Longest single rule put into the prompt whole. */
const MAX_RULE_BYTES = 32 * 1024;
/** Budget for all always-apply rules together; past it they drop to the index. */
const MAX_ALWAYS_BYTES = 96 * 1024;
const MAX_FILES_PER_DIR = 200;

type Frontmatter = Record<string, string | string[] | boolean>;

function unquote(value: string): string {
	const trimmed = value.trim();
	return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function parseValue(raw: string): string | string[] | boolean {
	const value = raw.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	if (value.startsWith("[") && value.endsWith("]"))
		return value
			.slice(1, -1)
			.split(",")
			.map(unquote)
			.filter(Boolean);
	return unquote(value);
}

/**
 * The flat YAML these files use: `key: value`, one-line `[a, b]` lists, and
 * indented `- item` lists. Anything more elaborate is not something a rule
 * file's header carries.
 */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
	const source = text.replace(/^\uFEFF/, "");
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
	if (!match) return { data: {}, body: source.trim() };
	const data: Frontmatter = {};
	let listKey: string | null = null;
	for (const line of match[1].split(/\r?\n/)) {
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && listKey) {
			const current = data[listKey];
			data[listKey] = [...(Array.isArray(current) ? current : []), unquote(item[1])];
			continue;
		}
		const pair = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
		if (!pair) continue;
		listKey = pair[2].trim() === "" ? pair[1] : null;
		data[pair[1]] = pair[2].trim() === "" ? [] : parseValue(pair[2]);
	}
	return { data, body: source.slice(match[0].length).trim() };
}

function list(value: Frontmatter[string] | undefined): string[] | undefined {
	if (value === undefined || typeof value === "boolean") return undefined;
	const items = (Array.isArray(value) ? value : value.split(",")).map((entry) => entry.trim()).filter(Boolean);
	return items.length ? items : undefined;
}

function text(value: Frontmatter[string] | undefined): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readText(path: string): string | null {
	try {
		if (!statSync(path).isFile()) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Files under `dir` whose names satisfy `accept`, recursively, sorted for a stable prompt. */
function filesIn(dir: string, accept: (name: string) => boolean, recursive = true): string[] {
	const out: string[] = [];
	const walk = (current: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (out.length >= MAX_FILES_PER_DIR) return;
			const path = join(current, entry.name);
			if (entry.isDirectory() && recursive) walk(path);
			else if (entry.isFile() && accept(entry.name)) out.push(path);
		}
	};
	walk(dir);
	return out;
}

function stem(path: string): string {
	return basename(path).replace(/\.instructions\.md$/i, "").replace(/\.(?:mdc|md|txt)$/i, "");
}

/** `.cursor/rules` and `.agents/rules`: alwaysApply / globs / description, as Cursor defines them. */
function cursorStyle(path: string, source: string): ForeignRule | null {
	const raw = readText(path);
	if (raw === null) return null;
	const { data, body } = parseFrontmatter(raw);
	if (!body) return null;
	const hasHeader = Object.keys(data).length > 0;
	return {
		name: stem(path),
		path,
		source,
		content: body,
		// A file with no header at all has nothing restricting it.
		alwaysApply: data.alwaysApply === true || !hasHeader,
		globs: list(data.globs),
		description: text(data.description),
	};
}

function whole(path: string, source: string, name = stem(path)): ForeignRule | null {
	const raw = readText(path);
	const body = raw === null ? "" : parseFrontmatter(raw).body;
	return body ? { name, path, source, content: body, alwaysApply: true } : null;
}

function windsurf(path: string): ForeignRule | null {
	const raw = readText(path);
	if (raw === null) return null;
	const { data, body } = parseFrontmatter(raw);
	if (!body) return null;
	const trigger = text(data.trigger) ?? "always_on";
	// A manual rule only applies when someone @-mentions it.
	if (trigger === "manual") return null;
	return {
		name: stem(path),
		path,
		source: "Windsurf",
		content: body,
		alwaysApply: trigger === "always_on",
		globs: trigger === "glob" ? list(data.globs) : undefined,
		description: text(data.description),
	};
}

function cline(path: string): ForeignRule | null {
	const raw = readText(path);
	if (raw === null) return null;
	const { data, body } = parseFrontmatter(raw);
	if (!body) return null;
	const globs = list(data.paths) ?? list(data.globs);
	return { name: stem(path), path, source: "Cline", content: body, alwaysApply: !globs, globs };
}

/** Copilot's `*.instructions.md`: `applyTo` is a comma-separated glob list; `**` means everything. */
function copilot(path: string): ForeignRule | null {
	const raw = readText(path);
	if (raw === null) return null;
	const { data, body } = parseFrontmatter(raw);
	if (!body) return null;
	const applyTo = list(data.applyTo);
	const everywhere = applyTo?.some((glob) => ["*", "**", "**/*"].includes(glob)) ?? false;
	return {
		name: stem(path),
		path,
		source: "Copilot",
		content: body,
		alwaysApply: everywhere,
		globs: everywhere ? undefined : applyTo,
		description: text(data.description),
	};
}

function claudeRule(path: string): ForeignRule | null {
	const raw = readText(path);
	if (raw === null) return null;
	const { data, body } = parseFrontmatter(raw);
	if (!body) return null;
	const globs = list(data.paths);
	return { name: stem(path), path, source: "Claude Code", content: body, alwaysApply: !globs, globs, description: text(data.description) };
}

function normalizeText(value: string): string {
	return value.replace(/\r\n/g, "\n").trim();
}

/**
 * Every rule another tool keeps in `dir`. Skips what pi already loads: the
 * first of AGENTS.override.md / AGENTS.md / CLAUDE.md in a directory.
 */
function rulesIn(dir: string): ForeignRule[] {
	const rules: ForeignRule[] = [];
	const add = (rule: ForeignRule | null) => {
		if (rule) rules.push(rule);
	};
	const markdown = (name: string) => /\.(?:md|mdc)$/i.test(name);

	for (const path of filesIn(join(dir, ".cursor", "rules"), markdown)) add(cursorStyle(path, "Cursor"));
	add(whole(join(dir, ".cursorrules"), "Cursor", "cursorrules"));
	for (const rulesDir of [".agents", ".agent"])
		for (const path of filesIn(join(dir, rulesDir, "rules"), markdown)) add(cursorStyle(path, "Agents"));
	for (const path of filesIn(join(dir, ".windsurf", "rules"), markdown)) add(windsurf(path));
	add(whole(join(dir, ".windsurfrules"), "Windsurf", "windsurfrules"));

	const clinePath = join(dir, ".clinerules");
	if (existsSync(clinePath)) {
		if (statSync(clinePath).isDirectory())
			for (const path of filesIn(clinePath, (name) => /\.(?:md|txt)$/i.test(name))) add(cline(path));
		else add(whole(clinePath, "Cline", "clinerules"));
	}

	add(whole(join(dir, ".github", "copilot-instructions.md"), "Copilot", "copilot-instructions"));
	for (const path of filesIn(join(dir, ".github", "instructions"), (name) => /\.instructions\.md$/i.test(name))) add(copilot(path));

	for (const path of filesIn(join(dir, ".claude", "rules"), markdown)) add(claudeRule(path));
	add(whole(join(dir, "GEMINI.md"), "Gemini", "GEMINI"));

	// pi reads only the first context file in a directory. A CLAUDE.md beside an
	// AGENTS.md is skipped there — unless it is just a copy, it says something.
	const agents = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD"].map((name) => readText(join(dir, name))).find((value) => value !== null);
	const claude = readText(join(dir, "CLAUDE.md")) ?? readText(join(dir, "CLAUDE.MD"));
	if (agents != null && claude !== null && normalizeText(claude) !== normalizeText(agents)) add(whole(join(dir, "CLAUDE.md"), "Claude Code", "CLAUDE"));
	return rules;
}

/** Foreign rules for a session in `cwd`: the checkout root's, then `cwd`'s own when it is deeper. */
export function discoverForeignRules(cwd: string, root: string): ForeignRule[] {
	const dirs = [resolve(root)];
	if (resolve(cwd) !== resolve(root)) dirs.push(resolve(cwd));
	const seen = new Set<string>();
	const rules: ForeignRule[] = [];
	for (const dir of dirs) {
		for (const rule of rulesIn(dir)) {
			const key = resolve(rule.path).toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			rules.push(rule);
		}
	}
	return rules;
}

/** Whether writing `path` changes a rule this module reads — the prompt then needs rebuilding. */
export function isForeignRulePath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return (
		/(?:^|\/)\.(?:cursor|windsurf|agents?|claude)\/rules\//.test(normalized) ||
		/(?:^|\/)\.clinerules(?:\/|$)/.test(normalized) ||
		/(?:^|\/)\.(?:cursorrules|windsurfrules)$/.test(normalized) ||
		/(?:^|\/)\.github\/(?:copilot-instructions\.md$|instructions\/.+\.instructions\.md$)/.test(normalized) ||
		/(?:^|\/)GEMINI\.md$/.test(normalized)
	);
}

function clip(content: string): string {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes <= MAX_RULE_BYTES) return content;
	return `${Buffer.from(content, "utf8").subarray(0, MAX_RULE_BYTES).toString("utf8").replace(/\uFFFD*$/, "")}\n\n[… truncated; read the file for the rest]`;
}

/**
 * The context-file entries these rules become: always-apply rules whole, in
 * discovery order, until the budget is spent; everything else — and whatever
 * the budget did not fit — as one index entry.
 */
export function foreignRuleContextFiles(rules: readonly ForeignRule[], root: string): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];
	const indexed: ForeignRule[] = [];
	let used = 0;
	for (const rule of rules) {
		if (!rule.alwaysApply) {
			if (rule.globs || rule.description) indexed.push(rule);
			continue;
		}
		const content = clip(rule.content);
		const size = Buffer.byteLength(content, "utf8");
		if (used + size > MAX_ALWAYS_BYTES) {
			indexed.push({ ...rule, description: rule.description ?? "Always applies; left out of the prompt for length" });
			continue;
		}
		used += size;
		files.push({ path: rule.path, content });
	}
	if (indexed.length) {
		const lines = indexed.map((rule) => {
			const scope = rule.globs ? ` (${rule.globs.join(", ")})` : "";
			const description = rule.description ? `: ${rule.description}` : "";
			const where = relative(root, rule.path).split("\\").join("/") || rule.path;
			return `- ${rule.source} rule "${rule.name}"${scope}${description} — ${where}`;
		});
		files.push({
			path: join(root, ".nekocode", "rule-index"),
			content: [
				"Rules this project keeps for other coding tools that apply only to some files or situations. Before working on files matching a rule's globs, or on what its description covers, read that rule's file and follow it.",
				...lines,
			].join("\n"),
		});
	}
	return files;
}
