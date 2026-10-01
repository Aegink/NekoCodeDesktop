import { useState, useSyncExternalStore } from "react";
import { VscError, VscSourceControl, VscSparkle, VscWarning } from "react-icons/vsc";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui/spinner";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import type { EditorAreaHandle, EditorStatus } from "./EditorArea";
import type { IdeWorkspace } from "./ide-store";
import { setTabCompletionEnabled, tabCompletionStore } from "./tab-completion";

/** The languages offered when the user overrides detection; Monaco knows many more. */
const COMMON_LANGUAGES: Array<[string, string]> = [
	["plaintext", "Plain Text"],
	["typescript", "TypeScript"],
	["javascript", "JavaScript"],
	["json", "JSON"],
	["markdown", "Markdown"],
	["html", "HTML"],
	["css", "CSS"],
	["scss", "SCSS"],
	["python", "Python"],
	["rust", "Rust"],
	["go", "Go"],
	["java", "Java"],
	["kotlin", "Kotlin"],
	["csharp", "C#"],
	["cpp", "C++"],
	["c", "C"],
	["shell", "Shell"],
	["powershell", "PowerShell"],
	["yaml", "YAML"],
	["xml", "XML"],
	["sql", "SQL"],
	["dockerfile", "Dockerfile"],
];

const noSubscribe = () => () => undefined;
const noVersion = () => 0;

function Item({
	children,
	onClick,
	title,
	className,
}: {
	children: React.ReactNode;
	onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
	title?: string;
	className?: string;
}) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			disabled={!onClick}
			className={cn(
				"flex h-full shrink-0 items-center gap-1 px-2 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground",
				onClick && "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
				className,
			)}
		>
			{children}
		</button>
	);
}

export function StatusBar({
	ws,
	status,
	editor,
	branch,
	streaming,
	onOpenScm,
}: {
	ws: IdeWorkspace | null;
	status: EditorStatus | null;
	editor: EditorAreaHandle | null;
	branch: string | null;
	streaming: boolean;
	onOpenScm: () => void;
}) {
	const { t } = useTranslation();
	useSyncExternalStore(ws?.subscribe ?? noSubscribe, ws?.getVersion ?? noVersion);
	const [menu, setMenu] = useState<ContextMenuState | null>(null);
	const completion = useSyncExternalStore(tabCompletionStore.subscribe, tabCompletionStore.getSnapshot);

	const menuAt = (event: React.MouseEvent<HTMLButtonElement>, items: ContextMenuState["items"]) => {
		const box = event.currentTarget.getBoundingClientRect();
		setMenu({ x: box.left, y: box.top - 8 - items.length * 26, items });
	};

	return (
		<footer className="flex h-[22px] shrink-0 items-stretch border-t border-[color:var(--app-surface-divider)]">
			{branch ? (
				<Item onClick={onOpenScm} title={t("ide.scm.title")}>
					<VscSourceControl className="size-3" />
					{branch}
				</Item>
			) : null}
			{status ? (
				<Item title={t("ide.status.problems")}>
					<VscError className="size-3" />
					{status.errors}
					<VscWarning className="ml-1 size-3" />
					{status.warnings}
				</Item>
			) : null}
			{streaming ? (
				<Item>
					<Spinner className="size-3" />
					{t("ide.status.agentWorking")}
				</Item>
			) : null}
			<div className="flex-1" />
			{status ? (
				<>
					<Item onClick={() => editor?.gotoLine()} title={t("ide.status.gotoLine")}>
						{t("ide.status.position", { line: status.line, column: status.column })}
						{status.selected > 0 ? ` ${t("ide.status.selected", { count: status.selected })}` : ""}
						{status.cursors > 1 ? ` ${t("ide.status.cursors", { count: status.cursors })}` : ""}
					</Item>
					<Item
						title={t("ide.status.indentation")}
						onClick={(event) =>
							menuAt(event, [
								...[2, 4, 8].map((size) => ({
									label: t("ide.status.spaces", { size }),
									onSelect: () => editor?.setIndentation(true, size),
								})),
								{ kind: "separator" as const },
								...[2, 4, 8].map((size) => ({
									label: t("ide.status.tabs", { size }),
									onSelect: () => editor?.setIndentation(false, size),
								})),
							])
						}
					>
						{status.insertSpaces ? t("ide.status.spaces", { size: status.tabSize }) : t("ide.status.tabs", { size: status.tabSize })}
					</Item>
					<Item title={t("ide.status.encoding")}>{status.bom ? "UTF-8 BOM" : "UTF-8"}</Item>
					<Item title={t("ide.status.eol")} onClick={() => editor?.setEol(status.eol === "LF" ? "CRLF" : "LF")}>
						{status.eol}
					</Item>
					<Item
						title={t("ide.status.language")}
						onClick={(event) =>
							menuAt(
								event,
								COMMON_LANGUAGES.map(([id, label]) => ({ label, onSelect: () => editor?.setLanguage(id) })),
							)
						}
					>
						{status.languageLabel}
					</Item>
				</>
			) : null}
			<Item
				onClick={() => void setTabCompletionEnabled(completion.state === "off").catch(() => {})}
				title={
					completion.state === "error" && completion.error
						? completion.error
						: t(`ide.status.tab.${completion.state}Hint` as const)
				}
				className={cn(completion.state === "error" && "text-[var(--warning,#d97706)]")}
			>
				{completion.state === "loading" ? <Spinner className="size-3" /> : <VscSparkle className="size-3" />}
				{t(completion.state === "off" ? "ide.status.tab.off" : "ide.status.tab.on")}
			</Item>
			{ws ? (
				<Item onClick={() => ws.setAutoSave(!ws.autoSave)} title={t("ide.status.autoSaveHint")}>
					{ws.autoSave ? t("ide.status.autoSaveOn") : t("ide.status.autoSaveOff")}
				</Item>
			) : null}
			<ContextMenu menu={menu} onClose={() => setMenu(null)} />
		</footer>
	);
}
