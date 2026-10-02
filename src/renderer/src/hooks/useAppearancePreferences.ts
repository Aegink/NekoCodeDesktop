// Persists the user's appearance preferences (fonts, sizes, density, chat width)
// and projects the font ones into root CSS variables. The size/density ones go
// through useAppearanceVariables, which App mounts once.

import { useSyncExternalStore } from "react";
import {
	DEFAULT_APPEARANCE_PREFERENCES,
	getAppearanceFontCssVariables,
	normalizeAppearancePreferences,
	type AppearancePreferences,
} from "../lib/appearancePreferences";

const STORAGE_KEY = "nekocode:appearance";
// Read once to carry the old standalone keys over; the new store wins after the first save.
const LEGACY_DENSITY_KEY = "nekocode:density";
const LEGACY_CHAT_WIDTH_KEY = "nekocode:chat-width";

let listeners: Array<() => void> = [];
let lastRaw: string | null | undefined;
let lastPreferences: AppearancePreferences = DEFAULT_APPEARANCE_PREFERENCES;

function readStorage(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function readPreferences(): AppearancePreferences {
	const raw = readStorage(STORAGE_KEY);
	if (raw === lastRaw) return lastPreferences;
	lastRaw = raw;
	let parsed: unknown = null;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		parsed = null;
	}
	lastPreferences = normalizeAppearancePreferences(parsed, {
		density: readStorage(LEGACY_DENSITY_KEY),
		chatWidth: readStorage(LEGACY_CHAT_WIDTH_KEY),
	});
	return lastPreferences;
}

function applyFontVariables(prefs: AppearancePreferences) {
	if (typeof document === "undefined") return;
	const rootStyle = document.documentElement.style;
	for (const [name, value] of Object.entries(getAppearanceFontCssVariables(prefs))) {
		if (value.length === 0) rootStyle.removeProperty(name);
		else rootStyle.setProperty(name, value);
	}
}

function emitChange() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.push(listener);
	const handleStorage = (event: StorageEvent) => {
		if (event.key !== STORAGE_KEY) return;
		applyFontVariables(readPreferences());
		emitChange();
	};
	window.addEventListener("storage", handleStorage);
	return () => {
		listeners = listeners.filter((current) => current !== listener);
		window.removeEventListener("storage", handleStorage);
	};
}

export function updateAppearancePreferences(patch: Partial<AppearancePreferences>) {
	const next = normalizeAppearancePreferences({ ...readPreferences(), ...patch });
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Storage unavailable: readStorage keeps returning null, so pin the cache
		// to that and the change still applies for this session.
		lastRaw = null;
		lastPreferences = next;
	}
	applyFontVariables(next);
	emitChange();
}

export function resetAppearancePreferences() {
	try {
		localStorage.removeItem(LEGACY_DENSITY_KEY);
		localStorage.removeItem(LEGACY_CHAT_WIDTH_KEY);
	} catch {
		// nothing to clear
	}
	updateAppearancePreferences(DEFAULT_APPEARANCE_PREFERENCES);
}

/**
 * The resolved code font stack, for canvas-ish surfaces (Monaco, xterm) that
 * take a font string rather than reading CSS variables themselves.
 */
export function readCodeFontFamily(): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue("--font-chat-code-family").trim();
	return value || "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace";
}

// Apply on module load so a custom font is in place before React's first paint.
if (typeof document !== "undefined") {
	applyFontVariables(readPreferences());
}

export function useAppearancePreferences() {
	const preferences = useSyncExternalStore(subscribe, readPreferences, () => DEFAULT_APPEARANCE_PREFERENCES);
	return {
		preferences,
		updatePreferences: updateAppearancePreferences,
		resetPreferences: resetAppearancePreferences,
	} as const;
}
