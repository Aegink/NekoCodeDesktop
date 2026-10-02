import {
	MAX_PROMPT_IMAGE_BYTES,
	type PromptImageAttachment,
} from "../../../../shared/agent";

export const SUPPORTED_PROMPT_IMAGE_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/bmp",
]);

const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
};

export function imageMimeType(file: Pick<File, "name" | "type">): string | null {
	const declared = file.type.trim().toLowerCase();
	if (declared) {
		const normalized = declared === "image/jpg" ? "image/jpeg" : declared;
		return SUPPORTED_PROMPT_IMAGE_TYPES.has(normalized) ? normalized : null;
	}
	const extension = /\.([a-z0-9]+)$/.exec(file.name.trim().toLowerCase())?.[1];
	return extension ? (EXTENSION_MIME_TYPES[extension] ?? null) : null;
}

function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	}
	return btoa(binary);
}

export async function fileToPromptImage(file: File): Promise<PromptImageAttachment> {
	const name = file.name.trim();
	if (name.length === 0 || name.length > 255) throw new Error("invalid image name");
	const mimeType = imageMimeType(file);
	if (!mimeType) throw new Error("unsupported image type");
	if (file.size <= 0) throw new Error("empty image");
	if (file.size > MAX_PROMPT_IMAGE_BYTES) throw new Error("image too large");
	const bytes = new Uint8Array(await file.arrayBuffer());
	return { name, mimeType, data: bytesToBase64(bytes) };
}

/**
 * The images a paste would attach. Only a clipboard with no text counts: a
 * screenshot or a copied image file, yes; cells copied from a spreadsheet
 * (text plus a picture of them), no — those paste as text.
 */
export function pastedImageFiles(data: DataTransfer): File[] {
	if (data.types.includes("text/plain")) return [];
	return [...data.items]
		.filter((item) => item.kind === "file")
		.map((item) => item.getAsFile())
		.filter((file): file is File => file !== null && imageMimeType(file) !== null);
}

/** Screenshots all arrive as "image.png"; give each a name worth showing. */
export function namePastedImages(files: readonly File[], now = new Date()): File[] {
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return files.map((file, index) => {
		if (!/^image\.[a-z0-9]+$/i.test(file.name)) return file;
		const extension = file.name.slice(file.name.lastIndexOf("."));
		return new File([file], `pasted-${stamp}${index ? `-${index + 1}` : ""}${extension}`, { type: file.type });
	});
}
