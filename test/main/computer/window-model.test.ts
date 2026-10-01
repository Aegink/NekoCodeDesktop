import { describe as group, expect, test } from "bun:test";
import { clickRoute, frameworkOf, keyRoute, needsForeground, normalizeKey } from "../../../src/main/computer/input-strategy";
import { centreInWindow, compactAttributes, diffModels, ElementIds, findElements, parseWindowState } from "../../../src/main/computer/window-model";

interface Spec {
	role: string;
	label: string;
	value?: string;
	id?: string;
	enabled?: boolean;
}

/** A driver read as get_window_state returns it, for a list of elements and plain texts. */
function state(elements: Spec[], texts: string[] = [], snapshot = "s1") {
	const markdown = [
		"window_id=7 pid=42 elements=" + elements.length,
		"",
		'- Window "Test"',
		...elements.map((e, i) => `  - [${i}] ${e.role} "${e.label}"${e.id ? ` [id=${e.id} actions=[invoke]]` : " [actions=[invoke]]"}`),
		...texts.map((t) => `  - Text "${t}"`),
	].join("\n");
	return {
		text: markdown,
		structuredJson: JSON.stringify({
			snapshot_id: snapshot,
			window_title: "Test",
			window_bounds: { x: 100, y: 50, width: 800, height: 600 },
			elements: elements.map((e, i) => ({
				element_index: i,
				role: e.role,
				label: e.label,
				...(e.value !== undefined ? { value: e.value } : {}),
				enabled: e.enabled !== false,
				actions: ["invoke"],
				frame: { x: 110 + i * 10, y: 60, w: 80, h: 30 },
			})),
			total_element_count: elements.length,
			returned_element_count: elements.length,
		}),
	};
}

const parse = (ids: ElementIds, read: ReturnType<typeof state>) => parseWindowState(42, 7, read.text, read.structuredJson, ids)!;

group("window model", () => {
	test("numbers stay with their element when the window changes around it", () => {
		const ids = new ElementIds();
		const first = parse(ids, state([{ role: "Edit", label: "Name", id: "name" }, { role: "Button", label: "Save" }]));
		const save = first.elements.find((e) => e.label === "Save")!;
		// A banner appears above everything: every driver index shifts by one.
		const second = parse(ids, state([{ role: "Text", label: "Unsaved changes" }, { role: "Edit", label: "Name", id: "name" }, { role: "Button", label: "Save" }]));
		const saveAgain = second.elements.find((e) => e.label === "Save")!;
		expect(saveAgain.id).toBe(save.id);
		expect(saveAgain.index).toBe(2);
		expect(second.tree).toContain(`[${save.id}] Button "Save"`);
		expect(second.tree).not.toContain("window_id=");
	});

	test("controls with the same name are told apart, by automation id or by order", () => {
		const ids = new ElementIds();
		const model = parse(ids, state([{ role: "Button", label: "OK" }, { role: "Button", label: "OK" }, { role: "Edit", label: "Port", id: "port" }, { role: "Edit", label: "Port", id: "host" }]));
		expect(new Set(model.elements.map((e) => e.id)).size).toBe(4);
	});

	test("a window handle is not taken for an automation id", () => {
		const ids = new ElementIds();
		const a = parse(ids, state([{ role: "Button", label: "Go", id: "1181318" }]));
		const b = parse(ids, state([{ role: "Button", label: "Go", id: "2231552" }]));
		expect(b.elements[0].id).toBe(a.elements[0].id);
	});

	test("diffs report what appeared, went and changed", () => {
		const ids = new ElementIds();
		const before = parse(ids, state([{ role: "Edit", label: "Name", value: "" }, { role: "Button", label: "Submit" }], ["Ready"]));
		const after = parse(ids, state([{ role: "Edit", label: "Name", value: "Ann" }, { role: "Button", label: "Undo" }], ["Saved"]));
		const lines = diffModels(before, after);
		expect(lines).toContain('~ [1] Edit "Name": value "" → "Ann"');
		expect(lines.some((l) => l.startsWith("+ [") && l.includes('Button "Undo"'))).toBe(true);
		expect(lines.some((l) => l.startsWith("- [") && l.includes('Button "Submit"'))).toBe(true);
		expect(lines).toContain('+ Text "Saved"');
		expect(lines).toContain('- Text "Ready"');
		expect(diffModels(after, after)).toEqual([]);
	});

	test("a wholesale change is summarised, not listed", () => {
		const ids = new ElementIds();
		const before = parse(ids, state(Array.from({ length: 20 }, (_, i) => ({ role: "ListItem", label: `a${i}` }))));
		const after = parse(ids, state(Array.from({ length: 20 }, (_, i) => ({ role: "ListItem", label: `b${i}` }))));
		const lines = diffModels(before, after);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("40 changes");
	});

	test("targets are found exact first, then by prefix, substring and value", () => {
		const ids = new ElementIds();
		const model = parse(ids, state([{ role: "Button", label: "Save As" }, { role: "Button", label: "Save" }, { role: "Edit", label: "File", value: "save.txt" }, { role: "MenuItem", label: "Autosave" }]));
		const tiers = findElements(model, { text: "save" });
		expect(tiers[0].map((e) => e.label)).toEqual(["Save"]);
		expect(tiers[1].map((e) => e.label)).toEqual(["Save As"]);
		expect(tiers[2].map((e) => e.label)).toEqual(["Autosave"]);
		expect(tiers[3].map((e) => e.label)).toEqual(["File"]);
		expect(findElements(model, { text: "save", role: "menuitem" })[2].map((e) => e.label)).toEqual(["Autosave"]);
	});

	test("an element's centre is given relative to its window", () => {
		const ids = new ElementIds();
		const model = parse(ids, state([{ role: "Button", label: "Go" }]));
		expect(centreInWindow(model, model.elements[0])).toEqual({ x: 50, y: 25 });
	});
});

group("input strategy", () => {
	test("frameworks are read from the window class", () => {
		expect(frameworkOf("WindowsForms10.Window.8.app.0.1929836_r14_ad1")).toBe("classic");
		expect(frameworkOf("#32770")).toBe("classic");
		expect(frameworkOf("HwndWrapper[App;;1234]")).toBe("xaml");
		expect(frameworkOf("ApplicationFrameWindow")).toBe("xaml");
		expect(frameworkOf("Chrome_WidgetWin_1")).toBe("web");
		expect(frameworkOf("OrpheusBrowserHost")).toBe("web");
		expect(frameworkOf("Qt5152QWindowIcon")).toBe("unknown");
	});

	const element = (role: string, label = "x") => ({ id: 1, index: 0, role, label, enabled: true, actions: ["invoke"] });

	test("a button in a classic app gets real input; a checkbox stays in the background", () => {
		expect(clickRoute(element("Button"), { framework: "classic", blocked: false })).toBe("foreground");
		expect(clickRoute(element("CheckBox"), { framework: "classic", blocked: false })).toBe("background");
		expect(clickRoute(element("Button"), { framework: "xaml", blocked: false })).toBe("background");
		expect(clickRoute(element("Button"), { framework: "unknown", blocked: false })).toBe("guarded");
		expect(clickRoute(element("CheckBox"), { framework: "xaml", blocked: true })).toBe("foreground");
	});

	test("in a web UI, real controls take their default action and plain elements get a real click", () => {
		const web = { framework: "web" as const, blocked: false };
		expect(clickRoute(element("Button"), web)).toBe("background");
		expect(clickRoute(element("Hyperlink"), web)).toBe("background");
		// A song title, a card, an icon: script handlers that only a real click reaches.
		expect(clickRoute(element("Text", "希望有羽毛和翅膀"), web)).toBe("foreground");
		expect(clickRoute(element("Image"), web)).toBe("foreground");
		expect(clickRoute(element("Group"), web)).toBe("foreground");
	});

	test("double and right clicks are pointer gestures everywhere", () => {
		expect(clickRoute(element("ListItem"), { framework: "xaml", blocked: false }, { count: 2 })).toBe("foreground");
		expect(clickRoute(element("Button"), { framework: "web", blocked: false }, { button: "right" })).toBe("foreground");
	});

	test("keys and typing are real input in every toolkit", () => {
		for (const framework of ["classic", "xaml", "web", "unknown"] as const) expect(keyRoute({ framework, blocked: false })).toBe("foreground");
	});

	test("key names are taken as models write them", () => {
		expect(normalizeKey("Enter")).toBe("return");
		expect(normalizeKey(" Esc ")).toBe("escape");
		expect(normalizeKey("Control")).toBe("ctrl");
		expect(normalizeKey("f5")).toBe("f5");
	});

	test("element lines lose ids and pattern lists but keep values", () => {
		expect(compactAttributes(' [value="orpheus://app.html" id=7013648 actions=[set_value,text,scroll]]')).toBe(' [value="orpheus://app.html"]');
		expect(compactAttributes(" [actions=[invoke]]")).toBe("");
		expect(compactAttributes(' "Save" [id=save actions=[invoke]]')).toBe(' "Save"');
	});

	test("a background miss is recognised from the driver's error", () => {
		expect(needsForeground("background_unavailable", "")).toBe(true);
		expect(needsForeground(undefined, 'If it didn\'t land, retry with delivery_mode: "foreground".')).toBe(true);
		expect(needsForeground("window_target_not_found", "gone")).toBe(false);
	});
});
