import { useEffect, useState, useSyncExternalStore } from "react";
import { VscCheck, VscChevronDown, VscExtensions, VscPackage, VscRefresh, VscVerifiedFilled, VscWarning } from "react-icons/vsc";
import type {
	IdeExtensionSearchEntry,
	IdeExtensionsSnapshot,
	IdeInstalledExtension,
} from "../../../../shared/ide-extensions";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { extensionRuntime } from "./extension-runtime";
import { PanelHeader, PanelIconButton } from "./PanelChrome";

const SEARCH_DEBOUNCE_MS = 400;

const CHIP_CLASS_NAME =
	"shrink-0 rounded bg-[var(--color-background-elevated-secondary)] px-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground";

function formatCount(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}K`;
	return String(count);
}

function ExtensionIcon({ src }: { src: string | null }) {
	return src ? (
		<img src={src} alt="" aria-hidden="true" draggable={false} className="size-8 shrink-0 rounded object-contain" />
	) : (
		<span className="flex size-8 shrink-0 items-center justify-center rounded bg-[var(--color-background-elevated-secondary)] text-muted-foreground">
			<VscExtensions className="size-4" />
		</span>
	);
}

/** What an installed extension gives the IDE, and what it asks for that the IDE does not do. */
function Capabilities({ extension }: { extension: IdeInstalledExtension }) {
	const { t } = useTranslation();
	const usable = extension.themes.length + extension.grammars.length + extension.languages.length + extension.snippets.length;
	return (
		<div className="flex flex-wrap items-center gap-1">
			{extension.themes.length ? <span className={CHIP_CLASS_NAME}>{t("ide.ext.themes", { count: extension.themes.length })}</span> : null}
			{extension.grammars.length ? <span className={CHIP_CLASS_NAME}>{t("ide.ext.grammars", { count: extension.grammars.length })}</span> : null}
			{extension.languages.length ? <span className={CHIP_CLASS_NAME}>{t("ide.ext.languages", { count: extension.languages.length })}</span> : null}
			{extension.snippets.length ? <span className={CHIP_CLASS_NAME}>{t("ide.ext.snippets", { count: extension.snippets.length })}</span> : null}
			{extension.hasCode || extension.unsupported.length ? (
				<span
					className={cn(CHIP_CLASS_NAME, "flex items-center gap-0.5 text-[var(--warning)]")}
					title={
						extension.unsupported.length
							? t("ide.ext.unsupportedList", { list: extension.unsupported.join(", ") })
							: undefined
					}
				>
					<VscWarning className="size-2.5" />
					{usable === 0 ? t("ide.ext.nothingUsable") : t("ide.ext.partial")}
				</span>
			) : null}
		</div>
	);
}

export function ExtensionsPanel() {
	const { t, language } = useTranslation();
	useSyncExternalStore(extensionRuntime.subscribe, extensionRuntime.getVersion);
	const snapshot = extensionRuntime.snapshot;
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<IdeExtensionSearchEntry[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const [rerun, setRerun] = useState(0);

	useEffect(() => {
		let cancelled = false;
		// The old list would sit under the new heading until the answer arrives.
		setResults(null);
		const timer = setTimeout(() => {
			setSearching(true);
			api
				.ideExtensionsSearch(query)
				.then((next) => {
					if (cancelled) return;
					setResults(next.entries);
					setError(null);
				})
				.catch((cause: unknown) => {
					if (!cancelled) setError(errorMessage(cause));
				})
				.finally(() => {
					if (!cancelled) setSearching(false);
				});
		}, query ? SEARCH_DEBOUNCE_MS : 0);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query, rerun]);

	const installedById = new Map(snapshot.installed.map((extension) => [extension.id.toLowerCase(), extension]));

	const run = async (id: string, work: () => Promise<IdeExtensionsSnapshot | null>, after?: (next: IdeExtensionsSnapshot) => void) => {
		setBusy(id);
		setError(null);
		setNotice(null);
		try {
			const next = await work();
			if (next) {
				await extensionRuntime.apply(next);
				after?.(next);
			}
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(null);
		}
	};

	const afterInstall = (id: string) => (next: IdeExtensionsSnapshot) => {
		const installed = next.installed.find((extension) => extension.id.toLowerCase() === id.toLowerCase());
		if (!installed) return;
		const usable = installed.themes.length + installed.grammars.length + installed.languages.length + installed.snippets.length;
		if (usable === 0) setNotice(t("ide.ext.installedNothing", { name: installed.displayName }));
		else if (installed.themes.length && !extensionRuntime.themeKey) {
			// A theme extension is installed to be used: switch to its first theme.
			extensionRuntime.setTheme(`${installed.id}::${installed.themes[0]!.id}`);
		}
	};

	const themes = extensionRuntime.themes;
	const currentTheme = themes.find((theme) => theme.key === extensionRuntime.themeKey);

	const openThemeMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
		const box = event.currentTarget.getBoundingClientRect();
		setMenu({
			x: box.left,
			y: box.bottom + 4,
			items: [
				{
					label: `${currentTheme ? "" : "✓ "}${t("ide.ext.themeDefault")}`,
					onSelect: () => extensionRuntime.setTheme(""),
				},
				...(themes.length ? [{ kind: "separator" as const }] : []),
				...themes.map((theme) => ({
					label: `${theme.key === extensionRuntime.themeKey ? "✓ " : ""}${theme.label} · ${theme.extension}`,
					onSelect: () => extensionRuntime.setTheme(theme.key),
				})),
			],
		});
	};

	const installedRow = (extension: IdeInstalledExtension) => {
		const failure = extensionRuntime.errors.get(extension.id);
		return (
			<div key={extension.id} className={cn("flex gap-2.5 px-3 py-2", !extension.enabled && "opacity-60")}>
				<ExtensionIcon src={extension.iconDataUrl} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-baseline gap-1.5">
						<span className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium">{extension.displayName}</span>
						<span className="shrink-0 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">{extension.version}</span>
					</div>
					<span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{extension.description}</span>
					<Capabilities extension={extension} />
					{failure ? <span className="text-[length:var(--app-font-size-ui-2xs,9px)] text-destructive">{failure}</span> : null}
					<div className="mt-0.5 flex flex-wrap gap-1">
						{extension.themes.length && extension.enabled ? (
							<Button
								size="xs"
								variant="chrome-outline"
								onClick={() => extensionRuntime.setTheme(`${extension.id}::${extension.themes[0]!.id}`)}
							>
								{t("ide.ext.useTheme")}
							</Button>
						) : null}
						<Button
							size="xs"
							variant="ghost"
							disabled={busy !== null}
							onClick={() => void run(extension.id, () => api.ideExtensionsSetEnabled(extension.id, !extension.enabled))}
						>
							{extension.enabled ? t("ide.ext.disable") : t("ide.ext.enable")}
						</Button>
						<Button
							size="xs"
							variant="ghost"
							disabled={busy !== null}
							onClick={() =>
								void run(extension.id, async () => {
									if (extensionRuntime.themeKey.startsWith(`${extension.id}::`)) extensionRuntime.setTheme("");
									return api.ideExtensionsUninstall(extension.id);
								})
							}
						>
							{busy === extension.id ? <Spinner className="size-3" /> : null}
							{t("ide.ext.uninstall")}
						</Button>
					</div>
				</div>
			</div>
		);
	};

	const resultRow = (entry: IdeExtensionSearchEntry) => {
		const installed = installedById.get(entry.id.toLowerCase());
		return (
			<div key={entry.id} className="flex gap-2.5 px-3 py-2 hover:bg-[var(--sidebar-accent)]">
				<ExtensionIcon src={entry.iconDataUrl} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-baseline gap-1.5">
						<span className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium" title={entry.id}>
							{entry.displayName}
						</span>
						<span className="shrink-0 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
							↓ {formatCount(entry.downloadCount)}
						</span>
					</div>
					<span className="line-clamp-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{entry.description}</span>
					<div className="flex items-center gap-1.5">
						<span className="flex min-w-0 items-center gap-0.5 truncate text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
							{entry.verified ? <VscVerifiedFilled className="size-2.5 shrink-0 text-[var(--color-text-accent)]" /> : null}
							{entry.namespace}
						</span>
						<div className="flex-1" />
						{installed ? (
							<span className="flex items-center gap-0.5 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
								<VscCheck className="size-3" />
								{installed.version === entry.version ? t("ide.ext.installed") : t("ide.ext.installedVersion", { version: installed.version })}
							</span>
						) : null}
						{!installed || installed.version !== entry.version ? (
							<Button
								size="xs"
								variant="default"
								disabled={busy !== null}
								onClick={() => void run(entry.id, () => api.ideExtensionsInstall(entry.id), afterInstall(entry.id))}
							>
								{busy === entry.id ? <Spinner className="size-3" /> : null}
								{installed ? t("ide.ext.update") : t("ide.ext.install")}
							</Button>
						) : null}
					</div>
				</div>
			</div>
		);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelHeader title={t("ide.ext.title")}>
				<PanelIconButton
					label={t("ide.ext.installVsix")}
					disabled={busy !== null}
					onClick={() => void run("vsix", () => api.ideExtensionsInstallVsix())}
				>
					<VscPackage />
				</PanelIconButton>
				<PanelIconButton
					label={t("common.refresh")}
					onClick={() => {
						setRerun((value) => value + 1);
						void api.ideExtensionsList(language).then((next) => extensionRuntime.apply(next));
					}}
				>
					<VscRefresh />
				</PanelIconButton>
			</PanelHeader>

			<div className="flex shrink-0 flex-col gap-1.5 px-2 pb-2">
				<button
					type="button"
					onClick={openThemeMenu}
					className="flex h-7 items-center gap-1.5 rounded-md border border-[color:var(--color-border)] px-2 text-left text-[length:var(--app-font-size-ui-sm,11px)] hover:bg-[var(--color-background-button-secondary-hover)]"
				>
					<span className="shrink-0 text-muted-foreground">{t("ide.ext.colorTheme")}</span>
					<span className="min-w-0 flex-1 truncate">{currentTheme?.label ?? t("ide.ext.themeDefault")}</span>
					<VscChevronDown className="shrink-0 text-muted-foreground" />
				</button>
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("ide.ext.searchPlaceholder")}
					spellCheck={false}
					className="h-7 rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] px-2 text-[length:var(--app-font-size-ui,12px)] outline-none placeholder:text-muted-foreground/60 focus:border-[color:var(--color-border-focus)]"
				/>
				<span className="text-[length:var(--app-font-size-ui-2xs,9px)] leading-relaxed text-muted-foreground">{t("ide.ext.scopeHint")}</span>
				{error ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span> : null}
				{notice ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--warning)]">{notice}</span> : null}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto pb-4">
				{!query && snapshot.installed.length ? (
					<>
						<div className="px-3 pb-1 pt-1 text-[length:var(--app-font-size-ui-xs,10px)] font-semibold uppercase tracking-wide text-muted-foreground">
							{t("ide.ext.installedTitle", { count: snapshot.installed.length })}
						</div>
						{snapshot.installed.map(installedRow)}
					</>
				) : null}
				<div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[length:var(--app-font-size-ui-xs,10px)] font-semibold uppercase tracking-wide text-muted-foreground">
					{query ? t("ide.ext.results") : t("ide.ext.popular")}
					{searching ? <Spinner className="size-3" /> : null}
				</div>
				{results && results.length === 0 && !searching ? (
					<p className="px-3 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">{t("ide.ext.noResults")}</p>
				) : null}
				{(results ?? []).map(resultRow)}
			</div>
			<ContextMenu menu={menu} onClose={() => setMenu(null)} />
		</div>
	);
}
