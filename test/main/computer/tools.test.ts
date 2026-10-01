import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ComputerCallResult } from "../../../src/main/computer/protocol";
import { COMPUTER_TOOL_NAMES, createComputerTools, type ComputerCaller } from "../../../src/main/computer/tools";

interface FakeElement {
	role: string;
	label: string;
	value?: string;
	/** What clicking it does to the desktop. */
	onClick?: (desktop: FakeDesktop) => void;
}

interface FakeWindow {
	pid: number;
	title: string;
	cls: string;
	elements: FakeElement[];
	texts: string[];
}

/**
 * A desktop the tools can drive: windows with element trees, a driver that
 * numbers elements per read the way the real one does, and clicks with effects.
 */
class FakeDesktop implements ComputerCaller {
	windows = new Map<number, FakeWindow>();
	calls: { name: string; args: Record<string, unknown> }[] = [];
	private snapshot = 0;
	private reads = new Map<number, { id: string; elements: FakeElement[] }>();
	/** Make one driver call fail or hang. */
	override?: (name: string, args: Record<string, unknown>) => Promise<ComputerCallResult> | undefined;

	open(id: number, window: Partial<FakeWindow> & { elements: FakeElement[] }) {
		this.windows.set(id, { pid: 42, title: `Window ${id}`, cls: "WindowsForms10.Window.8.app", texts: [], ...window });
	}

	async call(name: string, args: Record<string, unknown>): Promise<ComputerCallResult> {
		this.calls.push({ name, args });
		const special = this.override?.(name, args);
		if (special) return special;
		const ok = (text: string, extra: Partial<ComputerCallResult> = {}): ComputerCallResult => ({ text, images: [], isError: false, ...extra });
		const windowId = args.window_id as number;
		switch (name) {
			case "nekocode.window_class":
				return ok(this.windows.get(windowId)?.cls ?? "");
			case "nekocode.raise_window":
				return ok("raised");
			case "list_windows": {
				const windows = [...this.windows.entries()]
					.filter(([, w]) => args.pid === undefined || w.pid === args.pid)
					.map(([id, w]) => ({ window_id: id, pid: w.pid, title: w.title }));
				return ok(windows.map((w) => `${w.window_id} ${w.title}`).join("\n"), { structuredJson: JSON.stringify({ windows }) });
			}
			case "get_window_state": {
				const window = this.windows.get(windowId);
				if (!window) return { text: "no such window", images: [], isError: true };
				if (args.include_accessibility_tree === false) return ok("", { images: [{ data: "SHOT", mimeType: "image/png" }] });
				const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
				const id = `s${++this.snapshot}`;
				const shown = window.elements
					.map((element, index) => ({ element, index }))
					.filter(({ element }) => !query || element.label.toLowerCase().includes(query) || (element.value ?? "").toLowerCase().includes(query));
				this.reads.set(windowId, { id, elements: window.elements.slice() });
				const markdown = [
					`window_id=${windowId} pid=${window.pid} elements=${shown.length}`,
					"",
					`- Window "${window.title}"`,
					...shown.map(({ element, index }) => `  - [${index}] ${element.role} "${element.label}" [actions=[invoke]]`),
					...window.texts.filter((t) => !query || t.toLowerCase().includes(query)).map((t) => `  - Text "${t}"`),
				].join("\n");
				return ok(markdown, {
					images: args.include_screenshot ? [{ data: "SHOT", mimeType: "image/png" }] : [],
					structuredJson: JSON.stringify({
						snapshot_id: id,
						window_title: window.title,
						window_bounds: { x: 0, y: 0, width: 800, height: 600 },
						elements: shown.map(({ element, index }) => ({
							element_index: index,
							role: element.role,
							label: element.label,
							...(element.value !== undefined ? { value: element.value } : {}),
							enabled: true,
							actions: ["invoke"],
							frame: { x: 10, y: 10 + index * 30, w: 100, h: 25 },
						})),
						total_element_count: window.elements.length,
						returned_element_count: shown.length,
					}),
				});
			}
			case "click":
			case "set_value":
			case "type_text": {
				if (args.element_index === undefined) return ok(`${name} at point`);
				const read = this.reads.get(windowId);
				if (!read || read.id !== args.snapshot_id) return { text: "stale snapshot", images: [], isError: true };
				const element = read.elements[args.element_index as number];
				if (name === "click") element.onClick?.(this);
				else element.value = String(args.value ?? args.text);
				return ok(`${name} on [${args.element_index}]`);
			}
			default:
				return ok(`${name} done`);
		}
	}
}

function setup(desktop = new FakeDesktop(), guardMs = 2_000) {
	const tools = new Map(createComputerTools(desktop, undefined, { settleMs: 0, pollMs: 1, guardMs }).map((tool) => [tool.name, tool]));
	const run = (name: string, params: Record<string, unknown>) =>
		(tools.get(name)!.execute as (...args: unknown[]) => Promise<{ content: { type: string; text?: string; data?: string }[] }>)(
			"call-1",
			params,
			undefined,
			undefined,
			{},
		);
	const text = async (name: string, params: Record<string, unknown>) => (await run(name, params)).content[0].text ?? "";
	return { desktop, tools, run, text };
}

const actions = (desktop: FakeDesktop) => desktop.calls.filter((call) => ["click", "set_value", "type_text", "press_key", "hotkey"].includes(call.name));

describe("computer tools", () => {
	test("define every advertised tool", () => {
		const { tools } = setup();
		expect([...tools.keys()].sort()).toEqual([...COMPUTER_TOOL_NAMES].sort());
	});

	test("reading a window lists its elements with stable numbers and no screenshot", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { title: "Form", elements: [{ role: "Edit", label: "Name" }, { role: "Button", label: "Save" }, { role: "Button", label: "Cancel" }] });
		const { run } = setup(desktop);
		const result = await run("computer_get_window_state", { pid: 42, window_id: 7 });
		expect(result.content).toHaveLength(1);
		expect(result.content[0].text).toContain('[2] Button "Save"');
		expect(desktop.calls.find((c) => c.name === "get_window_state")?.args.include_screenshot).toBe(false);
	});

	test("a nearly empty tree comes with a screenshot", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { title: "Game", elements: [{ role: "Pane", label: "" }] });
		const { run } = setup(desktop);
		const result = await run("computer_get_window_state", { pid: 42, window_id: 7 });
		expect(result.content[1]).toMatchObject({ type: "image", data: "SHOT" });
		expect(result.content[0].text).toContain("custom-drawn");
	});

	test("a target is clicked by name, with the live index, as real input in a classic app", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { title: "Form", elements: [{ role: "Edit", label: "Name" }, { role: "Button", label: "Save" }] });
		const { text } = setup(desktop);
		const result = await text("computer_click", { pid: 42, target: "save" });
		expect(result).toContain('Clicked [2] Button "Save" — real input');
		const click = actions(desktop)[0];
		expect(click.args).toMatchObject({ element_index: 1, delivery_mode: "foreground" });
	});

	test("checkboxes stay in the background even in classic apps", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { elements: [{ role: "CheckBox", label: "Agree" }] });
		const { text } = setup(desktop);
		expect(await text("computer_click", { pid: 42, target: "Agree" })).toContain("UI Automation in the background");
		expect(actions(desktop)[0].args.delivery_mode).toBeUndefined();
	});

	test("an element number follows its element after the window changes", async () => {
		const desktop = new FakeDesktop();
		const clicked: string[] = [];
		desktop.open(7, { cls: "Chrome_WidgetWin_1", elements: [{ role: "Button", label: "Save", onClick: () => clicked.push("save") }] });
		const { run, text } = setup(desktop);
		await run("computer_get_window_state", { pid: 42, window_id: 7 });
		// Something appears above it: the driver now numbers Save 1, not 0.
		desktop.windows.get(7)!.elements.unshift({ role: "Button", label: "Dismiss", onClick: () => clicked.push("dismiss") });
		await text("computer_click", { pid: 42, element_index: 1 });
		expect(clicked).toEqual(["save"]);
	});

	test("an ambiguous name lists the candidates; nth picks one", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { cls: "Chrome_WidgetWin_1", elements: [{ role: "Button", label: "OK" }, { role: "Button", label: "OK" }] });
		const { run } = setup(desktop);
		await expect(run("computer_click", { pid: 42, target: "OK" })).rejects.toThrow("matches 2 elements");
		await run("computer_click", { pid: 42, target: "OK", nth: 2 });
		expect(actions(desktop)[0].args.element_index).toBe(1);
	});

	test("a name found nowhere is answered with what is there", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { elements: [{ role: "Button", label: "Open" }, { role: "Button", label: "Close" }] });
		const { run } = setup(desktop);
		await expect(run("computer_click", { pid: 42, target: "Save" })).rejects.toThrow(/No element named "Save"[\s\S]*Button "Open"/);
		expect(actions(desktop)).toHaveLength(0);
	});

	test("a click that opens a dialog returns the dialog's elements and the window's changes", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, {
			title: "Main",
			elements: [
				{
					role: "Button",
					label: "Delete",
					onClick: (d) => {
						d.open(9, { title: "Confirm", elements: [{ role: "Button", label: "Yes" }, { role: "Button", label: "No" }] });
						d.windows.get(7)!.texts.push("Waiting for confirmation");
					},
				},
			],
		});
		const { text } = setup(desktop);
		const result = await text("computer_click", { pid: 42, target: "Delete" });
		expect(result).toContain('New window 9 "Confirm"');
		expect(result).toContain('Button "Yes"');
		expect(result).toContain('+ Text "Waiting for confirmation"');
		// The dialog is where the next step happens, and it is found by name.
		await text("computer_click", { pid: 42, target: "Yes" });
		expect(actions(desktop).at(-1)!.args.window_id).toBe(9);
	});

	test("a dialog nested in its owner's tree is reported once, as its own window", async () => {
		const desktop = new FakeDesktop();
		const yes: FakeElement = {
			role: "Button",
			label: "Yes",
			onClick: (d) => {
				d.windows.delete(9);
				d.windows.get(7)!.elements = d.windows.get(7)!.elements.filter((e) => e.label !== "Yes" && e.label !== "No");
				d.windows.get(7)!.texts.push("Deleted");
			},
		};
		desktop.open(7, {
			title: "Main",
			elements: [
				{
					role: "Button",
					label: "Delete",
					// WinForms: the owned dialog's controls also show up inside the owner.
					onClick: (d) => {
						d.open(9, { title: "Confirm", elements: [yes, { role: "Button", label: "No" }] });
						d.windows.get(7)!.elements.push({ role: "Button", label: "Yes" }, { role: "Button", label: "No" });
					},
				},
			],
		});
		const { text } = setup(desktop);
		const opened = await text("computer_click", { pid: 42, target: "Delete" });
		expect(opened).toContain('New window 9 "Confirm"');
		expect(opened).not.toMatch(/Changes in window 7:[\s\S]*Button "Yes"/);
		const answered = await text("computer_click", { pid: 42, target: "Yes", window_id: 9 });
		expect(answered).toContain('Window 9 "Confirm" closed.');
		expect(answered).toContain('Changes in window 7:\n  + Text "Deleted"');
		expect(answered).not.toContain('- [');
	});

	test("an Invoke that does not return is treated as a modal: the dialog is shown and later input is real", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { cls: "SomeToolkitWindow", title: "Main", elements: [{ role: "Button", label: "Open" }] });
		desktop.override = (name, args) => {
			if (name === "click" && args.delivery_mode === undefined) {
				desktop.open(9, { title: "Modal", elements: [{ role: "Button", label: "OK" }] });
				return new Promise(() => {});
			}
			return undefined;
		};
		const { run } = setup(desktop, 20);
		const result = await run("computer_click", { pid: 42, target: "Open" });
		expect(result.content[0].text).toContain("the app is now waiting on a window it opened");
		expect(result.content[0].text).toContain('Window 9 "Modal" opened and is holding the app');
		expect(result.content[1]).toMatchObject({ type: "image", data: "SHOT" });
		await run("computer_press_key", { pid: 42, keys: ["return"] });
		expect(actions(desktop).at(-1)).toMatchObject({ name: "press_key", args: { delivery_mode: "foreground", window_id: 9 } });
	});

	test("a background attempt that did not land is retried as real input", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { cls: "Chrome_WidgetWin_1", elements: [{ role: "Button", label: "Go" }] });
		desktop.override = (name, args) =>
			name === "click" && args.delivery_mode === undefined
				? Promise.resolve({ text: "UIA pixel click timeout", images: [], isError: true, errorCode: "background_unavailable" })
				: undefined;
		const { text } = setup(desktop);
		expect(await text("computer_click", { pid: 42, target: "Go" })).toContain("background attempt did not land");
		expect(actions(desktop).at(-1)!.args.delivery_mode).toBe("foreground");
	});

	test("a sequence fills a form in one call and stops at the first failure", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, {
			cls: "Chrome_WidgetWin_1",
			elements: [
				{ role: "Edit", label: "Name", value: "" },
				{ role: "Button", label: "Submit", onClick: (d) => d.windows.get(7)!.texts.push("Thanks!") },
			],
		});
		const { text } = setup(desktop);
		const ok = await text("computer_sequence", {
			pid: 42,
			steps: [
				{ action: "type", target: "Name", text: "Ann", replace: true },
				{ action: "click", target: "Submit" },
			],
			wait_for: "Thanks",
		});
		expect(ok).toContain('1. Set [1] Edit "Name" to "Ann"');
		expect(ok).toContain('2. Clicked [2] Button "Submit"');
		expect(ok).toContain('✓ "Thanks" appeared.');
		const failed = await text("computer_sequence", {
			pid: 42,
			steps: [
				{ action: "click", target: "Missing" },
				{ action: "click", target: "Submit" },
			],
		});
		expect(failed).toContain("1. ✗ No element named");
		expect(failed).toContain("Stopped; steps 2–2 were not run.");
	});

	test("a menu path is walked item by item as real clicks in a classic app", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, {
			elements: [{ role: "MenuItem", label: "File", onClick: (d) => d.open(11, { title: "", elements: [{ role: "MenuItem", label: "Save As" }] }) }],
		});
		const { text } = setup(desktop);
		expect(await text("computer_menu", { pid: 42, path: ["File", "Save As"] })).toContain("Chose File > Save As");
		const clicks = actions(desktop);
		expect(clicks.map((c) => c.args.window_id)).toEqual([7, 11]);
		expect(clicks.every((c) => c.args.delivery_mode === "foreground")).toBe(true);
	});

	test("waiting reports whether the text showed up in time", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { elements: [{ role: "Button", label: "Go" }], texts: ["Loading"] });
		const { text } = setup(desktop);
		expect(await text("computer_wait", { pid: 42, text: "loading" })).toContain("appeared");
		expect(await text("computer_wait", { pid: 42, text: "Done", timeout_ms: 5 })).toContain("did not appear");
		expect(await text("computer_wait", { pid: 42, text: "Done", gone: true })).toContain("is gone");
	});

	test("what was typed into a field does not count as having appeared", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { cls: "OrpheusBrowserHost", elements: [{ role: "Edit", label: "Search", value: "feathers" }] });
		const { text } = setup(desktop);
		expect(await text("computer_wait", { pid: 42, text: "feathers", timeout_ms: 5 })).toContain("did not appear");
		desktop.windows.get(7)!.elements.push({ role: "Text", label: "feathers (live)" });
		expect(await text("computer_wait", { pid: 42, text: "feathers" })).toContain("appeared");
	});

	test("typing and keys go as real input; Enter is understood; replace without a target clears the focused field", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { cls: "OrpheusBrowserHost", elements: [{ role: "Edit", label: "Search" }] });
		const { text } = setup(desktop);
		await text("computer_type_text", { pid: 42, text: "hope", replace: true, submit: true });
		const sent = actions(desktop).map((call) => [call.name, call.args.delivery_mode, call.args.keys ?? call.args.key ?? call.args.text]);
		expect(sent).toEqual([
			["hotkey", "foreground", ["ctrl", "a"]],
			["type_text", "foreground", "hope"],
			["press_key", "foreground", "return"],
		]);
		await text("computer_press_key", { pid: 42, keys: ["Enter"] });
		expect(actions(desktop).at(-1)!.args).toMatchObject({ key: "return", delivery_mode: "foreground" });
	});

	test("a plain title in a web UI gets a real click, and a double click is always real", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { cls: "OrpheusBrowserHost", elements: [{ role: "Text", label: "Song" }, { role: "Button", label: "Play" }] });
		const { text } = setup(desktop);
		await text("computer_click", { pid: 42, target: "Song" });
		expect(actions(desktop).at(-1)!.args.delivery_mode).toBe("foreground");
		await text("computer_click", { pid: 42, target: "Play" });
		expect(actions(desktop).at(-1)!.args.delivery_mode).toBeUndefined();
		await text("computer_click", { pid: 42, target: "Play", count: 2 });
		expect(actions(desktop).at(-1)!.args.delivery_mode).toBe("foreground");
	});

	test("a wait step without text is a pause", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { cls: "OrpheusBrowserHost", elements: [{ role: "Button", label: "Go" }] });
		const { text } = setup(desktop);
		expect(await text("computer_sequence", { pid: 42, steps: [{ action: "wait", timeout_ms: 5 }, { action: "click", target: "Go" }] })).toContain("1. Waited 5 ms.");
	});

	test("targets, indices and points are not mixed, and a point needs both coordinates", async () => {
		const desktop = new FakeDesktop();
		desktop.open(7, { elements: [{ role: "Button", label: "Go" }] });
		const { run } = setup(desktop);
		await expect(run("computer_click", { pid: 42, target: "Go", x: 1, y: 2 })).rejects.toThrow("one way");
		await expect(run("computer_click", { pid: 42, x: 1 })).rejects.toThrow("together");
		await expect(run("computer_click", { pid: 42 })).rejects.toThrow("Give target");
		await expect(run("computer_click", { pid: 42, element_index: 5 })).rejects.toThrow("not known");
	});
});
