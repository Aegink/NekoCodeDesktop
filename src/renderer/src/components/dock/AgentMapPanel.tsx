import type { ReactNode } from "react";
import type { AgentSnapshot } from "../../../../shared/agent";
import type { ExplorerRun, TaskStep, WorkflowTask, WorkflowTodo } from "../../../../shared/workflow";
import { useTranslation, type TranslationKey } from "../../i18n";
import {
	mainActivity,
	stepCounts,
	subagentActivity,
	summarizeTurn,
	type MainActivity,
	type SubagentActivity,
	type ToolCallSummary,
} from "../../lib/agentActivity";
import { elapsedSeconds, formatElapsed, useNow } from "../../lib/elapsed";
import { AgentMapIcon, BotIcon, CheckIcon, SearchIcon, TriangleAlertIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { Spinner } from "../ui/spinner";

/** Finished subagents drawn under the main agent; older ones are counted, not drawn. */
const MAX_FINISHED_SHOWN = 6;
const RECENT_STEPS = 3;

type Tone = "active" | "attention" | "idle" | "done" | "failed";

const STATUS_KEYS: Record<WorkflowTask["status"], TranslationKey> = {
	running: "workflow.running",
	completed: "workflow.completed",
	failed: "workflow.failed",
	cancelled: "workflow.cancelled",
};

const KIND_KEYS: Record<WorkflowTask["kind"], TranslationKey> = {
	explore: "workflow.taskKind.explore",
	worker: "workflow.taskKind.worker",
};

function toneOfStatus(status: WorkflowTask["status"]): Tone {
	return status === "running" ? "active" : status === "completed" ? "done" : status === "failed" ? "failed" : "idle";
}

/** A node's state at a glance: a pulse while it works, a mark once it is done. */
function StatusMark({ tone }: { tone: Tone }) {
	if (tone === "done") return <CheckIcon className="size-3.5 shrink-0 text-[var(--success,#16a34a)]" />;
	if (tone === "failed") return <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />;
	return (
		<span className="relative flex size-2.5 shrink-0 items-center justify-center" aria-hidden="true">
			{tone === "active" ? <span className="agent-map-pulse absolute inset-0 rounded-full bg-[var(--color-token-text-link-foreground)]" /> : null}
			<span
				className={cn(
					"relative size-2 rounded-full",
					tone === "active" && "bg-[var(--color-token-text-link-foreground)]",
					tone === "attention" && "bg-[var(--warning,#d97706)]",
					tone === "idle" && "bg-muted-foreground/40",
				)}
			/>
		</span>
	);
}

function Elapsed({ since, until, live }: { since: number; until?: number; live: boolean }) {
	const now = useNow(live);
	return <span className="shrink-0 tabular-nums">{formatElapsed(elapsedSeconds(since, until ?? now))}</span>;
}

/** The line under a node's title that says what it is doing now. */
function ActivityLine({ tone, children, since, live }: { tone: Tone; children: ReactNode; since?: number; live: boolean }) {
	return (
		<div
			className={cn(
				"flex min-w-0 items-center gap-1.5 text-[length:var(--app-font-size-ui,12px)]",
				tone === "attention" ? "text-[var(--warning,#d97706)]" : tone === "failed" ? "text-destructive" : "text-foreground",
			)}
		>
			{tone === "active" && since !== undefined ? <Spinner className="size-3 shrink-0 text-muted-foreground" /> : null}
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{since !== undefined ? (
				<span className={cn("text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
					<Elapsed since={since} live={live} />
				</span>
			) : null}
		</div>
	);
}

function ToolLabel({ name, subject }: { name: string; subject: string | null }) {
	return (
		<>
			<span className="font-mono font-medium">{name}</span>
			{subject ? <span className={cn("font-mono", MUTED_LABEL_TEXT_CLASS_NAME)}> {subject}</span> : null}
		</>
	);
}

/** A few of the node's latest calls, newest last, so a glance shows the path it took. */
function RecentCalls({ calls }: { calls: { id: string; name: string; subject: string | null; status: "pending" | "running" | "done" | "error" }[] }) {
	if (calls.length === 0) return null;
	return (
		<ol className="flex flex-col gap-0.5 border-t border-[color:var(--app-surface-divider)] pt-1.5">
			{calls.map((call) => (
				<li key={call.id} className="flex min-w-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)]">
					{call.status === "running" || call.status === "pending" ? (
						<Spinner className="size-3 shrink-0 text-muted-foreground" />
					) : call.status === "error" ? (
						<TriangleAlertIcon className="size-3 shrink-0 text-destructive" />
					) : (
						<span className="size-3 shrink-0 text-center leading-3 text-muted-foreground/60">·</span>
					)}
					<span className={cn("min-w-0 flex-1 truncate", call.status === "done" && "opacity-70")}>
						<ToolLabel name={call.name} subject={call.subject} />
					</span>
				</li>
			))}
		</ol>
	);
}

function Meta({ children }: { children: ReactNode }) {
	return (
		<div className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
			{children}
		</div>
	);
}

function NodeCard({ tone, children, onClick }: { tone: Tone; children: ReactNode; onClick?: () => void }) {
	const className = cn(
		"flex w-full min-w-0 flex-col gap-1.5 rounded-xl border p-2.5 text-left transition-colors",
		tone === "active"
			? "border-[color:color-mix(in_srgb,var(--color-token-text-link-foreground)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--color-token-text-link-foreground)_5%,transparent)]"
			: tone === "attention"
				? "border-[color:color-mix(in_srgb,var(--warning,#d97706)_50%,transparent)]"
				: "border-[color:var(--app-surface-divider)]",
		onClick && "hover:bg-[var(--color-background-elevated-secondary)]",
	);
	return onClick ? (
		<button type="button" onClick={onClick} className={className}>
			{children}
		</button>
	) : (
		<div className={className}>{children}</div>
	);
}

function mainTone(activity: MainActivity): Tone {
	return activity.kind === "idle" ? "idle" : activity.kind === "question" ? "attention" : "active";
}

function MainActivityText({ activity }: { activity: MainActivity }) {
	const { t } = useTranslation();
	switch (activity.kind) {
		case "tool":
			return <ToolLabel name={activity.toolName} subject={activity.subject} />;
		case "idle":
			return <>{t("agentMap.activity.idle")}</>;
		case "question":
			return <>{t("agentMap.activity.question")}</>;
		case "waiting":
			return <>{t("agentMap.activity.waiting")}</>;
		case "thinking":
			return <>{t("agentMap.activity.thinking")}</>;
		case "replying":
			return <>{t("agentMap.activity.replying")}</>;
	}
}

function TodoProgress({ todos }: { todos: readonly WorkflowTodo[] }) {
	const { t } = useTranslation();
	const counted = todos.filter((todo) => todo.status !== "cancelled");
	if (counted.length === 0) return null;
	const done = counted.filter((todo) => todo.status === "completed").length;
	const current = counted.find((todo) => todo.status === "in_progress");
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2 text-[length:var(--app-font-size-ui-xs,10px)]">
				<span className={MUTED_LABEL_TEXT_CLASS_NAME}>{t("agentMap.todos", { done, total: counted.length })}</span>
				<span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10">
					<span
						className="block h-full rounded-full bg-[var(--color-token-text-link-foreground)] transition-[width] duration-300"
						style={{ width: `${(done / counted.length) * 100}%` }}
					/>
				</span>
			</div>
			{current ? <div className="truncate text-[length:var(--app-font-size-ui-sm,11px)]">▸ {current.text}</div> : null}
		</div>
	);
}

function MainNode({ snapshot }: { snapshot: AgentSnapshot }) {
	const { t } = useTranslation();
	const activity = mainActivity(snapshot.cells, snapshot.streaming, snapshot.workflow.request !== null);
	const turn = summarizeTurn(snapshot.cells);
	const tone = mainTone(activity);
	const model = snapshot.modelKey?.split("/").slice(1).join("/") || snapshot.modelKey;
	const mode =
		snapshot.workMode === "agent"
			? `${t("workMode.agent")} · ${t(`agentPhase.${snapshot.agentPhase}` as TranslationKey)}`
			: t(`workMode.${snapshot.workMode}` as TranslationKey);
	const since = activity.kind === "idle" || activity.kind === "question" ? undefined : activity.since;
	return (
		<NodeCard tone={tone}>
			<div className="flex min-w-0 items-center gap-2">
				<StatusMark tone={tone} />
				<BotIcon className="size-3.5 shrink-0 opacity-80" />
				<span className="shrink-0 text-[length:var(--app-font-size-ui,12px)] font-semibold">{t("agentMap.main")}</span>
				<span className={cn("min-w-0 flex-1 truncate font-mono text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
					{model}
				</span>
				<span className="shrink-0 rounded-md bg-[var(--color-background-elevated-secondary)] px-1.5 py-px text-[length:var(--app-font-size-ui-xs,10px)]">
					{mode}
				</span>
			</div>
			<ActivityLine tone={tone} since={since} live={snapshot.streaming}>
				<MainActivityText activity={activity} />
			</ActivityLine>
			{turn.startedAt !== null ? (
				<Meta>
					<span>
						{t("agentMap.turn")} <Elapsed since={turn.startedAt} live={snapshot.streaming} until={snapshot.streaming ? undefined : lastTimestamp(snapshot)} />
					</span>
					<span>{t("agentMap.toolCalls", { count: turn.toolCalls })}</span>
					{turn.errors ? <span className="text-destructive">{t("agentMap.errors", { count: turn.errors })}</span> : null}
				</Meta>
			) : null}
			<TodoProgress todos={snapshot.workflow.todos} />
			<RecentCalls calls={turn.recent.map((call: ToolCallSummary) => ({ id: call.id, name: call.toolName, subject: call.subject, status: call.status }))} />
		</NodeCard>
	);
}

/** When the last thing in the transcript happened — where a finished turn's clock stops. */
function lastTimestamp(snapshot: AgentSnapshot): number | undefined {
	return snapshot.cells[snapshot.cells.length - 1]?.timestamp;
}

function SubagentActivityText({ activity, status }: { activity: SubagentActivity; status: WorkflowTask["status"] }) {
	const { t } = useTranslation();
	switch (activity.kind) {
		case "tool":
			return <ToolLabel name={activity.toolName} subject={activity.subject} />;
		case "thinking":
			return <>{t("agentMap.activity.thinking")}</>;
		case "said":
			return <span className="italic">“{activity.text}”</span>;
		case "starting":
			return <>{t("agentMap.activity.starting")}</>;
		case "finished":
			return <>{t(STATUS_KEYS[status])}</>;
	}
}

function recentSteps(steps: readonly TaskStep[]) {
	return steps
		.filter((step): step is Extract<TaskStep, { kind: "tool" }> => step.kind === "tool")
		.slice(-RECENT_STEPS)
		.map((step) => ({ id: step.id, name: step.toolName, subject: step.args || null, status: step.status }));
}

function SubagentNode({
	title,
	label,
	icon,
	run,
	extra,
	onOpen,
}: {
	title: string;
	label: string;
	icon: ReactNode;
	run: WorkflowTask | ExplorerRun;
	extra?: ReactNode;
	onOpen?: () => void;
}) {
	const { t } = useTranslation();
	const activity = subagentActivity(run);
	const tone = toneOfStatus(run.status);
	const counts = stepCounts(run.steps);
	const since = activity.kind === "tool" || activity.kind === "thinking" ? activity.since : undefined;
	return (
		<NodeCard tone={tone} onClick={onOpen}>
			<div className="flex min-w-0 items-center gap-2">
				<StatusMark tone={tone} />
				{icon}
				<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] font-medium" title={title}>
					{title}
				</span>
				<span className={cn("shrink-0 text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>{label}</span>
			</div>
			<ActivityLine tone={tone === "failed" ? "failed" : tone} since={since} live={run.status === "running"}>
				<SubagentActivityText activity={activity} status={run.status} />
			</ActivityLine>
			<Meta>
				<Elapsed since={run.startedAt} until={run.endedAt} live={run.status === "running"} />
				<span>{t("agentMap.toolCalls", { count: counts.tools })}</span>
				{counts.errors ? <span className="text-destructive">{t("agentMap.errors", { count: counts.errors })}</span> : null}
				{extra}
				{onOpen ? <span className="ml-auto text-[var(--color-token-text-link-foreground)]">{t("agentMap.openTask")} →</span> : null}
			</Meta>
			{run.status === "running" ? <RecentCalls calls={recentSteps(run.steps)} /> : null}
		</NodeCard>
	);
}

type Child = { kind: "task"; task: WorkflowTask } | { kind: "explorer"; run: ExplorerRun };

/** Running first, oldest first so the tree does not reshuffle as they report; then the latest finished. */
function orderChildren(tasks: readonly WorkflowTask[], explorers: readonly ExplorerRun[]): { shown: Child[]; hidden: number } {
	const all: Child[] = [
		...tasks.map((task) => ({ kind: "task" as const, task })),
		...explorers.map((run) => ({ kind: "explorer" as const, run })),
	];
	const run = (child: Child) => (child.kind === "task" ? child.task : child.run);
	const running = all.filter((child) => run(child).status === "running").sort((a, b) => run(a).startedAt - run(b).startedAt);
	const finished = all
		.filter((child) => run(child).status !== "running")
		.sort((a, b) => (run(b).endedAt ?? run(b).startedAt) - (run(a).endedAt ?? run(a).startedAt));
	return { shown: [...running, ...finished.slice(0, MAX_FINISHED_SHOWN)], hidden: Math.max(0, finished.length - MAX_FINISHED_SHOWN) };
}

/**
 * What the agents in this session are doing, as a tree: the main agent at the
 * root, every worker and explorer it started hanging off it.
 *
 * Everything here is live state the transcript already has; the map is a
 * second way of reading it, organised by who is doing what rather than by
 * when it was said.
 */
export function AgentMapPanel({ snapshot, onOpenTask }: { snapshot: AgentSnapshot | null; onOpenTask?: (taskId: string) => void }) {
	const { t } = useTranslation();
	if (!snapshot) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
				<AgentMapIcon className="size-6 text-muted-foreground/60" />
				<p className={cn("text-[length:var(--app-font-size-ui,12px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>{t("agentMap.empty")}</p>
			</div>
		);
	}
	const { shown, hidden } = orderChildren(snapshot.workflow.tasks, snapshot.workflow.explorers ?? []);
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
			<MainNode snapshot={snapshot} />
			{shown.length === 0 ? (
				<p className={cn("px-1 text-[length:var(--app-font-size-ui-sm,11px)] leading-relaxed", MUTED_LABEL_TEXT_CLASS_NAME)}>
					{t("agentMap.noSubagents")}
				</p>
			) : (
				<div className="flex flex-col gap-2">
					<span className={cn("px-1 text-[length:var(--app-font-size-ui-xs,10px)] font-medium", MUTED_LABEL_TEXT_CLASS_NAME)}>
						{t("agentMap.subagents")}
					</span>
					{/* The trunk runs down the left; each child hangs off it on its own branch. */}
					<ul className="agent-map-tree flex flex-col gap-2">
						{shown.map((child) => (
							<li key={child.kind === "task" ? child.task.id : child.run.id} className="agent-map-branch">
								{child.kind === "task" ? (
									<SubagentNode
										title={child.task.description}
										label={t(KIND_KEYS[child.task.kind])}
										icon={<BotIcon className="size-3.5 shrink-0 opacity-80" />}
										run={child.task}
										extra={
											child.task.writablePaths.length ? (
												<span className="truncate font-mono" title={child.task.writablePaths.join(", ")}>
													✎ {child.task.writablePaths.slice(0, 2).join(", ")}
													{child.task.writablePaths.length > 2 ? ` +${child.task.writablePaths.length - 2}` : ""}
												</span>
											) : null
										}
										onOpen={onOpenTask ? () => onOpenTask(child.task.id) : undefined}
									/>
								) : (
									<SubagentNode
										title={child.run.query}
										label={t("agentMap.explorer")}
										icon={<SearchIcon className="size-3.5 shrink-0 opacity-80" />}
										run={child.run}
										extra={child.run.model ? <span className="truncate font-mono">{child.run.model.split("/").slice(1).join("/") || child.run.model}</span> : null}
									/>
								)}
							</li>
						))}
					</ul>
					{hidden ? (
						<p className={cn("px-1 text-[length:var(--app-font-size-ui-xs,10px)]", MUTED_LABEL_TEXT_CLASS_NAME)}>
							{t("agentMap.earlier", { count: hidden })}
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}
