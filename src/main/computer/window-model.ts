/**
 * What one read of a window says, in the terms the model works with.
 *
 * The driver numbers a window's elements afresh on every read, so a number the
 * model saw a moment ago can name a different element after the window
 * changes — a dialog opened above it, a row inserted before it. Here every
 * element gets a number that stays its own for as long as the window lives,
 * keyed by what it is (role, name, automation id, and which of several alike
 * it is), and the driver's current index is looked up from that at the moment
 * of acting.
 */

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface UiElement {
	/** The number the model sees; stable across reads of the same window. */
	id: number;
	/** The driver's index in the read this element came from. */
	index: number;
	role: string;
	label: string;
	value?: string;
	enabled: boolean;
	selected?: boolean;
	actions: string[];
	/** On screen, in physical pixels. */
	frame?: Rect;
	automationId?: string;
	/** The driver's index of the element it sits in, when that is actionable too. */
	parent?: number;
}

export interface WindowModel {
	pid: number;
	windowId: number;
	snapshotId: string;
	title: string;
	/** The window on screen, in physical pixels. */
	bounds?: Rect;
	/** The screenshot's size when one was taken; x/y arguments are in its pixels. */
	shot?: { width: number; height: number };
	elements: UiElement[];
	/** Rows that are not actionable but say something: labels, status text. */
	texts: string[];
	/** The tree as the model reads it, numbered with stable ids. */
	tree: string;
	/** A query or a cap left elements out. */
	partial: boolean;
	total: number;
}

/** Stable numbers for one window's elements. */
export class ElementIds {
	private next = 1;
	private readonly ids = new Map<string, number>();

	assign(key: string): number {
		let id = this.ids.get(key);
		if (id === undefined) {
			id = this.next++;
			this.ids.set(key, id);
		}
		return id;
	}
}

interface RawElement {
	element_index?: unknown;
	role?: unknown;
	label?: unknown;
	value?: unknown;
	enabled?: unknown;
	selected?: unknown;
	actions?: unknown;
	frame?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
	parent_index?: unknown;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function rect(x: unknown, y: unknown, width: unknown, height: unknown): Rect | undefined {
	const [rx, ry, rw, rh] = [num(x), num(y), num(width), num(height)];
	return rx === undefined || ry === undefined || rw === undefined || rh === undefined ? undefined : { x: rx, y: ry, width: rw, height: rh };
}

/** `  - [12] Button "OK" [id=okButton actions=[invoke]]` → its index and attributes. */
const INDEXED_LINE = /^(\s*-\s*)\[(\d+)\](.*)$/;
const AUTOMATION_ID = /\bid=([^\s\]]+)/;
/** `  - Text "Saved"` — a row with a name but no index. */
const TEXT_LINE = /^\s*-\s*([A-Za-z]+)\s+"(.*)"\s*$/;

/**
 * An element line's attributes without what the model never uses: automation
 * ids and the list of UI Automation patterns. A 500-element tree is half as
 * long without them, and every token of it is read before the next step.
 */
export function compactAttributes(rest: string): string {
	return rest
		.replace(/\s*actions=\[[^\]]*\]/g, "")
		.replace(/\s*\bid=[^\s\]]+/g, "")
		.replace(/\[\s+/g, "[")
		.replace(/\s+\]/g, "]")
		.replace(/\s*\[\]/g, "");
}

/**
 * A read of a window, from the driver's structured result and its markdown.
 * Null when the result carries no snapshot, which means it was not a read.
 */
export function parseWindowState(
	pid: number,
	windowId: number,
	text: string,
	structuredJson: string | undefined,
	ids: ElementIds,
): WindowModel | null {
	if (!structuredJson) return null;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(structuredJson) as Record<string, unknown>;
	} catch {
		return null;
	}
	const snapshotId = parsed.snapshot_id;
	if (typeof snapshotId !== "string") return null;

	// Automation ids are only in the markdown; they tell apart controls with the same name.
	const automationIds = new Map<number, string>();
	const markdown = str(parsed.tree_markdown) || text;
	for (const line of markdown.split("\n")) {
		const match = INDEXED_LINE.exec(line);
		const id = match ? AUTOMATION_ID.exec(match[3])?.[1] : undefined;
		// Numeric ids are window handles, which change with every run of the app.
		if (match && id && !/^\d+$/.test(id)) automationIds.set(Number(match[2]), id);
	}

	const elements: UiElement[] = [];
	const seen = new Map<string, number>();
	for (const raw of (Array.isArray(parsed.elements) ? parsed.elements : []) as RawElement[]) {
		const index = num(raw.element_index);
		if (index === undefined) continue;
		const role = str(raw.role);
		const label = str(raw.label).trim();
		const automationId = automationIds.get(index);
		const base = `${role}|${label}|${automationId ?? ""}`;
		const occurrence = (seen.get(base) ?? 0) + 1;
		seen.set(base, occurrence);
		const value = typeof raw.value === "string" ? raw.value : undefined;
		elements.push({
			id: ids.assign(`${base}|${occurrence}`),
			index,
			role,
			label,
			...(value !== undefined && value !== label ? { value } : {}),
			enabled: raw.enabled !== false,
			...(typeof raw.selected === "boolean" ? { selected: raw.selected } : {}),
			actions: Array.isArray(raw.actions) ? raw.actions.filter((a): a is string => typeof a === "string") : [],
			frame: rect(raw.frame?.x, raw.frame?.y, raw.frame?.w, raw.frame?.h),
			...(automationId ? { automationId } : {}),
			...(num(raw.parent_index) !== undefined ? { parent: num(raw.parent_index) } : {}),
		});
	}

	const byIndex = new Map(elements.map((element) => [element.index, element]));
	const texts: string[] = [];
	const lines: string[] = [];
	for (const line of markdown.split("\n")) {
		const match = INDEXED_LINE.exec(line);
		if (match) {
			const element = byIndex.get(Number(match[2]));
			lines.push(element ? `${match[1]}[${element.id}]${compactAttributes(match[3])}` : line);
			continue;
		}
		const textual = TEXT_LINE.exec(line);
		if (textual && textual[2].trim()) texts.push(`${textual[1]} "${textual[2]}"`);
		// A nameless container (`- Group`, `- Pane`) is structure the indentation already shows.
		if (/^\s*-\s*[A-Za-z]+\s*$/.test(line)) continue;
		lines.push(line);
	}
	// The driver's own header names its indices; the model only ever sees ours.
	while (lines.length && !/^\s*-/.test(lines[0])) lines.shift();

	const bounds = parsed.window_bounds as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined;
	const width = num(parsed.screenshot_width);
	const height = num(parsed.screenshot_height);
	const total = num(parsed.total_element_count) ?? elements.length;
	const returned = num(parsed.returned_element_count) ?? elements.length;
	return {
		pid,
		windowId,
		snapshotId,
		title: str(parsed.window_title),
		bounds: bounds ? rect(bounds.x, bounds.y, bounds.width, bounds.height) : undefined,
		shot: width && height ? { width, height } : undefined,
		elements,
		texts,
		tree: lines.join("\n").trimEnd(),
		// Not `elements_complete`: the driver reports that false even when every element came back.
		partial: returned < total,
		total,
	};
}

/**
 * What sits beside an element on screen: the names just right of it and in the
 * lines just below. Ten results all called "Hope" are told apart by the artist
 * under each. Position, not the tree: web UIs flatten their pages into one
 * container, so every element's tree neighbours are the whole page.
 */
export function contextOf(model: WindowModel, element: UiElement): string {
	const frame = element.frame;
	if (!frame || frame.height <= 0) return "";
	const lineHeight = frame.height;
	const near = model.elements
		.filter((other) => {
			const o = other.frame;
			if (!o || other.id === element.id || !/[\p{L}\p{N}]/u.test(other.label) || other.label === element.label) return false;
			const sameLine = Math.abs(o.y - frame.y) < lineHeight * 0.6 && o.x > frame.x && o.x - (frame.x + frame.width) < 200;
			const below = o.y >= frame.y + lineHeight * 0.5 && o.y - frame.y < lineHeight * 3.5 && o.x >= frame.x - 20 && o.x < frame.x + Math.max(frame.width, 300);
			return sameLine || below;
		})
		.sort((a, b) => a.frame!.y - b.frame!.y || a.frame!.x - b.frame!.x)
		.map((other) => other.label)
		.filter((label, index, all) => all.indexOf(label) === index)
		.slice(0, 3)
		.join(" / ");
	return near.length > 80 ? `${near.slice(0, 80)}…` : near;
}

/** `[12] Button "Save"`: how an action names what it acted on. */
export function nameOf(element: UiElement): string {
	return `[${element.id}] ${element.role || "Element"}${element.label ? ` "${element.label}"` : ""}`;
}

/** `[12] Button "Save"`, with the state worth knowing. */
export function describe(element: UiElement): string {
	const parts = [`[${element.id}] ${element.role || "Element"}${element.label ? ` "${element.label}"` : ""}`];
	if (element.value !== undefined) parts.push(`value="${element.value.length > 80 ? `${element.value.slice(0, 80)}…` : element.value}"`);
	if (!element.enabled) parts.push("disabled");
	if (element.selected) parts.push("selected");
	return parts.join(" ");
}

/** What makes two elements in different windows the same control, near enough. */
export const signature = (element: Pick<UiElement, "role" | "label">) => `${element.role}|${element.label}`;

/**
 * A window without the elements of other windows nested in its tree. Some
 * toolkits (WinForms among them) show an owned dialog inside its owner's tree
 * as well as on its own; diffing the owner would report the dialog twice.
 */
export function withoutForeign(model: WindowModel, foreign: ReadonlySet<string>, titles: ReadonlySet<string>): WindowModel {
	if (!foreign.size && !titles.size) return model;
	return {
		...model,
		elements: model.elements.filter((element) => !foreign.has(signature(element)) && !(element.role === "TitleBar" && titles.has(element.label))),
		texts: model.texts.filter((line) => {
			const match = /^(\w+) "(.*)"$/.exec(line);
			return !match || (!foreign.has(`${match[1]}|${match[2]}`) && !titles.has(match[2]));
		}),
	};
}

/** Past this, a change is a different screen, and listing it line by line helps nobody. */
const MAX_DIFF_LINES = 30;

/**
 * What changed in a window between two reads: elements that appeared, went
 * away or changed state, and text that appeared or went. Empty when nothing
 * did — which is itself worth telling the model, as "no visible change".
 */
export function diffModels(before: WindowModel, after: WindowModel): string[] {
	const old = new Map(before.elements.map((element) => [element.id, element]));
	const now = new Map(after.elements.map((element) => [element.id, element]));
	const lines: string[] = [];
	if (before.title !== after.title) lines.push(`~ title "${before.title}" → "${after.title}"`);
	for (const element of after.elements) {
		const previous = old.get(element.id);
		if (!previous) {
			lines.push(`+ ${describe(element)}`);
			continue;
		}
		const changes: string[] = [];
		if (previous.value !== element.value) changes.push(`value "${previous.value ?? ""}" → "${element.value ?? ""}"`);
		if (previous.enabled !== element.enabled) changes.push(element.enabled ? "enabled" : "disabled");
		if (!!previous.selected !== !!element.selected) changes.push(element.selected ? "selected" : "unselected");
		if (changes.length) lines.push(`~ [${element.id}] ${element.role} "${element.label}": ${changes.join(", ")}`);
	}
	for (const element of before.elements) if (!now.has(element.id)) lines.push(`- ${describe(element)}`);
	const oldTexts = new Set(before.texts);
	const newTexts = new Set(after.texts);
	for (const text of after.texts) if (!oldTexts.has(text)) lines.push(`+ ${text}`);
	for (const text of before.texts) if (!newTexts.has(text)) lines.push(`- ${text}`);
	if (lines.length > MAX_DIFF_LINES) {
		const added = lines.filter((line) => line.startsWith("+")).length;
		const removed = lines.filter((line) => line.startsWith("-")).length;
		return [`${lines.length} changes (${added} added, ${removed} removed): the window shows something new — read it with computer_get_window_state.`];
	}
	return lines;
}

export interface Selector {
	/** Text the element shows: its name, or its value. */
	text: string;
	role?: string;
}

/**
 * Elements a selector names, best first: an exact name beats a name that
 * starts with the text, which beats one that contains it; a value counts
 * after names. Disabled elements come last within a tier.
 */
export function findElements(model: WindowModel, selector: Selector): UiElement[][] {
	const text = selector.text.trim().toLowerCase();
	const role = selector.role?.trim().toLowerCase();
	const tiers: UiElement[][] = [[], [], [], []];
	if (!text && !role) return tiers;
	for (const element of model.elements) {
		if (role && element.role.toLowerCase() !== role) continue;
		// A role alone names every element of that role, equally.
		if (!text) {
			tiers[0].push(element);
			continue;
		}
		const label = element.label.toLowerCase();
		const value = (element.value ?? "").toLowerCase();
		const tier = label === text ? 0 : label.startsWith(text) ? 1 : label.includes(text) ? 2 : value.includes(text) ? 3 : -1;
		if (tier >= 0) tiers[tier].push(element);
	}
	for (const tier of tiers) tier.sort((a, b) => Number(b.enabled) - Number(a.enabled));
	return tiers;
}

/** Top to bottom, and left to right within a row; elements with no place on screen last. */
export function readingOrder(a: UiElement, b: UiElement): number {
	if (!a.frame || !b.frame) return (a.frame ? 0 : 1) - (b.frame ? 0 : 1);
	const sameRow = Math.abs(a.frame.y - b.frame.y) < Math.min(a.frame.height, b.frame.height) / 2;
	return sameRow ? a.frame.x - b.frame.x : a.frame.y - b.frame.y;
}

/** The centre of an element, relative to its window, in physical pixels. */
export function centreInWindow(model: WindowModel, element: UiElement): { x: number; y: number } | undefined {
	if (!element.frame || !model.bounds || element.frame.width <= 0 || element.frame.height <= 0) return undefined;
	return {
		x: Math.round(element.frame.x - model.bounds.x + element.frame.width / 2),
		y: Math.round(element.frame.y - model.bounds.y + element.frame.height / 2),
	};
}
