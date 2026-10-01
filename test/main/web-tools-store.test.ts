import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSearxngUrl, WebToolsStore } from "../../src/main/web-tools-store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-web-tools-"));
	dirs.push(dir);
	return dir;
}

function fakeEncryption(available = true) {
	return {
		isEncryptionAvailable: () => available,
		getSelectedStorageBackend: () => "kwallet6" as const,
		encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
		decryptString: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
	};
}

describe("WebToolsStore", () => {
	test("starts enabled on the keyless engines", () => {
		const store = new WebToolsStore(tmp(), fakeEncryption());
		expect(store.status()).toEqual({
			enabled: true,
			provider: "duckduckgo",
			keys: {
				tavily: false,
				bocha: false,
				zhipu: false,
				exa: false,
				brave: false,
				jina: false,
				perplexity: false,
				kagi: false,
				firecrawl: false,
			},
			accounts: { codex: false, gemini: false },
			searxngUrl: null,
			canStoreKeys: true,
		});
	});

	test("keeps keys encrypted on disk and out of the status", () => {
		const dir = tmp();
		const store = new WebToolsStore(dir, fakeEncryption());
		const status = store.update({ provider: "brave", keys: { brave: "  BSA-secret  " } });
		expect(status.keys.brave).toBe(true);
		expect(JSON.stringify(status)).not.toContain("BSA-secret");
		expect(readFileSync(join(dir, "web-tools.json"), "utf8")).not.toContain("BSA-secret");
		// A fresh store reads it back from disk.
		expect(new WebToolsStore(dir, fakeEncryption()).settings()).toEqual({
			enabled: true,
			provider: "brave",
			searxngUrl: null,
			keys: { brave: "BSA-secret" },
		});
	});

	test("an absent key is left alone and an empty one removes it", () => {
		const store = new WebToolsStore(tmp(), fakeEncryption());
		store.update({ keys: { exa: "exa-key" } });
		store.update({ enabled: false });
		expect(store.settings().keys).toEqual({ exa: "exa-key" });
		store.update({ keys: { exa: "" } });
		expect(store.settings().keys).toEqual({});
		expect(store.status().enabled).toBe(false);
	});

	test("refuses to save a key without a keyring, and bad input", () => {
		const store = new WebToolsStore(tmp(), fakeEncryption(false));
		expect(store.status().canStoreKeys).toBe(false);
		expect(() => store.update({ keys: { tavily: "k" } })).toThrow("keyring");
		expect(() => store.update({ provider: "google" as never })).toThrow("Unknown search provider");
		expect(() => store.update({ searxngUrl: "ftp://x" })).toThrow("http or https");
	});

	test("normalizes a SearXNG address", () => {
		expect(normalizeSearxngUrl("searx.example.org")).toBe("https://searx.example.org/");
		expect(normalizeSearxngUrl("http://localhost:8888/searx")).toBe("http://localhost:8888/searx");
		expect(normalizeSearxngUrl("  ")).toBeNull();
	});
});
