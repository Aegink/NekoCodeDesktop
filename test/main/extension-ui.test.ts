import { describe, expect, test } from "bun:test";
import { ExtensionUiHost, plainTheme, stripAnsi } from "../../src/main/extension-ui";

function host() {
	const notices: Array<{ level: string; text: string }> = [];
	let changes = 0;
	const ui = new ExtensionUiHost({
		onChange: () => {
			changes++;
		},
		onNotify: (level, text) => notices.push({ level, text }),
	});
	return { ui, ctx: ui.context(), notices, changes: () => changes };
}

describe("extension dialogs", () => {
	test("a select waits on the snapshot and resolves with the extension's own option", async () => {
		const { ui, ctx } = host();
		const pending = ctx.select("\u001b[1mPick\u001b[0m", ["\u001b[32mone\u001b[39m", "two"]);
		const dialog = ui.snapshot()?.dialog;
		expect(dialog).toMatchObject({ kind: "select", title: "Pick", options: ["one", "two"] });
		ui.answer({ id: dialog!.id, value: "one" });
		expect(await pending).toBe("\u001b[32mone\u001b[39m");
		expect(ui.snapshot()).toBeUndefined();
	});

	test("dialogs queue, and only the oldest is shown", async () => {
		const { ui, ctx } = host();
		const first = ctx.confirm("First", "really?");
		const second = ctx.input("Second", "name");
		const snapshot = ui.snapshot()!;
		expect(snapshot.dialog).toMatchObject({ kind: "confirm", title: "First", message: "really?" });
		expect(snapshot.queued).toBe(1);
		ui.answer({ id: snapshot.dialog!.id, confirmed: true });
		expect(await first).toBe(true);
		const next = ui.snapshot()!.dialog!;
		expect(next).toMatchObject({ kind: "input", placeholder: "name" });
		ui.answer({ id: next.id, value: "neko" });
		expect(await second).toBe("neko");
	});

	test("cancelling gives each kind its empty answer", async () => {
		const { ui, ctx } = host();
		const confirm = ctx.confirm("c", "m");
		ui.answer({ id: ui.snapshot()!.dialog!.id, cancelled: true });
		expect(await confirm).toBe(false);
		const input = ctx.input("i");
		ui.answer({ id: ui.snapshot()!.dialog!.id, cancelled: true });
		expect(await input).toBeUndefined();
	});

	test("a timeout or an abort settles the dialog without an answer", async () => {
		const { ui, ctx } = host();
		expect(await ctx.select("t", ["a"], { timeout: 5 })).toBeUndefined();
		const controller = new AbortController();
		const aborted = ctx.confirm("a", "b", { signal: controller.signal });
		controller.abort();
		expect(await aborted).toBe(false);
		expect(ui.snapshot()).toBeUndefined();
	});

	test("reset answers every open dialog so no extension waits forever", async () => {
		const { ui, ctx } = host();
		const one = ctx.select("x", ["a"]);
		const two = ctx.editor("y", "prefill");
		ui.reset();
		expect(await one).toBeUndefined();
		expect(await two).toBeUndefined();
	});

	test("stale answers are ignored", () => {
		const { ui, ctx } = host();
		void ctx.confirm("c", "m");
		ui.answer({ id: "nope", confirmed: true });
		expect(ui.snapshot()?.dialog?.title).toBe("c");
	});

	test("after dispose, dialogs answer at once", async () => {
		const { ui, ctx } = host();
		ui.dispose();
		expect(await ctx.confirm("c", "m")).toBe(false);
	});
});

describe("extension status and widgets", () => {
	test("status lines are set, replaced and cleared by key", () => {
		const { ui, ctx } = host();
		ctx.setStatus("git", "\u001b[33mmain\u001b[0m");
		ctx.setStatus("lint", "ok");
		ctx.setStatus("git", "dev");
		expect(ui.snapshot()?.statuses).toEqual([
			{ key: "git", text: "dev" },
			{ key: "lint", text: "ok" },
		]);
		ctx.setStatus("git", undefined);
		ctx.setStatus("lint", "");
		expect(ui.snapshot()).toBeUndefined();
	});

	test("text widgets show; component factories are skipped", () => {
		const { ui, ctx } = host();
		ctx.setWidget("todo", ["a", "b"], { placement: "belowEditor" });
		ctx.setWidget("fancy", (() => ({})) as never);
		expect(ui.snapshot()?.widgets).toEqual([{ key: "todo", lines: ["a", "b"], placement: "belowEditor" }]);
		ctx.setWidget("todo", undefined);
		expect(ui.snapshot()).toBeUndefined();
	});

	test("notify becomes a notice, without escapes", () => {
		const { ctx, notices } = host();
		ctx.notify("\u001b[31mbroke\u001b[0m", "error");
		ctx.notify("   ");
		expect(notices).toEqual([{ level: "error", text: "broke" }]);
	});

	test("editor text is offered once and taken back when the composer applies it", () => {
		const { ui, ctx } = host();
		ctx.setEditorText("hello");
		const editor = ui.snapshot()!.editor!;
		expect(editor).toMatchObject({ text: "hello", mode: "replace" });
		expect(ctx.getEditorText()).toBe("hello");
		ui.answer({ id: editor.id });
		expect(ui.snapshot()).toBeUndefined();
		ctx.pasteToEditor(" world");
		expect(ui.snapshot()!.editor).toMatchObject({ text: " world", mode: "insert" });
		expect(ctx.getEditorText()).toBe("hello world");
	});

	test("the theme styles nothing", () => {
		const { ctx } = host();
		expect(ctx.theme.fg("accent", "text")).toBe("text");
		expect(ctx.theme.bold("b")).toBe("b");
		expect(plainTheme.bg("selectedBg", "x")).toBe("x");
	});
});

test("stripAnsi removes colour and OSC sequences", () => {
	expect(stripAnsi("\u001b[1;31mred\u001b[0m \u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toBe("red link");
});
