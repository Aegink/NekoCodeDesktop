import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { VscChevronDown, VscChevronRight, VscCollapseAll, VscNewFile, VscNewFolder, VscRefresh } from "react-icons/vsc";
import type { FsEntry } from "../../../../shared/files";
import { mentionToken } from "../../../../shared/mentions";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { FileTypeIcon } from "../../lib/fileIcons";
import { FolderIcon, FolderOpenIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { isWithinPath, type IdeWorkspace } from "./ide-store";
import { GIT_STATUS_CLASS, type GitDecorations } from "./git-decorations";
import { PanelHeader, PanelIconButton } from "./PanelChrome";

type Editing =
	| { mode: "new-file" | "new-dir"; parent: string }
	| { mode: "rename"; target: FsEntry };

/** Folders a project listing never needs to show. */
const HIDDEN = new Set([".git"]);

function parentOf(relPath: string): string {
	const at = relPath.lastIndexOf("/");
	return at < 0 ? "" : relPath.slice(0, at);
}

function joinRel(parent: string, name: string): string {
	return parent ? `${parent}/${name}` : name;
}

/** Expanded folders per project, so switching away and back keeps the tree open. */
const expandedByProject = new Map<string, Set<string>>();

interface Row {
	entry: FsEntry;
	depth: number;
}

export function FileExplorer({
	ws,
	git,
	refreshSignal,
	onAddToChat,
	onError,
}: {
	ws: IdeWorkspace;
	git: GitDecorations;
	/** Bumped when something outside — the agent — may have changed the tree. */
	refreshSignal: number;
	onAddToChat: (text: string) => void;
	onError: (message: string) => void;
}) {
	const { t } = useTranslation();
	useSyncExternalStore(ws.subscribe, ws.getVersion);
	const cwd = ws.cwd;
	const [children, setChildren] = useState<Map<string, FsEntry[]>>(new Map());
	const [expanded, setExpanded] = useState<Set<string>>(() => expandedByProject.get(cwd) ?? new Set());
	const [selected, setSelected] = useState<string | null>(null);
	const [editing, setEditing] = useState<Editing | null>(null);
	const [draft, setDraft] = useState("");
	const [confirmDelete, setConfirmDelete] = useState<FsEntry | null>(null);
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const activePath = ws.activeTab?.relPath ?? null;

	useEffect(() => {
		expandedByProject.set(cwd, expanded);
	}, [cwd, expanded]);

	const load = useCallback(
		async (dir: string) => {
			try {
				// Main joins with the platform separator; the tree keys on `/`.
				const entries = (await api.fsList(cwd, dir))
					.filter((entry) => !HIDDEN.has(entry.name))
					.map((entry) => ({ ...entry, relPath: entry.relPath.replace(/\\/g, "/") }));
				setChildren((current) => new Map(current).set(dir, entries));
			} catch (cause) {
				// A folder deleted from under an expanded node: collapse it quietly.
				setChildren((current) => {
					const next = new Map(current);
					next.delete(dir);
					return next;
				});
				if (dir === "") onError(errorMessage(cause));
			}
		},
		[cwd, onError],
	);

	const refresh = useCallback(() => {
		void load("");
		for (const dir of expanded) void load(dir);
	}, [expanded, load]);

	// The root, and whatever was expanded the last time this project was open;
	// again whenever the signal says the tree may have changed.
	useEffect(() => {
		refresh();
	}, [cwd, refreshSignal]);

	// Reveal the active file: expand its folders so it is in view.
	useEffect(() => {
		if (!activePath) return;
		setSelected(activePath);
		const folders: string[] = [];
		for (let dir = parentOf(activePath); dir; dir = parentOf(dir)) folders.unshift(dir);
		const missing = folders.filter((dir) => !expanded.has(dir));
		if (missing.length === 0) return;
		setExpanded((current) => new Set([...current, ...missing]));
		for (const dir of missing) void load(dir);
	}, [activePath]);

	const toggle = (dir: string) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(dir)) next.delete(dir);
			else {
				next.add(dir);
				void load(dir);
			}
			return next;
		});
	};

	const rows = useMemo(() => {
		const list: Row[] = [];
		const walk = (dir: string, depth: number) => {
			for (const entry of children.get(dir) ?? []) {
				list.push({ entry, depth });
				if (entry.kind === "dir" && expanded.has(entry.relPath)) walk(entry.relPath, depth + 1);
			}
		};
		walk("", 0);
		return list;
	}, [children, expanded]);

	const beginCreate = (mode: "new-file" | "new-dir", parent: string) => {
		if (parent && !expanded.has(parent)) toggle(parent);
		setEditing({ mode, parent });
		setDraft("");
	};

	const beginRename = (entry: FsEntry) => {
		setEditing({ mode: "rename", target: entry });
		setDraft(entry.name);
	};

	/** The folder a "new file" from the header lands in: the selection's, or the root. */
	const targetFolder = (): string => {
		if (!selected) return "";
		const row = rows.find((entry) => entry.entry.relPath === selected);
		if (!row) return "";
		return row.entry.kind === "dir" ? row.entry.relPath : parentOf(row.entry.relPath);
	};

	const commitEdit = async () => {
		const current = editing;
		const name = draft.trim().replace(/\\/g, "/");
		setEditing(null);
		if (!current || !name) return;
		try {
			if (current.mode === "rename") {
				if (name === current.target.name) return;
				const from = current.target.relPath;
				const to = joinRel(parentOf(from), name);
				await api.ideRename({ cwd, from, to });
				ws.renamed(from, to);
				if (current.target.kind === "dir") {
					setExpanded((set) => new Set([...set].map((dir) => (isWithinPath(dir, from) ? to + dir.slice(from.length) : dir))));
				}
				await load(parentOf(from));
				setSelected(to);
			} else {
				const relPath = joinRel(current.parent, name);
				await api.ideCreate({ cwd, relPath, kind: current.mode === "new-dir" ? "dir" : "file" });
				// `a/b/c.ts` creates the folders on the way; show them.
				const created = parentOf(relPath);
				const opened: string[] = [];
				for (let dir = created; dir && dir !== current.parent; dir = parentOf(dir)) opened.push(dir);
				if (opened.length) setExpanded((set) => new Set([...set, ...opened]));
				await load(current.parent);
				for (const dir of opened) await load(dir);
				setSelected(relPath);
				if (current.mode === "new-file") ws.open(relPath);
			}
		} catch (cause) {
			onError(errorMessage(cause));
		}
	};

	const remove = async (entry: FsEntry) => {
		setConfirmDelete(null);
		try {
			await api.ideDelete(cwd, entry.relPath);
			ws.deleted(entry.relPath);
			await load(parentOf(entry.relPath));
		} catch (cause) {
			onError(errorMessage(cause));
		}
	};

	const absolutePath = (relPath: string) => {
		const separator = cwd.includes("\\") ? "\\" : "/";
		return `${cwd.replace(/[\\/]+$/, "")}${separator}${relPath.split("/").join(separator)}`;
	};

	const openMenu = (event: React.MouseEvent, entry: FsEntry | null) => {
		event.preventDefault();
		event.stopPropagation();
		if (entry) setSelected(entry.relPath);
		const folder = entry ? (entry.kind === "dir" ? entry.relPath : parentOf(entry.relPath)) : "";
		const items: ContextMenuItem[] = [
			{ label: t("ide.explorer.newFile"), onSelect: () => beginCreate("new-file", folder) },
			{ label: t("ide.explorer.newFolder"), onSelect: () => beginCreate("new-dir", folder) },
		];
		if (entry) {
			items.push(
				{ kind: "separator" },
				...(entry.kind === "file"
					? [
							{ label: t("ide.explorer.open"), onSelect: () => ws.open(entry.relPath) },
							{ label: t("ide.explorer.openDiff"), onSelect: () => ws.open(entry.relPath, { kind: "diff" }) },
						]
					: []),
				{
					label: t("ide.explorer.addToChat"),
					onSelect: () => onAddToChat(`${mentionToken({ kind: entry.kind, path: entry.relPath })} `),
				},
				{ kind: "separator" },
				{ label: t("ide.explorer.copyPath"), onSelect: () => void navigator.clipboard.writeText(absolutePath(entry.relPath)) },
				{ label: t("ide.explorer.copyRelativePath"), onSelect: () => void navigator.clipboard.writeText(entry.relPath) },
				{ kind: "separator" },
				{ label: t("ide.explorer.rename"), shortcut: "F2", onSelect: () => beginRename(entry) },
				{ label: t("common.delete"), shortcut: "Del", danger: true, onSelect: () => setConfirmDelete(entry) },
			);
		} else {
			items.push({ kind: "separator" }, { label: t("common.refresh"), onSelect: refresh });
		}
		setMenu({ x: event.clientX, y: event.clientY, items });
	};

	const onKeyDown = (event: React.KeyboardEvent) => {
		if (editing) return;
		const index = rows.findIndex((row) => row.entry.relPath === selected);
		const row = rows[index];
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
			if (next) setSelected(next.entry.relPath);
		} else if (!row) {
			return;
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (row.entry.kind === "dir") toggle(row.entry.relPath);
			else ws.open(row.entry.relPath);
		} else if (event.key === "ArrowRight" && row.entry.kind === "dir" && !expanded.has(row.entry.relPath)) {
			toggle(row.entry.relPath);
		} else if (event.key === "ArrowLeft") {
			if (row.entry.kind === "dir" && expanded.has(row.entry.relPath)) toggle(row.entry.relPath);
			else if (parentOf(row.entry.relPath)) setSelected(parentOf(row.entry.relPath));
		} else if (event.key === "F2") {
			event.preventDefault();
			beginRename(row.entry);
		} else if (event.key === "Delete") {
			event.preventDefault();
			setConfirmDelete(row.entry);
		}
	};

	const editor = (depth: number, kind: "file" | "dir") => (
		<div className="flex items-center gap-1.5 py-0.5 pr-2" style={{ paddingLeft: 8 + depth * 12 }}>
			<span className="w-3.5 shrink-0" />
			{kind === "dir" ? <FolderIcon className="size-3.5 shrink-0" /> : <FileTypeIcon name={draft || "file"} className="size-3.5 shrink-0" />}
			<input
				autoFocus
				spellCheck={false}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => void commitEdit()}
				onKeyDown={(event) => {
					event.stopPropagation();
					if (event.key === "Enter") void commitEdit();
					else if (event.key === "Escape") setEditing(null);
				}}
				onFocus={(event) => {
					// Select the name without its extension, as renaming usually keeps it.
					const dot = event.currentTarget.value.lastIndexOf(".");
					event.currentTarget.setSelectionRange(0, dot > 0 ? dot : event.currentTarget.value.length);
				}}
				className="min-w-0 flex-1 rounded border border-[color:var(--color-border-focus)] bg-[var(--color-background-control-opaque)] px-1 text-[length:var(--app-font-size-ui,12px)] outline-none"
			/>
		</div>
	);

	const creatingIn = editing && editing.mode !== "rename" ? editing.parent : null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelHeader title={t("ide.explorer.title")}>
				<PanelIconButton label={t("ide.explorer.newFile")} onClick={() => beginCreate("new-file", targetFolder())}>
					<VscNewFile />
				</PanelIconButton>
				<PanelIconButton label={t("ide.explorer.newFolder")} onClick={() => beginCreate("new-dir", targetFolder())}>
					<VscNewFolder />
				</PanelIconButton>
				<PanelIconButton label={t("common.refresh")} onClick={refresh}>
					<VscRefresh />
				</PanelIconButton>
				<PanelIconButton label={t("ide.explorer.collapseAll")} onClick={() => setExpanded(new Set())}>
					<VscCollapseAll />
				</PanelIconButton>
			</PanelHeader>
			<div
				ref={containerRef}
				role="tree"
				tabIndex={0}
				onKeyDown={onKeyDown}
				onContextMenu={(event) => openMenu(event, null)}
				className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-6 outline-none"
			>
				{creatingIn === "" ? editor(0, editing?.mode === "new-dir" ? "dir" : "file") : null}
				{rows.map(({ entry, depth }) => {
					const isDir = entry.kind === "dir";
					const open = isDir && expanded.has(entry.relPath);
					const status = git.status(entry.relPath, isDir);
					const dirty = !isDir && ws.docs.get(entry.relPath)?.dirty;
					const renaming = editing?.mode === "rename" && editing.target.relPath === entry.relPath;
					return (
						<div key={entry.relPath}>
							{renaming ? (
								editor(depth, entry.kind)
							) : (
								<div
									role="treeitem"
									aria-expanded={isDir ? open : undefined}
									aria-selected={selected === entry.relPath}
									title={entry.relPath}
									onClick={() => {
										setSelected(entry.relPath);
										containerRef.current?.focus();
										if (isDir) toggle(entry.relPath);
										else ws.open(entry.relPath, { preview: true });
									}}
									onDoubleClick={() => {
										if (!isDir) ws.open(entry.relPath, { preview: false });
									}}
									onContextMenu={(event) => openMenu(event, entry)}
									className={cn(
										"flex h-[22px] cursor-pointer select-none items-center gap-1.5 pr-2 text-[length:var(--app-font-size-ui,12px)]",
										selected === entry.relPath
											? "bg-[var(--sidebar-selected)] text-[var(--sidebar-accent-foreground)]"
											: "hover:bg-[var(--sidebar-accent)]",
									)}
									style={{ paddingLeft: 8 + depth * 12 }}
								>
									<span className="flex w-3.5 shrink-0 items-center justify-center text-muted-foreground">
										{isDir ? open ? <VscChevronDown /> : <VscChevronRight /> : null}
									</span>
									{isDir ? (
										open ? (
											<FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
										) : (
											<FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
										)
									) : (
										<FileTypeIcon name={entry.name} className="size-3.5 shrink-0" />
									)}
									<span className={cn("min-w-0 flex-1 truncate", status && GIT_STATUS_CLASS[status])}>
										{entry.name}
									</span>
									{dirty ? <span className="size-1.5 shrink-0 rounded-full bg-foreground/70" /> : null}
									{status ? (
										<span className={cn("shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] font-medium", GIT_STATUS_CLASS[status])}>
											{isDir ? "•" : status}
										</span>
									) : null}
								</div>
							)}
							{isDir && open && creatingIn === entry.relPath
								? editor(depth + 1, editing?.mode === "new-dir" ? "dir" : "file")
								: null}
						</div>
					);
				})}
				{rows.length === 0 && !editing ? (
					<div className="flex flex-col items-start gap-2 px-3 py-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
						{t("ide.explorer.empty")}
						<Button size="xs" variant="chrome-outline" onClick={() => beginCreate("new-file", "")}>
							{t("ide.explorer.newFile")}
						</Button>
					</div>
				) : null}
			</div>

			<ContextMenu menu={menu} onClose={() => setMenu(null)} />
			<ConfirmDialog
				open={confirmDelete !== null}
				onOpenChange={(open) => {
					if (!open) setConfirmDelete(null);
				}}
				title={t("ide.explorer.deleteTitle", { name: confirmDelete?.name ?? "" })}
				description={t("ide.explorer.deleteDescription")}
				footer={
					<>
						<Button onClick={() => setConfirmDelete(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button autoFocus onClick={() => confirmDelete && void remove(confirmDelete)} size="sm" variant="destructive">
							{t("common.delete")}
						</Button>
					</>
				}
			/>
		</div>
	);
}
