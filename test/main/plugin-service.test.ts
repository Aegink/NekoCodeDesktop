import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { PluginService } from "../../src/main/plugin-service";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function statePath(enabled: string[] = []): string {
	const dir = mkdtempSync(join(tmpdir(), "neko-plugins-"));
	dirs.push(dir);
	const path = join(dir, "plugins.json");
	writeFileSync(path, JSON.stringify({ enabled }));
	return path;
}

function loaded(
	entries: Array<{ source: string; origin: "package" | "top-level"; tools: string[]; commands?: string[] }>,
): LoadExtensionsResult {
	return {
		extensions: entries.map((entry, index) => ({
			path: `/ext/${index}.ts`,
			sourceInfo: { path: `/ext/${index}.ts`, source: entry.source, scope: "user", origin: entry.origin },
			tools: new Map(entry.tools.map((name) => [name, {}])),
			commands: new Map((entry.commands ?? []).map((name) => [name, {}])),
		})),
		errors: [],
	} as unknown as LoadExtensionsResult;
}

test("loose extensions' tools are always callable; a package's only once enabled", () => {
	const service = new PluginService({ statePath: statePath(["npm:on"]), onChange: () => undefined });
	const extensions = loaded([
		{ source: "auto", origin: "top-level", tools: ["loose_auto"] },
		{ source: "local", origin: "top-level", tools: ["loose_local"] },
		{ source: "npm:on", origin: "package", tools: ["on_tool"] },
		{ source: "npm:off", origin: "package", tools: ["off_tool"] },
	]);
	expect(service.enabledTools(extensions).sort()).toEqual(["loose_auto", "loose_local", "on_tool"]);
});

test("every service over one state file sees the same enabled set", () => {
	const path = statePath();
	const a = new PluginService({ statePath: path, onChange: () => undefined });
	const b = new PluginService({ statePath: path, onChange: () => undefined });
	a.setEnabled({ source: "npm:x", scope: "user", enabled: true });
	expect(b.isEnabled("npm:x")).toBe(true);
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: ["npm:x"] });
	b.setEnabled({ source: "npm:x", scope: "user", enabled: false });
	expect(a.isEnabled("npm:x")).toBe(false);
});

test("the list reports local extensions apart from packages", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "neko-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "neko-cwd-"));
	dirs.push(agentDir, cwd);
	const service = new PluginService({ statePath: statePath(), onChange: () => undefined, agentDir });
	const snapshot = await service.list(
		cwd,
		loaded([{ source: "auto", origin: "top-level", tools: ["t"], commands: ["hello"] }]),
	);
	expect(snapshot.plugins).toEqual([]);
	expect(snapshot.local).toEqual([{ path: "/ext/0.ts", scope: "user", tools: ["t"], commands: ["hello"] }]);
});
