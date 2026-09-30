import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { VscClose, VscExtensions, VscFiles, VscHistory, VscSearch, VscSettingsGear, VscSourceControl } from "react-icons/vsc";
import type { SessionSummary } from "../../../../shared/agent";
import type { RepoStatus } from "../../../../shared/git";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { NewThreadIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME } from "../chat/composerPickerStyles";
import { TerminalPanel } from "../TerminalPanel";
import { Button } from "../ui/button";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { EditorArea, type EditorAreaHandle, type EditorStatus, type InlineEditRequest } from "./EditorArea";
import { extensionRuntime } from "./extension-runtime";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { FileExplorer } from "./FileExplorer";
import { gitDecorations } from "./git-decorations";
import { workspaceFor } from "./ide-store";
import { PanelIconButton } from "./PanelChrome";
import { QuickOpen } from "./QuickOpen";
import { ScmPanel } from "./ScmPanel";
import { SearchPanel } from "./SearchPanel";
import { StatusBar } from "./StatusBar";

type SideView = "explorer" | "search" | "scm" | "extensions";

const SIDE_WIDTH_KEY = "nekocode:ide-side-width";
const CHAT_WIDTH_KEY = "nekocode:ide-chat-width";
const TERMINAL_HEIGHT_KEY = "nekocode:ide-terminal-height";
const SIDE_VIEW_KEY = "nekocode:ide-side-view";
/** How often open files are checked against the disk — the agent edits them. */
const DISK_POLL_MS = 2000;
const GIT_POLL_MS = 10_000;

function readNumber(key: string, fallback: number): number {
	try {
		const value = Number(localStorage.getItem(key));
		return Number.isFinite(value) && value > 0 ? value : fallback;
	} catch {
		return fallback;
	}
}

function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// not persisted
	}
}

/** A drag handle between two panes. `sign` is which way growing goes. */
function useDrag(
	value: number,
	setValue: (next: number) => void,
	options: { axis: "x" | "y"; sign: 1 | -1; min: number; max: () => number; storageKey: string },
) {
	return (event: React.MouseEvent) => {
		event.preventDefault();
		const start = options.axis === "x" ? event.clientX : event.clientY;
		const initial = value;
		let latest = value;
		const onMove = (move: MouseEvent) => {
			const delta = ((options.axis === "x" ? move.clientX : move.clientY) - start) * options.sign;
			latest = Math.round(Math.min(options.max(), Math.max(options.min, initial + delta)));
			setValue(latest);
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			document.body.style.cursor = "";
			writeStored(options.storageKey, String(latest));
		};
		document.body.style.cursor = options.axis === "x" ? "col-resize" : "row-resize";
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};
}

function Splitter({ axis, onMouseDown }: { axis: "x" | "y"; onMouseDown: (event: React.MouseEvent) => void }) {
	return (
		<div
			aria-hidden="true"
			onMouseDown={onMouseDown}
			className={cn(
				"relative z-10 shrink-0 bg-transparent transition-colors hover:bg-[var(--color-text-accent)]/40",
				axis === "x" ? "-mx-0.5 w-1 cursor-col-resize" : "-my-0.5 h-1 cursor-row-resize",
			)}
		/>
	);
}

function ActivityButton({
	label,
	active,
	badge,
	onClick,
	children,
}: {
	label: string;
	active?: boolean;
	badge?: number;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"relative flex size-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-5",
				active && "text-foreground",
			)}
		>
			{active ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-[var(--color-text-accent)]" /> : null}
			{children}
			{badge ? (
				<span className="absolute bottom-1.5 right-1 min-w-3.5 rounded-full bg-[var(--color-text-accent)] px-1 text-center text-[9px] leading-3.5 text-white">
					{badge > 99 ? "99+" : badge}
				</span>
			) : null}
		</button>
	);
}

export interface IdeLayoutProps {
	cwd: string | null;
	visible: boolean;
	dark: boolean;
	/** The agent conversation, docked on the right like Cursor's chat. */
	chat: ReactNode;
	chatTitle: string | null;
	sideOpen: boolean;
	onSideOpenChange: (open: boolean) => void;
	chatOpen: boolean;
	onChatOpenChange: (open: boolean) => void;
	streaming: boolean;
	/** Bumped when an agent run ends: files and git state may have moved. */
	agentActivity: number;
	/** A file the conversation asked to open — a tool row's click. */
	openFileRequest: { path: string; nonce: number } | null;
	sessions: SessionSummary[];
	activeSessionId: string | null;
	onOpenSession: (session: SessionSummary) => void;
	onNewSession: () => void;
	onAddToChat: (text: string) => void;
	onInlineEdit: (request: InlineEditRequest) => Promise<void>;
	onOpenSettings: () => void;
	onPickProject: () => void;
}

/**
 * The editor-first layout: activity bar, a side panel (files, search, source
 * control), tabbed editors over a terminal, and the agent's conversation docked
 * on the right — the arrangement Cursor made familiar.
 */
export default function IdeLayout(props: IdeLayoutProps) {
	const { t, language } = useTranslation();
	const { cwd } = props;
	// Installed VS Code extensions apply to every project, so they load here,
	// above the per-project workbench.
	useEffect(() => {
		api
			.ideExtensionsList(language)
			.then((snapshot) => extensionRuntime.apply(snapshot))
			.catch(() => undefined);
	}, [language]);
	if (!cwd) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
				{t("ide.noProject")}
				<Button size="sm" variant="chrome-outline" onClick={props.onPickProject}>
					{t("ide.openProject")}
				</Button>
			</div>
		);
	}
	return <IdeWorkbench key={cwd} {...props} cwd={cwd} />;
}

function IdeWorkbench({
	cwd,
	visible,
	dark,
	chat,
	chatTitle,
	sideOpen,
	onSideOpenChange,
	chatOpen,
	onChatOpenChange,
	streaming,
	agentActivity,
	openFileRequest,
	sessions,
	activeSessionId,
	onOpenSession,
	onNewSession,
	onAddToChat,
	onInlineEdit,
	onOpenSettings,
}: IdeLayoutProps & { cwd: string }) {
	const { t } = useTranslation();
	const ws = useMemo(() => workspaceFor(cwd), [cwd]);
	useSyncExternalStore(ws.subscribe, ws.getVersion);
	const editorRef = useRef<EditorAreaHandle | null>(null);
	const chatRef = useRef<HTMLElement | null>(null);
	const [sideView, setSideView] = useState<SideView>(() => {
		try {
			const stored = localStorage.getItem(SIDE_VIEW_KEY);
			return stored === "search" || stored === "scm" || stored === "extensions" ? stored : "explorer";
		} catch {
			return "explorer";
		}
	});
	const [sideWidth, setSideWidth] = useState(() => readNumber(SIDE_WIDTH_KEY, 260));
	const [chatWidth, setChatWidth] = useState(() => readNumber(CHAT_WIDTH_KEY, 420));
	const [terminalHeight, setTerminalHeight] = useState(() => readNumber(TERMINAL_HEIGHT_KEY, 240));
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [quickOpen, setQuickOpen] = useState(false);
	const [status, setStatus] = useState<EditorStatus | null>(null);
	const [repo, setRepo] = useState<RepoStatus | null>(null);
	const [searchFocus, setSearchFocus] = useState(0);
	const [searchSeed, setSearchSeed] = useState<{ text: string; nonce: number } | null>(null);
	const [historyMenu, setHistoryMenu] = useState<ContextMenuState | null>(null);
	const [localError, setLocalError] = useState<string | null>(null);

	const reportError = useCallback((message: string) => setLocalError(message), []);
	useEffect(() => {
		if (!localError) return;
		const timer = setTimeout(() => setLocalError(null), 6000);
		return () => clearTimeout(timer);
	}, [localError]);

	const showSide = (view: SideView) => {
		setSideView(view);
		writeStored(SIDE_VIEW_KEY, view);
		onSideOpenChange(true);
	};

	/** Clicking the active view's icon folds the panel away, as in VS Code. */
	const toggleSide = (view: SideView) => {
		if (sideOpen && sideView === view) onSideOpenChange(false);
		else showSide(view);
	};

	const refreshGit = useCallback(() => {
		api
			.gitStatus(cwd)
			.then(setRepo)
			.catch(() => setRepo(null));
	}, [cwd]);

	// Git state: on open, after agent runs, on a slow timer, and shortly after edits are saved.
	useEffect(() => {
		refreshGit();
	}, [refreshGit, agentActivity]);
	useEffect(() => {
		if (!visible) return;
		const timer = setInterval(refreshGit, GIT_POLL_MS);
		return () => clearInterval(timer);
	}, [visible, refreshGit]);
	const savedFingerprint = [...ws.docs.values()].map((doc) => `${doc.relPath}:${doc.mtimeMs}`).join("|");
	useEffect(() => {
		const timer = setTimeout(refreshGit, 800);
		return () => clearTimeout(timer);
	}, [savedFingerprint, refreshGit]);

	// Open files follow the disk while the IDE is on screen.
	useEffect(() => {
		if (!visible) return;
		const poll = () => {
			if (document.visibilityState === "visible") void ws.pollDisk().catch(() => undefined);
		};
		poll();
		const timer = setInterval(poll, DISK_POLL_MS);
		window.addEventListener("focus", poll);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", poll);
		};
	}, [visible, ws, agentActivity]);

	// A file the conversation pointed at — absolute or project-relative.
	useEffect(() => {
		if (!openFileRequest) return;
		const norm = (path: string) => path.replace(/\\/g, "/");
		const root = norm(cwd).replace(/\/+$/, "");
		let rel = norm(openFileRequest.path).replace(/^\.\//, "");
		if (rel.toLowerCase().startsWith(`${root.toLowerCase()}/`)) rel = rel.slice(root.length + 1);
		const match = rel.match(/^(.*?):(\d+)(?::(\d+))?$/);
		if (match) ws.open(match[1]!, { line: Number(match[2]), column: Number(match[3] ?? 1) });
		else ws.open(rel);
	}, [openFileRequest, cwd, ws]);

	const focusChat = useCallback(() => {
		if (!chatOpen) onChatOpenChange(true);
		// After the panel has rendered: its composer is the textarea inside.
		requestAnimationFrame(() => chatRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
	}, [chatOpen, onChatOpenChange]);

	const addToChat = useCallback(
		(text: string) => {
			onAddToChat(text);
			focusChat();
		},
		[onAddToChat, focusChat],
	);

	const inlineEdit = useCallback(
		async (request: InlineEditRequest) => {
			if (!chatOpen) onChatOpenChange(true);
			await onInlineEdit(request);
		},
		[chatOpen, onChatOpenChange, onInlineEdit],
	);

	// Workbench shortcuts. Keys the editor handles never get here — Monaco stops
	// them — so these are the ones that work from anywhere in the layout.
	useEffect(() => {
		if (!visible) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			const mod = event.ctrlKey || event.metaKey;
			if (!mod) return;
			const key = event.key.toLowerCase();
			const run = (action: () => void) => {
				event.preventDefault();
				event.stopPropagation();
				action();
			};
			if (event.shiftKey && !event.altKey) {
				if (key === "p") run(() => editorRef.current?.commandPalette());
				else if (key === "e") run(() => showSide("explorer"));
				else if (key === "f")
					run(() => {
						const text = editorRef.current?.selectionText() ?? "";
						if (text) setSearchSeed({ text, nonce: Date.now() });
						showSide("search");
						setSearchFocus((value) => value + 1);
					});
				else if (key === "g") run(() => showSide("scm"));
				else if (key === "x") run(() => showSide("extensions"));
				else if (event.code === "Tab") run(() => cycleTab(-1));
				return;
			}
			if (event.altKey) {
				if (key === "b") run(() => onChatOpenChange(!chatOpen));
				else if (key === "s") run(() => void ws.saveAll());
				return;
			}
			if (key === "p") run(() => setQuickOpen(true));
			else if (key === "b") run(() => onSideOpenChange(!sideOpen));
			else if (event.code === "Backquote") run(() => setTerminalOpen((open) => !open));
			else if (key === "i") run(focusChat);
			else if (key === "s") run(() => void editorRef.current?.save());
			else if (key === "w") run(() => ws.activeId && editorRef.current?.requestClose([ws.activeId]));
			else if (key === "l") run(() => editorRef.current?.addSelectionToChat());
			else if (event.code === "Tab") run(() => cycleTab(1));
		};
		const cycleTab = (step: number) => {
			if (ws.tabs.length < 2) return;
			const at = ws.tabs.findIndex((tab) => tab.id === ws.activeId);
			const next = ws.tabs[(at + step + ws.tabs.length) % ws.tabs.length];
			if (next) ws.activate(next.id);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	const startSideDrag = useDrag(sideWidth, setSideWidth, {
		axis: "x",
		sign: 1,
		min: 170,
		max: () => Math.max(170, window.innerWidth * 0.45),
		storageKey: SIDE_WIDTH_KEY,
	});
	const startChatDrag = useDrag(chatWidth, setChatWidth, {
		axis: "x",
		sign: -1,
		min: 320,
		max: () => Math.max(320, window.innerWidth * 0.6),
		storageKey: CHAT_WIDTH_KEY,
	});
	const startTerminalDrag = useDrag(terminalHeight, setTerminalHeight, {
		axis: "y",
		sign: -1,
		min: 100,
		max: () => Math.max(100, window.innerHeight - 220),
		storageKey: TERMINAL_HEIGHT_KEY,
	});

	const git = useMemo(() => gitDecorations(repo), [repo]);
	const changeCount = repo?.files.length ?? 0;

	const openHistory = (event: React.MouseEvent<HTMLButtonElement>) => {
		const box = event.currentTarget.getBoundingClientRect();
		const recent = sessions.filter((session) => session.cwd === cwd).slice(0, 20);
		setHistoryMenu({
			x: box.left - 180,
			y: box.bottom + 4,
			items: recent.length
				? recent.map((session) => ({
						label: `${session.id === activeSessionId ? "● " : ""}${session.titlePending ? t("sidebar.newSession") : session.title}`,
						onSelect: () => onOpenSession(session),
					}))
				: [{ label: t("ide.chat.noHistory"), disabled: true, onSelect: () => undefined }],
		});
	};

	return (
		<div className="ide-layout flex h-full min-h-0 flex-col">
			<div className="flex min-h-0 flex-1">
				<nav className="flex w-11 shrink-0 flex-col items-center pt-1">
					<ActivityButton label={t("ide.explorer.title")} active={sideOpen && sideView === "explorer"} onClick={() => toggleSide("explorer")}>
						<VscFiles />
					</ActivityButton>
					<ActivityButton label={t("ide.search.title")} active={sideOpen && sideView === "search"} onClick={() => toggleSide("search")}>
						<VscSearch />
					</ActivityButton>
					<ActivityButton
						label={t("ide.ext.title")}
						active={sideOpen && sideView === "extensions"}
						onClick={() => toggleSide("extensions")}
					>
						<VscExtensions />
					</ActivityButton>
					<ActivityButton
						label={t("ide.scm.title")}
						active={sideOpen && sideView === "scm"}
						badge={changeCount}
						onClick={() => toggleSide("scm")}
					>
						<VscSourceControl />
					</ActivityButton>
					<div className="flex-1" />
					<ActivityButton label={t("settings.title")} onClick={onOpenSettings}>
						<VscSettingsGear />
					</ActivityButton>
				</nav>

				{sideOpen ? (
					<>
						<div className="flex min-h-0 shrink-0 flex-col" style={{ width: sideWidth }}>
							{sideView === "explorer" ? (
								<FileExplorer ws={ws} git={git} refreshSignal={agentActivity} onAddToChat={addToChat} onError={reportError} />
							) : sideView === "search" ? (
								<SearchPanel ws={ws} focusSignal={searchFocus} initialQuery={searchSeed} />
							) : sideView === "extensions" ? (
								<ExtensionsPanel />
							) : (
								<ScmPanel ws={ws} repo={repo} onRefresh={refreshGit} />
							)}
						</div>
						<Splitter axis="x" onMouseDown={startSideDrag} />
					</>
				) : null}

				<main
					className={cn(
						CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
						"flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-t-lg",
					)}
				>
					<EditorArea
						ref={editorRef}
						ws={ws}
						dark={dark}
						visible={visible}
						onStatus={setStatus}
						onAddToChat={addToChat}
						onInlineEdit={inlineEdit}
						onQuickOpen={() => setQuickOpen(true)}
						onFocusChat={focusChat}
						onError={reportError}
					/>
					{localError ? (
						<div className="flex shrink-0 items-center gap-2 border-t border-[color:var(--app-surface-divider)] px-3 py-1 text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">
							<span className="min-w-0 flex-1 truncate">{localError}</span>
							<button type="button" aria-label={t("common.close")} onClick={() => setLocalError(null)}>
								<VscClose />
							</button>
						</div>
					) : null}
					{terminalOpen ? (
						<>
							<Splitter axis="y" onMouseDown={startTerminalDrag} />
							<div className="flex shrink-0 flex-col border-t border-[color:var(--app-surface-divider)]" style={{ height: terminalHeight }}>
								<TerminalPanel cwd={cwd} docked onClose={() => setTerminalOpen(false)} />
							</div>
						</>
					) : null}
				</main>

				{chatOpen ? (
					<>
						<Splitter axis="x" onMouseDown={startChatDrag} />
						<aside
							ref={chatRef}
							className={cn(
								CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
								"ml-1 flex min-h-0 shrink-0 flex-col overflow-hidden rounded-t-lg",
							)}
							style={{ width: chatWidth }}
						>
							<div className="flex h-9 shrink-0 items-center gap-1 border-b border-[color:var(--app-surface-divider)] pl-3 pr-1.5">
								<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-sm,11px)] font-medium">
									{chatTitle ?? t("ide.chat.title")}
								</span>
								<PanelIconButton label={t("ide.chat.new")} onClick={onNewSession}>
									<NewThreadIcon />
								</PanelIconButton>
								<PanelIconButton label={t("ide.chat.history")} onClick={openHistory}>
									<VscHistory />
								</PanelIconButton>
								<PanelIconButton label={t("ide.chat.close")} onClick={() => onChatOpenChange(false)}>
									<VscClose />
								</PanelIconButton>
							</div>
							<div className="flex min-h-0 flex-1 flex-col">{chat}</div>
						</aside>
					</>
				) : null}
			</div>

			<StatusBar
				ws={ws}
				status={status}
				editor={editorRef.current}
				branch={git.branch}
				streaming={streaming}
				onOpenScm={() => showSide("scm")}
			/>

			{quickOpen ? (
				<QuickOpen ws={ws} onClose={() => setQuickOpen(false)} onCommandPalette={() => editorRef.current?.commandPalette()} />
			) : null}
			<ContextMenu menu={historyMenu} onClose={() => setHistoryMenu(null)} />
		</div>
	);
}
