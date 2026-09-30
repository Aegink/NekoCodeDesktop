import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { FileTypeIcon } from "../../lib/fileIcons";
import { cn } from "../../lib/utils";
import { APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME } from "../chat/composerPickerStyles";
import type { IdeWorkspace } from "./ide-store";

const QUERY_DEBOUNCE_MS = 60;

/** `path:line:column` — the form compilers and stack traces print. */
function parseQuery(raw: string): { path: string; line?: number; column?: number } {
	const match = raw.trim().match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
	if (!match) return { path: raw.trim() };
	return {
		path: match[1] ?? "",
		...(match[2] ? { line: Number(match[2]) } : {}),
		...(match[3] ? { column: Number(match[3]) } : {}),
	};
}

/**
 * Ctrl+P. Files by fuzzy name, recent ones first when nothing is typed;
 * `name:42` opens at a line, `:42` jumps in the open file, `>` hands over to the
 * editor's command palette.
 */
export function QuickOpen({
	ws,
	onClose,
	onCommandPalette,
}: {
	ws: IdeWorkspace;
	onClose: () => void;
	onCommandPalette: () => void;
}) {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<string[]>(ws.recent);
	const [index, setIndex] = useState(0);
	const listRef = useRef<HTMLDivElement | null>(null);
	const parsed = parseQuery(query);
	const gotoLine = query.startsWith(":");

	useEffect(() => {
		if (query.startsWith(">")) {
			onClose();
			onCommandPalette();
			return;
		}
		if (gotoLine) {
			setResults([]);
			return;
		}
		const path = parsed.path;
		if (!path) {
			setResults(ws.recent);
			setIndex(0);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			api
				.ideQuickOpen(ws.cwd, path)
				.then((files) => {
					if (cancelled) return;
					setResults(files);
					setIndex(0);
				})
				.catch(() => undefined);
		}, QUERY_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query]);

	useEffect(() => {
		listRef.current?.querySelector<HTMLElement>(`[data-index='${index}']`)?.scrollIntoView({ block: "nearest" });
	}, [index]);

	const choose = (relPath: string | undefined, pin: boolean) => {
		if (gotoLine) {
			const line = Number(query.slice(1).split(":")[0]);
			const column = Number(query.slice(1).split(":")[1] ?? 1) || 1;
			const tab = ws.activeTab;
			if (tab && line > 0) ws.open(tab.relPath, { kind: tab.kind, line, column });
			onClose();
			return;
		}
		if (!relPath) return;
		ws.open(relPath, {
			preview: !pin,
			...(parsed.line ? { line: parsed.line, column: parsed.column ?? 1 } : {}),
		});
		onClose();
	};

	return createPortal(
		<div className="fixed inset-0 z-[65]" onMouseDown={onClose}>
			<div
				role="dialog"
				aria-label={t("ide.command.quickOpen")}
				onMouseDown={(event) => event.stopPropagation()}
				className={cn(
					APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME,
					"absolute left-1/2 top-12 flex w-[min(600px,calc(100vw-4rem))] -translate-x-1/2 flex-col overflow-hidden p-1.5",
				)}
			>
				<input
					autoFocus
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							onClose();
						} else if (event.key === "ArrowDown") {
							event.preventDefault();
							setIndex((value) => Math.min(results.length - 1, value + 1));
						} else if (event.key === "ArrowUp") {
							event.preventDefault();
							setIndex((value) => Math.max(0, value - 1));
						} else if (event.key === "Enter") {
							event.preventDefault();
							choose(results[index], event.ctrlKey || event.metaKey);
						}
					}}
					placeholder={t("ide.quickOpen.placeholder")}
					spellCheck={false}
					className="h-8 rounded-lg border border-[color:var(--color-border-focus)] bg-[var(--color-background-control-opaque)] px-2.5 text-[length:var(--app-font-size-ui,12px)] outline-none"
				/>
				<div ref={listRef} className="mt-1 max-h-[min(420px,60vh)] overflow-y-auto">
					{gotoLine ? (
						<p className="px-2.5 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							{ws.activeTab ? t("ide.quickOpen.gotoLine", { line: query.slice(1) || "…" }) : t("ide.quickOpen.noFile")}
						</p>
					) : results.length === 0 ? (
						<p className="px-2.5 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
							{parsed.path ? t("ide.quickOpen.noResults") : t("ide.quickOpen.hint")}
						</p>
					) : (
						<>
							{!parsed.path ? (
								<div className="px-2.5 pb-0.5 pt-1 text-[length:var(--app-font-size-ui-2xs,9px)] uppercase tracking-wide text-muted-foreground">
									{t("ide.quickOpen.recent")}
								</div>
							) : null}
							{results.map((relPath, at) => {
								const name = relPath.slice(relPath.lastIndexOf("/") + 1);
								const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
								return (
									<button
										key={relPath}
										type="button"
										data-index={at}
										onMouseMove={() => setIndex(at)}
										onClick={() => choose(relPath, false)}
										className={cn(
											"flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[length:var(--app-font-size-ui,12px)]",
											at === index && "bg-[var(--color-background-button-secondary-hover)]",
										)}
									>
										<FileTypeIcon name={name} className="size-3.5 shrink-0" />
										<span className="shrink-0">{name}</span>
										<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{dir}</span>
										{ws.docs.get(relPath)?.dirty ? <span className="size-1.5 shrink-0 rounded-full bg-foreground/70" /> : null}
									</button>
								);
							})}
						</>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
