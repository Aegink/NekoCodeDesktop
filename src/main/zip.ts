import { inflateRawSync } from "node:zlib";

/**
 * Just enough of the zip format to open a `.vsix`: the central directory,
 * stored and deflated entries. A `.vsix` is a plain zip, and pulling in a
 * dependency to read one would be more code than this.
 *
 * Zip64 archives (over 4 GB, or over 65535 entries) are refused; no extension
 * package comes near either.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
/** The end record sits in the last 22 bytes, plus a comment of up to 64 KB. */
const END_SEARCH_WINDOW = 22 + 0xffff;

export interface ZipEntry {
	/** `/`-separated, as stored. */
	name: string;
	isDirectory: boolean;
	size: number;
	read(): Buffer;
}

export interface ZipLimits {
	/** Largest total of uncompressed sizes accepted — a guard against zip bombs. */
	maxTotalBytes: number;
	maxEntries: number;
}

const DEFAULT_LIMITS: ZipLimits = { maxTotalBytes: 512 * 1024 * 1024, maxEntries: 20_000 };

/** A path inside an archive that could land outside the folder it is extracted to. */
export function isUnsafeZipPath(name: string): boolean {
	const normalized = name.replace(/\\/g, "/");
	return (
		normalized.startsWith("/") ||
		/^[a-zA-Z]:/.test(normalized) ||
		normalized.split("/").some((segment) => segment === "..") ||
		normalized.includes("\0")
	);
}

export function readZip(buffer: Buffer, limits: ZipLimits = DEFAULT_LIMITS): ZipEntry[] {
	const searchFrom = Math.max(0, buffer.length - END_SEARCH_WINDOW);
	let end = -1;
	for (let at = buffer.length - 22; at >= searchFrom; at--) {
		if (buffer.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
			end = at;
			break;
		}
	}
	if (end < 0) throw new Error("Not a zip archive");
	const count = buffer.readUInt16LE(end + 10);
	const directorySize = buffer.readUInt32LE(end + 12);
	const directoryOffset = buffer.readUInt32LE(end + 16);
	if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error("Zip64 archives are not supported");
	if (count > limits.maxEntries) throw new Error("Too many entries in archive");
	if (directoryOffset + directorySize > buffer.length) throw new Error("Truncated zip archive");

	const entries: ZipEntry[] = [];
	let total = 0;
	let at = directoryOffset;
	for (let index = 0; index < count; index++) {
		if (buffer.readUInt32LE(at) !== CENTRAL_DIRECTORY_ENTRY) throw new Error("Corrupt zip directory");
		const flags = buffer.readUInt16LE(at + 8);
		const method = buffer.readUInt16LE(at + 10);
		const compressedSize = buffer.readUInt32LE(at + 20);
		const size = buffer.readUInt32LE(at + 24);
		const nameLength = buffer.readUInt16LE(at + 28);
		const extraLength = buffer.readUInt16LE(at + 30);
		const commentLength = buffer.readUInt16LE(at + 32);
		const localOffset = buffer.readUInt32LE(at + 42);
		// Bit 11: the name is UTF-8. Without it the name is CP437, which for the
		// ASCII names a package uses reads the same.
		const name = buffer.toString(flags & 0x800 ? "utf8" : "latin1", at + 46, at + 46 + nameLength);
		at += 46 + nameLength + extraLength + commentLength;

		if (flags & 0x1) throw new Error(`Encrypted zip entry: ${name}`);
		total += size;
		if (total > limits.maxTotalBytes) throw new Error("Archive expands past the size limit");

		entries.push({
			name,
			isDirectory: name.endsWith("/"),
			size,
			read: () => {
				if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) throw new Error(`Corrupt zip entry: ${name}`);
				const localNameLength = buffer.readUInt16LE(localOffset + 26);
				const localExtraLength = buffer.readUInt16LE(localOffset + 28);
				const dataStart = localOffset + 30 + localNameLength + localExtraLength;
				const data = buffer.subarray(dataStart, dataStart + compressedSize);
				if (method === 0) return Buffer.from(data);
				if (method === 8) {
					const inflated = inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
					if (inflated.length !== size) throw new Error(`Size mismatch in zip entry: ${name}`);
					return inflated;
				}
				throw new Error(`Unsupported compression in zip entry ${name}: method ${method}`);
			},
		});
	}
	return entries;
}
