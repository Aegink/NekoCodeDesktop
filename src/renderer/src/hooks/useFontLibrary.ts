// The fonts the appearance pickers offer: what is installed on this machine plus
// what the user imported. The system list is read once per launch.

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { mergeFontFamilies, type SystemFont } from "../../../shared/font-names";
import { getImportedFonts, subscribeImportedFonts, type ImportedFont } from "../lib/importedFonts";

let systemFonts: Promise<SystemFont[]> | null = null;

async function querySystemFonts(): Promise<SystemFont[]> {
	if (api.runtime === "electron") return api.fontsList();
	// The WebUI renders on another machine, so the desktop's fonts mean nothing
	// there; ask the browser instead. It only knows English names and nothing
	// about coverage, and may refuse outright.
	const query = (window as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
	if (typeof query !== "function") return [];
	const fonts = await query.call(window);
	return mergeFontFamilies(fonts.map((font) => ({ family: font.family, chinese: false, monospace: false })));
}

function loadSystemFonts(): Promise<SystemFont[]> {
	systemFonts ??= querySystemFonts().catch(() => {
		systemFonts = null;
		return [];
	});
	return systemFonts;
}

export function useFontLibrary(enabled: boolean) {
	const imported = useSyncExternalStore(subscribeImportedFonts, getImportedFonts, getImportedFonts);
	const [system, setSystem] = useState<SystemFont[] | null>(null);
	useEffect(() => {
		if (!enabled || system) return;
		let cancelled = false;
		void loadSystemFonts().then((fonts) => {
			if (!cancelled) setSystem(fonts);
		});
		return () => {
			cancelled = true;
		};
	}, [enabled, system]);
	return { system, imported } as { system: SystemFont[] | null; imported: readonly ImportedFont[] };
}
