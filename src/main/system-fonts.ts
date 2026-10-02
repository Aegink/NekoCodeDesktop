/**
 * The fonts installed on this machine, for the appearance font pickers.
 *
 * The renderer's Local Font Access API only reports English family names, and
 * the point of the picker is to find 微软雅黑 or 思源黑体 by the name people
 * know them by. So the main process reads the name tables itself: a handful of
 * small reads per file, never the whole (often 20 MB) CJK font.
 */
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { mergeFontFamilies, readFontInfos, type FontInfo, type SystemFont } from "../shared/font-names";

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".otc"]);
const MAX_DEPTH = 4;
const CONCURRENCY = 16;

function fontDirectories(): string[] {
	const home = homedir();
	if (process.platform === "win32") {
		const windir = process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows";
		const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
		return [join(windir, "Fonts"), join(local, "Microsoft", "Windows", "Fonts")];
	}
	if (process.platform === "darwin") {
		return ["/System/Library/Fonts", "/Library/Fonts", join(home, "Library", "Fonts")];
	}
	return ["/usr/share/fonts", "/usr/local/share/fonts", join(home, ".local", "share", "fonts"), join(home, ".fonts")];
}

async function collectFontFiles(directory: string, depth: number, into: string[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (depth < MAX_DEPTH) await collectFontFiles(path, depth + 1, into);
		} else if (FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
			into.push(path);
		}
	}
}

async function readFontFile(path: string): Promise<FontInfo[]> {
	let handle;
	try {
		handle = await open(path, "r");
		const file = handle;
		return await readFontInfos(async (offset, length) => {
			const buffer = new Uint8Array(length);
			const { bytesRead } = await file.read(buffer, 0, length, offset);
			return buffer.subarray(0, bytesRead);
		});
	} catch {
		// Unreadable or malformed: leave it out rather than fail the whole list.
		return [];
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function scanSystemFonts(): Promise<SystemFont[]> {
	const files: string[] = [];
	for (const directory of fontDirectories()) await collectFontFiles(directory, 0, files);

	const infos: FontInfo[] = [];
	let next = 0;
	const worker = async () => {
		while (next < files.length) {
			const path = files[next++];
			infos.push(...(await readFontFile(path)));
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));

	// Vertical-writing faces (@SimSun) and hidden system faces (.SF NS) aren't pickable.
	return mergeFontFamilies(infos)
		.filter((font) => !font.family.startsWith("@") && !font.family.startsWith("."))
		.sort((left, right) => (left.localizedFamily ?? left.family).localeCompare(right.localizedFamily ?? right.family, "zh-CN"));
}

let cached: Promise<SystemFont[]> | null = null;

/** Scanned once per launch; `refresh` rescans after the user installs a font. */
export function listSystemFonts(refresh = false): Promise<SystemFont[]> {
	if (refresh || !cached) {
		cached = scanSystemFonts().catch((error) => {
			cached = null;
			throw error;
		});
	}
	return cached;
}
