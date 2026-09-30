import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { keysymForChar, parseKeyCombo, type DesktopAction } from "../../shared/remote-desktop";
import type { SshStore } from "../ssh-store";
import { pickHost } from "../ssh-tool";
import { shellQuote } from "../ssh-service";
import { accessibilityScript, accessibilityWrapper, parseAccessibility, type A11yElement } from "./accessibility";
import type { RfbClient, RfbRect } from "./rfb";
import type { RemoteDesktopService } from "./service";

/**
 * The remote desktop, for the agent: look at the screen, click, type, press
 * keys, scroll, drag — on the graphical desktop of a saved SSH server, over
 * the same VNC connection the user watches in the side panel.
 *
 * What makes it quick is not seeing less but asking less often:
 * - `sequence` runs several steps in one call, each waiting only until the
 *   screen stops changing, so a login is one round trip instead of five;
 * - after acting, the result is what changed — nothing, when nothing did;
 *   a crop of the region, when that is all; the whole screen only when most
 *   of it moved;
 * - `elements` reads the accessibility tree as text: names, states, field
 *   contents and exact places, so the agent can act on "element 7" without
 *   an image at all.
 *
 * Coordinates are in the full screenshot's pixels throughout. A desktop is
 * usually wider than a model should be sent, so it is scaled down and every
 * coordinate scaled back up here; the model never deals in two spaces.
 */

export const REMOTE_DESKTOP_TOOL_NAME = "remote_desktop";

/** Encode a region of RGBA pixels, scaled to the given size, as a base64 image. */
export type DesktopImageEncoder = (
	rgba: Uint8Array,
	width: number,
	height: number,
	region: RfbRect,
	target: { width: number; height: number },
) => { data: string; mimeType: string };

interface Source {
	store: SshStore;
	service: RemoteDesktopService;
	encode: DesktopImageEncoder;
}

let source: () => Source | null = () => null;

export function configureRemoteDesktopTool(value: () => Source | null): void {
	source = value;
}

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 800;
const KEY_GAP_MS = 8;
/** Past this share of the screen a crop saves little: send it all. */
const FULL_SCREEN_SHARE = 0.45;
/** Around a changed region, so what changed is seen in its context. */
const CROP_MARGIN = 24;
const MAX_STEPS = 20;
const ELEMENT_LIMIT = 150;

/** The screenshot's size for a screen, and the factor from screenshot to screen pixels. */
export function screenshotScale(width: number, height: number): { width: number; height: number; factor: number } {
	const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
	return { width: Math.round(width * scale), height: Math.round(height * scale), factor: 1 / scale };
}

const ACTION_OPS = ["click", "double_click", "right_click", "move", "drag", "type", "key", "scroll", "wait"] as const;
type ActionOp = (typeof ACTION_OPS)[number];
const OPS = ["screenshot", "zoom", "elements", "sequence", ...ACTION_OPS] as const;
type Op = (typeof OPS)[number];

const stepFields = {
	x: Type.Optional(Type.Number({ description: "X in the full screenshot's pixels." })),
	y: Type.Optional(Type.Number({ description: "Y in the full screenshot's pixels." })),
	element: Type.Optional(Type.Integer({ minimum: 1, description: "Act on this element from the latest op=elements instead of x,y." })),
	to_x: Type.Optional(Type.Number({ description: "Drag end X." })),
	to_y: Type.Optional(Type.Number({ description: "Drag end Y." })),
	text: Type.Optional(Type.String({ description: "Text to type (type). With element, that field is clicked first." })),
	keys: Type.Optional(Type.String({ description: "Key or combo joined with + (key), e.g. enter, ctrl+l, alt+f4." })),
	direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")], { description: "scroll direction" })),
	amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Scroll steps. Defaults to 3." })),
	seconds: Type.Optional(Type.Number({ minimum: 0.1, maximum: 30, description: "How long to wait (wait)." })),
} satisfies Record<string, TSchema>;

const step = Type.Object(
	{ op: Type.Union(ACTION_OPS.map((op) => Type.Literal(op))), ...stepFields },
	{ additionalProperties: false },
);

const schema = Type.Object(
	{
		op: Type.Union(OPS.map((op) => Type.Literal(op)), {
			description:
				"elements: list the visible controls, labels and field contents as text, numbered — the cheapest way to see a window. screenshot: the whole screen. zoom: a region (x,y,width,height) at full resolution. sequence: run `steps` in one call (e.g. click a field, type, press enter). click / double_click / right_click / move / drag / type / key / scroll / wait: one step. After acting you get only what changed: 'unchanged', a crop of the changed region, or the whole screen when most of it changed.",
		}),
		host: Type.Optional(Type.String({ description: "Saved SSH host name or id. Optional when only one host is saved." })),
		...stepFields,
		width: Type.Optional(Type.Number({ description: "Region width (zoom), screenshot pixels." })),
		height: Type.Optional(Type.Number({ description: "Region height (zoom), screenshot pixels." })),
		steps: Type.Optional(Type.Array(step, { maxItems: MAX_STEPS, description: "The steps of a sequence, run in order; it stops at the first that fails." })),
		query: Type.Optional(Type.String({ description: "Only elements whose name, text or role contains this (elements)." })),
		look: Type.Optional(
			Type.Union([Type.Literal("changes"), Type.Literal("screen"), Type.Literal("none")], {
				description: "After acting: changes (default) returns only what changed; screen, the whole screen; none, text only.",
			}),
		),
	},
	{ additionalProperties: false },
);

type Input = Static<typeof schema>;
type Step = Static<typeof step>;

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Cancelled"));
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("Cancelled"));
		}, { once: true });
	});

/** Where the pointer was left, per host: scroll and type without coordinates act there. */
const lastPointer = new Map<string, { x: number; y: number }>();
/** The latest `elements` listing per host, in screen pixels: what `element: n` refers to. */
const elementCache = new Map<string, A11yElement[]>();

function onScreen(element: A11yElement, rfb: RfbClient): boolean {
	return element.x >= 0 && element.y >= 0 && element.x + element.width <= rfb.width && element.y + element.height <= rfb.height;
}

/** Where a step acts, in screen pixels: an element's centre, or x,y scaled up from the screenshot. */
function target(hostId: string, fields: Step | Input, rfb: RfbClient, op: string, which: "from" | "to" = "from"): { x: number; y: number } {
	if (which === "from" && fields.element !== undefined) {
		const element = elementCache.get(hostId)?.[fields.element - 1];
		if (!element) throw new Error(`No element ${fields.element}: list them with op=elements first`);
		if (!onScreen(element, rfb))
			throw new Error(`Element ${fields.element} reports a place outside the screen (a stale position); take a screenshot and use x,y`);
		return { x: Math.round(element.x + element.width / 2), y: Math.round(element.y + element.height / 2) };
	}
	const x = which === "from" ? fields.x : fields.to_x;
	const y = which === "from" ? fields.y : fields.to_y;
	const names = which === "from" ? "x and y (or element)" : "to_x and to_y";
	if (typeof x !== "number" || typeof y !== "number") throw new Error(`${op} needs ${names}`);
	const { width, height, factor } = screenshotScale(rfb.width, rfb.height);
	if (x < 0 || y < 0 || x > width || y > height) throw new Error(`(${x}, ${y}) is outside the ${width}×${height} screenshot`);
	return { x: Math.min(rfb.width - 1, Math.round(x * factor)), y: Math.min(rfb.height - 1, Math.round(y * factor)) };
}

async function click(rfb: RfbClient, at: { x: number; y: number }, button: number, count: number): Promise<void> {
	rfb.pointer(at.x, at.y, 0);
	await sleep(20);
	for (let i = 0; i < count; i++) {
		rfb.pointer(at.x, at.y, button);
		await sleep(30);
		rfb.pointer(at.x, at.y, 0);
		await sleep(count > 1 ? 60 : 20);
	}
}

async function drag(rfb: RfbClient, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
	rfb.pointer(from.x, from.y, 0);
	await sleep(30);
	rfb.pointer(from.x, from.y, 1);
	await sleep(60);
	// Intermediate moves: toolkits start a drag on motion, not on a jump.
	const steps = 12;
	for (let i = 1; i <= steps; i++) {
		rfb.pointer(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 1);
		await sleep(15);
	}
	rfb.pointer(to.x, to.y, 0);
}

async function pressCombo(rfb: RfbClient, combo: string): Promise<void> {
	const keysyms = parseKeyCombo(combo);
	for (const keysym of keysyms) {
		rfb.key(keysym, true);
		await sleep(KEY_GAP_MS);
	}
	for (const keysym of [...keysyms].reverse()) {
		rfb.key(keysym, false);
		await sleep(KEY_GAP_MS);
	}
}

async function typeText(rfb: RfbClient, text: string, signal?: AbortSignal): Promise<void> {
	for (const char of text) {
		if (signal?.aborted) throw new Error("Cancelled");
		const keysym = keysymForChar(char);
		rfb.key(keysym, true);
		rfb.key(keysym, false);
		await sleep(KEY_GAP_MS);
	}
}

/** One step of input. Returns a word for the result line. */
async function perform(desktop: Source, hostId: string, rfb: RfbClient, fields: Step, signal?: AbortSignal): Promise<string> {
	const op = fields.op as ActionOp;
	const mark = (kind: DesktopAction["kind"], label: string, at?: { x: number; y: number }) =>
		desktop.service.markAction({ hostId, kind, label, ...(at ?? {}) });
	switch (op) {
		case "click":
		case "double_click":
		case "right_click": {
			const at = target(hostId, fields, rfb, op);
			mark(op, op.replace("_", " "), at);
			await click(rfb, at, op === "right_click" ? 4 : 1, op === "double_click" ? 2 : 1);
			lastPointer.set(hostId, at);
			return op.replace("_", " ");
		}
		case "move": {
			const at = target(hostId, fields, rfb, op);
			mark("move", "move", at);
			rfb.pointer(at.x, at.y, 0);
			lastPointer.set(hostId, at);
			return "move";
		}
		case "drag": {
			const from = target(hostId, fields, rfb, op);
			const to = target(hostId, fields, rfb, op, "to");
			mark("drag", "drag", to);
			await drag(rfb, from, to);
			lastPointer.set(hostId, to);
			return "drag";
		}
		case "type": {
			const text = fields.text ?? "";
			if (!text) throw new Error("type needs text");
			if (fields.element !== undefined || fields.x !== undefined) {
				const at = target(hostId, fields, rfb, op);
				await click(rfb, at, 1, 1);
				lastPointer.set(hostId, at);
				await sleep(80, signal);
			}
			mark("type", text.length > 40 ? `${text.slice(0, 40)}…` : text, lastPointer.get(hostId));
			await typeText(rfb, text, signal);
			return `type (${[...text].length} characters)`;
		}
		case "key": {
			if (!fields.keys?.trim()) throw new Error("key needs keys");
			mark("key", fields.keys, lastPointer.get(hostId));
			await pressCombo(rfb, fields.keys);
			return `key ${fields.keys}`;
		}
		case "scroll": {
			const at = fields.x !== undefined || fields.y !== undefined || fields.element !== undefined
				? target(hostId, fields, rfb, op)
				: (lastPointer.get(hostId) ?? { x: rfb.width / 2, y: rfb.height / 2 });
			const direction = fields.direction ?? "down";
			const button = { up: 8, down: 16, left: 32, right: 64 }[direction];
			mark("scroll", `scroll ${direction}`, at);
			rfb.pointer(at.x, at.y, 0);
			for (let i = 0; i < (fields.amount ?? 3); i++) {
				rfb.pointer(at.x, at.y, button);
				rfb.pointer(at.x, at.y, 0);
				await sleep(25);
			}
			lastPointer.set(hostId, at);
			return `scroll ${direction}`;
		}
		case "wait":
			await sleep((fields.seconds ?? 1) * 1000, signal);
			return `wait ${fields.seconds ?? 1}s`;
		default:
			throw new Error(`Unknown step: ${String(fields.op)}`);
	}
}

type Content = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

function fullScreen(desktop: Source, rfb: RfbClient): Content {
	const size = screenshotScale(rfb.width, rfb.height);
	const image = desktop.encode(rfb.framebuffer, rfb.width, rfb.height, { x: 0, y: 0, width: rfb.width, height: rfb.height }, { width: size.width, height: size.height });
	const note = size.factor > 1
		? `Screen ${rfb.width}×${rfb.height}, shown at ${size.width}×${size.height}: give coordinates in these screenshot pixels.`
		: `Screen ${rfb.width}×${rfb.height}.`;
	return [
		{ type: "text", text: note },
		{ type: "image", data: image.data, mimeType: image.mimeType },
	];
}

/**
 * What changed since the agent last looked: nothing; crops of the one or two
 * largest changed regions at screenshot scale (a point in a crop is its
 * offset plus the crop's corner), with smaller changes named by place; or
 * the whole screen when most of it changed.
 */
function changes(desktop: Source, hostId: string, rfb: RfbClient, look: "changes" | "screen" | "none"): Content {
	const { first, regions } = desktop.service.takeAgentChanges(hostId);
	const size = screenshotScale(rfb.width, rfb.height);
	const inShot = (value: number) => Math.round(value / size.factor);
	const where = (rect: RfbRect) => `(${inShot(rect.x)}, ${inShot(rect.y)})–(${inShot(rect.x + rect.width)}, ${inShot(rect.y + rect.height)})`;
	if (look === "none")
		return [{ type: "text", text: regions.length ? `The screen changed at ${regions.slice(0, 6).map(where).join(", ")}.` : "The screen did not change." }];
	if (look === "screen" || first) return fullScreen(desktop, rfb);
	if (!regions.length) return [{ type: "text", text: "The screen did not change since your last look." }];
	const padded = regions.slice(0, 2).map((rect) => {
		const x = Math.max(0, rect.x - CROP_MARGIN);
		const y = Math.max(0, rect.y - CROP_MARGIN);
		return {
			x,
			y,
			width: Math.min(rfb.width, rect.x + rect.width + CROP_MARGIN) - x,
			height: Math.min(rfb.height, rect.y + rect.height + CROP_MARGIN) - y,
		};
	});
	const shown = padded.reduce((sum, rect) => sum + rect.width * rect.height, 0);
	if (shown > rfb.width * rfb.height * FULL_SCREEN_SHARE) return fullScreen(desktop, rfb);
	const content: Content = [];
	const lines = [
		`Only part of the screen changed; ${padded.length === 1 ? "the image shows" : "the images show"} it at the same scale as the ${size.width}×${size.height} screenshot, so a point (u, v) in an image is its corner plus (u, v):`,
		...padded.map((region, index) => `image ${index + 1}: ${where(region)}`),
	];
	const rest = regions.slice(2, 8);
	if (rest.length) lines.push(`Smaller changes, not shown: ${rest.map(where).join(", ")}.`);
	content.push({ type: "text", text: lines.join("\n") });
	for (const region of padded) {
		const image = desktop.encode(rfb.framebuffer, rfb.width, rfb.height, region, {
			width: Math.max(1, inShot(region.width)),
			height: Math.max(1, inShot(region.height)),
		});
		content.push({ type: "image", data: image.data, mimeType: image.mimeType });
	}
	return content;
}

function zoom(desktop: Source, rfb: RfbClient, input: Input): Content {
	const size = screenshotScale(rfb.width, rfb.height);
	const { x, y, width, height } = input;
	if (typeof x !== "number" || typeof y !== "number" || !width || !height) throw new Error("zoom needs x, y, width and height");
	const region = {
		x: Math.max(0, Math.round(x * size.factor)),
		y: Math.max(0, Math.round(y * size.factor)),
		width: 0,
		height: 0,
	};
	region.width = Math.min(rfb.width - region.x, Math.round(width * size.factor));
	region.height = Math.min(rfb.height - region.y, Math.round(height * size.factor));
	if (region.width <= 0 || region.height <= 0) throw new Error("The zoom region is outside the screen");
	const scale = Math.min(MAX_WIDTH / region.width, MAX_HEIGHT / region.height, 4);
	const target = { width: Math.round(region.width * scale), height: Math.round(region.height * scale) };
	const image = desktop.encode(rfb.framebuffer, rfb.width, rfb.height, region, target);
	return [
		{
			type: "text",
			text: `Zoomed: (${x}, ${y}) ${width}×${height} of the screenshot, enlarged ${(scale * size.factor).toFixed(1)}×. Keep giving coordinates in full-screenshot pixels.`,
		},
		{ type: "image", data: image.data, mimeType: image.mimeType },
	];
}

/** The element list as the model reads it: numbered, grouped by window, in screenshot pixels. */
export function formatElements(elements: A11yElement[], omitted: number, screen: { width: number; height: number }): string {
	if (!elements.length) return "No accessible elements were found (the app may not expose an accessibility tree); use a screenshot.";
	const size = screenshotScale(screen.width, screen.height);
	const inShot = (value: number) => Math.round(value / size.factor);
	const lines: string[] = [];
	let group = "";
	elements.forEach((element, index) => {
		const heading = `${element.active ? "Active window" : "Window"} "${element.window || element.app}" (${element.app})`;
		if (heading !== group) {
			group = heading;
			lines.push(`${heading}:`);
		}
		const off = element.x < 0 || element.y < 0 || element.x + element.width > screen.width || element.y + element.height > screen.height;
		const place = off ? "off-screen?" : `(${inShot(element.x)},${inShot(element.y)} ${inShot(element.width)}×${inShot(element.height)})`;
		const states = element.states.length ? ` [${element.states.join(", ")}]` : "";
		const text = element.text !== undefined ? ` = ${JSON.stringify(element.text.length > 300 ? `…${element.text.slice(-300)}` : element.text)}` : "";
		lines.push(`  [${index + 1}] ${element.role} ${JSON.stringify(element.name)}${states} ${place}${text}`);
	});
	if (omitted) lines.push(`(${omitted} more not listed; narrow with query)`);
	return lines.join("\n");
}

export function createRemoteDesktopTool(): ToolDefinition {
	return {
		name: REMOTE_DESKTOP_TOOL_NAME,
		label: REMOTE_DESKTOP_TOOL_NAME,
		description:
			"Operate the graphical desktop of a saved SSH server through VNC — the user watches it live in the side panel and can take control at any time. Cheapest first: op=elements lists the visible controls and field contents as text, and element numbers can be clicked or typed into directly; screenshot when you need to see layout or an app that lists nothing. Batch known steps with op=sequence (click field, type, key enter) — one call instead of several. After acting you get only what changed. Coordinates are always full-screenshot pixels. Prefer the ssh tool for anything a shell command can do. If the user has taken control, stop and wait for them to hand it back.",
		promptSnippet:
			"remote_desktop(op=elements|screenshot|zoom|sequence|click|type|key|scroll|drag|wait, host?, element?, steps?) sees and operates a saved server's graphical desktop.",
		parameters: schema,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const input = params as Input;
			const desktop = source();
			if (!desktop) throw new Error("The remote desktop is unavailable in this session");
			const host = pickHost(desktop.store.hosts(), input.host, (ref) => desktop.store.find(ref));
			let rfb = await desktop.service.agent(host.id);
			const op = input.op as Op;
			const reply = (content: Content) => ({
				content: [
					...(content[0]?.type === "text" ? [{ type: "text" as const, text: `[${host.name}] ${content[0].text}` }] : []),
					...content.slice(content[0]?.type === "text" ? 1 : 0),
				],
				details: { op, host: host.name },
			});

			if (op === "screenshot") {
				desktop.service.takeAgentChanges(host.id);
				return reply(fullScreen(desktop, rfb));
			}
			if (op === "zoom") return reply(zoom(desktop, rfb, input));
			if (op === "elements") {
				const script = accessibilityScript({ limit: ELEMENT_LIMIT, query: input.query ?? "", width: rfb.width, height: rfb.height });
				const output = await desktop.service.run(host.id, `sh -c ${shellQuote(accessibilityWrapper(desktop.service.display(host.id)))}`, script, 20_000);
				const { elements, omitted } = parseAccessibility(output);
				elementCache.set(host.id, elements);
				return reply([{ type: "text", text: formatElements(elements, omitted, rfb) }]);
			}

			const steps: Step[] = op === "sequence" ? (input.steps ?? []) : [{ ...input, op } as Step];
			if (!steps.length) throw new Error("sequence needs steps");
			const done: string[] = [];
			for (const [index, current] of steps.entries()) {
				// The user may take over mid-sequence; the next step must not go on regardless.
				rfb = await desktop.service.agent(host.id);
				try {
					done.push(await perform(desktop, host.id, rfb, current, signal));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(steps.length > 1 ? `Step ${index + 1} (${current.op}) failed after ${done.length} done: ${message}` : message);
				}
				const last = index === steps.length - 1;
				// Between steps input only has to reach the app, which it does at once;
				// the result waits for the picture, at this server's own pace.
				if (current.op !== "wait")
					await desktop.service.settle(host.id, last
						? { quietMs: 700, firstMs: 800, maxMs: 6000, adaptive: true, signal }
						: { quietMs: 120, firstMs: 250, maxMs: 1500, signal });
			}
			const content = changes(desktop, host.id, rfb, input.look ?? "changes");
			const summary = `${done.join(" → ")} done.`;
			return reply(content[0]?.type === "text" ? [{ type: "text", text: `${summary} ${content[0].text}` }, ...content.slice(1)] : [{ type: "text", text: summary }, ...content]);
		},
	};
}
