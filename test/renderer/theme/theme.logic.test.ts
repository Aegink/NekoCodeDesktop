import { describe, expect, test } from "bun:test";
import {
	DEFAULT_THEME_STATE,
	applyCommunityTheme,
	createThemeShareString,
	forgetCommunityTheme,
	normalizeThemeState,
	parseThemeShareString,
	resolveThemePack,
	setThemeCodeThemeId,
	updateThemePackFromShareString,
} from "../../../src/renderer/src/theme/theme.logic";

/** Shaped like Codex desktop's own export (26.915): optional font faces and `accentSource` included. */
function codexShare(codeThemeId: string): string {
	return `codex-theme-v1:${JSON.stringify({
		codeThemeId,
		theme: {
			accent: "#007AFF",
			accentSource: "custom",
			contrast: 40,
			fonts: {
				code: "SF Mono",
				codeFace: { family: "SF Mono", fullName: "SF Mono Regular", postscriptName: "SFMono-Regular" },
				content: null,
				ui: null,
			},
			ink: "#1d1d1f",
			opaqueWindows: true,
			semanticColors: { diffAdded: "#28a745", diffRemoved: "#d73a49", skill: "#8e44ad" },
			surface: "#f5f5f7",
		},
		variant: "light",
	})}`;
}

describe("theme share strings", () => {
	test("a Codex desktop export imports, its extra fields ignored", () => {
		const payload = parseThemeShareString(codexShare("github"));
		expect(payload.codeThemeId).toBe("github");
		expect(payload.unknownCodeThemeId).toBeUndefined();
		expect(payload.theme).toEqual({
			accent: "#007aff",
			contrast: 40,
			fonts: { code: "SF Mono", ui: null },
			ink: "#1d1d1f",
			opaqueWindows: true,
			semanticColors: { diffAdded: "#28a745", diffRemoved: "#d73a49", skill: "#8e44ad" },
			surface: "#f5f5f7",
		});
	});

	test("a syntax theme this build lacks keeps the colors and falls back for highlighting", () => {
		const payload = parseThemeShareString(codexShare("xcode"));
		expect(payload.unknownCodeThemeId).toBe("xcode");
		expect(payload.codeThemeId).toBe(DEFAULT_THEME_STATE.codeThemeIds.light);
		const state = updateThemePackFromShareString(DEFAULT_THEME_STATE, codexShare("xcode"), "light");
		expect(resolveThemePack(state, "light").theme.surface).toBe("#f5f5f7");
	});

	test("an export imports back unchanged", () => {
		const pack = resolveThemePack(DEFAULT_THEME_STATE, "dark");
		const payload = parseThemeShareString(createThemeShareString("dark", pack));
		expect({ codeThemeId: payload.codeThemeId, theme: payload.theme }).toEqual(pack);
	});

	test("a string missing required colors is still refused", () => {
		expect(() => parseThemeShareString('codex-theme-v1:{"codeThemeId":"codex","theme":{},"variant":"dark"}')).toThrow();
		expect(() => parseThemeShareString("not a theme")).toThrow();
	});
});

describe("community themes", () => {
	const lavender = {
		id: "lavender-snow",
		variant: "light" as const,
		colors: { accent: "#5666a3", surface: "#fafbff", ink: "#30384f", diffAdded: "#28765c", diffRemoved: "#af3d59" },
	};

	test("applying takes the palette and remembers the theme for its variant", () => {
		const state = applyCommunityTheme(DEFAULT_THEME_STATE, lavender);
		const theme = resolveThemePack(state, "light").theme;
		expect([theme.accent, theme.surface, theme.ink]).toEqual(["#5666a3", "#fafbff", "#30384f"]);
		expect(theme.semanticColors.diffAdded).toBe("#28765c");
		expect(state.communityThemeIds).toEqual({ light: "lavender-snow", dark: null });
		// Survives a save and a reload.
		expect(normalizeThemeState(JSON.parse(JSON.stringify(state))).communityThemeIds.light).toBe("lavender-snow");
	});

	test("a built-in palette or a share string takes over from it", () => {
		const applied = applyCommunityTheme(DEFAULT_THEME_STATE, lavender);
		expect(setThemeCodeThemeId(applied, "light", "github").communityThemeIds.light).toBeNull();
		const share = createThemeShareString("light", resolveThemePack(DEFAULT_THEME_STATE, "light"));
		expect(updateThemePackFromShareString(applied, share, "light").communityThemeIds.light).toBeNull();
	});

	test("an uninstalled theme is forgotten, its colors kept", () => {
		const applied = applyCommunityTheme(DEFAULT_THEME_STATE, lavender);
		const forgotten = forgetCommunityTheme(applied, "lavender-snow");
		expect(forgotten.communityThemeIds.light).toBeNull();
		expect(resolveThemePack(forgotten, "light").theme.accent).toBe("#5666a3");
	});

	test("an old stored state gets no community theme and full artwork strength", () => {
		const state = normalizeThemeState({ mode: "dark" });
		expect(state.communityThemeIds).toEqual({ dark: null, light: null });
		expect(state.artStrength).toBe(100);
		expect(normalizeThemeState({ communityThemeIds: { light: "../x" } }).communityThemeIds.light).toBeNull();
	});
});
