import { describe, expect, test } from "bun:test";
import { parseThemePackage, readCommunityTheme } from "../../src/shared/themes";

/** A tiny PNG, as codexthemes.ai embeds artwork. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Shaped like the lavender-snow package codexthemes.ai serves. */
function codexThemePackage(overrides: Record<string, unknown> = {}, manifest: Record<string, unknown> = {}): string {
	return JSON.stringify({
		format: "codex-theme",
		schemaVersion: 1,
		exportedAt: "2026-09-01T00:00:00.000Z",
		manifest: {
			schemaVersion: 1,
			id: "lavender-snow",
			displayName: "普鲸 · DeepSeek",
			description: "浅白、雾蓝与淡紫的三栏主题",
			version: "0.4.0",
			mode: "light",
			css: "theme.css",
			art: "assets/artwork.jpg",
			design: { backgroundScope: "workspace", artFocalPoint: "40% 34% in source, centered within middle pane" },
			palette: {
				canvas: "#FAFBFF",
				surface: "#f3f5fc",
				text: "#30384f",
				accent: "#5666a3",
				success: "#28765c",
				danger: "#af3d59",
			},
			author: { name: "Acca" },
			homepage: "https://codexthemes.ai",
			...manifest,
		},
		css: "main.main-surface { background: url(x) }",
		readme: "# Lavender",
		art: { filename: "artwork.png", mimeType: "image/png", base64: PNG },
		...overrides,
	});
}

describe("parseThemePackage", () => {
	test("keeps the palette and artwork, drops the Codex stylesheet", () => {
		const parsed = parseThemePackage(codexThemePackage());
		expect(parsed.theme).toEqual({
			id: "lavender-snow",
			name: "普鲸 · DeepSeek",
			description: "浅白、雾蓝与淡紫的三栏主题",
			author: "Acca",
			version: "0.4.0",
			variant: "light",
			colors: { accent: "#5666a3", surface: "#fafbff", ink: "#30384f", diffAdded: "#28765c", diffRemoved: "#af3d59" },
			art: true,
			backgroundScope: "workspace",
			artPosition: "40% 34%",
			homepage: "https://codexthemes.ai",
		});
		expect(parsed.art?.fileName).toBe("art.png");
		expect(parsed.manifest.art).toBe("art.png");
		expect(parsed.manifest.css).toBeUndefined();
	});

	test("a palette-only package has no artwork", () => {
		const parsed = parseThemePackage(codexThemePackage({ art: undefined }, { art: undefined }));
		expect(parsed.art).toBeNull();
		expect(parsed.theme.art).toBe(false);
		expect(parsed.manifest.art).toBeUndefined();
	});

	test("refuses what is not a safe theme package", () => {
		expect(() => parseThemePackage("not json")).toThrow("不是 JSON");
		expect(() => parseThemePackage(codexThemePackage({ format: "zip" }))).toThrow(".codex-theme");
		expect(() => parseThemePackage(codexThemePackage({ schemaVersion: 2 }))).toThrow("版本");
		expect(() => parseThemePackage(codexThemePackage({}, { id: "../escape" }))).toThrow("id 无效");
		expect(() => parseThemePackage(codexThemePackage({}, { palette: { canvas: "#ffffff" } }))).toThrow("缺少配色");
		expect(() =>
			parseThemePackage(codexThemePackage({ art: { filename: "x.svg", mimeType: "image/svg+xml", base64: "PHN2Zz4=" } })),
		).toThrow("背景图格式");
	});
});

describe("readCommunityTheme", () => {
	test("a manifest without a mode takes it from the canvas lightness", () => {
		const dark = readCommunityTheme({ id: "night", palette: { canvas: "#101014", text: "#e8e8ee", accent: "#7c9cff" } }, false);
		expect(dark.variant).toBe("dark");
		expect(dark.backgroundScope).toBe("home");
		expect(dark.artPosition).toBe("center");
		// Diff colors the palette left out fall back to the variant's defaults.
		expect(dark.colors.diffAdded).toBe("#40c977");
	});
});
