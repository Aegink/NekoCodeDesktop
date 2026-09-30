import { useState } from "react";
import { VscAdd, VscCheck, VscDiscard, VscGoToFile, VscRefresh, VscRemove } from "react-icons/vsc";
import type { ChangedFile, GitActionKind, RepoStatus } from "../../../../shared/git";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { FileTypeIcon } from "../../lib/fileIcons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { changedPath, GIT_STATUS_CLASS, gitLetter } from "./git-decorations";
import type { IdeWorkspace } from "./ide-store";
import { PanelHeader, PanelIconButton } from "./PanelChrome";

interface Row {
	file: ChangedFile;
	path: string;
	/** Which side of the index this row is: a file with both shows twice. */
	staged: boolean;
}

/** The status letter for one side of a porcelain `XY` pair. */
function sideLetter(file: ChangedFile, staged: boolean) {
	if (file.untracked) return gitLetter("??");
	const code = staged ? file.status[0] : file.status[1];
	return gitLetter(code && code !== " " ? `${code} ` : file.status);
}

/** Source control: what changed, staging, discarding and committing. */
export function ScmPanel({
	ws,
	repo,
	onRefresh,
}: {
	ws: IdeWorkspace;
	repo: RepoStatus | null;
	onRefresh: () => void;
}) {
	const { t } = useTranslation();
	const cwd = ws.cwd;
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [discard, setDiscard] = useState<Row | "all" | null>(null);

	const files = repo?.files ?? [];
	const staged: Row[] = files
		.filter((file) => file.staged)
		.map((file) => ({ file, path: changedPath(file), staged: true }));
	const changes: Row[] = files
		.filter((file) => file.untracked || (file.status[1] !== " " && file.status[1] !== undefined))
		.map((file) => ({ file, path: changedPath(file), staged: false }));

	const run = async (work: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
			onRefresh();
		}
	};

	const action = (kind: GitActionKind, file?: string) => run(() => api.gitAction({ cwd, action: kind, ...(file ? { file } : {}) }));

	const commit = () =>
		run(async () => {
			// Unsaved edits are not what the user sees as "the change"; save first.
			await ws.saveAll();
			await api.ideGitCommit(cwd, message, staged.length === 0);
			setMessage("");
			for (const tab of ws.tabs) if (tab.kind === "diff") void ws.refreshHead(tab.relPath);
		});

	const confirmDiscard = async () => {
		const target = discard;
		setDiscard(null);
		if (!target) return;
		await action("revert", target === "all" ? undefined : target.path);
		// The buffer should follow the file back, unless it holds edits of its own.
		for (const doc of ws.docs.values()) if (!doc.dirty) void ws.revert(doc.relPath).catch(() => undefined);
	};

	if (repo && !repo.gitAvailable) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<PanelHeader title={t("ide.scm.title")} />
				<p className="px-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{repo.gitError ?? t("ide.scm.noGit")}</p>
			</div>
		);
	}

	if (repo && !repo.isRepo) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<PanelHeader title={t("ide.scm.title")} />
				<div className="flex flex-col items-start gap-2 px-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
					{t("ide.scm.notRepo")}
					<Button size="xs" variant="chrome-outline" disabled={busy} onClick={() => void run(() => api.gitInit(cwd))}>
						{t("ide.scm.init")}
					</Button>
				</div>
			</div>
		);
	}

	const group = (title: string, rows: Row[], isStaged: boolean) =>
		rows.length === 0 ? null : (
			<div className="flex flex-col">
				<div className="group/header flex h-[22px] items-center gap-1 px-3 text-[length:var(--app-font-size-ui-xs,10px)] font-semibold uppercase tracking-wide text-muted-foreground">
					<span className="flex-1">{title}</span>
					<span className="hidden items-center group-hover/header:flex">
						{isStaged ? (
							<PanelIconButton label={t("ide.scm.unstageAll")} onClick={() => void action("unstage")} disabled={busy}>
								<VscRemove />
							</PanelIconButton>
						) : (
							<>
								<PanelIconButton label={t("ide.scm.discardAll")} onClick={() => setDiscard("all")} disabled={busy}>
									<VscDiscard />
								</PanelIconButton>
								<PanelIconButton label={t("ide.scm.stageAll")} onClick={() => void action("stage")} disabled={busy}>
									<VscAdd />
								</PanelIconButton>
							</>
						)}
					</span>
					<span className="rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)] font-normal">
						{rows.length}
					</span>
				</div>
				{rows.map((row) => {
					const name = row.path.slice(row.path.lastIndexOf("/") + 1);
					const dir = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "";
					const letter = sideLetter(row.file, row.staged);
					return (
						<div
							key={`${row.staged}:${row.path}`}
							role="button"
							tabIndex={0}
							title={row.path}
							onClick={() => ws.open(row.path, { kind: letter === "D" ? "file" : "diff", preview: true })}
							onKeyDown={(event) => {
								if (event.key === "Enter") ws.open(row.path, { kind: "diff", preview: true });
							}}
							className="group/row flex h-[22px] cursor-pointer items-center gap-1.5 pl-5 pr-2 text-[length:var(--app-font-size-ui,12px)] hover:bg-[var(--sidebar-accent)]"
						>
							<FileTypeIcon name={name} className="size-3.5 shrink-0" />
							<span className={cn("shrink-0", letter === "D" && "line-through")}>{name}</span>
							<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{dir}</span>
							<span className="hidden items-center group-hover/row:flex" onClick={(event) => event.stopPropagation()}>
								<PanelIconButton label={t("ide.scm.openFile")} onClick={() => ws.open(row.path, { preview: false })}>
									<VscGoToFile />
								</PanelIconButton>
								{row.staged ? (
									<PanelIconButton label={t("ide.scm.unstage")} onClick={() => void action("unstage", row.path)} disabled={busy}>
										<VscRemove />
									</PanelIconButton>
								) : (
									<>
										<PanelIconButton label={t("ide.scm.discard")} onClick={() => setDiscard(row)} disabled={busy}>
											<VscDiscard />
										</PanelIconButton>
										<PanelIconButton label={t("ide.scm.stage")} onClick={() => void action("stage", row.path)} disabled={busy}>
											<VscAdd />
										</PanelIconButton>
									</>
								)}
							</span>
							<span className={cn("w-3 shrink-0 text-center text-[length:var(--app-font-size-ui-xs,10px)] font-medium", GIT_STATUS_CLASS[letter])}>
								{letter}
							</span>
						</div>
					);
				})}
			</div>
		);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelHeader title={repo?.branch ? `${t("ide.scm.title")} · ${repo.branch}` : t("ide.scm.title")}>
				<PanelIconButton label={t("common.refresh")} onClick={onRefresh}>
					<VscRefresh />
				</PanelIconButton>
			</PanelHeader>
			<div className="flex shrink-0 flex-col gap-1.5 px-2 pb-2">
				<textarea
					value={message}
					onChange={(event) => setMessage(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && message.trim() && files.length) {
							event.preventDefault();
							void commit();
						}
					}}
					rows={3}
					placeholder={t("ide.scm.messagePlaceholder")}
					className="w-full resize-none rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2 py-1 text-[length:var(--app-font-size-ui,12px)] outline-none placeholder:text-muted-foreground/60 focus:border-[color:var(--color-border-focus)]"
				/>
				<Button size="sm" variant="default" disabled={busy || !message.trim() || files.length === 0} onClick={() => void commit()}>
					<VscCheck />
					{staged.length === 0 ? t("ide.scm.commitAll") : t("ide.scm.commit")}
				</Button>
				{error ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span> : null}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto pb-4">
				{repo === null ? (
					<p className="px-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("common.loading")}</p>
				) : files.length === 0 ? (
					<p className="px-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("ide.scm.clean")}</p>
				) : (
					<>
						{group(t("ide.scm.staged"), staged, true)}
						{group(t("ide.scm.changes"), changes, false)}
					</>
				)}
			</div>
			<ConfirmDialog
				open={discard !== null}
				onOpenChange={(open) => {
					if (!open) setDiscard(null);
				}}
				title={discard === "all" ? t("ide.scm.discardAllTitle") : t("ide.scm.discardTitle", { name: discard?.path ?? "" })}
				description={
					discard !== "all" && discard?.file.untracked ? t("ide.scm.discardUntracked") : t("ide.scm.discardDescription")
				}
				footer={
					<>
						<Button onClick={() => setDiscard(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button autoFocus onClick={() => void confirmDiscard()} size="sm" variant="destructive">
							{t("ide.scm.discard")}
						</Button>
					</>
				}
			/>
		</div>
	);
}
