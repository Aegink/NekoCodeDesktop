// Reads what the font pickers need straight out of an sfnt (TTF / OTF / TTC):
// the family name CSS matches on, its Chinese name if the font carries one, and
// whether it covers Chinese or is monospaced.
//
// It works against a random-access reader rather than a buffer so the main
// process can scan every installed font while reading only a few KB of each —
// CJK fonts routinely run past 20 MB.

export interface FontInfo {
	/** The family name CSS `font-family` matches (English / default record). */
	family: string;
	/** The family's Chinese name, when the font carries one that differs. */
	localizedFamily?: string;
	/** Declares Simplified or Traditional Chinese support. */
	chinese: boolean;
	monospace: boolean;
}

/** An installed font family, as listed to the renderer. */
export type SystemFont = FontInfo;

export type FontByteReader = (offset: number, length: number) => Promise<Uint8Array>;

const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */]);
const TTC_TAG = 0x74746366; // ttcf
const MAX_NAME_TABLE_BYTES = 1 << 20;
const MAX_COLLECTION_FONTS = 64;

// Windows language ids: zh-CN, zh-SG, then zh-TW, zh-HK, zh-MO.
const CHINESE_WINDOWS_LANGS = [0x0804, 0x1004, 0x0404, 0x0c04, 0x1404];
// Mac language ids: Simplified then Traditional Chinese.
const CHINESE_MAC_LANGS = [33, 19];
const CODE_PAGE_SIMPLIFIED_CHINESE = 1 << 18;
const CODE_PAGE_TRADITIONAL_CHINESE = 1 << 20;
const PANOSE_LATIN_TEXT = 2;
const PANOSE_MONOSPACED = 9;

interface NameRecord {
	platformId: number;
	encodingId: number;
	languageId: number;
	nameId: number;
	value: string;
}

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeUtf16Be(bytes: Uint8Array): string {
	let out = "";
	for (let index = 0; index + 1 < bytes.length; index += 2) {
		out += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
	}
	return out;
}

function decodeWith(label: string, bytes: Uint8Array): string | null {
	try {
		return new TextDecoder(label).decode(bytes);
	} catch {
		return null;
	}
}

function decodeNameRecord(platformId: number, encodingId: number, bytes: Uint8Array): string | null {
	// Unicode and Windows records are UTF-16BE (Windows symbol fonts included).
	if (platformId === 0 || platformId === 3) return decodeUtf16Be(bytes);
	if (platformId === 1) {
		if (encodingId === 0) return decodeWith("macintosh", bytes) ?? String.fromCharCode(...bytes);
		if (encodingId === 25) return decodeWith("gbk", bytes);
		if (encodingId === 2) return decodeWith("big5", bytes);
	}
	return null;
}

function parseNameTable(bytes: Uint8Array): NameRecord[] {
	if (bytes.length < 6) return [];
	const data = view(bytes);
	const count = data.getUint16(2);
	const stringOffset = data.getUint16(4);
	const records: NameRecord[] = [];
	for (let index = 0; index < count; index++) {
		const at = 6 + index * 12;
		if (at + 12 > bytes.length) break;
		const nameId = data.getUint16(at + 6);
		// Family (1), subfamily isn't needed, typographic family (16).
		if (nameId !== 1 && nameId !== 16) continue;
		const platformId = data.getUint16(at);
		const encodingId = data.getUint16(at + 2);
		const length = data.getUint16(at + 8);
		const start = stringOffset + data.getUint16(at + 10);
		if (start + length > bytes.length) continue;
		const value = decodeNameRecord(platformId, encodingId, bytes.subarray(start, start + length))
			?.replace(/\0/g, "")
			.trim();
		if (!value) continue;
		records.push({ platformId, encodingId, languageId: data.getUint16(at + 4), nameId, value });
	}
	return records;
}

function isEnglishRecord(record: NameRecord): boolean {
	if (record.platformId === 3) return (record.languageId & 0x3ff) === 0x09;
	if (record.platformId === 1) return record.languageId === 0;
	return record.platformId === 0;
}

function isChineseRecord(record: NameRecord): boolean {
	if (record.platformId === 3) return CHINESE_WINDOWS_LANGS.includes(record.languageId);
	if (record.platformId === 1) return CHINESE_MAC_LANGS.includes(record.languageId);
	return false;
}

function rankChinese(record: NameRecord): number {
	const list = record.platformId === 3 ? CHINESE_WINDOWS_LANGS : CHINESE_MAC_LANGS;
	return list.indexOf(record.languageId);
}

/**
 * Picks the family names. The typographic family (16) groups every weight under
 * one name, which is what Chromium matches; legacy fonts only have the RIBBI
 * family (1).
 */
export function pickFamilyNames(records: readonly NameRecord[]): { family: string; localizedFamily?: string } | null {
	const typographic = records.filter((record) => record.nameId === 16);
	const pool = typographic.length > 0 ? typographic : records.filter((record) => record.nameId === 1);
	if (pool.length === 0) return null;
	const english =
		pool.find((record) => record.platformId === 3 && record.languageId === 0x0409) ??
		pool.find(isEnglishRecord) ??
		pool.find((record) => !isChineseRecord(record)) ??
		pool[0];
	const chinese = pool
		.filter(isChineseRecord)
		.sort((left, right) => rankChinese(left) - rankChinese(right))[0];
	return chinese && chinese.value !== english.value
		? { family: english.value, localizedFamily: chinese.value }
		: { family: english.value };
}

async function readSfnt(read: FontByteReader, offset: number): Promise<FontInfo | null> {
	const header = await read(offset, 12);
	if (header.length < 12 || !SFNT_VERSIONS.has(view(header).getUint32(0))) return null;
	const numTables = view(header).getUint16(4);
	const directory = await read(offset + 12, numTables * 16);
	const tables = new Map<string, { offset: number; length: number }>();
	const dir = view(directory);
	for (let index = 0; index < numTables && (index + 1) * 16 <= directory.length; index++) {
		const at = index * 16;
		const tag = String.fromCharCode(directory[at], directory[at + 1], directory[at + 2], directory[at + 3]);
		tables.set(tag, { offset: dir.getUint32(at + 8), length: dir.getUint32(at + 12) });
	}

	const nameTable = tables.get("name");
	if (!nameTable) return null;
	const names = pickFamilyNames(
		parseNameTable(await read(nameTable.offset, Math.min(nameTable.length, MAX_NAME_TABLE_BYTES))),
	);
	if (!names) return null;

	let chinese = names.localizedFamily !== undefined;
	let monospace = false;
	const os2 = tables.get("OS/2");
	if (os2) {
		const bytes = await read(os2.offset, Math.min(os2.length, 86));
		const data = view(bytes);
		if (bytes.length >= 42 && bytes[32] === PANOSE_LATIN_TEXT && bytes[35] === PANOSE_MONOSPACED) monospace = true;
		if (bytes.length >= 82 && data.getUint16(0) >= 1) {
			const codePages = data.getUint32(78);
			if (codePages & (CODE_PAGE_SIMPLIFIED_CHINESE | CODE_PAGE_TRADITIONAL_CHINESE)) chinese = true;
		}
	}
	const post = tables.get("post");
	if (post && !monospace) {
		const bytes = await read(post.offset, 16);
		if (bytes.length >= 16 && view(bytes).getUint32(12) !== 0) monospace = true;
	}
	return { ...names, chinese, monospace };
}

/**
 * Every face in the file — one for a TTF/OTF, several for a collection.
 * Returns [] for anything that isn't an sfnt (WOFF/WOFF2 included).
 */
export async function readFontInfos(read: FontByteReader): Promise<FontInfo[]> {
	const header = await read(0, 12);
	if (header.length < 12) return [];
	const tag = view(header).getUint32(0);
	if (tag !== TTC_TAG) {
		const info = await readSfnt(read, 0);
		return info ? [info] : [];
	}
	const numFonts = Math.min(view(header).getUint32(8), MAX_COLLECTION_FONTS);
	const offsets = view(await read(12, numFonts * 4));
	const infos: FontInfo[] = [];
	for (let index = 0; index < numFonts && (index + 1) * 4 <= offsets.byteLength; index++) {
		const info = await readSfnt(read, offsets.getUint32(index * 4));
		if (info) infos.push(info);
	}
	return infos;
}

/** A reader over bytes already in memory. */
export function bufferReader(bytes: Uint8Array): FontByteReader {
	return async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length));
}

/** Collapses faces sharing a family (weights, collection members) into one entry. */
export function mergeFontFamilies(infos: Iterable<FontInfo>): FontInfo[] {
	const byFamily = new Map<string, FontInfo>();
	for (const info of infos) {
		const key = info.family.toLowerCase();
		const existing = byFamily.get(key);
		if (!existing) {
			byFamily.set(key, { ...info });
			continue;
		}
		existing.chinese ||= info.chinese;
		existing.monospace ||= info.monospace;
		existing.localizedFamily ??= info.localizedFamily;
	}
	return [...byFamily.values()];
}

/** The name to show: the Chinese one when there is one. */
export function fontDisplayName(font: FontInfo): string {
	return font.localizedFamily ?? font.family;
}
