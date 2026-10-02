// Font files the user imported in Settings → Appearance. The bytes live in
// IndexedDB and are registered with `document.fonts` on every launch, so an
// imported font works anywhere a font-family name does — the pickers, the CSS
// variables, Monaco and xterm — without being installed on the system.

import { bufferReader, readFontInfos, type FontInfo } from "../../../shared/font-names";

export interface ImportedFont extends FontInfo {
	id: string;
	fileName: string;
	size: number;
	addedAt: number;
}

interface StoredFont extends ImportedFont {
	data: ArrayBuffer;
}

export type FontImportErrorCode = "unsupported" | "tooLarge" | "invalid";

export class FontImportError extends Error {
	constructor(
		readonly code: FontImportErrorCode,
		readonly fileName: string,
	) {
		super(`${code}: ${fileName}`);
	}
}

export const IMPORTABLE_FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"] as const;
const SFNT_EXTENSIONS = new Set([".ttf", ".otf"]);
const MAX_FONT_BYTES = 64 * 1024 * 1024;
const DB_NAME = "nekocode-fonts";
const STORE = "fonts";

let fonts: readonly ImportedFont[] = [];
const faces = new Map<string, FontFace>();
let listeners: Array<() => void> = [];
let loaded: Promise<void> | null = null;

function emitChange() {
	for (const listener of listeners) listener();
}

export function subscribeImportedFonts(listener: () => void): () => void {
	listeners.push(listener);
	return () => {
		listeners = listeners.filter((current) => current !== listener);
	};
}

export function getImportedFonts(): readonly ImportedFont[] {
	return fonts;
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await openDb();
	try {
		return await new Promise<T>((resolve, reject) => {
			const transaction = db.transaction(STORE, mode);
			const request = run(transaction.objectStore(STORE));
			transaction.oncomplete = () => resolve(request.result);
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
	} finally {
		db.close();
	}
}

function metadata({ data: _data, ...font }: StoredFont): ImportedFont {
	return font;
}

async function createFace(family: string, data: ArrayBuffer): Promise<FontFace> {
	const face = new FontFace(family, data);
	await face.load();
	return face;
}

/** Registers every stored font. Runs once at startup; later calls share the first. */
export function loadImportedFonts(): Promise<void> {
	loaded ??= (async () => {
		let stored: StoredFont[];
		try {
			stored = await withStore("readonly", (store) => store.getAll() as IDBRequest<StoredFont[]>);
		} catch {
			return;
		}
		const ready: ImportedFont[] = [];
		for (const font of stored) {
			try {
				const face = await createFace(font.family, font.data);
				document.fonts.add(face);
				faces.set(font.id, face);
				ready.push(metadata(font));
			} catch {
				// A file the engine no longer accepts; keep it out of the list.
			}
		}
		fonts = ready.sort((left, right) => left.addedAt - right.addedAt);
		emitChange();
	})();
	return loaded;
}

function extensionOf(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

/**
 * Validates, registers and stores one font file. Re-importing a family replaces
 * the earlier file, so updating a font is just importing it again.
 */
export async function importFontFile(file: File): Promise<ImportedFont> {
	await loadImportedFonts();
	const extension = extensionOf(file.name);
	// Font collections (.ttc) are refused by the browser's font sanitizer.
	if (!(IMPORTABLE_FONT_EXTENSIONS as readonly string[]).includes(extension)) {
		throw new FontImportError("unsupported", file.name);
	}
	if (file.size > MAX_FONT_BYTES) throw new FontImportError("tooLarge", file.name);

	const data = await file.arrayBuffer();
	// WOFF/WOFF2 are compressed, so their name table can't be read without
	// inflating them; the file name stands in for the family.
	const infos = SFNT_EXTENSIONS.has(extension) ? await readFontInfos(bufferReader(new Uint8Array(data))) : [];
	const info: FontInfo = infos[0] ?? {
		family: file.name.slice(0, file.name.length - extension.length).trim() || file.name,
		chinese: false,
		monospace: false,
	};

	let face: FontFace;
	try {
		face = await createFace(info.family, data);
	} catch {
		throw new FontImportError("invalid", file.name);
	}

	const record: StoredFont = {
		...info,
		id: crypto.randomUUID(),
		fileName: file.name,
		size: file.size,
		addedAt: Date.now(),
		data,
	};
	const replaced = fonts.filter((font) => font.family.toLowerCase() === info.family.toLowerCase());
	await withStore("readwrite", (store) => {
		for (const old of replaced) store.delete(old.id);
		return store.put(record);
	});
	for (const old of replaced) {
		const oldFace = faces.get(old.id);
		if (oldFace) document.fonts.delete(oldFace);
		faces.delete(old.id);
	}
	document.fonts.add(face);
	faces.set(record.id, face);
	const font = metadata(record);
	fonts = [...fonts.filter((existing) => !replaced.includes(existing)), font];
	emitChange();
	return font;
}

export async function removeImportedFont(id: string): Promise<void> {
	await withStore("readwrite", (store) => store.delete(id));
	const face = faces.get(id);
	if (face) document.fonts.delete(face);
	faces.delete(id);
	fonts = fonts.filter((font) => font.id !== id);
	emitChange();
}

// Register imported fonts as early as possible so a saved custom font that is
// one of them paints on the first frame it can.
if (typeof indexedDB !== "undefined" && typeof document !== "undefined") {
	void loadImportedFonts();
}
