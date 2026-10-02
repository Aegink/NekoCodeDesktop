import { describe, expect, test } from "bun:test";
import {
	DEFAULT_APPEARANCE_PREFERENCES,
	getAppearanceFontCssVariables,
	normalizeAppearancePreferences,
} from "../../../src/renderer/src/lib/appearancePreferences";
import { normalizeUiFontFamilyCssValue } from "../../../src/renderer/src/lib/fontFamily";

describe("normalizeAppearancePreferences", () => {
	test("falls back to defaults for missing or malformed input", () => {
		expect(normalizeAppearancePreferences(null)).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
		expect(normalizeAppearancePreferences("nope")).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
		expect(
			normalizeAppearancePreferences({
				uiFontFamily: 42,
				fontSizePx: "big",
				codeLigatures: "yes",
				density: "cramped",
				chatWidth: "huge",
			}),
		).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
	});

	test("clamps sizes into range and treats blank fonts as unset", () => {
		const prefs = normalizeAppearancePreferences({
			uiFontFamily: "   ",
			codeFontFamily: " Fira Code ",
			fontSizePx: 99,
			codeFontSizePx: 2,
			terminalFontSizePx: 14.6,
			editorFontSizePx: 100,
		});
		expect(prefs.uiFontFamily).toBeNull();
		expect(prefs.codeFontFamily).toBe("Fira Code");
		expect(prefs.fontSizePx).toBe(18);
		expect(prefs.codeFontSizePx).toBe(9);
		expect(prefs.terminalFontSizePx).toBe(15);
		expect(prefs.editorFontSizePx).toBe(24);
	});

	test("carries the legacy density and chat width keys over until the store has its own", () => {
		const legacy = { density: "compact", chatWidth: "wide" };
		const migrated = normalizeAppearancePreferences(null, legacy);
		expect(migrated.density).toBe("compact");
		expect(migrated.chatWidth).toBe("wide");

		const saved = normalizeAppearancePreferences({ density: "spacious", chatWidth: "full" }, legacy);
		expect(saved.density).toBe("spacious");
		expect(saved.chatWidth).toBe("full");
	});
});

describe("getAppearanceFontCssVariables", () => {
	test("leaves every variable unset by default so the theme stack applies", () => {
		for (const value of Object.values(getAppearanceFontCssVariables(DEFAULT_APPEARANCE_PREFERENCES))) {
			expect(value).toBe("");
		}
	});

	test("quotes custom fonts and appends a fallback stack", () => {
		const variables = getAppearanceFontCssVariables({
			...DEFAULT_APPEARANCE_PREFERENCES,
			uiFontFamily: "HarmonyOS Sans SC",
			codeFontFamily: "Cascadia Code",
			codeLigatures: false,
		});
		expect(variables["--user-font-ui-family"]).toStartWith('"HarmonyOS Sans SC", ');
		expect(variables["--user-font-ui-family"]).toEndWith("sans-serif");
		expect(variables["--user-font-code-family"]).toStartWith('"Cascadia Code", ');
		expect(variables["--user-font-code-family"]).toEndWith("monospace");
		expect(variables["--app-code-font-variant-ligatures"]).toBe("none");
	});
});

describe("normalizeUiFontFamilyCssValue", () => {
	test("keeps a list that already ends in a generic family as-is", () => {
		expect(normalizeUiFontFamilyCssValue("Inter, sans-serif")).toBe("Inter, sans-serif");
		expect(normalizeUiFontFamilyCssValue("")).toBeNull();
	});
});
