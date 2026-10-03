import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installWindowsFsyncCompat } from "../../src/main/windows-fsync";

const dir = mkdtempSync(join(tmpdir(), "neko-fsync-"));
const file = join(dir, "data.txt");
writeFileSync(file, "x");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("off Windows nothing is patched", async () => {
	const before = fs.fsyncSync;
	await installWindowsFsyncCompat("linux");
	expect(fs.fsyncSync).toBe(before);
});

describe.if(process.platform === "win32")("on Windows", () => {
	test("a read-only handle can be flushed, as plugins written elsewhere expect", async () => {
		await installWindowsFsyncCompat();
		const handle = await open(file, "r");
		try {
			await handle.sync();
			await handle.datasync();
		} finally {
			await handle.close();
		}
		const fd = fs.openSync(file, "r");
		try {
			fs.fsyncSync(fd);
			await new Promise<void>((resolve, reject) => fs.fsync(fd, (error) => (error ? reject(error) : resolve())));
		} finally {
			fs.closeSync(fd);
		}
	});

	test("other errors still throw", async () => {
		await installWindowsFsyncCompat();
		const fd = fs.openSync(file, "r");
		fs.closeSync(fd);
		expect(() => fs.fsyncSync(fd)).toThrow();
	});
});
