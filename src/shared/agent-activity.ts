import type { AgentCell } from "./agent";
import type { ExplorerRun, TaskStep, WorkflowTask } from "./workflow";

/**
 * What the agents in a session are doing, read off what the UI already has.
 *
 * The main agent's state is not reported anywhere as such — it is the tail of
 * the transcript: a tool cell still running, a reply still streaming its
 * reasoning or its text. Reading it here keeps the agent map in step with
 * the transcript by construction, since both look at the same cells.
 */

type ToolCell = Extract<AgentCell, { type: "tool" }>;

/** The argument that says what a call was about, per tool, in one line. */
const SUBJECT_KEYS: Record<string, readonly string[]> = {
	read: ["path"],
	write: ["path"],
	edit: ["path"],
	ls: ["path"],
	stat: ["paths"],
	grep: ["pattern"],
	find: ["pattern"],
	bash: ["command"],
	powershell: ["command"],
	cmd: ["command"],
	ast_grep: ["pattern"],
	ast_edit: ["pattern"],
	web_search: ["query"],
	web_fetch: ["url"],
	code_search: ["query"],
	task: ["description"],
	github: ["op", "number", "query", "path"],
};

const MAX_SUBJECT = 120;

function oneLine(value: string): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > MAX_SUBJECT ? `${line.slice(0, MAX_SUBJECT)}…` : line;
}

/** A short "what" for a tool call, or null when its arguments say nothing readable. */
export function toolSubject(toolName: string, args: unknown): string | null {
	if (typeof args === "string") return args ? oneLine(args) : null;
	if (!args || typeof args !== "object") return null;
	const record = args as Record<string, unknown>;
	const keys = SUBJECT_KEYS[toolName] ?? ["path", "query", "pattern", "command", "url", "description"];
	const parts: string[] = [];
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value) parts.push(value);
		else if (typeof value === "number") parts.push(`#${value}`);
		else if (Array.isArray(value) && value.length) parts.push(value.length === 1 ? String(value[0]) : `${value[0]} +${value.length - 1}`);
		// One subject is enough for most tools; github composes op and target.
		if (parts.length && toolName !== "github") break;
	}
	return parts.length ? oneLine(parts.join(" · ")) : null;
}

export type MainActivity =
	| { kind: "idle" }
	/** Blocked on the user answering a workflow question. */
	| { kind: "question" }
	/** A turn is running but nothing is streaming yet. */
	| { kind: "waiting"; since: number }
	| { kind: "thinking"; since: number }
	| { kind: "replying"; since: number }
	| { kind: "tool"; toolName: string; subject: string | null; since: number };

/** The cells of the turn in progress, or of the last one: everything after the last prompt. */
export function currentTurnCells(cells: readonly AgentCell[]): { prompt: Extract<AgentCell, { type: "user" }> | null; cells: AgentCell[] } {
	for (let i = cells.length - 1; i >= 0; i--) {
		const cell = cells[i];
		if (cell.type === "user") return { prompt: cell, cells: cells.slice(i + 1) };
	}
	return { prompt: null, cells: [...cells] };
}

/**
 * What the main agent is doing right now.
 *
 * A running tool wins over everything: tools can run in parallel with the
 * reply that called them, and the call is the thing the user is waiting on.
 */
export function mainActivity(cells: readonly AgentCell[], streaming: boolean, question: boolean): MainActivity {
	if (question) return { kind: "question" };
	if (!streaming) return { kind: "idle" };
	const { prompt, cells: turn } = currentTurnCells(cells);
	for (let i = turn.length - 1; i >= 0; i--) {
		const cell = turn[i];
		if (cell.type === "tool" && (cell.status === "running" || cell.status === "pending"))
			return { kind: "tool", toolName: cell.toolName, subject: toolSubject(cell.toolName, cell.args), since: cell.startedAt ?? cell.timestamp };
	}
	const last = turn[turn.length - 1];
	if (last?.type === "assistant" && last.streaming) {
		if (last.thinkingStartedAt !== undefined && last.thinkingEndedAt === undefined)
			return { kind: "thinking", since: last.thinkingStartedAt };
		if (last.text) return { kind: "replying", since: last.thinkingEndedAt ?? last.timestamp };
	}
	return { kind: "waiting", since: last?.timestamp ?? prompt?.timestamp ?? Date.now() };
}

export interface ToolCallSummary {
	id: string;
	toolName: string;
	subject: string | null;
	status: ToolCell["status"];
	startedAt: number;
}

export interface TurnSummary {
	/** When the prompt was sent; null before the first one. */
	startedAt: number | null;
	toolCalls: number;
	errors: number;
	/** Newest last. */
	recent: ToolCallSummary[];
}

/** Counts and the latest calls of the current turn. */
export function summarizeTurn(cells: readonly AgentCell[], recent = 6): TurnSummary {
	const { prompt, cells: turn } = currentTurnCells(cells);
	const tools = turn.filter((cell): cell is ToolCell => cell.type === "tool");
	return {
		startedAt: prompt?.timestamp ?? null,
		toolCalls: tools.length,
		errors: tools.filter((cell) => cell.status === "error").length,
		recent: tools.slice(-recent).map((cell) => ({
			id: cell.toolCallId,
			toolName: cell.toolName,
			subject: toolSubject(cell.toolName, cell.args),
			status: cell.status,
			startedAt: cell.startedAt ?? cell.timestamp,
		})),
	};
}

export type SubagentActivity =
	| { kind: "starting" }
	| { kind: "thinking"; since: number }
	| { kind: "tool"; toolName: string; subject: string; since: number }
	| { kind: "said"; text: string }
	| { kind: "finished" };

/**
 * What a worker or explorer is doing, from its newest step.
 *
 * Its steps arrive already summarised by main — a tool's arguments are one
 * line — so this only has to pick the step that describes "now".
 */
export function subagentActivity(run: Pick<WorkflowTask | ExplorerRun, "status" | "steps">): SubagentActivity {
	if (run.status !== "running") return { kind: "finished" };
	const steps: TaskStep[] = run.steps;
	for (let i = steps.length - 1; i >= 0; i--) {
		const step = steps[i];
		if (step.kind === "tool" && step.status === "running")
			return { kind: "tool", toolName: step.toolName, subject: oneLine(step.args), since: step.startedAt };
	}
	const last = steps[steps.length - 1];
	if (!last) return { kind: "starting" };
	if (last.kind === "thinking" && last.endedAt === undefined) return { kind: "thinking", since: last.startedAt };
	if (last.kind === "message") return { kind: "said", text: oneLine(last.text) };
	return { kind: "thinking", since: last.kind === "tool" ? (last.endedAt ?? last.startedAt) : last.startedAt };
}

/** Tool calls a subagent has made, and how many failed. */
export function stepCounts(steps: readonly TaskStep[]): { tools: number; errors: number } {
	let tools = 0;
	let errors = 0;
	for (const step of steps) {
		if (step.kind !== "tool") continue;
		tools++;
		if (step.status === "error") errors++;
	}
	return { tools, errors };
}
