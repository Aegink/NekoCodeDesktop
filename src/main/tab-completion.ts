import type { CompletionRequest, CompletionResponse } from "../shared/code-intel";
import { askModel, type ModelCallRuntime } from "./model-call";
import type { SearchHit } from "./semantic-index/project-index";

/**
 * Tab completion for the IDE layout: the code around the cursor goes to a
 * model from Settings → Providers and models, told to answer with only what
 * belongs at the cursor, and what comes back is cut down to exactly that.
 *
 * The editor is the secondary surface here — the agent is the primary one — so
 * this is kept to a single suggestion per pause, a short timeout, and no
 * request at all while it is switched off.
 */

export interface CompletionSettings {
	enabled: boolean;
	/** `provider/model`. */
	modelKey: string | null;
}

export interface TabCompletionDeps {
	settings: () => CompletionSettings;
	getRuntime: () => Promise<ModelCallRuntime>;
	/** Keyword neighbours from the project index, for context; absent when the index is off. */
	related?: (cwd: string, text: string, excludePath: string, limit: number) => Promise<SearchHit[]>;
}

/** The renderer clips too; this is the backstop. */
export const MAX_PREFIX_CHARS = 8_000;
export const MAX_SUFFIX_CHARS = 3_000;
const MAX_CONTEXT_CHARS = 2_500;
const MAX_SNIPPET_LINES = 30;
const MAX_COMPLETION_LINES = 16;
const TIMEOUT_MS = 20_000;

/** The identifiers near the cursor, as a query for related code elsewhere. */
export function contextQuery(prefix: string): string {
	const tail = prefix.split("\n").slice(-20).join("\n");
	const words = tail.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
	return [...new Set(words)].slice(-30).join(" ");
}

/** Related chunks from other files, clipped to a budget. */
export function snippetBlock(hits: readonly SearchHit[]): { path: string; text: string }[] {
	const out: { path: string; text: string }[] = [];
	let used = 0;
	for (const hit of hits) {
		const text = hit.text.split("\n").slice(0, MAX_SNIPPET_LINES).join("\n");
		if (used + text.length > MAX_CONTEXT_CHARS) break;
		used += text.length;
		out.push({ path: hit.path, text });
	}
	return out;
}

export const SYSTEM_PROMPT = [
	"You are a code completion engine inside an editor.",
	"You are given a file with the cursor marked <CURSOR>. Reply with exactly the text to insert at the cursor and nothing else:",
	"no explanation, no markdown fences, no repetition of the code before or after the cursor.",
	"Complete the current statement or block — at most a few lines. If nothing sensible fits, reply with an empty message.",
].join("\n");

export function buildPrompt(
	request: Pick<CompletionRequest, "relPath" | "languageId" | "prefix" | "suffix">,
	snippets: readonly { path: string; text: string }[],
): string {
	const related = snippets.length
		? `Related code elsewhere in the project:\n${snippets.map((snippet) => `--- ${snippet.path}\n${snippet.text}`).join("\n")}\n\n`
		: "";
	return `${related}File: ${request.relPath} (${request.languageId})\n${request.prefix}<CURSOR>${request.suffix}`;
}

/** Opening brackets minus closing ones; negative when the text closes more than it opens. */
function bracketBalance(text: string): number {
	let balance = 0;
	for (const char of text) {
		if (char === "(" || char === "[" || char === "{") balance++;
		else if (char === ")" || char === "]" || char === "}") balance--;
	}
	return balance;
}

/**
 * Cut a raw answer down to what belongs at the cursor.
 *
 * Models wrap code in fences, repeat the line they were given, and run on into
 * the code that follows. All three are trimmed, and in the middle of a line
 * only the rest of that line is offered.
 */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
	let text = raw.replace(/\r\n?/g, "\n");
	const fenced = /```[^\n]*\n([\s\S]*?)(?:\n```|$)/.exec(text);
	if (fenced) text = fenced[1];
	text = text.replace(/<\/?CURSOR>/g, "");
	// An echo of the line the cursor is on, indented or not.
	const linePrefix = prefix.slice(prefix.lastIndexOf("\n") + 1);
	const head = linePrefix.trim();
	const body = text.trimStart();
	if (head && body.startsWith(head)) {
		text = body.slice(head.length);
		// The cursor sits after a space the echo also had.
		if (/\s$/.test(linePrefix)) text = text.replace(/^[ \t]+/, "");
	}

	const lineSuffix = suffix.split("\n")[0];
	if (lineSuffix.trim()) {
		// Mid-line: the rest of this line only, minus whatever already follows the cursor.
		text = text.split("\n")[0];
		const tail = lineSuffix.trim();
		const at = text.indexOf(tail);
		if (at >= 0) text = text.slice(0, at);
		else if (bracketBalance(text) < 0) {
			// It closes what was opened before the cursor — and the line already does.
			for (let size = Math.min(tail.length, text.length); size > 0; size--) {
				if (text.endsWith(tail.slice(0, size))) {
					text = text.slice(0, -size);
					break;
				}
			}
		}
		return text.trimEnd() ? text.replace(/\s+$/, "") : "";
	}

	// Stop where the model starts writing the code that already follows.
	const nextLine = suffix.split("\n").find((line) => line.trim().length >= 3)?.trim();
	let lines = text.split("\n");
	if (nextLine) {
		const repeat = lines.findIndex((line, index) => index > 0 && line.trim() === nextLine);
		if (repeat > 0) lines = lines.slice(0, repeat);
	}
	lines = lines.slice(0, MAX_COMPLETION_LINES);
	while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
	const result = lines.join("\n");
	return result.trim() ? result.replace(/[ \t]+$/, "") : "";
}

export class TabCompletionService {
	private readonly inflight = new Map<string, AbortController>();

	constructor(private readonly deps: TabCompletionDeps) {}

	cancel(id: string): void {
		this.inflight.get(id)?.abort();
		this.inflight.delete(id);
	}

	async complete(request: CompletionRequest): Promise<CompletionResponse> {
		const settings = this.deps.settings();
		if (!settings.enabled) return { text: "" };
		// One editor, one suggestion: anything older is already stale.
		for (const [id, controller] of this.inflight) {
			controller.abort();
			this.inflight.delete(id);
		}
		const controller = new AbortController();
		this.inflight.set(request.id, controller);
		const clipped: CompletionRequest = {
			...request,
			prefix: request.prefix.slice(-MAX_PREFIX_CHARS),
			suffix: request.suffix.slice(0, MAX_SUFFIX_CHARS),
		};
		try {
			// Context is a nicety: a failure to find any never costs the suggestion.
			const hits = (await this.deps.related?.(clipped.cwd, contextQuery(clipped.prefix), clipped.relPath, 3).catch(() => [])) ?? [];
			const raw = await this.ask(settings, clipped, snippetBlock(hits), controller.signal);
			if (controller.signal.aborted) return { text: "" };
			return { text: cleanCompletion(raw, clipped.prefix, clipped.suffix) };
		} catch (error) {
			if (controller.signal.aborted) return { text: "" };
			throw error;
		} finally {
			if (this.inflight.get(request.id) === controller) this.inflight.delete(request.id);
		}
	}

	private async ask(
		settings: CompletionSettings,
		request: CompletionRequest,
		snippets: readonly { path: string; text: string }[],
		signal: AbortSignal,
	): Promise<string> {
		if (!settings.modelKey) throw new Error("Tab completion: no model is selected");
		try {
			return await askModel(await this.deps.getRuntime(), settings.modelKey, SYSTEM_PROMPT, buildPrompt(request, snippets), {
				maxTokens: 256,
				reasoningMaxTokens: 2048,
				timeoutMs: TIMEOUT_MS,
				signal,
			});
		} catch (error) {
			throw new Error(`Tab completion: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
