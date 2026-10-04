/**
 * Community themes: the `.codex-theme` packages codexthemes.ai publishes for
 * the Codex desktop app, installed into a directory this app owns.
 *
 * A package is one UTF-8 JSON document — a manifest with a semantic palette,
 * a stylesheet, and usually a background artwork as base64. The stylesheet is
 * written against Codex's DOM and injected into Codex over its debugging port,
 * so it means nothing here and is never run. What carries over is the palette,
 * mapped onto this app's own theme colors, and the artwork, shown behind the
 * chat under a veil of the theme's own surface color.
 */

export type CommunityThemeVariant = "light" | "dark";

/** The palette, already in this app's terms. */
export interface CommunityThemeColors {
	accent: string;
	/** The window and panel base: the package's `canvas`. */
	surface: string;
	/** Body text: the package's `text`. */
	ink: string;
	diffAdded: string;
	diffRemoved: string;
}

export interface CommunityTheme {
	/** Directory name, and the slug on codexthemes.ai. */
	id: string;
	name: string;
	description: string;
	author: string | null;
	version: string | null;
	/** The one variant a community theme is designed for. */
	variant: CommunityThemeVariant;
	colors: CommunityThemeColors;
	/** A background artwork is installed beside the manifest. */
	art: boolean;
	/** `home`: behind an empty chat only; `workspace`: behind conversations too. */
	backgroundScope: "home" | "workspace";
	/** CSS `background-position` that keeps the artwork's subject in view. */
	artPosition: string;
	homepage: string | null;
}

export interface ThemeLibrarySnapshot {
	/** Where installed themes live; also the drop folder for packages. */
	dir: string;
	themes: CommunityTheme[];
}

export interface ThemeLibraryChange {
	snapshot: ThemeLibrarySnapshot;
	/** Packages dropped into the folder and installed just now, to apply. */
	installed: string[];
}

export const THEME_PACKAGE_EXTENSION = ".codex-theme";
/** codexthemes.ai's own ceiling. */
export const MAX_THEME_PACKAGE_BYTES = 30 * 1024 * 1024;
/** The environment variable the agent's shell reads the themes folder from. */
export const THEMES_DIR_ENV = "NEKOCODE_THEMES_DIR";

const HEX = /^#[0-9a-f]{6}$/i;
const THEME_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const ART_TYPES: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};
export const ART_MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

/** Used when a palette leaves the diff colors out, per variant. */
const FALLBACK_DIFF: Record<CommunityThemeVariant, { added: string; removed: string }> = {
	light: { added: "#00a240", removed: "#ba2623" },
	dark: { added: "#40c977", removed: "#fa423e" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hex(value: unknown): string | null {
	return typeof value === "string" && HEX.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function text(value: unknown, max = 500): string | null {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** Perceived lightness, 0–1, for a palette that does not say which mode it is. */
function lightness(color: string): number {
	const channel = (offset: number) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function isThemeId(value: unknown): value is string {
	return typeof value === "string" && THEME_ID.test(value) && value !== "." && value !== "..";
}

/**
 * The leading `x% y%` of the manifest's free-text focal point — "40% 34% in
 * source, centered within middle pane" — or the center.
 */
function artPosition(design: Record<string, unknown>): string {
	const focal = typeof design.artFocalPoint === "string" ? design.artFocalPoint : "";
	const match = /^\s*(\d{1,3}(?:\.\d+)?%)\s+(\d{1,3}(?:\.\d+)?%)/.exec(focal);
	return match ? `${match[1]} ${match[2]}` : "center";
}

/**
 * A manifest as this app shows it. Throws, with a message meant for the user,
 * when the palette lacks the three colors everything else derives from.
 */
export function readCommunityTheme(manifest: unknown, hasArt: boolean): CommunityTheme {
	if (!isRecord(manifest)) throw new Error("主题清单不是一个对象");
	const id = typeof manifest.id === "string" ? manifest.id.trim().toLowerCase() : "";
	if (!isThemeId(id)) throw new Error(`主题 id 无效：${String(manifest.id)}`);
	const palette = isRecord(manifest.palette) ? manifest.palette : {};
	const surface = hex(palette.canvas) ?? hex(palette.surface);
	const ink = hex(palette.text);
	const accent = hex(palette.accent) ?? hex(palette.focus);
	if (!surface || !ink || !accent) throw new Error("主题缺少配色：需要 canvas（或 surface）、text 和 accent");
	const variant: CommunityThemeVariant =
		manifest.mode === "light" || manifest.mode === "dark" ? manifest.mode : lightness(surface) > 0.5 ? "light" : "dark";
	const design = isRecord(manifest.design) ? manifest.design : {};
	const author = isRecord(manifest.author) ? text(manifest.author.name, 100) : text(manifest.author, 100);
	return {
		id,
		name: text(manifest.displayName, 100) ?? id,
		description: text(manifest.description) ?? "",
		author,
		version: text(manifest.version, 40),
		variant,
		colors: {
			accent,
			surface,
			ink,
			diffAdded: hex(palette.success) ?? FALLBACK_DIFF[variant].added,
			diffRemoved: hex(palette.danger) ?? FALLBACK_DIFF[variant].removed,
		},
		art: hasArt,
		backgroundScope: design.backgroundScope === "workspace" ? "workspace" : "home",
		artPosition: artPosition(design),
		homepage: text(manifest.homepage, 300),
	};
}

export interface ParsedThemePackage {
	theme: CommunityTheme;
	/** The manifest to store, its `art` pointing at the file written beside it. */
	manifest: Record<string, unknown>;
	art: { fileName: string; base64: string } | null;
}

/**
 * Validate a `.codex-theme` document. Only the manifest and the artwork are
 * kept: the stylesheet targets another app and scripts are never wanted.
 */
export function parseThemePackage(source: string): ParsedThemePackage {
	if (source.length > MAX_THEME_PACKAGE_BYTES * 1.4) throw new Error("主题包超过 30 MB");
	let value: unknown;
	try {
		value = JSON.parse(source.replace(/^\uFEFF/, ""));
	} catch {
		throw new Error("不是有效的主题包：内容不是 JSON");
	}
	if (!isRecord(value) || value.format !== "codex-theme") throw new Error("不是 .codex-theme 主题包");
	if (value.schemaVersion !== 1) throw new Error(`不支持的主题包版本：${String(value.schemaVersion)}`);
	if (!isRecord(value.manifest)) throw new Error("主题包缺少 manifest");

	let art: ParsedThemePackage["art"] = null;
	if (isRecord(value.art) && typeof value.art.base64 === "string" && value.art.base64) {
		const extension = ART_TYPES[String(value.art.mimeType).toLowerCase()];
		if (!extension) throw new Error(`不支持的背景图格式：${String(value.art.mimeType)}`);
		if (!/^[A-Za-z0-9+/=\s]+$/.test(value.art.base64)) throw new Error("背景图数据已损坏");
		art = { fileName: `art.${extension}`, base64: value.art.base64.replace(/\s+/g, "") };
	}
	const theme = readCommunityTheme(value.manifest, !!art);
	const manifest: Record<string, unknown> = { ...value.manifest, id: theme.id };
	delete manifest.css;
	if (art) manifest.art = art.fileName;
	else delete manifest.art;
	return { theme, manifest, art };
}
