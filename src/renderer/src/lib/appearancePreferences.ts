// User-level appearance preferences that sit on top of the theme pack: custom
// fonts, font sizes, density, and chat width. Unlike the theme state these do not
// change with the light/dark variant or the code theme — a font the user picked
// stays picked when they switch to Dracula.

import { DEFAULT_UI_DENSITY, normalizeUiDensity, type UiDensity } from "./appDensity";
import { DEFAULT_CHAT_WIDTH, normalizeChatWidthMode, type ChatWidthMode } from "./chatWidth";
import {
	DEFAULT_CHAT_FONT_SIZE_PX,
	MAX_CHAT_FONT_SIZE_PX,
	MIN_CHAT_FONT_SIZE_PX,
	normalizeChatFontSizePx,
} from "./appTypography";
import { normalizeMonospaceFontFamilyCssValue, normalizeUiFontFamilyCssValue } from "./fontFamily";

export interface AppearancePreferences {
	/** Custom UI font family list; null leaves the theme / system stack in charge. */
	uiFontFamily: string | null;
	/** Custom code font family list; null leaves the theme / bundled mono stack in charge. */
	codeFontFamily: string | null;
	/** Base size the whole typography scale (UI chrome and transcript) derives from. */
	fontSizePx: number;
	/** Transcript code blocks; null keeps them on the typography scale. */
	codeFontSizePx: number | null;
	terminalFontSizePx: number;
	editorFontSizePx: number;
	codeLigatures: boolean;
	density: UiDensity;
	chatWidth: ChatWidthMode;
}

export const FONT_SIZE_RANGE = { min: MIN_CHAT_FONT_SIZE_PX, max: MAX_CHAT_FONT_SIZE_PX } as const;
export const MONO_FONT_SIZE_RANGE = { min: 9, max: 24 } as const;

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
	uiFontFamily: null,
	codeFontFamily: null,
	fontSizePx: DEFAULT_CHAT_FONT_SIZE_PX,
	codeFontSizePx: null,
	terminalFontSizePx: 12,
	editorFontSizePx: 13,
	codeLigatures: true,
	density: DEFAULT_UI_DENSITY,
	chatWidth: DEFAULT_CHAT_WIDTH,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFontName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

export function normalizeMonoFontSizePx(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(MONO_FONT_SIZE_RANGE.max, Math.max(MONO_FONT_SIZE_RANGE.min, Math.round(value)));
}

export function normalizeAppearancePreferences(
	value: unknown,
	legacy: { density?: unknown; chatWidth?: unknown } = {},
): AppearancePreferences {
	const prefs = isRecord(value) ? value : {};
	const defaults = DEFAULT_APPEARANCE_PREFERENCES;
	return {
		uiFontFamily: normalizeFontName(prefs.uiFontFamily),
		codeFontFamily: normalizeFontName(prefs.codeFontFamily),
		fontSizePx:
			typeof prefs.fontSizePx === "number" ? normalizeChatFontSizePx(prefs.fontSizePx) : defaults.fontSizePx,
		codeFontSizePx:
			typeof prefs.codeFontSizePx === "number" ? normalizeMonoFontSizePx(prefs.codeFontSizePx, 12) : null,
		terminalFontSizePx: normalizeMonoFontSizePx(prefs.terminalFontSizePx, defaults.terminalFontSizePx),
		editorFontSizePx: normalizeMonoFontSizePx(prefs.editorFontSizePx, defaults.editorFontSizePx),
		codeLigatures: typeof prefs.codeLigatures === "boolean" ? prefs.codeLigatures : defaults.codeLigatures,
		// Density and chat width predate this store and lived under their own keys.
		density: normalizeUiDensity(prefs.density ?? legacy.density),
		chatWidth: normalizeChatWidthMode(prefs.chatWidth ?? legacy.chatWidth),
	};
}

/**
 * The CSS variables the preferences contribute. An empty string means "unset":
 * the applier removes the property so index.css falls back to the theme stack.
 */
export function getAppearanceFontCssVariables(prefs: AppearancePreferences): Record<string, string> {
	return {
		"--user-font-ui-family": normalizeUiFontFamilyCssValue(prefs.uiFontFamily) ?? "",
		"--user-font-code-family": normalizeMonospaceFontFamilyCssValue(prefs.codeFontFamily) ?? "",
		"--app-code-font-variant-ligatures": prefs.codeLigatures ? "" : "none",
	};
}
