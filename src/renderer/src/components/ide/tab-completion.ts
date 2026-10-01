import type { CodeIntelStatus } from "../../../../shared/code-intel";
import { api, errorMessage } from "../../api";
import { monaco } from "./monaco-setup";

/**
 * Tab completion: one inline suggestion after the cursor rests, from the model
 * picked under Settings → Code intelligence.
 *
 * Monaco providers are global, so this registers once and serves every
 * editor; a file belongs to whichever open workspace contains it. The state
 * shown in the status bar is a tiny store of its own.
 */

/** Context sent either side of the cursor; main clips again. */
const PREFIX_CHARS = 6_000;
const SUFFIX_CHARS = 2_000;
const DEBOUNCE_MS = 350;

export type TabCompletionState = "off" | "unconfigured" | "idle" | "loading" | "error";

interface Snapshot {
	state: TabCompletionState;
	error: string | null;
}

let snapshot: Snapshot = { state: "off", error: null };
const listeners = new Set<() => void>();

function setSnapshot(next: Snapshot): void {
	if (next.state === snapshot.state && next.error === snapshot.error) return;
	snapshot = next;
	for (const listener of listeners) listener();
}

export const tabCompletionStore = {
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	getSnapshot(): Snapshot {
		return snapshot;
	},
};

/** Whether the saved settings name a model to ask. */
export function completionConfigured(status: CodeIntelStatus): boolean {
	return !!status.completion.modelKey;
}

function applyStatus(status: CodeIntelStatus): void {
	if (!status.completion.enabled) setSnapshot({ state: "off", error: null });
	else if (!completionConfigured(status)) setSnapshot({ state: "unconfigured", error: null });
	else if (snapshot.state === "off" || snapshot.state === "unconfigured") setSnapshot({ state: "idle", error: null });
}

/** Re-read the settings; called on mount and after the settings page saves. */
export function refreshTabCompletion(): void {
	api.codeIntelStatus().then(applyStatus).catch(() => setSnapshot({ state: "off", error: null }));
}

/** Switch completion on or off from the status bar. */
export async function setTabCompletionEnabled(enabled: boolean): Promise<void> {
	applyStatus(await api.codeIntelSave({ completion: { enabled } }));
}

const roots = new Map<string, number>();
let registration: monaco.IDisposable | null = null;

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/** The workspace a model's file is in, and its path there. */
function locate(uri: monaco.Uri): { cwd: string; relPath: string } | null {
	if (uri.scheme !== "file") return null;
	const path = normalize(uri.fsPath);
	const lower = path.toLowerCase();
	let best: { cwd: string; relPath: string } | null = null;
	for (const cwd of roots.keys()) {
		const root = normalize(cwd);
		if (!lower.startsWith(`${root.toLowerCase()}/`)) continue;
		if (!best || root.length > best.cwd.length) best = { cwd, relPath: path.slice(root.length + 1) };
	}
	return best;
}

/**
 * Only where a suggestion can go: at the end of a line, or before nothing but
 * closing punctuation. In the middle of a word the user is editing, not writing.
 */
export function cursorAcceptsSuggestion(lineAfterCursor: string): boolean {
	return /^\s*[)\]}>'"`;:,.]*\s*$/.test(lineAfterCursor);
}

/** The last suggestion, so typing into it is served without a new request. */
let last: { uri: string; line: number; before: string; text: string } | null = null;

function fromLast(uri: string, line: number, before: string): string | null {
	if (!last || last.uri !== uri || last.line !== line || !before.startsWith(last.before)) return null;
	const typed = before.slice(last.before.length);
	if (!typed || !last.text.startsWith(typed)) return null;
	const rest = last.text.slice(typed.length);
	return rest || null;
}

/** Sent by the settings page, which must not import this module and with it Monaco. */
export const CODE_INTEL_CHANGED_EVENT = "nekocode:code-intel-changed";

function register(): void {
	if (registration) return;
	window.addEventListener(CODE_INTEL_CHANGED_EVENT, refreshTabCompletion);
	registration = monaco.languages.registerInlineCompletionsProvider("*", {
		debounceDelayMs: DEBOUNCE_MS,
		async provideInlineCompletions(model, position, context, token) {
			const empty = { items: [] };
			if (snapshot.state === "off" || snapshot.state === "unconfigured") return empty;
			// The suggestion list is open; the user is choosing from it.
			if (context.selectedSuggestionInfo) return empty;
			const where = locate(model.uri);
			if (!where) return empty;
			const lineText = model.getLineContent(position.lineNumber);
			const before = lineText.slice(0, position.column - 1);
			if (!cursorAcceptsSuggestion(lineText.slice(position.column - 1))) return empty;
			const at = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);

			const uri = model.uri.toString();
			const cached = fromLast(uri, position.lineNumber, before);
			if (cached) return { items: [{ insertText: cached, range: at }] };

			const offset = model.getOffsetAt(position);
			const start = model.getPositionAt(Math.max(0, offset - PREFIX_CHARS));
			const end = model.getPositionAt(offset + SUFFIX_CHARS);
			const prefix = model.getValueInRange(monaco.Range.fromPositions(start, position));
			const suffix = model.getValueInRange(monaco.Range.fromPositions(position, end));
			if (!prefix.trim()) return empty;

			const id = crypto.randomUUID();
			const cancel = token.onCancellationRequested(() => void api.tabCompleteCancel(id).catch(() => {}));
			setSnapshot({ state: "loading", error: null });
			try {
				const { text } = await api.tabComplete({
					id,
					cwd: where.cwd,
					relPath: where.relPath,
					languageId: model.getLanguageId(),
					prefix,
					suffix,
				});
				if (snapshot.state === "loading") setSnapshot({ state: "idle", error: null });
				if (token.isCancellationRequested || !text) return empty;
				last = { uri, line: position.lineNumber, before, text };
				return { items: [{ insertText: text, range: at }] };
			} catch (error) {
				// Read afresh: it may have been switched off while the request was out.
				if (tabCompletionStore.getSnapshot().state !== "off") setSnapshot({ state: "error", error: errorMessage(error) });
				return empty;
			} finally {
				cancel.dispose();
			}
		},
		disposeInlineCompletions() {},
	});
}

/** Serve completions for files under `cwd` until the returned function is called. */
export function attachTabCompletion(cwd: string): () => void {
	roots.set(cwd, (roots.get(cwd) ?? 0) + 1);
	register();
	refreshTabCompletion();
	return () => {
		const count = (roots.get(cwd) ?? 1) - 1;
		if (count > 0) roots.set(cwd, count);
		else roots.delete(cwd);
	};
}
