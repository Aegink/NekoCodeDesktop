import { useEffect, useRef, useState } from "react";
import {
	VscCaseSensitive,
	VscChevronDown,
	VscChevronRight,
	VscCollapseAll,
	VscEllipsis,
	VscRefresh,
	VscRegex,
	VscReplaceAll,
	VscWholeWord,
} from "react-icons/vsc";
import { replacementText, searchPattern, type IdeSearchResult } from "../../../../shared/ide";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { FileTypeIcon } from "../../lib/fileIcons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import type { IdeWorkspace } from "./ide-store";
import { PanelHeader, PanelIconButton } from "./PanelChrome";

const SEARCH_DEBOUNCE_MS = 300;

const FIELD_CLASS_NAME =
	"h-6 min-w-0 flex-1 bg-transparent px-1.5 text-[length:var(--app-font-size-ui,12px)] outline-none placeholder:text-muted-foreground/60";
const FIELD_BOX_CLASS_NAME =
	"flex items-center rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] focus-within:border-[color:var(--color-border-focus)]";

function ToggleButton({
	label,
	active,
	onClick,
	children,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground [&_svg]:size-3.5",
				active
					? "bg-[color-mix(in_srgb,var(--color-text-accent)_22%,transparent)] text-foreground outline outline-1 outline-[color:var(--color-text-accent)]"
					: "hover:bg-[var(--color-background-button-secondary-hover)]",
			)}
		>
			{children}
		</button>
	);
}

/** Project-wide search, and replace, in the side panel. */
export function SearchPanel({
	ws,
	focusSignal,
	initialQuery,
}: {
	ws: IdeWorkspace;
	/** Bumped to focus the query box — Ctrl+Shift+F. */
	focusSignal: number;
	/** The editor's selection when the panel was summoned, if any. */
	initialQuery: { text: string; nonce: number } | null;
}) {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const [replace, setReplace] = useState("");
	const [showReplace, setShowReplace] = useState(false);
	const [showDetails, setShowDetails] = useState(false);
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [wholeWord, setWholeWord] = useState(false);
	const [regex, setRegex] = useState(false);
	const [include, setInclude] = useState("");
	const [exclude, setExclude] = useState("");
	const [result, setResult] = useState<IdeSearchResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [confirmReplace, setConfirmReplace] = useState(false);
	const [rerun, setRerun] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const cwd = ws.cwd;

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [focusSignal]);

	useEffect(() => {
		if (initialQuery?.text) setQuery(initialQuery.text);
	}, [initialQuery]);

	useEffect(() => {
		if (!query) {
			setResult(null);
			setError(null);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			setLoading(true);
			api
				.ideSearch({ cwd, query, caseSensitive, wholeWord, regex, include, exclude })
				.then((next) => {
					if (cancelled) return;
					setResult(next);
					setError(null);
				})
				.catch((cause: unknown) => {
					if (!cancelled) setError(errorMessage(cause));
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [cwd, query, caseSensitive, wholeWord, regex, include, exclude, rerun]);

	/**
	 * Replace in every file with a match. Open files are edited in their buffer,
	 * as one undoable step each, and left for the user to save — the same as
	 * typing there. Files that are not open are rewritten on disk, refusing any
	 * that changed since they were searched.
	 */
	const replaceAll = async () => {
		setConfirmReplace(false);
		if (!result) return;
		let pattern: RegExp;
		try {
			pattern = searchPattern({ query, caseSensitive, wholeWord, regex });
		} catch (cause) {
			setError(errorMessage(cause));
			return;
		}
		const replacement = replacementText(replace, regex);
		const failures: string[] = [];
		for (const file of result.files) {
			try {
				const model = ws.docs.get(file.relPath)?.model;
				if (model) {
					const text = model.getValue();
					const next = text.replace(new RegExp(pattern.source, pattern.flags), replacement);
					if (next !== text) {
						model.pushStackElement();
						model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null);
						model.pushStackElement();
					}
					continue;
				}
				const read = await api.ideReadText(cwd, file.relPath);
				if (read.kind !== "text") continue;
				const next = read.text.replace(new RegExp(pattern.source, pattern.flags), replacement);
				if (next === read.text) continue;
				const written = await api.ideWriteText({
					cwd,
					relPath: file.relPath,
					text: next,
					bom: read.bom,
					expectedMtimeMs: read.mtimeMs,
				});
				if (!written.ok) failures.push(file.relPath);
			} catch {
				failures.push(file.relPath);
			}
		}
		setError(failures.length ? t("ide.search.replaceFailed", { files: failures.join(", ") }) : null);
		setRerun((value) => value + 1);
	};

	const files = result?.files ?? [];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelHeader title={t("ide.search.title")}>
				<PanelIconButton label={t("common.refresh")} onClick={() => setRerun((value) => value + 1)}>
					<VscRefresh />
				</PanelIconButton>
				<PanelIconButton
					label={t("ide.explorer.collapseAll")}
					onClick={() => setCollapsed(new Set(files.map((file) => file.relPath)))}
				>
					<VscCollapseAll />
				</PanelIconButton>
			</PanelHeader>

			<div className="flex shrink-0 gap-1 px-2 pb-2">
				<button
					type="button"
					aria-label={t("ide.search.toggleReplace")}
					title={t("ide.search.toggleReplace")}
					onClick={() => setShowReplace((value) => !value)}
					className="flex w-4 shrink-0 items-start justify-center pt-1 text-muted-foreground hover:text-foreground"
				>
					{showReplace ? <VscChevronDown /> : <VscChevronRight />}
				</button>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className={FIELD_BOX_CLASS_NAME}>
						<input
							ref={inputRef}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") setRerun((value) => value + 1);
							}}
							placeholder={t("ide.search.placeholder")}
							spellCheck={false}
							className={FIELD_CLASS_NAME}
						/>
						<ToggleButton label={t("ide.search.matchCase")} active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>
							<VscCaseSensitive />
						</ToggleButton>
						<ToggleButton label={t("ide.search.wholeWord")} active={wholeWord} onClick={() => setWholeWord((v) => !v)}>
							<VscWholeWord />
						</ToggleButton>
						<ToggleButton label={t("ide.search.regex")} active={regex} onClick={() => setRegex((v) => !v)}>
							<VscRegex />
						</ToggleButton>
					</div>
					{showReplace ? (
						<div className={FIELD_BOX_CLASS_NAME}>
							<input
								value={replace}
								onChange={(event) => setReplace(event.target.value)}
								placeholder={t("ide.search.replacePlaceholder")}
								spellCheck={false}
								className={FIELD_CLASS_NAME}
							/>
							<ToggleButton
								label={t("ide.search.replaceAll")}
								active={false}
								onClick={() => {
									if (files.length) setConfirmReplace(true);
								}}
							>
								<VscReplaceAll />
							</ToggleButton>
						</div>
					) : null}
					<div className="flex justify-end">
						<button
							type="button"
							title={t("ide.search.details")}
							aria-label={t("ide.search.details")}
							onClick={() => setShowDetails((value) => !value)}
							className="rounded px-1 text-muted-foreground hover:bg-[var(--color-background-button-secondary-hover)]"
						>
							<VscEllipsis />
						</button>
					</div>
					{showDetails ? (
						<>
							<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("ide.search.include")}</span>
							<div className={FIELD_BOX_CLASS_NAME}>
								<input
									value={include}
									onChange={(event) => setInclude(event.target.value)}
									placeholder="src/**, *.ts"
									spellCheck={false}
									className={FIELD_CLASS_NAME}
								/>
							</div>
							<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("ide.search.exclude")}</span>
							<div className={FIELD_BOX_CLASS_NAME}>
								<input
									value={exclude}
									onChange={(event) => setExclude(event.target.value)}
									placeholder="*.test.ts, dist"
									spellCheck={false}
									className={FIELD_CLASS_NAME}
								/>
							</div>
						</>
					) : null}
				</div>
			</div>

			<div className="shrink-0 px-3 pb-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
				{error ? (
					<span className="text-destructive">{error}</span>
				) : loading ? (
					t("ide.search.searching")
				) : result ? (
					result.matchCount === 0 ? (
						t("ide.search.noResults")
					) : (
						t(result.truncated ? "ide.search.summaryTruncated" : "ide.search.summary", {
							matches: result.matchCount,
							files: result.files.length,
						})
					)
				) : null}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto pb-4">
				{files.map((file) => {
					const name = file.relPath.slice(file.relPath.lastIndexOf("/") + 1);
					const dir = file.relPath.includes("/") ? file.relPath.slice(0, file.relPath.lastIndexOf("/")) : "";
					const closed = collapsed.has(file.relPath);
					return (
						<div key={file.relPath}>
							<button
								type="button"
								onClick={() =>
									setCollapsed((current) => {
										const next = new Set(current);
										if (next.has(file.relPath)) next.delete(file.relPath);
										else next.add(file.relPath);
										return next;
									})
								}
								className="flex h-[22px] w-full items-center gap-1.5 px-2 text-left text-[length:var(--app-font-size-ui,12px)] hover:bg-[var(--sidebar-accent)]"
								title={file.relPath}
							>
								<span className="shrink-0 text-muted-foreground">{closed ? <VscChevronRight /> : <VscChevronDown />}</span>
								<FileTypeIcon name={name} className="size-3.5 shrink-0" />
								<span className="shrink-0">{name}</span>
								<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{dir}</span>
								<span className="shrink-0 rounded-full bg-[var(--color-background-elevated-secondary)] px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">
									{file.matches.length}
								</span>
							</button>
							{closed
								? null
								: file.matches.map((match) => (
										<button
											key={`${match.line}:${match.column}`}
											type="button"
											onClick={() =>
												ws.open(file.relPath, {
													preview: true,
													line: match.line,
													column: match.column,
													endLine: match.line,
													endColumn: match.column + match.length,
												})
											}
											onDoubleClick={() => ws.open(file.relPath, { preview: false })}
											className="flex h-[22px] w-full items-center gap-2 pl-8 pr-2 text-left font-mono text-[length:var(--app-font-size-ui-xs,10px)] hover:bg-[var(--sidebar-accent)]"
										>
											<span className="w-7 shrink-0 text-right text-muted-foreground/70">{match.line}</span>
											<span className="min-w-0 flex-1 truncate whitespace-pre">
												{match.preview.slice(0, match.previewColumn)}
												<mark className="rounded-sm bg-[color-mix(in_srgb,#e5a50a_40%,transparent)] text-inherit">
													{match.preview.slice(match.previewColumn, match.previewColumn + match.length)}
												</mark>
												{match.preview.slice(match.previewColumn + match.length)}
											</span>
										</button>
									))}
						</div>
					);
				})}
			</div>

			<ConfirmDialog
				open={confirmReplace}
				onOpenChange={setConfirmReplace}
				title={t("ide.search.replaceAllTitle")}
				description={t("ide.search.replaceAllDescription", {
					matches: result?.matchCount ?? 0,
					files: files.length,
					replace: replace || t("ide.search.emptyReplacement"),
				})}
				footer={
					<>
						<Button onClick={() => setConfirmReplace(false)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button autoFocus onClick={() => void replaceAll()} size="sm" variant="destructive">
							{t("ide.search.replaceAll")}
						</Button>
					</>
				}
			/>
		</div>
	);
}
