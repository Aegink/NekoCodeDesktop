import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkFile, isIndexable, looksMinified } from "../../../src/main/semantic-index/chunker";
import { EXPAND_SYSTEM, parseRanking, parseTerms, rerankPrompt } from "../../../src/main/semantic-index/assist";
import { fuseRankings, indexChunk, ProjectIndex, rankLexical, termCount, TermDictionary, withinScope } from "../../../src/main/semantic-index/project-index";
import { SemanticIndexService } from "../../../src/main/semantic-index/service";
import { splitIdentifier, tokenize } from "../../../src/main/semantic-index/tokenize";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "nekocode-index-"));
	dirs.push(dir);
	return dir;
}

function project(files: Record<string, string>): string {
	const root = tmp();
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

/** A listing that does not depend on git, so a temp directory works. */
const listOf = (files: Record<string, string>) => async () => Object.keys(files);

describe("tokenize", () => {
	test("splits identifiers at case, separators and digits", () => {
		expect(splitIdentifier("parseHTTPResponse2")).toEqual(["parse", "http", "response", "2"]);
		expect(splitIdentifier("MAX_FILE_BYTES")).toEqual(["max", "file", "bytes"]);
	});

	test("keeps compounds whole, stems plurals and drops stopwords", () => {
		const terms = tokenize("function loadSessions(the_files) { return sessions; }");
		expect(terms).toContain("load");
		expect(terms).toContain("session");
		expect(terms).toContain("loadsessions");
		expect(terms).toContain("file");
		expect(terms).not.toContain("function");
		expect(terms).not.toContain("the");
	});

	test("cuts Han text into overlapping pairs", () => {
		expect(tokenize("会话标题")).toEqual(["会话", "话标", "标题"]);
	});
});

describe("chunkFile", () => {
	test("cuts at declarations and names each chunk after its symbol", () => {
		const body = (name: string) =>
			[`export function ${name}() {`, ...Array.from({ length: 14 }, (_, i) => `\tconst v${i} = ${i};`), "}", ""].join("\n");
		const chunks = chunkFile("src/a.ts", body("alpha") + body("beta") + body("gamma"));
		expect(chunks.map((chunk) => chunk.symbol)).toEqual(["alpha", "beta", "gamma"]);
		expect(chunks[0].startLine).toBe(1);
		expect(chunks[1].startLine).toBe(17);
		expect(chunks[2].endLine).toBe(48);
	});

	test("merges small declarations instead of cutting a chunk per line", () => {
		const text = Array.from({ length: 30 }, (_, i) => `export const c${i} = ${i};`).join("\n");
		const chunks = chunkFile("src/consts.ts", text);
		expect(chunks.length).toBeLessThanOrEqual(3);
	});

	test("hard-cuts a block too long to keep whole", () => {
		const text = ["function huge() {", ...Array.from({ length: 300 }, (_, i) => `\tcall(${i});`), "}"].join("\n");
		const chunks = chunkFile("src/huge.js", text);
		expect(chunks.length).toBeGreaterThan(2);
		for (const chunk of chunks) expect(chunk.endLine - chunk.startLine).toBeLessThan(121);
		// Every line is covered exactly once.
		expect(chunks[0].startLine).toBe(1);
		for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
		expect(chunks[chunks.length - 1].endLine).toBe(302);
	});

	test("the same text keeps the same hash, an edit changes it", () => {
		const a = chunkFile("x.py", "def f():\n    return 1\n")[0];
		const b = chunkFile("x.py", "def f():\n    return 1\n")[0];
		const c = chunkFile("x.py", "def f():\n    return 2\n")[0];
		expect(a.hash).toBe(b.hash);
		expect(a.hash).not.toBe(c.hash);
	});

	test("picks the files worth reading", () => {
		expect(isIndexable("src/app.tsx")).toBe(true);
		expect(isIndexable("Dockerfile")).toBe(true);
		expect(isIndexable("bun.lock")).toBe(false);
		expect(isIndexable("dist/app.min.js")).toBe(false);
		expect(isIndexable("assets/logo.png")).toBe(false);
		expect(looksMinified("x".repeat(5_000))).toBe(true);
		expect(looksMinified("short\nlines\n".repeat(500))).toBe(false);
	});
});

describe("ranking", () => {
	const dictionary = new TermDictionary();
	const chunks = [
		{ path: "src/auth/session.ts", text: "export function expireSessions(store) { store.deleteExpired(); }" },
		{ path: "src/http/retry.ts", text: "export async function withRetry(request, attempts) { backoff(); }" },
		{ path: "README.md", text: "How to install the project and run it." },
	].map((entry, i) => indexChunk({ ...entry, startLine: 1, endLine: 1, symbol: null, hash: String(i) }, dictionary));

	test("stores each chunk's terms as sorted ids with their counts", () => {
		const chunk = indexChunk({ path: "a.ts", text: "retry retry retry backoff", startLine: 1, endLine: 1, symbol: null, hash: "x" }, dictionary);
		expect([...chunk.termIds]).toEqual([...chunk.termIds].sort((a, b) => a - b));
		expect(termCount(chunk, dictionary.lookup("retry")!)).toBe(3);
		expect(termCount(chunk, dictionary.lookup("backoff")!)).toBe(1);
		expect(termCount(chunk, dictionary.lookup("install")!)).toBe(0);
	});

	test("BM25 puts the chunk that shares the query's words first", () => {
		const ranked = rankLexical(chunks, "where are expired sessions deleted", 3, dictionary);
		expect(ranked[0].chunk.path).toBe("src/auth/session.ts");
		expect(rankLexical(chunks, "retry with backoff", 3, dictionary)[0].chunk.path).toBe("src/http/retry.ts");
		expect(rankLexical(chunks, "zzz", 3, dictionary)).toEqual([]);
	});

	test("fusion rewards agreement and caps chunks per file", () => {
		const [a, b, c] = chunks;
		const fused = fuseRankings([[{ chunk: a, score: 1 }, { chunk: b, score: 0.5 }], [{ chunk: b, score: 1 }, { chunk: c, score: 0.5 }]], 3);
		expect(fused[0].chunk).toBe(b);
		const sameFile = [0, 1, 2, 3].map((i) => indexChunk({ path: "one.ts", text: `x${i}`, startLine: i, endLine: i, symbol: null, hash: `h${i}` }, dictionary));
		const other = indexChunk({ path: "two.ts", text: "y", startLine: 1, endLine: 1, symbol: null, hash: "y" }, dictionary);
		const page = fuseRankings([[...sameFile, other].map((chunk) => ({ chunk, score: 1 }))], 3);
		expect(page.map((entry) => entry.chunk.path)).toEqual(["one.ts", "one.ts", "two.ts"]);
	});

	test("scope narrows to a directory or a file", () => {
		expect(withinScope("src/a/b.ts", "src/a")).toBe(true);
		expect(withinScope("src/a/b.ts", "./src/a/")).toBe(true);
		expect(withinScope("src/ab/b.ts", "src/a")).toBe(false);
		expect(withinScope("src/a/b.ts", "src/a/b.ts")).toBe(true);
		expect(withinScope("x.ts", undefined)).toBe(true);
	});
});

describe("ProjectIndex", () => {
	test("indexes, then picks up edits and deletions", async () => {
		const files = { "src/billing.ts": "export function chargeInvoice(customer) { stripe.charge(customer); }\n", "notes.md": "Nothing here.\n" };
		const root = project(files);
		const listing = { ...files } as Record<string, string>;
		const index = new ProjectIndex(root, { listFiles: async () => Object.keys(listing) });
		await index.refresh();
		expect(index.fileCount).toBe(2);
		expect(index.lexical("charge invoice", 5)[0].chunk.path).toBe("src/billing.ts");

		writeFileSync(join(root, "src/billing.ts"), "export function refundOrder(order) { gateway.refund(order); }\n");
		await index.refresh();
		expect(index.lexical("charge invoice", 5)).toEqual([]);
		expect(index.lexical("refund order", 5)[0].chunk.path).toBe("src/billing.ts");

		delete listing["src/billing.ts"];
		await index.refresh();
		expect(index.fileCount).toBe(1);
		expect(index.lexical("refund", 5)).toEqual([]);
	});

	test("skips binary files and files it should not read", async () => {
		const files = { "a.ts": "const a = 1;\n", "b.ts": "binary\0data", "c.png": "x" };
		const index = new ProjectIndex(project(files), { listFiles: listOf(files) });
		await index.refresh();
		expect(index.chunks().map((chunk) => chunk.path)).toEqual(["a.ts"]);
	});
});

describe("search assistance", () => {
	test("reads search terms from JSON, or from a bare list", () => {
		expect(parseTerms('Sure:\n```json\n{"terms": ["purgeStaleSessions", "session_cleanup", "expire"]}\n```')).toEqual([
			"purgeStaleSessions",
			"session_cleanup",
			"expire",
		]);
		expect(parseTerms("- cleanupSessions\n- expiredAt, ttl")).toEqual(["cleanupSessions", "expiredAt", "ttl"]);
	});

	test("reads a ranking, dropping numbers out of range and repeats", () => {
		expect(parseRanking('{"ranked": [3, 1, 3, 9]}', 4)).toEqual([2, 0]);
		expect(parseRanking("The best are [2, 1].", 2)).toEqual([1, 0]);
		expect(parseRanking('{"ranked": []}', 4)).toEqual([]);
		expect(parseRanking("I cannot tell.", 4)).toBeNull();
	});

	test("numbers candidates with their location for the reranker", () => {
		const prompt = rerankPrompt("where are sessions purged", [
			{ path: "src/jobs.ts", startLine: 2, endLine: 4, symbol: "purgeStaleSessions", text: "export function purgeStaleSessions() {}" },
		]);
		expect(prompt).toStartWith("Question: where are sessions purged");
		expect(prompt).toContain("[1] src/jobs.ts:2-4 (purgeStaleSessions)\nexport function purgeStaleSessions() {}");
	});
});

describe("SemanticIndexService", () => {
	const files = {
		"src/jobs.ts": "/** Nightly maintenance. */\nexport function purgeStaleSessions(db) {\n\tdb.run('delete from sessions where last_seen < now() - 30');\n}\n",
		"src/net.ts": "export async function withBackoff(fn) {\n\tfor (let attempt = 0; ; attempt++) {\n\t\ttry { return await fn(); } catch { await sleep(2 ** attempt); }\n\t}\n}\n",
		"docs/sessions.md": "Sessions are kept for 30 days, then removed.\n",
	};

	/** A search model whose two answers the test decides. */
	function assistant(terms: string[], ranking: (prompt: string) => number[]) {
		const calls: string[] = [];
		return {
			calls,
			model: "p/fast",
			ask: async (system: string, prompt: string) => {
				calls.push(system === EXPAND_SYSTEM ? "expand" : "rerank");
				return system === EXPAND_SYSTEM ? JSON.stringify({ terms }) : JSON.stringify({ ranked: ranking(prompt) });
			},
		};
	}

	test("answers by keywords without a search model", async () => {
		const root = project(files);
		const service = new SemanticIndexService({ getAssistant: () => null });
		const result = await service.search(root, "purge stale sessions");
		expect(result).toMatchObject({ mode: "lexical", model: null, note: null });
		expect(result.hits[0].path).toBe("src/jobs.ts");
		expect(service.status(root)).toMatchObject({ state: "ready", files: 3 });
	});

	test("a Chinese question finds English code once the model rewrites it", async () => {
		const root = project(files);
		const plain = await new SemanticIndexService({ getAssistant: () => null }).search(root, "过期会话在哪里清理");
		expect(plain.hits).toEqual([]);

		const helper = assistant(["purgeStaleSessions", "sessions", "delete"], () => []);
		const result = await new SemanticIndexService({ getAssistant: () => helper }).search(root, "过期会话在哪里清理");
		expect(result.mode).toBe("assisted");
		expect(result.hits[0].path).toBe("src/jobs.ts");
		expect(helper.calls).toEqual(["expand", "rerank"]);
	});

	test("the reranker's picks come first, the rest keep their keyword order behind them", async () => {
		const root = project(files);
		// Put the snippet that mentions backoff first, whatever the keywords said.
		const helper = assistant(["sessions", "withBackoff"], (prompt) => {
			const numbered = [...prompt.matchAll(/^\[(\d+)\] (\S+):/gm)];
			return numbered.filter(([, , path]) => path === "src/net.ts").map(([, n]) => Number(n));
		});
		const result = await new SemanticIndexService({ getAssistant: () => helper }).search(root, "sessions");
		expect(result.hits[0].path).toBe("src/net.ts");
		expect(result.hits.map((hit) => hit.path)).toContain("src/jobs.ts");
	});

	test("falls back to keywords, with a note, when the model fails", async () => {
		const root = project(files);
		const broken = { model: "p/down", ask: async () => { throw new Error("HTTP 503"); } };
		const result = await new SemanticIndexService({ getAssistant: () => broken }).search(root, "purge stale sessions");
		expect(result.mode).toBe("lexical");
		expect(result.hits[0].path).toBe("src/jobs.ts");
		expect(result.note).toContain("query rewrite failed (HTTP 503)");
		expect(result.note).toContain("rerank failed (HTTP 503)");
	});

	test("lists files without git, through the walk", async () => {
		const root = project(files);
		const service = new SemanticIndexService({ getAssistant: () => null });
		await service.rebuild(root);
		expect(service.status(root).chunks).toBeGreaterThanOrEqual(3);
	});
});
