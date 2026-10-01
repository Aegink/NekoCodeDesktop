import type { TaskStep } from "../../../shared/workflow";

/**
 * What the Fast Context card shows of a `code_search` run, read off the
 * explorer's live steps and the report it returns.
 */

export type ToolStep = Extract<TaskStep, { kind: "tool" }>;

export type StepKind = "read" | "search" | "list" | "other";

export interface StepSubject {
	kind: StepKind;
	/** What the call touched: a file name, a pattern, a folder. */
	text: string;
	/** Where it looked, shown dimmed: a line range, or the folder a search ran in. */
	detail?: string;
	/** The whole path, for a tooltip. */
	path?: string;
}

/**
 * One field of a step's argument preview. The preview is JSON cut to one line
 * and sometimes truncated mid-string, so it is read with a pattern rather than
 * parsed — a truncated value is still worth showing.
 */
function field(args: string, name: string): string | undefined {
	const match = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(args);
	if (!match) return undefined;
	try {
		return JSON.parse(`"${match[1].replace(/\\$/, "")}"`) as string;
	} catch {
		return match[1];
	}
}

function numberField(args: string, name: string): number | undefined {
	const match = new RegExp(`"${name}"\\s*:\\s*(\\d+)`).exec(args);
	return match ? Number(match[1]) : undefined;
}

export function basename(path: string): string {
	const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || path;
}

/** What a step did, in the card's terms. */
export function stepSubject(step: ToolStep): StepSubject {
	const args = step.args;
	switch (step.toolName) {
		case "read": {
			const path = field(args, "path") ?? args;
			const offset = numberField(args, "offset");
			const limit = numberField(args, "limit");
			const range = offset !== undefined ? `L${offset}${limit !== undefined ? `–${offset + limit - 1}` : "+"}` : undefined;
			return { kind: "read", text: basename(path), detail: range, path };
		}
		case "grep":
		case "ast_grep":
		case "semantic_search":
		case "find": {
			const pattern = field(args, "pattern") ?? field(args, "query") ?? args;
			const where = field(args, "path") ?? field(args, "glob");
			return { kind: "search", text: pattern, detail: where && where !== "." ? where : undefined };
		}
		case "ls":
		case "stat": {
			const path = field(args, "path") ?? field(args, "paths") ?? ".";
			return { kind: "list", text: path === "." ? "./" : basename(path), path };
		}
		default:
			return { kind: "other", text: step.toolName, detail: args || undefined };
	}
}

export interface Turn {
	/** Step ids, for React keys. */
	id: string;
	steps: ToolStep[];
}

/**
 * The explorer's tool calls, grouped into the turns it made them in.
 *
 * The explorer fans out: one reply issues several searches at once, and the
 * next reply comes after reading their results. Calls from the same reply
 * start within moments of each other, so a call starting well after the
 * turn's first one opens the next turn.
 */
export function groupTurns(steps: readonly TaskStep[], gapMs = 600): Turn[] {
	const turns: Turn[] = [];
	let first = Number.NEGATIVE_INFINITY;
	for (const step of steps) {
		if (step.kind !== "tool") continue;
		const current = turns[turns.length - 1];
		if (!current || step.startedAt - first > gapMs) {
			turns.push({ id: step.id, steps: [step] });
			first = step.startedAt;
		} else current.steps.push(step);
	}
	return turns;
}

export interface ExplorerStats {
	searches: number;
	/** Distinct files read. */
	files: number;
	turns: number;
}

export function explorerStats(steps: readonly TaskStep[]): ExplorerStats {
	const files = new Set<string>();
	let searches = 0;
	for (const step of steps) {
		if (step.kind !== "tool") continue;
		const subject = stepSubject(step);
		if (subject.kind === "read" && subject.path) files.add(subject.path.replace(/\\/g, "/"));
		else if (subject.kind === "search") searches++;
	}
	return { searches, files: files.size, turns: groupTurns(steps).length };
}

export interface Location {
	path: string;
	start?: number;
	end?: number;
	/** Why the explorer thinks it is relevant. */
	note: string;
}

/**
 * The locations in an explorer report. The prompt asks for one
 * `` - `path:start-end` — why `` line per finding; anything else is prose and
 * stays in the full report.
 */
export function parseReportLocations(report: string): Location[] {
	const locations: Location[] = [];
	const seen = new Set<string>();
	const token = /`([^`\s]+?)(?::(\d+)(?:[-–](\d+))?)?`/g;
	for (const line of report.split("\n")) {
		const bullet = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
		if (!bullet || !bullet[1].startsWith("`")) continue;
		// Everything before the dash names places — sometimes two, joined by
		// "and" — and everything after it says why. The why belongs to each.
		const split = /\s[—–]\s|\s-\s/.exec(bullet[1]);
		// Without a dash the model wrote a sentence — "`a.ts:3` defines …" — whose
		// place is its first token and whose note is the rest.
		const lead = split ? null : /^`[^`]+`[\s:,;]*/.exec(bullet[1]);
		const head = split ? bullet[1].slice(0, split.index) : (lead?.[0] ?? bullet[1]);
		const rest = split ? bullet[1].slice(split.index + split[0].length) : bullet[1].slice(head.length);
		const note = rest.replace(/\*\*/g, "").trim();
		for (const [, path, start, end] of head.matchAll(token)) {
			// A bare word in backticks is a symbol, not a place.
			if (!/[/\\.]/.test(path)) continue;
			const key = `${path}:${start ?? ""}-${end ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			locations.push({
				path,
				...(start ? { start: Number(start) } : {}),
				...(end ? { end: Number(end) } : {}),
				note,
			});
		}
	}
	return locations;
}

/** A note split into plain text and `code` spans, so backticks render as code rather than as backticks. */
export function inlineCode(text: string): { code: boolean; text: string }[] {
	return text
		.split(/(`[^`]+`)/)
		.filter(Boolean)
		.map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 2 ? { code: true, text: part.slice(1, -1) } : { code: false, text: part }));
}

export function locationRange(location: Pick<Location, "start" | "end">): string | null {
	if (location.start === undefined) return null;
	return location.end !== undefined && location.end !== location.start ? `L${location.start}–${location.end}` : `L${location.start}`;
}
