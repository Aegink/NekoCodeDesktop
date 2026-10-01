import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CUSTOM_PROMPTS } from "../../src/shared/prompts";
import { PromptStore } from "../../src/main/prompt-store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-prompts-"));
	dirs.push(dir);
	return dir;
}

describe("PromptStore", () => {
	test("starts on the default prompt with nothing custom", () => {
		const store = new PromptStore(tmp());
		expect(store.snapshot()).toEqual({ activeId: null, prompts: [] });
		expect(store.activeContent()).toBeNull();
	});

	test("adding a prompt does not put it in use unless asked", () => {
		const store = new PromptStore(tmp());
		const added = store.save({ name: "Reviewer", content: "Review code." });
		expect(added.activeId).toBeNull();
		expect(added.prompts).toMatchObject([{ name: "Reviewer", content: "Review code." }]);
		const used = store.save({ name: "Writer", content: "Write code.", activate: true });
		expect(store.activeContent()).toBe("Write code.");
		expect(used.activeId).toBe(used.prompts[1].id);
	});

	test("choices survive a restart", () => {
		const dir = tmp();
		const { prompts } = new PromptStore(dir).save({ name: "A", content: "aaa", activate: true });
		const reopened = new PromptStore(dir);
		expect(reopened.snapshot().activeId).toBe(prompts[0].id);
		expect(reopened.activeContent()).toBe("aaa");
	});

	test("editing keeps the id and the choice", () => {
		let clock = 1;
		const store = new PromptStore(tmp(), () => clock);
		const [created] = store.save({ name: "A", content: "old", activate: true }).prompts;
		clock = 5;
		const [edited] = store.save({ id: created.id, name: "A2", content: "new" }).prompts;
		expect(edited).toEqual({ id: created.id, name: "A2", content: "new", createdAt: 1, updatedAt: 5 });
		expect(store.activeContent()).toBe("new");
	});

	test("going back to the default prompt, and removing the one in use", () => {
		const store = new PromptStore(tmp());
		const [a] = store.save({ name: "A", content: "a", activate: true }).prompts;
		store.setActive(null);
		expect(store.activeContent()).toBeNull();
		store.setActive(a.id);
		expect(store.remove(a.id)).toEqual({ activeId: null, prompts: [] });
		expect(store.activeContent()).toBeNull();
	});

	test("refuses empty, unknown and too many", () => {
		const store = new PromptStore(tmp());
		expect(() => store.save({ name: " ", content: "x" })).toThrow();
		expect(() => store.save({ name: "x", content: "  " })).toThrow();
		expect(() => store.save({ id: "missing", name: "x", content: "y" })).toThrow();
		expect(() => store.setActive("missing")).toThrow();
		for (let i = 0; i < MAX_CUSTOM_PROMPTS; i++) store.save({ name: `p${i}`, content: "c" });
		expect(() => store.save({ name: "one more", content: "c" })).toThrow();
	});

	test("a hand-edited file is read defensively", () => {
		const dir = tmp();
		writeFileSync(
			join(dir, "prompts.json"),
			JSON.stringify({
				version: 2,
				activeId: "gone",
				prompts: [{ id: "a", name: "A", content: "ok" }, { id: "a", name: "dup", content: "x" }, { id: "b", name: "", content: "x" }, "junk"],
			}),
		);
		const store = new PromptStore(dir);
		expect(store.snapshot().activeId).toBeNull();
		expect(store.snapshot().prompts.map((prompt) => prompt.name)).toEqual(["A"]);
	});
});
