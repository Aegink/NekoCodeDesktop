// The community themes installed in `~/.nekocode/themes`, shared by the
// appearance settings and the chat's background. One store for the window: the
// folder is watched in main, and a package the agent drops there arrives here
// as a change that also applies the theme — the user asked for it to be
// installed, which means wanting to see it.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CommunityTheme, ThemeLibrarySnapshot } from "../../../shared/themes";
import { optionalApi } from "../api";
import { applyCommunityThemeNow, forgetCommunityThemeNow } from "./useTheme";

let library: ThemeLibrarySnapshot | null = null;
const listeners = new Set<() => void>();
let started = false;
const artCache = new Map<string, Promise<string | null>>();

function setLibrary(next: ThemeLibrarySnapshot) {
	library = next;
	for (const listener of listeners) listener();
}

export async function refreshThemeLibrary(): Promise<void> {
	const bridge = optionalApi();
	if (!bridge) return;
	try {
		setLibrary(await bridge.themesList());
	} catch {
		// Bridge without the method (an older host); the list stays empty.
	}
}

function start() {
	if (started) return;
	started = true;
	const bridge = optionalApi();
	if (!bridge) return;
	void refreshThemeLibrary();
	bridge.onThemesChanged?.((change) => {
		for (const id of change.installed) artCache.delete(id);
		setLibrary(change.snapshot);
		const installed = change.installed.at(-1);
		const theme = installed ? change.snapshot.themes.find((entry) => entry.id === installed) : undefined;
		if (theme) applyCommunityThemeNow(theme);
	});
}

function subscribe(listener: () => void) {
	start();
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useThemeLibrary(): ThemeLibrarySnapshot | null {
	return useSyncExternalStore(subscribe, () => library, () => null);
}

/** Install a package's palette and artwork, then show it. */
export async function installThemePackage(source: string): Promise<CommunityTheme> {
	const bridge = optionalApi();
	if (!bridge) throw new Error("主题库不可用");
	const theme = await bridge.themesInstall(source);
	artCache.delete(theme.id);
	await refreshThemeLibrary();
	applyCommunityThemeNow(theme);
	return theme;
}

export async function removeCommunityTheme(id: string): Promise<void> {
	const bridge = optionalApi();
	if (!bridge) return;
	setLibrary(await bridge.themesRemove(id));
	artCache.delete(id);
	forgetCommunityThemeNow(id);
}

/** A theme's artwork as a data URL, read once per install. */
export function useCommunityArt(theme: CommunityTheme | null | undefined): string | null {
	const id = theme?.art ? theme.id : null;
	const [art, setArt] = useState<{ id: string; url: string | null } | null>(null);
	useEffect(() => {
		if (!id) return;
		const bridge = optionalApi();
		if (!bridge) return;
		let request = artCache.get(id);
		if (!request) {
			request = bridge.themesArt(id).catch(() => null);
			artCache.set(id, request);
		}
		let live = true;
		void request.then((url) => {
			if (live) setArt({ id, url });
		});
		return () => {
			live = false;
		};
	}, [id, library]);
	return id && art?.id === id ? art.url : null;
}
