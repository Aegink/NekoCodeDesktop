import fs from "node:fs";
import { open } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

/**
 * Let a read-only file handle be flushed on Windows, as it can be elsewhere.
 *
 * POSIX `fsync` works on any descriptor; Windows' `FlushFileBuffers` needs
 * write access, so Node fails `sync()` on a handle opened with `"r"` with
 * EPERM. Plugins written on macOS or Linux do exactly that — write a file,
 * reopen it read-only, sync, rename — and every such write then fails on
 * Windows. A read-only handle has nothing of its own waiting to be flushed:
 * the data went through another handle, and the OS writes it back as usual. So
 * EPERM from a flush is answered as the no-op it is on other platforms, and
 * every other error still throws.
 *
 * Patched before pi loads, process-wide, because plugins run in this process
 * and reach for whichever `fs` they like.
 */
let installed: Promise<void> | null = null;

export function installWindowsFsyncCompat(platform: NodeJS.Platform = process.platform): Promise<void> {
	if (platform !== "win32") return Promise.resolve();
	installed ??= install();
	return installed;
}

function isFlushDenied(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
}

async function install(): Promise<void> {
	// FileHandle is not exported; its prototype is reached through an instance.
	const handle = await open(process.execPath, "r");
	const proto = Object.getPrototypeOf(handle) as Record<"sync" | "datasync", (...args: unknown[]) => Promise<void>>;
	await handle.close();
	for (const name of ["sync", "datasync"] as const) {
		const original = proto[name];
		proto[name] = async function (this: unknown, ...args: unknown[]) {
			try {
				await original.apply(this, args);
			} catch (error) {
				if (!isFlushDenied(error)) throw error;
			}
		};
	}

	for (const name of ["fsyncSync", "fdatasyncSync"] as const) {
		const original = fs[name];
		fs[name] = ((fd: number) => {
			try {
				original(fd);
			} catch (error) {
				if (!isFlushDenied(error)) throw error;
			}
		}) as typeof original;
	}
	for (const name of ["fsync", "fdatasync"] as const) {
		const original = fs[name];
		fs[name] = ((fd: number, callback: fs.NoParamCallback) =>
			original(fd, (error) => callback(error && !isFlushDenied(error) ? error : null))) as typeof original;
	}
	// ES module imports of `node:fs` read their own copy of the exports.
	syncBuiltinESMExports();
}
