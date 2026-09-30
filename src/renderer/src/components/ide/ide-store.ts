import { FS_IMAGE_MIME } from "../../../../shared/files";
import type { IdeWriteResult } from "../../../../shared/ide";
import { api, errorMessage } from "../../api";
import { languageForPath, monaco } from "./monaco-setup";

/**
 * The IDE's open files and tabs for one project, kept outside React.
 *
 * Monaco models are the documents; React only draws them. Holding them here
 * rather than in component state is what lets the IDE be hidden — the Agent
 * layout, another project — and come back with every tab, cursor and unsaved
 * edit where it was left.
 */

export type IdeDocState = "loading" | "ready" | "image" | "binary" | "tooLarge" | "error";

export interface IdeDoc {
	relPath: string;
	state: IdeDocState;
	error?: string;
	imageUrl?: string;
	size?: number;
	/** The file's mtime when last read or written — what a save is checked against. */
	mtimeMs: number | null;
	bom: boolean;
	model: monaco.editor.ITextModel | null;
	/** Monaco's alternative version id at the last load or save: equal means clean. */
	savedVersion: number;
	dirty: boolean;
	/** The file changed on disk under unsaved edits, or a save was refused for that. */
	conflict: boolean;
	/** The file is gone from disk. */
	deleted: boolean;
	/** Bumped when the disk's version replaced the buffer, for a transient notice. */
	reloadedAt: number;
}

export type IdeTabKind = "file" | "diff";

export interface IdeTab {
	id: string;
	kind: IdeTabKind;
	relPath: string;
	/** A single-click open: replaced by the next one until it is edited or pinned. */
	preview: boolean;
}

export interface IdeRevealRequest {
	tabId: string;
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	nonce: number;
}

const AUTO_SAVE_STORAGE_KEY = "nekocode:ide-auto-save";
const AUTO_SAVE_DELAY_MS = 1000;
const RECENT_LIMIT = 30;

export function tabIdFor(kind: IdeTabKind, relPath: string): string {
	return `${kind}:${relPath}`;
}

function normalizeRel(relPath: string): string {
	return relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function joinPath(cwd: string, relPath: string): string {
	return `${cwd.replace(/[\\/]+$/, "")}/${relPath}`;
}

function isImage(relPath: string): boolean {
	const extension = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();
	return relPath.includes(".") && extension in FS_IMAGE_MIME;
}

/** Whether `relPath` is `folder` or inside it. */
export function isWithinPath(relPath: string, folder: string): boolean {
	return relPath === folder || relPath.startsWith(`${folder}/`);
}

export class IdeWorkspace {
	readonly docs = new Map<string, IdeDoc>();
	tabs: IdeTab[] = [];
	activeId: string | null = null;
	/** Most recently opened first, for Ctrl+P before anything is typed. */
	recent: string[] = [];
	reveal: IdeRevealRequest | null = null;
	/** The committed side of each diff tab, keyed by path. */
	readonly headModels = new Map<string, monaco.editor.ITextModel>();
	readonly viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
	autoSave: boolean;
	version = 0;

	private listeners = new Set<() => void>();
	private autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private subscriptions = new Map<string, monaco.IDisposable>();

	constructor(readonly cwd: string) {
		let stored: string | null = null;
		try {
			stored = localStorage.getItem(AUTO_SAVE_STORAGE_KEY);
		} catch {
			// no storage: default applies
		}
		this.autoSave = stored === "1";
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	private emit(): void {
		this.version++;
		for (const listener of this.listeners) listener();
	}

	get activeTab(): IdeTab | null {
		return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
	}

	get dirtyDocs(): IdeDoc[] {
		return [...this.docs.values()].filter((doc) => doc.dirty);
	}

	setAutoSave(enabled: boolean): void {
		this.autoSave = enabled;
		try {
			localStorage.setItem(AUTO_SAVE_STORAGE_KEY, enabled ? "1" : "0");
		} catch {
			// not persisted
		}
		if (enabled) for (const doc of this.dirtyDocs) this.scheduleAutoSave(doc);
		this.emit();
	}

	// -------------------------------------------------------------------------
	// Opening and closing
	// -------------------------------------------------------------------------

	open(
		rawPath: string,
		options: { kind?: IdeTabKind; preview?: boolean; line?: number; column?: number; endLine?: number; endColumn?: number } = {},
	): void {
		const relPath = normalizeRel(rawPath);
		if (!relPath) return;
		const kind = options.kind ?? "file";
		const id = tabIdFor(kind, relPath);
		const existing = this.tabs.find((tab) => tab.id === id);
		if (existing) {
			// Opening a preview tab for real — a double-click — pins it.
			if (existing.preview && options.preview === false) existing.preview = false;
		} else {
			const tab: IdeTab = { id, kind, relPath, preview: options.preview ?? false };
			const previewAt = tab.preview ? this.tabs.findIndex((entry) => entry.preview) : -1;
			if (previewAt >= 0) {
				const replaced = this.tabs[previewAt]!;
				this.tabs.splice(previewAt, 1, tab);
				this.release(replaced);
			} else {
				const activeAt = this.tabs.findIndex((entry) => entry.id === this.activeId);
				this.tabs.splice(activeAt >= 0 ? activeAt + 1 : this.tabs.length, 0, tab);
			}
		}
		this.activeId = id;
		this.recent = [relPath, ...this.recent.filter((entry) => entry !== relPath)].slice(0, RECENT_LIMIT);
		this.reveal = options.line
			? {
					tabId: id,
					line: options.line,
					column: options.column ?? 1,
					...(options.endLine !== undefined ? { endLine: options.endLine } : {}),
					...(options.endColumn !== undefined ? { endColumn: options.endColumn } : {}),
					nonce: Date.now(),
				}
			: null;
		void this.ensureDoc(relPath);
		if (kind === "diff") void this.ensureHead(relPath);
		this.emit();
	}

	pin(tabId: string): void {
		const tab = this.tabs.find((entry) => entry.id === tabId);
		if (tab?.preview) {
			tab.preview = false;
			this.emit();
		}
	}

	activate(tabId: string): void {
		if (this.activeId === tabId) return;
		this.activeId = tabId;
		const tab = this.activeTab;
		if (tab) this.recent = [tab.relPath, ...this.recent.filter((entry) => entry !== tab.relPath)].slice(0, RECENT_LIMIT);
		this.emit();
	}

	/** Close without asking; the caller has already confirmed unsaved changes. */
	close(tabId: string): void {
		const at = this.tabs.findIndex((tab) => tab.id === tabId);
		if (at < 0) return;
		const [tab] = this.tabs.splice(at, 1);
		if (this.activeId === tabId) this.activeId = (this.tabs[at - 1] ?? this.tabs[at])?.id ?? null;
		this.viewStates.delete(tabId);
		if (tab) this.release(tab, true);
		this.emit();
	}

	closeMany(tabIds: readonly string[]): void {
		for (const id of tabIds) this.close(id);
	}

	moveTab(tabId: string, toIndex: number): void {
		const from = this.tabs.findIndex((tab) => tab.id === tabId);
		if (from < 0) return;
		const [tab] = this.tabs.splice(from, 1);
		this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab!);
		this.emit();
	}

	/** Whether closing this tab would drop unsaved edits nobody else shows. */
	closeLosesEdits(tabId: string): boolean {
		const tab = this.tabs.find((entry) => entry.id === tabId);
		if (!tab || !this.docs.get(tab.relPath)?.dirty) return false;
		return !this.tabs.some((other) => other.id !== tabId && other.relPath === tab.relPath);
	}

	/** Drop a document no tab shows any more. */
	private release(tab: IdeTab, discard = false): void {
		if (this.tabs.some((other) => other.relPath === tab.relPath)) return;
		const doc = this.docs.get(tab.relPath);
		if (doc && (discard || !doc.dirty)) {
			this.subscriptions.get(tab.relPath)?.dispose();
			this.subscriptions.delete(tab.relPath);
			doc.model?.dispose();
			this.docs.delete(tab.relPath);
			clearTimeout(this.autoSaveTimers.get(tab.relPath));
			this.autoSaveTimers.delete(tab.relPath);
		}
		this.headModels.get(tab.relPath)?.dispose();
		this.headModels.delete(tab.relPath);
	}

	// -------------------------------------------------------------------------
	// Documents
	// -------------------------------------------------------------------------

	private async ensureDoc(relPath: string): Promise<void> {
		if (this.docs.has(relPath)) return;
		const doc: IdeDoc = {
			relPath,
			state: "loading",
			mtimeMs: null,
			bom: false,
			model: null,
			savedVersion: 0,
			dirty: false,
			conflict: false,
			deleted: false,
			reloadedAt: 0,
		};
		this.docs.set(relPath, doc);
		try {
			if (isImage(relPath)) {
				const result = await api.fsReadFile(this.cwd, relPath);
				if (result.kind === "image") {
					doc.state = "image";
					doc.imageUrl = result.dataUrl;
					doc.size = result.size;
				} else {
					doc.state = "binary";
					doc.size = result.kind === "binary" ? result.size : undefined;
				}
			} else {
				const result = await api.ideReadText(this.cwd, relPath);
				if (result.kind !== "text") {
					doc.state = result.kind;
					doc.size = result.size;
				} else {
					// Opened and closed again while the read was in flight.
					if (this.docs.get(relPath) !== doc) return;
					const uri = monaco.Uri.file(joinPath(this.cwd, relPath));
					monaco.editor.getModel(uri)?.dispose();
					const model = monaco.editor.createModel(result.text, languageForPath(relPath), uri);
					doc.model = model;
					doc.mtimeMs = result.mtimeMs;
					doc.bom = result.bom;
					doc.size = result.size;
					doc.savedVersion = model.getAlternativeVersionId();
					doc.state = "ready";
					this.subscriptions.set(
						relPath,
						model.onDidChangeContent(() => this.contentChanged(doc)),
					);
				}
			}
		} catch (cause) {
			doc.state = "error";
			doc.error = errorMessage(cause);
		}
		this.emit();
	}

	private async ensureHead(relPath: string): Promise<void> {
		if (this.headModels.has(relPath)) return;
		const uri = monaco.Uri.from({ scheme: "git-head", path: `/${relPath}` });
		monaco.editor.getModel(uri)?.dispose();
		const model = monaco.editor.createModel("", languageForPath(relPath), uri);
		this.headModels.set(relPath, model);
		try {
			model.setValue((await api.ideGitHead(this.cwd, relPath)) ?? "");
		} catch {
			// Not a repository, or git is missing: the diff shows the file as new.
		}
		this.emit();
	}

	/** Refresh the committed side of an open diff — after a commit, say. */
	async refreshHead(relPath: string): Promise<void> {
		const model = this.headModels.get(relPath);
		if (!model) return;
		try {
			model.setValue((await api.ideGitHead(this.cwd, relPath)) ?? "");
		} catch {
			// keep what is shown
		}
	}

	private contentChanged(doc: IdeDoc): void {
		const dirty = doc.model !== null && doc.model.getAlternativeVersionId() !== doc.savedVersion;
		if (dirty) {
			// An edit pins the preview tab that shows it, as in VS Code.
			for (const tab of this.tabs) if (tab.relPath === doc.relPath) tab.preview = false;
		}
		if (dirty && this.autoSave) this.scheduleAutoSave(doc);
		if (dirty !== doc.dirty) {
			doc.dirty = dirty;
			this.emit();
		}
	}

	private scheduleAutoSave(doc: IdeDoc): void {
		clearTimeout(this.autoSaveTimers.get(doc.relPath));
		this.autoSaveTimers.set(
			doc.relPath,
			setTimeout(() => {
				this.autoSaveTimers.delete(doc.relPath);
				if (doc.dirty && !doc.conflict) void this.save(doc.relPath).catch(() => undefined);
			}, AUTO_SAVE_DELAY_MS),
		);
	}

	/**
	 * Write a buffer to disk. A conflict — the file moved on since it was read —
	 * is reported rather than overwritten, unless `force`.
	 */
	async save(relPath: string, force = false): Promise<IdeWriteResult | null> {
		const doc = this.docs.get(relPath);
		const model = doc?.model;
		if (!doc || !model) return null;
		const version = model.getAlternativeVersionId();
		const result = await api.ideWriteText({
			cwd: this.cwd,
			relPath,
			text: model.getValue(),
			bom: doc.bom,
			expectedMtimeMs: doc.deleted ? null : doc.mtimeMs,
			force,
		});
		if (result.ok) {
			doc.mtimeMs = result.mtimeMs;
			doc.savedVersion = version;
			doc.dirty = model.getAlternativeVersionId() !== version;
			doc.conflict = false;
			doc.deleted = false;
		} else {
			doc.conflict = true;
		}
		this.emit();
		return result;
	}

	async saveAll(): Promise<void> {
		for (const doc of this.dirtyDocs) {
			if (!doc.conflict) await this.save(doc.relPath);
		}
	}

	/** Throw away the buffer's edits and take the file as it is on disk. */
	async revert(relPath: string): Promise<void> {
		const doc = this.docs.get(relPath);
		if (!doc?.model) return;
		const result = await api.ideReadText(this.cwd, relPath);
		if (result.kind !== "text") return;
		this.replaceContent(doc, result.text, result.mtimeMs, result.bom);
		doc.conflict = false;
		doc.deleted = false;
		this.emit();
	}

	/** Put new text in a model as one undoable edit, and call that the saved state. */
	private replaceContent(doc: IdeDoc, text: string, mtimeMs: number, bom: boolean): void {
		const model = doc.model;
		if (!model) return;
		if (model.getValue() !== text) {
			model.pushStackElement();
			model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
			model.pushStackElement();
		}
		doc.mtimeMs = mtimeMs;
		doc.bom = bom;
		doc.savedVersion = model.getAlternativeVersionId();
		doc.dirty = false;
	}

	/**
	 * Notice files that changed on disk under open tabs — the agent edits the
	 * same files the user has open. A clean buffer takes the new version; a
	 * dirty one is marked as conflicting and left for the user to decide.
	 */
	async pollDisk(): Promise<void> {
		const docs = [...this.docs.values()].filter((doc) => doc.state === "ready" && doc.model);
		if (docs.length === 0) return;
		const stats = await api.ideStat(
			this.cwd,
			docs.map((doc) => doc.relPath),
		);
		let changed = false;
		for (const entry of stats) {
			const doc = this.docs.get(entry.relPath);
			if (!doc?.model) continue;
			if (entry.mtimeMs === null) {
				if (!doc.deleted) {
					doc.deleted = true;
					changed = true;
				}
				continue;
			}
			if (doc.deleted) {
				doc.deleted = false;
				changed = true;
			}
			if (doc.mtimeMs !== null && Math.abs(entry.mtimeMs - doc.mtimeMs) <= 1) continue;
			if (doc.dirty) {
				if (!doc.conflict) {
					doc.conflict = true;
					changed = true;
				}
				continue;
			}
			try {
				const result = await api.ideReadText(this.cwd, doc.relPath);
				if (result.kind !== "text" || doc.dirty) continue;
				this.replaceContent(doc, result.text, result.mtimeMs, result.bom);
				doc.reloadedAt = Date.now();
				changed = true;
			} catch {
				// Mid-write, most likely; the next poll will see it settled.
			}
		}
		if (changed) this.emit();
	}

	// -------------------------------------------------------------------------
	// Explorer operations that move files under open tabs
	// -------------------------------------------------------------------------

	/** Follow a rename: every open file at or under `from` moves to `to`. */
	renamed(from: string, to: string): void {
		const source = normalizeRel(from);
		const target = normalizeRel(to);
		for (const doc of [...this.docs.values()]) {
			if (!isWithinPath(doc.relPath, source)) continue;
			const next = target + doc.relPath.slice(source.length);
			this.docs.delete(doc.relPath);
			this.subscriptions.get(doc.relPath)?.dispose();
			this.subscriptions.delete(doc.relPath);
			const old = doc.model;
			if (old) {
				// A model's URI is fixed, so the text moves to a new one.
				const uri = monaco.Uri.file(joinPath(this.cwd, next));
				monaco.editor.getModel(uri)?.dispose();
				const model = monaco.editor.createModel(old.getValue(), languageForPath(next), uri);
				const wasDirty = doc.dirty;
				old.dispose();
				doc.model = model;
				doc.savedVersion = wasDirty ? -1 : model.getAlternativeVersionId();
				this.subscriptions.set(next, model.onDidChangeContent(() => this.contentChanged(doc)));
			}
			doc.relPath = next;
			this.docs.set(next, doc);
		}
		for (const tab of this.tabs) {
			if (!isWithinPath(tab.relPath, source)) continue;
			const next = target + tab.relPath.slice(source.length);
			const id = tabIdFor(tab.kind, next);
			if (this.activeId === tab.id) this.activeId = id;
			this.viewStates.delete(tab.id);
			tab.id = id;
			tab.relPath = next;
		}
		this.recent = this.recent.map((entry) =>
			isWithinPath(entry, source) ? target + entry.slice(source.length) : entry,
		);
		this.emit();
	}

	/** Follow a delete: tabs on clean files under it close; dirty ones stay, marked deleted. */
	deleted(relPath: string): void {
		const folder = normalizeRel(relPath);
		for (const tab of [...this.tabs]) {
			if (!isWithinPath(tab.relPath, folder)) continue;
			const doc = this.docs.get(tab.relPath);
			if (doc?.dirty) doc.deleted = true;
			else this.close(tab.id);
		}
		this.recent = this.recent.filter((entry) => !isWithinPath(entry, folder));
		this.emit();
	}

	dispose(): void {
		for (const subscription of this.subscriptions.values()) subscription.dispose();
		for (const doc of this.docs.values()) doc.model?.dispose();
		for (const model of this.headModels.values()) model.dispose();
		for (const timer of this.autoSaveTimers.values()) clearTimeout(timer);
		this.docs.clear();
		this.headModels.clear();
		this.listeners.clear();
	}
}

const workspaces = new Map<string, IdeWorkspace>();

/** The one workspace per project, created on first use and kept for the session. */
export function workspaceFor(cwd: string): IdeWorkspace {
	let workspace = workspaces.get(cwd);
	if (!workspace) {
		workspace = new IdeWorkspace(cwd);
		workspaces.set(cwd, workspace);
	}
	return workspace;
}
