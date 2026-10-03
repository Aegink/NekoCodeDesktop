import type { ExtensionUIContext, ExtensionUIDialogOptions, Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionDialog, ExtensionUiAnswer, ExtensionUiSnapshot } from "../shared/agent";

/** Escape sequences a terminal-minded extension styles its text with. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/** Long enough for any status line or widget; more is an extension dumping a log. */
const MAX_TEXT = 4000;
const MAX_WIDGET_LINES = 40;

function clean(text: unknown): string {
	return stripAnsi(String(text ?? "")).slice(0, MAX_TEXT);
}

/**
 * A theme that styles nothing.
 *
 * Extensions call `theme.fg("accent", text)` and the like to colour what they
 * hand the UI. The real theme answers with ANSI escapes, which a DOM shows as
 * noise; this one hands the text back unchanged. Any styling method — the last
 * string argument is the text — and any other lookup gets something harmless.
 */
export const plainTheme = new Proxy({} as Theme, {
	get(_target, prop) {
		if (prop === "name") return "nekocode";
		if (prop === Symbol.toPrimitive || prop === "then") return undefined;
		return (...args: unknown[]) => {
			for (let i = args.length - 1; i >= 0; i--) if (typeof args[i] === "string") return args[i];
			return "";
		};
	},
});

interface PendingDialog {
	dialog: ExtensionDialog;
	settle: (answer: ExtensionUiAnswer) => void;
}

/**
 * The desktop's side of pi's extension UI.
 *
 * pi's own TUI draws dialogs in the terminal; here they become state on the
 * session's snapshot, which every surface showing the session renders and
 * answers through {@link answer}. Keeping it on the snapshot rather than
 * sending one-off events is what lets a question from a session that is not on
 * screen wait until somebody opens it.
 *
 * What has no DOM equivalent — TUI components, raw terminal input, custom
 * editors — degrades the way pi's RPC mode does: accepted and ignored, or
 * answered with "nothing chosen".
 */
export class ExtensionUiHost {
	private dialogs: PendingDialog[] = [];
	private statuses = new Map<string, string>();
	private widgets = new Map<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>();
	private working: string | undefined;
	private editor: ExtensionUiSnapshot["editor"];
	/** What `getEditorText` answers: the composer as extensions last left it. */
	private editorText = "";
	private seq = 0;
	private disposed = false;

	constructor(
		private readonly options: {
			/** The state above changed; push a snapshot. */
			onChange: () => void;
			/** `ctx.ui.notify`: becomes a notice in the transcript. */
			onNotify: (level: "info" | "warning" | "error", text: string) => void;
		},
	) {}

	private nextId(): string {
		return `ext-${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
	}

	private ask<T>(
		dialog: Omit<ExtensionDialog, "id">,
		fallback: T,
		read: (answer: ExtensionUiAnswer) => T,
		opts?: ExtensionUIDialogOptions,
	): Promise<T> {
		if (this.disposed || opts?.signal?.aborted) return Promise.resolve(fallback);
		const entry: PendingDialog = { dialog: { ...dialog, id: this.nextId() }, settle: () => undefined };
		return new Promise<T>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => entry.settle({ id: entry.dialog.id, cancelled: true });
			entry.settle = (answer) => {
				if (timer) clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				const index = this.dialogs.indexOf(entry);
				if (index < 0) return;
				this.dialogs.splice(index, 1);
				this.options.onChange();
				resolve(answer.cancelled ? fallback : read(answer));
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout && opts.timeout > 0) timer = setTimeout(onAbort, opts.timeout);
			this.dialogs.push(entry);
			this.options.onChange();
		});
	}

	/**
	 * Answer the dialog on screen — or, with the editor request's id, say the
	 * composer has taken its text, so it is not applied again by the next surface
	 * to show the session. Unknown ids are stale answers and ignored.
	 */
	answer(answer: ExtensionUiAnswer): void {
		if (this.editor?.id === answer.id) {
			this.editor = undefined;
			this.options.onChange();
			return;
		}
		this.dialogs.find((entry) => entry.dialog.id === answer.id)?.settle(answer);
	}

	snapshot(): ExtensionUiSnapshot | undefined {
		if (!this.dialogs.length && !this.statuses.size && !this.widgets.size && !this.working && !this.editor) {
			return undefined;
		}
		return {
			dialog: this.dialogs[0]?.dialog ?? null,
			queued: Math.max(0, this.dialogs.length - 1),
			statuses: [...this.statuses].map(([key, text]) => ({ key, text })),
			widgets: [...this.widgets].map(([key, widget]) => ({ key, ...widget })),
			...(this.working ? { working: this.working } : {}),
			...(this.editor ? { editor: this.editor } : {}),
		};
	}

	/**
	 * Drop what the session's extensions put on screen, answering every open
	 * dialog with "nothing chosen" so no extension is left awaiting forever.
	 * Called when the session goes away or reloads its extensions.
	 */
	reset(): void {
		for (const entry of [...this.dialogs]) entry.settle({ id: entry.dialog.id, cancelled: true });
		const had = this.statuses.size || this.widgets.size || this.working || this.editor;
		this.statuses.clear();
		this.widgets.clear();
		this.working = undefined;
		this.editor = undefined;
		this.editorText = "";
		if (had) this.options.onChange();
	}

	dispose(): void {
		this.reset();
		this.disposed = true;
	}

	context(): ExtensionUIContext {
		const host = this;
		const setEditor = (text: string, mode: "replace" | "insert") => {
			const value = String(text ?? "");
			host.editor = { id: host.nextId(), text: value, mode };
			host.editorText = mode === "replace" ? value : host.editorText + value;
			host.options.onChange();
		};
		return {
			select: (title, options, opts) =>
				host.ask(
					{ kind: "select", title: clean(title), options: options.map(clean) },
					undefined,
					// Answered with the label shown, which is the extension's own string
					// once the escapes are gone; map it back to what the extension gave.
					(answer) => options.find((option) => clean(option) === answer.value),
					opts,
				),
			confirm: (title, message, opts) =>
				host.ask({ kind: "confirm", title: clean(title), message: clean(message) }, false, (answer) => answer.confirmed === true, opts),
			input: (title, placeholder, opts) =>
				host.ask(
					{ kind: "input", title: clean(title), ...(placeholder ? { placeholder: clean(placeholder) } : {}) },
					undefined,
					(answer) => answer.value ?? "",
					opts,
				),
			editor: (title, prefill) =>
				host.ask(
					{ kind: "editor", title: clean(title), ...(prefill ? { prefill: String(prefill) } : {}) },
					undefined,
					(answer) => answer.value ?? "",
				),
			notify(message, type) {
				const text = clean(message).trim();
				if (text && !host.disposed) host.options.onNotify(type ?? "info", text);
			},
			onTerminalInput: () => () => undefined,
			setStatus(key, text) {
				const value = text === undefined ? "" : clean(text).trim();
				if (value) host.statuses.set(key, value);
				else if (!host.statuses.delete(key)) return;
				host.options.onChange();
			},
			setWorkingMessage(message) {
				host.working = message ? clean(message).trim() || undefined : undefined;
				host.options.onChange();
			},
			setWorkingVisible: () => undefined,
			setWorkingIndicator: () => undefined,
			setHiddenThinkingLabel: () => undefined,
			setWidget(key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) {
				if (content === undefined) {
					if (host.widgets.delete(key)) host.options.onChange();
					return;
				}
				// A component factory draws into the TUI; there is nothing to call it with.
				if (!Array.isArray(content)) return;
				host.widgets.set(key, {
					lines: content.slice(0, MAX_WIDGET_LINES).map(clean),
					placement: options?.placement ?? "aboveEditor",
				});
				host.options.onChange();
			},
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: () => undefined,
			custom: async () => undefined as never,
			pasteToEditor: (text) => setEditor(text, "insert"),
			setEditorText: (text) => setEditor(text, "replace"),
			// The composer lives in another process and this has to answer now. What
			// an extension last put there is the best answer there is.
			getEditorText: () => host.editorText,
			addAutocompleteProvider: () => undefined,
			setEditorComponent: () => undefined,
			getEditorComponent: () => undefined,
			get theme() {
				return plainTheme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Themes are not supported in NekoCode" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => undefined,
		} as ExtensionUIContext;
	}
}
