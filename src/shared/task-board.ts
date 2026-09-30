import type { AgentSnapshot } from "./agent";
import { currentTurnCells, mainActivity, type MainActivity } from "./agent-activity";

/**
 * The task board: every session that has run in this app since it started,
 * side by side, so several tasks can be pushed forward at once and watched
 * without opening each one in turn.
 *
 * An entry is a summary, never the transcript. The board is pushed on every
 * change of any running task, and a handful of short fields is what keeps that
 * affordable where a snapshot per task would not be.
 */

export type TaskBoardStatus =
	/** A turn is in progress. */
	| "running"
	/** Blocked on the user answering a workflow question. */
	| "question"
	/** The last turn ended with an answer. */
	| "done"
	/** The last turn ended on an error. */
	| "failed";

export interface TaskBoardEntry {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	title: string;
	titlePending: boolean;
	status: TaskBoardStatus;
	/** What the agent is doing right now; `idle` once the turn is over. */
	activity: MainActivity;
	/** When the current or last turn's prompt was sent. */
	startedAt: number | null;
	/** When the last turn stopped; null while it runs. */
	endedAt: number | null;
	/** First line of the last answer, or the error the turn ended on. */
	summary: string | null;
	/** Lines the agent added and removed across the session, from its checkpoints. */
	additions: number;
	deletions: number;
	/** Distinct files the agent edited. */
	files: number;
	/** The task's private checkout, when it has one. */
	worktree: { branch: string; base: string } | null;
	/** The session the window is showing. */
	selected: boolean;
}

/** When a turn the board watched started and stopped, measured by main. */
export interface TaskRunTimes {
	startedAt: number;
	endedAt: number | null;
}

const MAX_SUMMARY = 160;

function firstLine(text: string): string | null {
	const line = text
		.split("\n")
		.map((entry) => entry.replace(/^[#>*\-\s]+/, "").trim())
		.find(Boolean);
	if (!line) return null;
	return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY)}…` : line;
}

export function taskBoardEntry(
	snapshot: AgentSnapshot,
	options: { run?: TaskRunTimes; worktree?: { branch: string; base: string } | null; selected?: boolean } = {},
): TaskBoardEntry {
	const question = snapshot.workflow.request !== null;
	const activity = mainActivity(snapshot.cells, snapshot.streaming, question);
	const { prompt, cells: turn } = currentTurnCells(snapshot.cells);

	let failure: string | null = null;
	let answer: string | null = null;
	for (let i = turn.length - 1; i >= 0 && !failure && !answer; i--) {
		const cell = turn[i];
		if (cell.type === "assistant") {
			if (cell.error) failure = cell.error;
			else if (cell.text.trim()) answer = cell.text;
		} else if (cell.type === "notice" && cell.level === "error") failure = cell.text;
	}
	if (!snapshot.streaming && !failure && !answer && snapshot.error) failure = snapshot.error;

	const status: TaskBoardStatus = question
		? "question"
		: snapshot.streaming
			? "running"
			: failure
				? "failed"
				: "done";

	let additions = 0;
	let deletions = 0;
	const files = new Set<string>();
	for (const checkpoint of snapshot.checkpoints) {
		additions += checkpoint.additions;
		deletions += checkpoint.deletions;
		for (const file of checkpoint.files) files.add(file.path);
	}

	const last = snapshot.cells[snapshot.cells.length - 1];
	return {
		sessionId: snapshot.session.id,
		sessionFile: snapshot.session.sessionFile,
		cwd: snapshot.session.cwd,
		title: snapshot.session.title,
		titlePending: snapshot.session.titlePending,
		status,
		activity,
		startedAt: prompt?.timestamp ?? options.run?.startedAt ?? null,
		endedAt: snapshot.streaming ? null : (options.run?.endedAt ?? last?.timestamp ?? null),
		summary: status === "failed" ? firstLine(failure ?? "") : status === "done" ? firstLine(answer ?? "") : null,
		additions,
		deletions,
		files: files.size,
		worktree: options.worktree ?? null,
		selected: options.selected ?? false,
	};
}

const STATUS_ORDER: Record<TaskBoardStatus, number> = { question: 0, running: 1, failed: 2, done: 3 };

/**
 * Tasks that need the user come first, then those still working, then the
 * finished ones — each group newest first, so the board reads top to bottom
 * as "what wants me, what is moving, what is done".
 */
export function sortTaskBoard(entries: readonly TaskBoardEntry[]): TaskBoardEntry[] {
	return [...entries].sort(
		(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.startedAt ?? 0) - (a.startedAt ?? 0),
	);
}

/** Tasks still in flight — the count the sidebar badge shows. */
export function activeTaskCount(entries: readonly TaskBoardEntry[]): number {
	return entries.filter((entry) => entry.status === "running" || entry.status === "question").length;
}
