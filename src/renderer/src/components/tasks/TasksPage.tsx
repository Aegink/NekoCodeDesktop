import { useEffect, useRef, useState } from "react";
import { projectLabel } from "../../../../shared/paths";
import { activeTaskCount, type TaskBoardEntry } from "../../../../shared/task-board";
import { api, errorMessage } from "../../api";
import { useTranslation, type TranslateFn } from "../../i18n";
import { useNow } from "../../lib/elapsed";
import {
	CircleAlertIcon,
	CircleCheckIcon,
	CircleXIcon,
	GitBranchIcon,
	KanbanIcon,
	StopIcon,
	XIcon,
} from "../../lib/icons";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { Button } from "../ui/button";
import { DiffStat } from "../ui/diff-stat";
import { Spinner } from "../ui/spinner";

/** `m:ss`, the way a stopwatch reads — every row's clock lines up. */
function clock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function StatusGlyph({ entry }: { entry: TaskBoardEntry }) {
	switch (entry.status) {
		case "running":
			return (
				<span className="flex size-3.5 items-center justify-center">
					<span className="size-1.5 animate-pulse rounded-full bg-foreground" />
				</span>
			);
		case "question":
			return <CircleAlertIcon className="size-3.5 text-[var(--warning)]" />;
		case "done":
			return <CircleCheckIcon className="size-3.5 text-[var(--success)]" />;
		case "failed":
			return <CircleXIcon className="size-3.5 text-destructive" />;
	}
}

/** The second line of a row: what the task is doing, or how it ended. */
function statusText(entry: TaskBoardEntry, t: TranslateFn): string {
	if (entry.status === "done") return entry.summary ?? t("tasks.status.done");
	if (entry.status === "failed") return entry.summary ?? t("tasks.status.failed");
	const activity = entry.activity;
	switch (activity.kind) {
		case "tool":
			return activity.subject ? `${activity.toolName} ${activity.subject}` : activity.toolName;
		case "question":
			return t("agentMap.activity.question");
		case "thinking":
			return t("agentMap.activity.thinking");
		case "replying":
			return t("agentMap.activity.replying");
		case "waiting":
			return t("agentMap.activity.waiting");
		case "idle":
			return t("agentMap.activity.idle");
	}
}

function TaskRow({
	entry,
	now,
	cwd,
	onOpen,
}: {
	entry: TaskBoardEntry;
	now: number;
	cwd: string | null;
	onOpen: (entry: TaskBoardEntry) => void;
}) {
	const { t } = useTranslation();
	const live = entry.status === "running" || entry.status === "question";
	const elapsed = entry.startedAt === null ? null : clock((entry.endedAt ?? now) - entry.startedAt);
	// A worktree already names where the task works; otherwise the project does,
	// but only when it is not the one the board is looking at.
	const place = entry.worktree
		? null
		: cwd && entry.cwd !== cwd
			? projectLabel(entry.cwd, api.homeDir)
			: null;
	return (
		<li className="group relative">
			<button
				type="button"
				onClick={() => onOpen(entry)}
				className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
			>
				<span className="mt-px shrink-0">
					<StatusGlyph entry={entry} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] font-medium">
							{entry.titlePending ? t("sessions.pendingTitle") : entry.title}
						</span>
						{entry.selected ? (
							<span className="shrink-0 rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{t("tasks.onScreen")}
							</span>
						) : null}
						<span className="flex-1" />
						{/* Room for the hover actions, which sit over this corner. */}
						<span className="flex shrink-0 items-center gap-2 font-mono text-[length:var(--app-font-size-ui-xs,10px)] group-hover:invisible">
							{entry.additions || entry.deletions ? (
								<DiffStat insertions={entry.additions} deletions={entry.deletions} />
							) : null}
							{elapsed ? <span className={MUTED_LABEL_TEXT_CLASS_NAME}>{elapsed}</span> : null}
						</span>
					</span>
					<span
						className={cn(
							"flex min-w-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)]",
							MUTED_LABEL_TEXT_CLASS_NAME,
						)}
					>
						{entry.worktree ? (
							<>
								<GitBranchIcon className="size-3 shrink-0" />
								<span className="shrink-0 font-mono">{entry.worktree.branch}</span>
								<span className="shrink-0 opacity-60">·</span>
							</>
						) : place ? (
							<>
								<span className="shrink-0">{place}</span>
								<span className="shrink-0 opacity-60">·</span>
							</>
						) : null}
						<span className={cn("min-w-0 truncate", entry.status === "running" && "shimmer")}>
							{statusText(entry, t)}
						</span>
						{!live && entry.files ? (
							<span className="shrink-0 opacity-70">· {t("tasks.files", { count: entry.files })}</span>
						) : null}
					</span>
				</span>
			</button>
			<span className="absolute top-2 right-2 hidden items-center gap-0.5 group-hover:flex">
				{live ? (
					<Button
						aria-label={t("tasks.stop")}
						title={t("tasks.stop")}
						onClick={() => void api.agentAbortTask(entry.sessionId)}
						size="icon-xs"
						variant="ghost"
					>
						<StopIcon className="size-3" />
					</Button>
				) : (
					<Button
						aria-label={t("tasks.dismiss")}
						title={t("tasks.dismiss")}
						onClick={() => void api.agentDismissTasks([entry.sessionId])}
						size="icon-xs"
						variant="ghost"
					>
						<XIcon className="size-3.5" />
					</Button>
				)}
			</span>
		</li>
	);
}

/**
 * 多任务: start several tasks and watch them move together.
 *
 * Every task is a session of its own, started in the background, so starting
 * the next never waits on or disturbs the last. The board is a summary of all
 * of them at once; clicking one opens its conversation full screen, the way a
 * sidebar row does.
 */
export function TasksPage({
	cwd,
	entries,
	workspaceName,
	onOpen,
	onOpenSettings,
	onClose,
}: {
	cwd: string | null;
	entries: TaskBoardEntry[];
	workspaceName: string;
	onOpen: (entry: TaskBoardEntry) => void;
	onOpenSettings: () => void;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState("");
	/** Starts still on their way — several can be, since each is sent without waiting. */
	const [launching, setLaunching] = useState(0);
	const [notice, setNotice] = useState<{ kind: "error" | "warning"; text: string } | null>(null);
	const [isolated, setIsolated] = useState<boolean | null>(null);
	const input = useRef<HTMLTextAreaElement | null>(null);
	const running = activeTaskCount(entries);
	const now = useNow(running > 0);
	const finished = entries.filter((entry) => entry.status === "done" || entry.status === "failed");

	useEffect(() => {
		api
			.preferencesGet()
			.then((preferences) => setIsolated(preferences.isolateBackgroundTasks))
			.catch(() => undefined);
		input.current?.focus();
	}, []);

	const launch = async () => {
		const text = draft.trim();
		if (!text || !cwd) return;
		// Cleared at once, not after the reply: the next task can be typed while
		// this one is still being set up — a worktree takes a moment to create.
		setDraft("");
		setNotice(null);
		setLaunching((count) => count + 1);
		try {
			const result = await api.agentStartBackground({ cwd, text });
			if (!result.accepted) {
				setNotice({ kind: "error", text: result.error });
				// Given back rather than lost, unless something new is being typed.
				setDraft((current) => (current.trim() ? current : text));
			} else if (result.warning) setNotice({ kind: "warning", text: result.warning });
		} catch (cause) {
			setNotice({ kind: "error", text: errorMessage(cause) });
			setDraft((current) => (current.trim() ? current : text));
		} finally {
			setLaunching((count) => count - 1);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--app-surface-divider)] px-3">
				<KanbanIcon className="size-3.5" />
				<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">{t("nav.tasks")}</span>
				<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
					{t("tasks.workspace", { name: workspaceName })}
				</span>
				<div className="flex-1" />
				{running ? (
					<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
						{t("tasks.runningCount", { count: running })}
					</span>
				) : null}
				{finished.length ? (
					<Button
						onClick={() => void api.agentDismissTasks(finished.map((entry) => entry.sessionId))}
						size="xs"
						variant="chrome-outline"
					>
						{t("tasks.clearFinished")}
					</Button>
				) : null}
				<Button aria-label={t("common.close")} onClick={onClose} size="icon-xs" variant="ghost">
					<XIcon className="size-3.5" />
				</Button>
			</header>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
					<form
						className="flex flex-col rounded-lg border border-[color:var(--color-border)] bg-[var(--composer-surface)]"
						onSubmit={(event) => {
							event.preventDefault();
							void launch();
						}}
					>
						<textarea
							ref={input}
							value={draft}
							disabled={!cwd}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
								event.preventDefault();
								void launch();
							}}
							placeholder={cwd ? t("tasks.launchPlaceholder") : t("tasks.noProject")}
							rows={2}
							className="field-sizing-content max-h-48 min-h-14 w-full resize-none bg-transparent px-3 py-2.5 text-[length:var(--app-font-size-ui,12px)] outline-none placeholder:text-muted-foreground"
						/>
						<div className="flex items-center gap-2 px-2 pb-2">
							<span
								className={cn(
									"flex min-w-0 flex-1 items-center gap-1.5 truncate pl-1 text-[length:var(--app-font-size-ui-xs,10px)]",
									MUTED_LABEL_TEXT_CLASS_NAME,
								)}
							>
								{cwd ? <span className="shrink-0 font-medium">{projectLabel(cwd, api.homeDir)}</span> : null}
								{isolated !== null ? (
									<>
										<span className="shrink-0 opacity-60">·</span>
										{isolated ? <GitBranchIcon className="size-3 shrink-0" /> : null}
										<span className="truncate">{isolated ? t("tasks.isolated") : t("tasks.shared")}</span>
										<button
											type="button"
											onClick={onOpenSettings}
											className="shrink-0 text-[var(--color-token-text-link-foreground)] hover:underline"
										>
											{t("tasks.changeIsolation")}
										</button>
									</>
								) : null}
							</span>
							{launching ? (
								<span
									className={cn(
										"flex shrink-0 items-center gap-1 text-[length:var(--app-font-size-ui-xs,10px)]",
										MUTED_LABEL_TEXT_CLASS_NAME,
									)}
								>
									<Spinner className="size-3" />
									{t("tasks.launching", { count: launching })}
								</span>
							) : null}
							<Button disabled={!cwd || !draft.trim()} size="xs" type="submit" variant="default">
								{t("tasks.launch")}
							</Button>
						</div>
					</form>

					{notice ? (
						<p
							className={cn(
								"px-1 text-[length:var(--app-font-size-ui-sm,11px)]",
								notice.kind === "error" ? "text-destructive" : "text-[var(--warning)]",
							)}
						>
							{notice.text}
						</p>
					) : null}

					{entries.length === 0 ? (
						<p className={cn("px-1 py-6 text-center text-[length:var(--app-font-size-ui-sm,11px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
							{t("tasks.empty")}
						</p>
					) : (
						<ul className="flex flex-col divide-y divide-[color:var(--app-surface-divider)] overflow-hidden rounded-lg border border-[color:var(--color-border)]">
							{entries.map((entry) => (
								<TaskRow cwd={cwd} entry={entry} key={entry.sessionId} now={now} onOpen={onOpen} />
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}
