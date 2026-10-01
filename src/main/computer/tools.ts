import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { clickRoute, frameworkOf, isUnresponsive, keyRoute, needsForeground, normalizeKey, type Framework, type Route } from "./input-strategy";
import { RAISE_WINDOW, WINDOW_CLASS, type ComputerCallResult, type ComputerImage } from "./protocol";
import {
	centreInWindow,
	contextOf,
	describe,
	diffModels,
	ElementIds,
	nameOf,
	findElements,
	parseWindowState,
	readingOrder,
	signature,
	withoutForeign,
	type UiElement,
	type WindowModel,
} from "./window-model";

/**
 * Computer Use tools: the model's view of the desktop driver.
 *
 * Built to need as few round trips and as few screenshots as possible:
 *
 * - Elements are addressed by what they say (`target: "Save"`) or by a number
 *   that stays the element's own across reads; the driver's per-read index is
 *   looked up afresh at the moment of acting, so a window that changed in
 *   between cannot turn a click into a click on something else.
 * - Every action reports what it changed — new windows with their elements,
 *   elements that appeared, went or changed — so the next step rarely needs a
 *   separate read, and never a screenshot just to see whether it worked.
 * - Each action picks its delivery: UI Automation in the background where it
 *   is safe, real input where a background Invoke could hang the app behind a
 *   modal dialog (see input-strategy.ts), and real input again when the
 *   background attempt reports it did not land.
 * - Reading a window returns its element tree; a screenshot is attached only
 *   when asked for, or when the tree has too little in it to act on.
 */

export const COMPUTER_TOOL_NAMES = [
	"computer_list_apps",
	"computer_list_windows",
	"computer_launch_app",
	"computer_get_window_state",
	"computer_click",
	"computer_type_text",
	"computer_press_key",
	"computer_scroll",
	"computer_set_value",
	"computer_drag",
	"computer_menu",
	"computer_wait",
	"computer_sequence",
	"computer_screenshot",
] as const;

export interface ComputerCaller {
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerCallResult>;
}

/** A point on the screen in physical pixels, the driver's coordinate space. */
export interface ScreenPoint {
	x: number;
	y: number;
}

/** What the on-screen agent cursor should show for the action about to run. */
export interface PointerAction {
	kind: "click" | "type" | "key" | "scroll" | "drag" | "set_value";
	label: string;
	/** Where the action lands, when it is known. */
	at?: ScreenPoint;
	/** A drag's end. */
	to?: ScreenPoint;
	/** Where to appear when `at` is unknown and the cursor is not up yet: the window's centre. */
	fallback?: ScreenPoint;
}

/**
 * Something that shows the user where the agent is acting. `act` runs before
 * the driver call and may take a moment — the glide is what makes an action
 * visible — but it never decides whether the action happens.
 */
export interface ComputerPointer {
	act(action: PointerAction): Promise<void>;
	/** The action is over. */
	settle(): void;
}

export interface ComputerToolOptions {
	/** Pause after an action before looking at its effect. */
	settleMs?: number;
	/** How long a guarded background Invoke may run before the app is presumed blocked by a modal. */
	guardMs?: number;
	/** Interval between looks while waiting for something to appear. */
	pollMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

/** Past this a tree is noise the model scrolls past; `query` narrows it instead. */
const MAX_TEXT_CHARS = 40_000;
/** A new window's tree shown with an action's result. */
const NEW_WINDOW_LINES = 60;
/** A tree with fewer actionable elements than this is custom-drawn: it needs to be seen. */
const SPARSE_TREE = 3;
/** Observation reads are capped: a 10 000-element browser tree is seconds per read. */
const OBSERVE_MAX_ELEMENTS = 2_000;
const MAX_WAIT_MS = 30_000;
/** A read's tree beyond this goes unread anyway, and costs the model time on every later step. */
const MAX_TREE_CHARS = 16_000;
/** Fields: text in them is input, not something that appeared. */
const EDITABLE_ROLES = new Set(["Edit", "ComboBox", "Document"]);

class DriverError extends Error {
	constructor(
		message: string,
		readonly code: string | undefined,
	) {
		super(message);
	}
}

// --- Schemas -------------------------------------------------------------------

const pid = Type.Integer({ description: "Target process id, from computer_list_windows or computer_launch_app." });
const windowId = Type.Optional(
	Type.Integer({ description: "Window id (HWND). Defaults to the window last read or acted on for this pid." }),
);
/** Ways to name what an action is for; shared by every action that takes a target. */
const targeting = {
	target: Type.Optional(
		Type.String({
			description:
				'The element\'s visible name (or value), e.g. "Save", "File name". Exact names win over partial ones; the app\'s other windows (dialogs, dropdowns) are searched too. Preferred over element_index and x/y.',
		}),
	),
	role: Type.Optional(Type.String({ description: 'Narrow target to a role, e.g. "Button", "Edit", "MenuItem", "ListItem".' })),
	nth: Type.Optional(Type.Integer({ minimum: 1, description: "Which match to use when target names several equally well (1-based)." })),
	element_index: Type.Optional(
		Type.Integer({ description: "Element number [N] from computer_get_window_state or an earlier result; it stays valid while the element exists." }),
	),
	x: Type.Optional(Type.Number({ description: "X in the window screenshot's pixels — only for UI with no element to name." })),
	y: Type.Optional(Type.Number({ description: "Y in the window screenshot's pixels." })),
};
const waitFor = {
	wait_for: Type.Optional(Type.String({ description: "Text expected to appear after the action (in any window of the app); the result says whether it did." })),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: "How long wait_for may wait. Default 5000." })),
};
const foreground = Type.Optional(
	Type.Boolean({ description: "Force real input with the window brought to the front. Chosen automatically when needed; rarely worth setting." }),
);

const listAppsSchema = Type.Object({
	include_installed: Type.Optional(Type.Boolean({ description: "Also list installed apps that are not running. Default false." })),
});
const listWindowsSchema = Type.Object({ pid: Type.Optional(Type.Integer({ description: "Only this process's windows." })) });
const launchSchema = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				'App display name in the system language, e.g. "Notepad", or "计算器" on Chinese Windows. If it is not found, get the launch_path from computer_list_apps with include_installed.',
		}),
	),
	aumid: Type.Optional(Type.String({ description: "AppUserModelID of a packaged (Store) app." })),
	path: Type.Optional(Type.String({ description: "Full path to an executable." })),
	launch_path: Type.Optional(Type.String({ description: "launch_path returned by computer_list_apps." })),
	urls: Type.Optional(Type.Array(Type.String(), { description: "URLs to open in the default browser." })),
	arguments: Type.Optional(Type.Array(Type.String(), { description: "Extra command-line arguments." })),
});
const windowStateSchema = Type.Object({
	pid,
	window_id: Type.Integer({ description: "Window id (HWND) from computer_list_windows or computer_launch_app." }),
	query: Type.Optional(Type.String({ description: "Case-insensitive filter: keep matching elements and their ancestors." })),
	include_screenshot: Type.Optional(
		Type.Boolean({
			description: "Attach a screenshot. Default false: the element tree is enough to act on, and one is attached anyway when the tree is nearly empty.",
		}),
	),
	max_depth: Type.Optional(Type.Integer({ minimum: 1, description: "Tree depth limit. Default 25." })),
});
const clickSchema = Type.Object({
	pid,
	window_id: windowId,
	...targeting,
	button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "2 for a double click." })),
	foreground,
	...waitFor,
});
const typeSchema = Type.Object({
	pid,
	text: Type.String({ description: "Text to enter." }),
	window_id: windowId,
	...targeting,
	replace: Type.Optional(
		Type.Boolean({ description: "Replace the field's whole content instead of typing at the caret (sets the value directly). Needs a target or element_index." }),
	),
	submit: Type.Optional(Type.Boolean({ description: "Press Enter afterwards." })),
	foreground,
	...waitFor,
});
const keySchema = Type.Object({
	pid,
	keys: Type.Array(Type.String(), {
		minItems: 1,
		description:
			'One key, or modifiers followed by one key: ["return"], ["ctrl", "s"], ["ctrl", "shift", "t"]. Names: return, tab, escape, space, delete, backspace, up, down, left, right, home, end, pageup, pagedown, f1-f12, letters, digits; modifiers ctrl, shift, alt, win.',
	}),
	window_id: windowId,
	...targeting,
	foreground,
	...waitFor,
});
const scrollSchema = Type.Object({
	pid,
	direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
	amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Ticks. Default 3." })),
	by: Type.Optional(Type.Union([Type.Literal("line"), Type.Literal("page")])),
	window_id: windowId,
	...targeting,
	foreground,
});
const setValueSchema = Type.Object({
	pid,
	value: Type.String({ description: "New value; for a combo box, the option's text." }),
	window_id: windowId,
	...targeting,
	...waitFor,
});
const dragSchema = Type.Object({
	pid,
	from_x: Type.Number(),
	from_y: Type.Number(),
	to_x: Type.Number(),
	to_y: Type.Number(),
	window_id: windowId,
	foreground,
});
const menuSchema = Type.Object({
	pid,
	path: Type.Array(Type.String(), { minItems: 1, maxItems: 8, description: 'Menu items from the top, e.g. ["File", "Save As..."].' }),
	window_id: windowId,
	...waitFor,
});
const waitSchema = Type.Object({
	pid,
	text: Type.String({ minLength: 1, description: "Text to wait for, in any window of the app (names and values)." }),
	gone: Type.Optional(Type.Boolean({ description: "Wait for the text to disappear instead." })),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: "Default 10000." })),
});
const stepSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("click"),
			Type.Literal("type"),
			Type.Literal("key"),
			Type.Literal("set_value"),
			Type.Literal("scroll"),
			Type.Literal("menu"),
			Type.Literal("wait"),
		],
		{ description: "What the step does; each takes the same arguments as its own tool." },
	),
	...targeting,
	text: Type.Optional(Type.String({ description: "type: the text; wait: the text to wait for." })),
	replace: Type.Optional(Type.Boolean()),
	submit: Type.Optional(Type.Boolean()),
	keys: Type.Optional(Type.Array(Type.String())),
	value: Type.Optional(Type.String()),
	path: Type.Optional(Type.Array(Type.String())),
	direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")])),
	amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
	button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
	gone: Type.Optional(Type.Boolean()),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS })),
});
const sequenceSchema = Type.Object({
	pid,
	window_id: windowId,
	steps: Type.Array(stepSchema, { minItems: 1, maxItems: 20 }),
	...waitFor,
});
const screenshotSchema = Type.Object({});

type Step = Static<typeof stepSchema>;

interface Target {
	pid: number;
	window_id?: number;
	target?: string;
	role?: string;
	nth?: number;
	element_index?: number;
	x?: number;
	y?: number;
}

/** Where an action lands once its target is resolved. */
interface Resolved {
	pid: number;
	window: number;
	model?: WindowModel;
	element?: UiElement;
	/** The driver's arguments for that element or point. */
	args: Record<string, unknown>;
}

interface Observation {
	lines: string[];
	images: ComputerImage[];
}

const key = (pid: number, window: number) => `${pid}:${window}`;

export function createComputerTools(host: ComputerCaller, pointer?: ComputerPointer, options: ComputerToolOptions = {}): ToolDefinition[] {
	const settleMs = options.settleMs ?? 250;
	const guardMs = options.guardMs ?? 2_000;
	const pollMs = options.pollMs ?? 300;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	/** Stable element numbers, per window. */
	const ids = new Map<string, ElementIds>();
	/** The latest complete read of each window, for diffs and for the cursor. */
	const full = new Map<string, WindowModel>();
	/** The driver's latest read of each window, complete or not: its indices are the live ones. */
	const live = new Map<string, WindowModel>();
	/** The window each process was last read or acted on through. */
	const lastWindow = new Map<number, number>();
	const frameworks = new Map<number, Framework>();
	/** Apps stuck in a modal opened by a guarded Invoke, until that Invoke returns. */
	const blocked = new Map<number, { window: number; since: number }>();

	const idsFor = (pid: number, window: number) => {
		let found = ids.get(key(pid, window));
		if (!found) {
			found = new ElementIds();
			ids.set(key(pid, window), found);
		}
		return found;
	};

	const forget = (pid: number, window: number) => {
		for (const map of [ids, full, live]) map.delete(key(pid, window));
		if (lastWindow.get(pid) === window) lastWindow.delete(pid);
	};

	const run = async (name: string, args: Record<string, unknown>, signal: AbortSignal | undefined) => {
		const result = await host.call(name, args, signal);
		if (result.isError) {
			const code = result.errorCode ? `[${result.errorCode}] ` : "";
			throw new DriverError(`${code}${result.text || `${name} failed`}`, result.errorCode);
		}
		return result;
	};

	const framework = async (window: number, signal: AbortSignal | undefined): Promise<Framework> => {
		const cached = frameworks.get(window);
		if (cached) return cached;
		const result = await host.call(WINDOW_CLASS, { window_id: window }, signal).catch(() => null);
		const found = result && !result.isError ? frameworkOf(result.text) : "unknown";
		frameworks.set(window, found);
		return found;
	};

	interface WindowInfo {
		window_id: number;
		title: string;
	}

	const windowsOf = async (pid: number, signal: AbortSignal | undefined): Promise<WindowInfo[]> => {
		const result = await host.call("list_windows", { pid, on_screen_only: true }, signal).catch(() => null);
		if (!result || result.isError || !result.structuredJson) return [];
		try {
			const parsed = JSON.parse(result.structuredJson) as { windows?: unknown; _legacy_windows?: unknown };
			const list = (Array.isArray(parsed.windows) ? parsed.windows : Array.isArray(parsed._legacy_windows) ? parsed._legacy_windows : []) as {
				window_id?: unknown;
				pid?: unknown;
				title?: unknown;
			}[];
			return list
				.filter((entry) => typeof entry.window_id === "number" && (entry.pid === undefined || entry.pid === pid))
				.map((entry) => ({ window_id: entry.window_id as number, title: typeof entry.title === "string" ? entry.title : "" }));
		} catch {
			return [];
		}
	};

	/** Read a window's tree. A read with a query is partial: it refreshes the live indices but not the diff baseline. */
	const read = async (
		pid: number,
		window: number,
		signal: AbortSignal | undefined,
		extra: { query?: string; screenshot?: boolean; maxDepth?: number; maxElements?: number } = {},
	): Promise<{ model: WindowModel; result: ComputerCallResult }> => {
		const args: Record<string, unknown> = { pid, window_id: window, include_screenshot: extra.screenshot === true };
		if (extra.query) args.query = extra.query;
		if (extra.maxDepth) args.max_depth = extra.maxDepth;
		if (extra.maxElements) args.max_elements = extra.maxElements;
		const result = await run("get_window_state", args, signal);
		const model = parseWindowState(pid, window, result.text, result.structuredJson, idsFor(pid, window));
		if (!model) throw new DriverError(`Could not read window ${window}.`, undefined);
		live.set(key(pid, window), model);
		if (!extra.query && !model.partial) full.set(key(pid, window), model);
		else if (!extra.query && !full.has(key(pid, window))) full.set(key(pid, window), model);
		blocked.delete(pid);
		return { model, result };
	};

	const defaultWindow = async (pid: number, given: number | undefined, signal: AbortSignal | undefined): Promise<number> => {
		const window = given ?? lastWindow.get(pid);
		if (window !== undefined) return window;
		const windows = await windowsOf(pid, signal);
		if (windows.length === 1) return windows[0].window_id;
		if (!windows.length) throw new Error(`Process ${pid} has no visible window; check the pid with computer_list_windows.`);
		throw new Error(`Process ${pid} has ${windows.length} windows; pass window_id (${windows.map((w) => `${w.window_id} "${w.title}"`).join(", ")}).`);
	};

	/** The element a target names, looked for in the given window first and then the app's other windows. */
	const resolveTarget = async (pid: number, window: number, target: Target, signal: AbortSignal | undefined): Promise<Resolved> => {
		const text = target.target ?? "";
		const windows = [window, ...(await windowsOf(pid, signal)).map((w) => w.window_id).filter((id) => id !== window)];
		const tried: string[] = [];
		for (const candidate of windows.slice(0, 6)) {
			let model: WindowModel;
			try {
				({ model } = await read(pid, candidate, signal, { query: text }));
			} catch (error) {
				tried.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const tiers = findElements(model, { text, role: target.role });
			const found = tiers.find((tier) => tier.length > 0);
			if (!found) continue;
			// In reading order, so nth: 1 is the one a person would call the first.
			const best = [...found].sort(readingOrder);
			let chosen: UiElement | undefined;
			if (target.nth !== undefined) chosen = best[target.nth - 1];
			else if (best.length === 1 || (best[0].enabled && best.filter((element) => element.enabled).length === 1)) chosen = best[0];
			if (!chosen) {
				// The full read has the neighbours a filtered one leaves out.
				const neighbours = full.get(key(pid, candidate)) ?? model;
				const list = best
					.slice(0, 12)
					.map((element) => {
						const near = contextOf(neighbours, element);
						return `  ${describe(element)}${near ? ` — ${near}` : ""}`;
					})
					.join("\n");
				throw new Error(
					target.nth !== undefined
						? `Only ${best.length} element(s) match "${text}"; nth=${target.nth} is out of range:\n${list}`
						: `"${text}" matches ${best.length} elements in window ${candidate}; pass role, nth or element_index:\n${list}`,
				);
			}
			return { pid, window: candidate, model, element: chosen, args: { element_index: chosen.index, snapshot_id: model.snapshotId } };
		}
		// Nothing anywhere: show what there is, so the next attempt is not a guess.
		let visible = "";
		try {
			const { model } = await read(pid, window, signal, { maxElements: OBSERVE_MAX_ELEMENTS });
			visible = model.elements
				.filter((element) => element.label)
				.slice(0, 40)
				.map((element) => `  ${describe(element)}`)
				.join("\n");
		} catch {
			// The error below says enough.
		}
		throw new Error(
			`No element named "${text}"${target.role ? ` with role ${target.role}` : ""} in window ${window} or the app's other windows.` +
				(visible ? ` Elements there include:\n${visible}` : "") +
				(tried.length ? `\nUnreadable: ${tried.join("; ")}` : ""),
		);
	};

	/** Resolve whatever a call names into driver arguments, re-reading so the index is the live one. */
	const resolve = async (target: Target, signal: AbortSignal | undefined, needs: "element" | "any" | "none"): Promise<Resolved> => {
		const ways = [target.target !== undefined, target.element_index !== undefined, target.x !== undefined || target.y !== undefined].filter(Boolean).length;
		if (ways > 1) throw new Error("Name the target one way: target, element_index, or x and y — not several.");
		if ((target.x === undefined) !== (target.y === undefined)) throw new Error("x and y must be given together.");
		// A role on its own ("the Edit") is a target too: the only element of that role.
		if (target.target === undefined && target.role && target.element_index === undefined && target.x === undefined) {
			target = { ...target, target: "" };
		}
		if (target.target !== undefined) {
			// A name is searched for across the app's windows, so an ambiguous default is no obstacle.
			const window = await defaultWindow(target.pid, target.window_id, signal).catch(async (error: unknown) => {
				const first = (await windowsOf(target.pid, signal))[0];
				if (!first) throw error;
				return first.window_id;
			});
			return resolveTarget(target.pid, window, target, signal);
		}
		const window = await defaultWindow(target.pid, target.window_id, signal);
		if (target.element_index !== undefined) {
			const element = [live.get(key(target.pid, window)), full.get(key(target.pid, window))]
				.flatMap((model) => model?.elements ?? [])
				.find((candidate) => candidate.id === target.element_index);
			if (!element) {
				throw new Error(
					`Element [${target.element_index}] is not known in window ${window}; read the window with computer_get_window_state, or name it with target.`,
				);
			}
			// Re-read so the driver's index is the one the element has now.
			const { model } = await read(target.pid, window, signal, element.label ? { query: element.label } : {});
			const fresh = model.elements.find((candidate) => candidate.id === element.id);
			if (!fresh) throw new Error(`${describe(element)} is no longer in window ${window}; it changed since it was read.`);
			return { pid: target.pid, window, model, element: fresh, args: { element_index: fresh.index, snapshot_id: model.snapshotId } };
		}
		if (target.x !== undefined && target.y !== undefined) {
			return { pid: target.pid, window, model: full.get(key(target.pid, window)), args: { x: target.x, y: target.y } };
		}
		if (needs === "element") throw new Error("Give target, element_index, or x and y.");
		return { pid: target.pid, window, model: full.get(key(target.pid, window)), args: {} };
	};

	/** Where on screen a resolved target is, for the cursor overlay. */
	const locate = (resolved: Resolved): { at?: ScreenPoint; fallback?: ScreenPoint } => {
		const model = resolved.model ?? full.get(key(resolved.pid, resolved.window));
		const bounds = model?.bounds;
		const fallback = bounds ? { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) } : undefined;
		const frame = resolved.element?.frame;
		if (frame) return { at: { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) }, fallback };
		if (typeof resolved.args.x === "number" && typeof resolved.args.y === "number" && bounds) {
			const scaleX = model?.shot ? bounds.width / model.shot.width : 1;
			const scaleY = model?.shot ? bounds.height / model.shot.height : 1;
			return { at: { x: Math.round(bounds.x + resolved.args.x * scaleX), y: Math.round(bounds.y + resolved.args.y * scaleY) }, fallback };
		}
		return { fallback };
	};

	/**
	 * Run one driver action by the route chosen for it. Returns what to tell
	 * the model about how it went, including a background attempt that was
	 * retried as real input, or an Invoke that is still running behind a modal.
	 */
	const deliver = async (
		name: string,
		args: Record<string, unknown>,
		route: Route,
		resolved: Resolved,
		signal: AbortSignal | undefined,
		action: PointerAction | null,
	): Promise<{ text: string; how: string }> => {
		if (pointer && action) {
			// Raised, not activated, so the user can see the window the cursor works in.
			await host.call(RAISE_WINDOW, { window_id: resolved.window }, signal).catch(() => undefined);
			await pointer.act(action).catch(() => undefined);
		}
		try {
			if (route === "foreground") {
				const result = await run(name, { ...args, pid: resolved.pid, window_id: resolved.window, delivery_mode: "foreground" }, signal);
				return { text: result.text, how: "real input, window brought to the front" };
			}
			const call = run(name, { ...args, pid: resolved.pid, window_id: resolved.window }, signal);
			let outcome: ComputerCallResult;
			if (route === "guarded") {
				const timedOut = Symbol("guard");
				const first = await Promise.race([call, sleep(guardMs).then(() => timedOut)]);
				if (first === timedOut) {
					// The Invoke is still running inside the app: a modal opened from its handler.
					blocked.set(resolved.pid, { window: resolved.window, since: Date.now() });
					call.then(
						() => blocked.delete(resolved.pid),
						() => blocked.delete(resolved.pid),
					);
					return { text: "", how: "UI Automation; the app is now waiting on a window it opened" };
				}
				outcome = first as ComputerCallResult;
			} else outcome = await call;
			return { text: outcome.text, how: "UI Automation in the background" };
		} catch (error) {
			if (route !== "foreground" && error instanceof DriverError && needsForeground(error.code, error.message)) {
				const result = await run(name, { ...args, pid: resolved.pid, window_id: resolved.window, delivery_mode: "foreground" }, signal);
				return { text: result.text, how: "real input (the background attempt did not land)" };
			}
			throw error;
		} finally {
			pointer?.settle();
		}
	};

	/**
	 * Whether text shows in a window: names, values, plain text — but not inside
	 * fields, where it is most often what was just typed, not a result of it.
	 */
	const shows = (model: WindowModel, text: string) => {
		const needle = text.toLowerCase();
		return (
			model.elements.some(
				(element) =>
					!EDITABLE_ROLES.has(element.role) &&
					(element.label.toLowerCase().includes(needle) || (element.value ?? "").toLowerCase().includes(needle)),
			) || model.texts.some((line) => line.toLowerCase().includes(needle))
		);
	};

	/** Poll the app's windows until text appears (or goes). */
	const waitForText = async (pid: number, text: string, gone: boolean, timeoutMs: number, signal: AbortSignal | undefined) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			let found = false;
			for (const window of (await windowsOf(pid, signal)).map((w) => w.window_id)) {
				try {
					const { model } = await read(pid, window, signal, { query: text });
					if (shows(model, text)) {
						found = true;
						break;
					}
				} catch {
					// A window that cannot be read right now does not show it.
				}
			}
			if (found !== gone) return true;
			if (Date.now() >= deadline) return false;
			signal?.throwIfAborted();
			await sleep(pollMs);
		}
	};

	/**
	 * What an action did: windows that opened or closed, and what changed in
	 * the window it was aimed at. A new window comes with its elements, so the
	 * dialog an action opened can be answered without another read.
	 */
	const observe = async (
		pid: number,
		window: number,
		before: { model?: WindowModel; windows: WindowInfo[] },
		wait: { text?: string; timeoutMs?: number },
		signal: AbortSignal | undefined,
	): Promise<Observation> => {
		const lines: string[] = [];
		const images: ComputerImage[] = [];
		await sleep(settleMs);
		const after = await windowsOf(pid, signal);
		const beforeIds = new Set(before.windows.map((w) => w.window_id));
		const afterIds = new Set(after.map((w) => w.window_id));
		const opened = after.filter((w) => !beforeIds.has(w.window_id));
		const closed = before.windows.filter((w) => !afterIds.has(w.window_id));
		// Elements of windows that opened or closed, which some toolkits also nest in their owner's tree.
		const foreign = new Set<string>();
		const foreignTitles = new Set<string>();
		for (const gone of closed) {
			lines.push(`Window ${gone.window_id} "${gone.title}" closed.`);
			for (const element of full.get(key(pid, gone.window_id))?.elements ?? []) foreign.add(signature(element));
			if (gone.title) foreignTitles.add(gone.title);
			forget(pid, gone.window_id);
		}

		if (blocked.has(pid)) {
			for (const dialog of opened.slice(0, 2)) {
				lines.push(
					`Window ${dialog.window_id} "${dialog.title}" opened and is holding the app: until it closes the app does not answer UI Automation. ` +
						`Its screenshot is attached; answer it with computer_press_key (return, escape, tab, alt+letter) or computer_click with x/y from the screenshot — both go as real input.`,
				);
				const shot = await host.call("get_window_state", { pid, window_id: dialog.window_id, include_accessibility_tree: false }, signal).catch(() => null);
				if (shot && !shot.isError) images.push(...shot.images);
				lastWindow.set(pid, dialog.window_id);
			}
			if (!opened.length) lines.push("The app has not finished handling the action yet; it may be busy or showing a window of its own.");
			return { lines, images };
		}

		for (const dialog of opened.slice(0, 2)) {
			try {
				const { model } = await read(pid, dialog.window_id, signal, { maxElements: OBSERVE_MAX_ELEMENTS });
				for (const element of model.elements) foreign.add(signature(element));
				if (dialog.title || model.title) foreignTitles.add(dialog.title || model.title);
				const tree = model.tree.split("\n");
				lines.push(
					`New window ${dialog.window_id} "${dialog.title || model.title}":`,
					...tree.slice(0, NEW_WINDOW_LINES),
					...(tree.length > NEW_WINDOW_LINES ? [`  … ${tree.length - NEW_WINDOW_LINES} more lines; read it with computer_get_window_state`] : []),
				);
			} catch (error) {
				lines.push(`New window ${dialog.window_id} "${dialog.title}" (could not be read: ${error instanceof Error ? error.message : String(error)})`);
			}
		}
		if (opened.length > 2) lines.push(`… and ${opened.length - 2} more new windows.`);

		/** Read a window again and report how it differs from its last complete read. */
		const report = async (target: number, baseline: WindowModel | undefined, quietWhenUnchanged: boolean) => {
			try {
				const { model } = await read(pid, target, signal, { maxElements: OBSERVE_MAX_ELEMENTS });
				if (!baseline) return;
				const changes = diffModels(withoutForeign(baseline, foreign, foreignTitles), withoutForeign(model, foreign, foreignTitles));
				if (changes.length) lines.push(`Changes in window ${target}:`, ...changes.map((line) => `  ${line}`));
				else if (!quietWhenUnchanged) lines.push(`No visible change in window ${target}.`);
			} catch (error) {
				lines.push(`Window ${target} could not be read after the action: ${error instanceof Error ? error.message : String(error)}`);
			}
		};

		if (afterIds.has(window)) {
			await report(window, before.model, false);
			// A dialog that opened is where the next step happens.
			if (opened.length) lastWindow.set(pid, opened[0].window_id);
		} else {
			if (!closed.some((w) => w.window_id === window)) lines.push(`Window ${window} is no longer visible.`);
			// The window acted in is gone (a dialog answered): the one behind it is where things go on.
			const next = opened[0] ?? after.find((w) => full.has(key(pid, w.window_id))) ?? after[0];
			if (next) {
				lastWindow.set(pid, next.window_id);
				if (!opened.length) await report(next.window_id, full.get(key(pid, next.window_id)), true);
			}
		}

		if (wait.text) {
			const found = await waitForText(pid, wait.text, false, wait.timeoutMs ?? 5_000, signal);
			lines.push(found ? `✓ "${wait.text}" appeared.` : `✗ "${wait.text}" did not appear within ${wait.timeoutMs ?? 5_000} ms.`);
		}
		return { lines, images };
	};

	/** The state an action's result is compared with: the app's windows, and a complete read of the target window. */
	const baseline = async (resolved: Resolved, signal: AbortSignal | undefined) => {
		const windows = await windowsOf(resolved.pid, signal);
		let model = full.get(key(resolved.pid, resolved.window));
		if (!model && !blocked.has(resolved.pid)) {
			model = await read(resolved.pid, resolved.window, signal, { maxElements: OBSERVE_MAX_ELEMENTS }).then(({ model: read }) => read, () => undefined);
		}
		return { windows, model };
	};

	const routeContext = async (pid: number, window: number, signal: AbortSignal | undefined) => ({
		framework: await framework(window, signal),
		blocked: blocked.has(pid),
	});

	// --- Actions, shared by the tools and by computer_sequence --------------------

	const what = (resolved: Resolved) => (resolved.element ? nameOf(resolved.element) : typeof resolved.args.x === "number" ? `(${resolved.args.x}, ${resolved.args.y})` : `window ${resolved.window}`);

	const doClick = async (params: Target & { button?: string; count?: number; foreground?: boolean }, signal: AbortSignal | undefined) => {
		const resolved = await resolve(params, signal, "element");
		const route = params.foreground
			? "foreground"
			: clickRoute(resolved.element, await routeContext(resolved.pid, resolved.window, signal), { button: params.button, count: params.count });
		const args = { ...resolved.args };
		if (params.button) args.button = params.button;
		if (params.count) args.count = params.count;
		const verb = params.button === "right" ? "右键" : (params.count ?? 1) > 1 ? "双击" : "点击";
		const outcome = await deliver("click", args, route, resolved, signal, {
			kind: "click",
			label: resolved.element?.label ? `${verb} · ${preview(resolved.element.label)}` : verb,
			...locate(resolved),
		});
		return { resolved, line: `Clicked ${what(resolved)} — ${outcome.how}.` };
	};

	const doType = async (params: Target & { text: string; replace?: boolean; submit?: boolean; foreground?: boolean }, signal: AbortSignal | undefined) => {
		const named = params.target !== undefined || params.role !== undefined || params.element_index !== undefined || params.x !== undefined;
		const resolved = await resolve(params, signal, "none");
		const context = await routeContext(resolved.pid, resolved.window, signal);
		const lines: string[] = [];
		if (params.replace && !named) {
			// No field named: replace what is in the focused one, as a person would.
			await deliver("hotkey", { keys: ["ctrl", "a"] }, "foreground", resolved, signal, null);
			const outcome = await deliver("type_text", { text: params.text }, "foreground", resolved, signal, {
				kind: "type",
				label: `输入 · ${preview(params.text)}`,
				...locate(resolved),
			});
			lines.push(`Replaced the focused field's text with "${preview(params.text)}" — ${outcome.how}.`);
		} else if (params.replace) {
			const outcome = await deliver("set_value", { ...resolved.args, value: params.text }, context.blocked ? "foreground" : "background", resolved, signal, {
				kind: "set_value",
				label: `设置 · ${preview(params.text)}`,
				...locate(resolved),
			});
			lines.push(`Set ${what(resolved)} to "${preview(params.text)}" — ${outcome.how}.`);
		} else {
			const route = params.foreground ? "foreground" : keyRoute(context);
			const outcome = await deliver("type_text", { ...resolved.args, text: params.text }, route, resolved, signal, {
				kind: "type",
				label: `输入 · ${preview(params.text)}`,
				...locate(resolved),
			});
			lines.push(`Typed "${preview(params.text)}" into ${named ? what(resolved) : "the focused field"} — ${outcome.how}.`);
		}
		if (params.submit) {
			const outcome = await deliver("press_key", { key: "return" }, params.foreground ? "foreground" : keyRoute(context), { ...resolved, args: {} }, signal, null);
			lines.push(`Pressed Enter — ${outcome.how}.`);
		}
		return { resolved, line: lines.join(" ") };
	};

	const doKey = async (params: Target & { keys: string[]; foreground?: boolean }, signal: AbortSignal | undefined) => {
		const keys = params.keys.map(normalizeKey).filter(Boolean);
		if (!keys.length) throw new Error("keys is empty.");
		const resolved = await resolve(params, signal, "none");
		const route = params.foreground ? "foreground" : keyRoute(await routeContext(resolved.pid, resolved.window, signal));
		const action: PointerAction = { kind: "key", label: `按键 · ${keys.map(keyName).join("+")}`, ...locate(resolved) };
		const outcome =
			keys.length === 1
				? await deliver("press_key", { ...resolved.args, key: keys[0] }, route, resolved, signal, action)
				: await deliver("hotkey", { ...resolved.args, keys }, route, resolved, signal, action);
		return { resolved, line: `Pressed ${keys.map(keyName).join("+")} — ${outcome.how}.` };
	};

	const doSetValue = async (params: Target & { value: string }, signal: AbortSignal | undefined) => {
		const resolved = await resolve(params, signal, "element");
		if (!resolved.element) throw new Error("set_value needs an element: give target or element_index.");
		const outcome = await deliver("set_value", { ...resolved.args, value: params.value }, blocked.has(resolved.pid) ? "foreground" : "background", resolved, signal, {
			kind: "set_value",
			label: `设置 · ${preview(params.value)}`,
			...locate(resolved),
		});
		return { resolved, line: `Set ${what(resolved)} to "${preview(params.value)}" — ${outcome.how}.` };
	};

	const doScroll = async (
		params: Target & { direction: "up" | "down" | "left" | "right"; amount?: number; by?: string; foreground?: boolean },
		signal: AbortSignal | undefined,
	) => {
		let resolved = await resolve(params, signal, "none");
		// Scrolling a named list means scrolling at its centre.
		if (resolved.element && resolved.model) {
			const centre = centreInWindow(resolved.model, resolved.element);
			if (centre) resolved = { ...resolved, args: { x: centre.x, y: centre.y } };
		}
		const context = await routeContext(resolved.pid, resolved.window, signal);
		const route = params.foreground || (context.framework === "classic" && resolved.args.x !== undefined) ? "foreground" : keyRoute(context);
		const args: Record<string, unknown> = { ...resolved.args, direction: params.direction };
		if (params.amount) args.amount = params.amount;
		if (params.by) args.by = params.by;
		const arrow = { up: "↑", down: "↓", left: "←", right: "→" }[params.direction];
		const outcome = await deliver("scroll", args, route, resolved, signal, { kind: "scroll", label: `滚动 ${arrow}`, ...locate(resolved) });
		return { resolved, line: `Scrolled ${params.direction} ${params.amount ?? 3} — ${outcome.how}.` };
	};

	const doMenu = async (params: { pid: number; window_id?: number; path: string[] }, signal: AbortSignal | undefined) => {
		const window = await defaultWindow(params.pid, params.window_id, signal);
		const context = await routeContext(params.pid, window, signal);
		if (context.framework === "xaml") {
			const resolved: Resolved = { pid: params.pid, window, args: {} };
			const outcome = await deliver("invoke_menu", { path: params.path }, "guarded", resolved, signal, null);
			return { resolved, line: `Chose ${params.path.join(" > ")} — ${outcome.how}.` };
		}
		// Item by item, as real clicks: each level opens the next, often in a window of its own.
		let resolved: Resolved = { pid: params.pid, window, args: {} };
		for (const [index, item] of params.path.entries()) {
			resolved = await resolveTarget(params.pid, resolved.window, { pid: params.pid, target: item, role: "MenuItem" }, signal).catch(async (error: unknown) => {
				// Some toolkits name menu entries as plain buttons or list items.
				if (index === 0) throw error;
				return resolveTarget(params.pid, resolved.window, { pid: params.pid, target: item }, signal);
			});
			await deliver("click", resolved.args, "foreground", resolved, signal, { kind: "click", label: `菜单 · ${item}`, ...locate(resolved) });
			if (index < params.path.length - 1) await sleep(settleMs);
		}
		return { resolved: { ...resolved, window }, line: `Chose ${params.path.join(" > ")} — real input.` };
	};

	/** Run an action, then report it with what it changed. */
	const act = async (
		params: { pid: number; window_id?: number; wait_for?: string; timeout_ms?: number },
		signal: AbortSignal | undefined,
		perform: () => Promise<{ resolved: Resolved; line: string }>,
	) => {
		// The baseline is taken against the window the action will most likely hit.
		const window = await defaultWindow(params.pid, params.window_id, signal).catch(() => undefined);
		const before = window !== undefined ? await baseline({ pid: params.pid, window, args: {} }, signal) : { windows: await windowsOf(params.pid, signal) };
		const { resolved, line } = await perform();
		lastWindow.set(resolved.pid, resolved.window);
		// A target found in another window (a dialog) is compared against that window.
		const reference =
			resolved.window === window ? before : { windows: before.windows, model: full.get(key(resolved.pid, resolved.window)) };
		const observation = await observe(resolved.pid, resolved.window, reference, { text: params.wait_for, timeoutMs: params.timeout_ms }, signal);
		return reply([line, ...observation.lines].join("\n"), observation.images, { pid: resolved.pid, windowId: resolved.window });
	};

	const reply = (text: string, images: ComputerImage[], details: Record<string, unknown>) => {
		const body = text.trim() || "Done.";
		return {
			content: [
				{ type: "text" as const, text: body.length > MAX_TEXT_CHARS ? `${body.slice(0, MAX_TEXT_CHARS)}\n… (truncated; narrow it with query or max_depth)` : body },
				...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
			],
			details,
		};
	};

	const tool = <T extends TSchema>(
		name: (typeof COMPUTER_TOOL_NAMES)[number],
		description: string,
		parameters: T,
		execute: (params: Static<T>, signal: AbortSignal | undefined) => Promise<ReturnType<typeof reply>>,
	): ToolDefinition =>
		({
			name,
			label: name,
			description,
			parameters,
			// One desktop, one pointer: two actions racing each other on it would
			// each observe the other's half-finished state.
			executionMode: "sequential",
			execute: (_id: string, params: Static<T>, signal: AbortSignal | undefined) => execute(params, signal),
		}) as unknown as ToolDefinition;

	const ACTION_NOTE = "The result reports what changed — new windows with their elements, elements that appeared or changed — so a separate read is rarely needed.";

	return [
		tool(
			"computer_list_apps",
			"List apps on this Windows desktop: running ones with their pid, and optionally installed ones with the launch_path computer_launch_app accepts.",
			listAppsSchema,
			async (params, signal) => {
				const result = await run("list_apps", {}, signal);
				return reply(params.include_installed ? result.text : runningAppsText(result), [], {});
			},
		),
		tool(
			"computer_list_windows",
			"List the visible top-level windows with pid, window_id, title and bounds. Start here to find the window to work in.",
			listWindowsSchema,
			async (params, signal) => {
				const result = await run("list_windows", { on_screen_only: true, ...(params.pid !== undefined ? { pid: params.pid } : {}) }, signal);
				return reply(result.text, [], {});
			},
		),
		tool(
			"computer_launch_app",
			"Launch an app without taking focus. Give one of name, aumid, path or launch_path. Returns a pid and the app's windows; use those window ids — for Store apps the pid is the shared frame host, not the app itself.",
			launchSchema,
			async (params, signal) => {
				const { arguments: extra, ...rest } = params;
				if (!rest.name && !rest.aumid && !rest.path && !rest.launch_path && !rest.urls?.length) {
					throw new Error("Give one of name, aumid, path, launch_path or urls.");
				}
				const result = await run("launch_app", { ...rest, ...(extra?.length ? { additional_arguments: extra } : {}) }, signal);
				return reply(result.text, [], {});
			},
		),
		tool(
			"computer_get_window_state",
			[
				"Read a window's UI Automation tree: every actionable element is listed as [N] Role \"name\" with its state. The numbers stay the element's own across reads.",
				"No screenshot by default — act by name (target) or number (element_index); one is attached when the tree is too sparse to act on, or ask with include_screenshot.",
				"Actions report their own effects, so call this to start on a window, or when a result says to.",
			].join(" "),
			windowStateSchema,
			async (params, signal) => {
				try {
					const { model, result } = await read(params.pid, params.window_id, signal, {
						query: params.query,
						screenshot: params.include_screenshot,
						maxDepth: params.max_depth,
					});
					lastWindow.set(params.pid, params.window_id);
					const sparse = !params.query && model.elements.length < SPARSE_TREE;
					let images = result.images;
					if (sparse && !params.include_screenshot) {
						const shot = await host.call("get_window_state", { pid: params.pid, window_id: params.window_id, include_accessibility_tree: false }, signal).catch(() => null);
						if (shot && !shot.isError) images = shot.images;
					}
					const header = `Window ${params.window_id} "${model.title}" (pid ${params.pid}): ${model.elements.length} actionable element(s)${model.partial ? ` of ${model.total} — partial` : ""}.`;
					const note = sparse
						? "\nThe tree has almost nothing actionable (custom-drawn UI): the screenshot is attached; act with x/y in its pixels."
						: "";
					let tree = model.tree;
					if (tree.length > MAX_TREE_CHARS) {
						const cut = tree.lastIndexOf("\n", MAX_TREE_CHARS);
						const hidden = tree.slice(cut).split("\n").length - 1;
						tree = `${tree.slice(0, cut)}\n… ${hidden} more lines. Name what you need with target, or narrow the read with query.`;
					}
					return reply(`${header}${note}\n\n${tree}`, images, { pid: params.pid, windowId: params.window_id });
				} catch (error) {
					if (!(error instanceof DriverError) || !isUnresponsive(error.message)) throw error;
					// The app is not answering UI Automation — most often a modal it is waiting on. Pixels still work.
					blocked.set(params.pid, { window: params.window_id, since: Date.now() });
					const shot = await run("get_window_state", { pid: params.pid, window_id: params.window_id, include_accessibility_tree: false }, signal);
					return reply(
						`Window ${params.window_id} is not answering UI Automation (the app is probably waiting on a modal dialog). Its screenshot is attached: ` +
							"use computer_press_key, or computer_click with x/y in the screenshot's pixels — both are sent as real input until the app answers again.",
						shot.images,
						{ pid: params.pid, windowId: params.window_id },
					);
				}
			},
		),
		tool(
			"computer_click",
			`Click an element, named by target (its visible name) or element_index, or a point x/y. count: 2 double-clicks — what opens or plays an item in most lists (songs, files, rows); button covers right clicks. ${ACTION_NOTE}`,
			clickSchema,
			async (params, signal) => act(params, signal, () => doClick(params, signal)),
		),
		tool(
			"computer_type_text",
			`Type text into a field named by target/element_index (or the focused one). replace clears the field first; submit: true presses Enter afterwards — use it to run a search or send a form. ${ACTION_NOTE}`,
			typeSchema,
			async (params, signal) => act(params, signal, () => doType(params, signal)),
		),
		tool(
			"computer_press_key",
			`Press a key or a key combination in a window, e.g. ["return"] or ["ctrl", "s"]; target/element_index focuses an element first. ${ACTION_NOTE}`,
			keySchema,
			async (params, signal) => act(params, signal, () => doKey(params, signal)),
		),
		tool(
			"computer_scroll",
			"Scroll a window, or the list or pane named by target/element_index.",
			scrollSchema,
			async (params, signal) => act(params, signal, () => doScroll(params, signal)),
		),
		tool(
			"computer_set_value",
			`Set an element's value directly (text field, slider, combo box) through UI Automation, without typing. ${ACTION_NOTE}`,
			setValueSchema,
			async (params, signal) => act(params, signal, () => doSetValue(params, signal)),
		),
		tool(
			"computer_drag",
			"Press, drag and release between two points in the window screenshot's pixels.",
			dragSchema,
			async (params, signal) =>
				act(params, signal, async () => {
					const resolved = await resolve({ pid: params.pid, window_id: params.window_id }, signal, "none");
					const context = await routeContext(resolved.pid, resolved.window, signal);
					const route = params.foreground || context.blocked || context.framework === "classic" ? "foreground" : "background";
					const from = locate({ ...resolved, args: { x: params.from_x, y: params.from_y } });
					const to = locate({ ...resolved, args: { x: params.to_x, y: params.to_y } });
					const outcome = await deliver(
						"drag",
						{ from_x: params.from_x, from_y: params.from_y, to_x: params.to_x, to_y: params.to_y },
						route,
						resolved,
						signal,
						{ kind: "drag", label: "拖拽", ...from, to: to.at },
					);
					return { resolved, line: `Dragged (${params.from_x}, ${params.from_y}) → (${params.to_x}, ${params.to_y}) — ${outcome.how}.` };
				}),
		),
		tool(
			"computer_menu",
			`Choose an item from an app's menu bar by its path, e.g. ["File", "Save As..."], in one call. ${ACTION_NOTE}`,
			menuSchema,
			async (params, signal) => act(params, signal, () => doMenu(params, signal)),
		),
		tool(
			"computer_wait",
			"Wait until text appears in (or, with gone, disappears from) any window of the app — a page loading, a progress dialog closing.",
			waitSchema,
			async (params, signal) => {
				const timeout = params.timeout_ms ?? 10_000;
				const done = await waitForText(params.pid, params.text, params.gone === true, timeout, signal);
				return reply(
					done
						? `✓ "${params.text}" ${params.gone ? "is gone" : "appeared"}.`
						: `✗ "${params.text}" ${params.gone ? "is still there" : "did not appear"} after ${timeout} ms.`,
					[],
					{ pid: params.pid },
				);
			},
		),
		tool(
			"computer_sequence",
			"Run several actions in one call — e.g. fill a form and submit: click, type, set_value, key, scroll, menu, wait — each step with the same arguments as its own tool. Stops at the first step that fails. The result lists each step and then what changed.",
			sequenceSchema,
			async (params, signal) =>
				act(params, signal, async () => {
					const done: string[] = [];
					let last: Resolved | undefined;
					for (const [index, step] of params.steps.entries()) {
						const target: Target = { pid: params.pid, window_id: params.window_id, ...pickTarget(step) };
						try {
							const outcome = await runStep(step, target, signal);
							last = outcome.resolved ?? last;
							done.push(`${index + 1}. ${outcome.line}`);
						} catch (error) {
							done.push(`${index + 1}. ✗ ${error instanceof Error ? error.message : String(error)}`);
							if (index < params.steps.length - 1) done.push(`Stopped; steps ${index + 2}–${params.steps.length} were not run.`);
							break;
						}
						if (index < params.steps.length - 1) await sleep(Math.min(settleMs, 150));
					}
					const window = last?.window ?? (await defaultWindow(params.pid, params.window_id, signal));
					return { resolved: last ?? { pid: params.pid, window, args: {} }, line: done.join("\n") };
				}),
		),
		tool(
			"computer_screenshot",
			"Screenshot the whole primary display. For one window, computer_get_window_state with include_screenshot is better: it also lists the elements.",
			screenshotSchema,
			async (_params, signal) => {
				const result = await run("get_desktop_state", {}, signal);
				return reply(result.text, result.images, {});
			},
		),
	];

	function pickTarget(step: Step): Omit<Target, "pid" | "window_id"> {
		return {
			...(step.target !== undefined ? { target: step.target } : {}),
			...(step.role !== undefined ? { role: step.role } : {}),
			...(step.nth !== undefined ? { nth: step.nth } : {}),
			...(step.element_index !== undefined ? { element_index: step.element_index } : {}),
			...(step.x !== undefined ? { x: step.x } : {}),
			...(step.y !== undefined ? { y: step.y } : {}),
		};
	}

	async function runStep(step: Step, target: Target, signal: AbortSignal | undefined): Promise<{ resolved?: Resolved; line: string }> {
		switch (step.action) {
			case "click":
				return doClick({ ...target, button: step.button, count: step.count }, signal);
			case "type":
				if (step.text === undefined) throw new Error("type needs text.");
				return doType({ ...target, text: step.text, replace: step.replace, submit: step.submit }, signal);
			case "key":
				if (!step.keys?.length) throw new Error("key needs keys.");
				return doKey({ ...target, keys: step.keys }, signal);
			case "set_value":
				if (step.value === undefined) throw new Error("set_value needs value.");
				return doSetValue({ ...target, value: step.value }, signal);
			case "scroll":
				return doScroll({ ...target, direction: step.direction ?? "down", amount: step.amount }, signal);
			case "menu":
				if (!step.path?.length) throw new Error("menu needs path.");
				return doMenu({ pid: target.pid, window_id: target.window_id, path: step.path }, signal);
			case "wait": {
				if (!step.text) {
					const pause = Math.min(step.timeout_ms ?? 1_000, 10_000);
					await sleep(pause);
					return { line: `Waited ${pause} ms.` };
				}
				const timeout = step.timeout_ms ?? 10_000;
				const found = await waitForText(target.pid, step.text, step.gone === true, timeout, signal);
				if (!found) throw new Error(`"${step.text}" ${step.gone ? "was still there" : "did not appear"} after ${timeout} ms.`);
				return { line: `Waited for "${step.text}" ${step.gone ? "to go" : "to appear"}.` };
			}
		}
	}
}

function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
}

function keyName(key: string): string {
	return key.charAt(0).toUpperCase() + key.slice(1);
}

interface ListedApp {
	name?: unknown;
	pid?: unknown;
	running?: unknown;
	active?: unknown;
}

/**
 * The running apps only. The full list includes every Start-menu shortcut on
 * the machine, often hundreds of lines the model rarely needs.
 */
function runningAppsText(result: ComputerCallResult): string {
	try {
		const parsed = JSON.parse(result.structuredJson ?? "") as { apps?: ListedApp[] };
		if (!Array.isArray(parsed.apps)) return result.text;
		const running = parsed.apps.filter((app) => app.running === true);
		return [
			`${running.length} running app(s):`,
			...running.map((app) => `- ${String(app.name)} (pid ${String(app.pid)})${app.active === true ? " [active]" : ""}`),
		].join("\n");
	} catch {
		return result.text;
	}
}
