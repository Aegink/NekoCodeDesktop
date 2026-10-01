import { useEffect, useState } from "react";
import {
	MAX_PROMPT_LENGTH,
	MAX_PROMPT_NAME_LENGTH,
	PROMPT_PLACEHOLDERS,
	type CustomPrompt,
	type PromptsSnapshot,
	type SavePromptRequest,
} from "../../../../shared/prompts";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { PencilIcon, PlusIcon, TrashCanIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SETTINGS_TEXTAREA_CLASS_NAME, SettingsDialog } from "./SettingsDialog";

const HINT_CLASS_NAME = "text-[length:var(--app-font-size-ui-xs,10px)] leading-relaxed text-muted-foreground";

/** Adding (no `prompt`) or editing one of the user's prompts. */
function PromptEditor({
	prompt,
	active,
	busy,
	error,
	onClose,
	onSave,
}: {
	prompt?: CustomPrompt;
	active: boolean;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onSave: (request: SavePromptRequest) => void;
}) {
	const { t } = useTranslation();
	const [name, setName] = useState(prompt?.name ?? "");
	const [content, setContent] = useState(prompt?.content ?? "");
	const tooLong = content.length > MAX_PROMPT_LENGTH;
	const invalid = busy || tooLong || !name.trim() || !content.trim();
	const save = (activate: boolean) =>
		onSave({ ...(prompt ? { id: prompt.id } : {}), name: name.trim(), content, activate });

	return (
		<SettingsDialog
			wide
			title={t(prompt ? "prompts.editTitle" : "prompts.addTitle")}
			onClose={onClose}
			footer={
				<>
					<span className={cn("mr-auto", HINT_CLASS_NAME, tooLong && "text-destructive")}>
						{t("prompts.chars", { count: content.length.toLocaleString() })}
					</span>
					<Button onClick={onClose} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
					{active ? null : (
						<Button disabled={invalid} onClick={() => save(true)} size="sm" variant="ghost">
							{t("prompts.saveAndUse")}
						</Button>
					)}
					<Button disabled={invalid} onClick={() => save(false)} size="sm" variant="subtle">
						{t("common.save")}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-1">
				<Label>{t("prompts.name")}</Label>
				<Input
					autoFocus={!prompt}
					maxLength={MAX_PROMPT_NAME_LENGTH}
					placeholder={t("prompts.namePlaceholder")}
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-1">
				<Label>{t("prompts.content")}</Label>
				<textarea
					autoFocus={!!prompt}
					aria-label={t("prompts.content")}
					className={cn(SETTINGS_TEXTAREA_CLASS_NAME, "min-h-[20rem] flex-1")}
					placeholder={t("prompts.contentPlaceholder")}
					spellCheck={false}
					value={content}
					onChange={(event) => setContent(event.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-0.5">
				<p className={HINT_CLASS_NAME}>{t("prompts.runtimeNote")}</p>
				<p className={HINT_CLASS_NAME}>{t("prompts.placeholders", { tokens: PROMPT_PLACEHOLDERS.join(", ") })}</p>
				<p className={HINT_CLASS_NAME}>{t("prompts.applyNote")}</p>
			</div>
			{error ? <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</p> : null}
		</SettingsDialog>
	);
}

/** The ring of a radio option; filled when it is the one in use. */
function RadioMark({ checked }: { checked: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-3.5 shrink-0 items-center justify-center rounded-full border",
				checked ? "border-[var(--color-text-accent,#2563eb)]" : "border-[color:var(--color-border)]",
			)}
		>
			{checked ? <span className="size-1.5 rounded-full bg-[var(--color-text-accent,#2563eb)]" /> : null}
		</span>
	);
}

/**
 * Which system prompt sessions are built on: NekoCode's default one — listed,
 * never shown — or one the user wrote.
 */
export function PromptSettings() {
	const { t } = useTranslation();
	const [snapshot, setSnapshot] = useState<PromptsSnapshot | null>(null);
	const [editing, setEditing] = useState<CustomPrompt | "new" | null>(null);
	const [removing, setRemoving] = useState<CustomPrompt | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.promptsList().then(setSnapshot).catch((cause: unknown) => setError(errorMessage(cause)));
	}, []);

	const run = (request: Promise<PromptsSnapshot>, done?: () => void) => {
		setBusy(true);
		setError(null);
		request
			.then((next) => {
				setSnapshot(next);
				done?.();
			})
			.catch((cause: unknown) => setError(errorMessage(cause)))
			.finally(() => setBusy(false));
	};

	const activeId = snapshot?.activeId ?? null;
	const select = (id: string | null) => {
		if (snapshot && id !== activeId && !busy) run(api.promptsSetActive(id));
	};

	const option = (id: string | null, checked: boolean, label: React.ReactNode, hint: React.ReactNode) => (
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			disabled={!snapshot || busy}
			onClick={() => select(id)}
			className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] rounded-lg"
		>
			<RadioMark checked={checked} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-center gap-2">{label}</span>
				<span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{hint}</span>
			</span>
		</button>
	);

	const inUse = (
		<span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-text-accent,#2563eb)_12%,transparent)] px-1.5 py-px text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--color-text-accent,#2563eb)]">
			{t("prompts.inUse")}
		</span>
	);

	return (
		<section className="flex flex-col gap-4 text-[length:var(--app-font-size-ui,12px)]">
			<p className="leading-relaxed text-muted-foreground">{t("prompts.intro")}</p>

			<div className="flex flex-col gap-1">
				<div className="flex items-center justify-between gap-2 px-1">
					<h3 className="text-xs text-muted-foreground">{t("settings.section.prompts")}</h3>
					<Button
						disabled={!snapshot || busy}
						onClick={() => {
							setError(null);
							setEditing("new");
						}}
						size="xs"
						variant="chrome-outline"
					>
						<PlusIcon className="size-3.5" />
						{t("prompts.add")}
					</Button>
				</div>
				<div
					role="radiogroup"
					aria-label={t("settings.section.prompts")}
					className="divide-y divide-[color:var(--app-surface-divider)] rounded-xl border border-[color:var(--app-surface-divider)]"
				>
					<div className="flex items-center pr-3">
						{option(
							null,
							activeId === null,
							<>
								<span className="truncate">{t("prompts.default")}</span>
								<span className="shrink-0 rounded-full bg-[var(--color-background-button-secondary-hover)] px-1.5 py-px text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
									{t("prompts.badgeBuiltin")}
								</span>
								{activeId === null ? inUse : null}
							</>,
							t("prompts.defaultHint"),
						)}
					</div>
					{snapshot?.prompts.map((prompt) => (
						<div key={prompt.id} className="flex items-center gap-1 pr-2">
							{option(
								prompt.id,
								activeId === prompt.id,
								<>
									<span className="truncate">{prompt.name}</span>
									{activeId === prompt.id ? inUse : null}
								</>,
								`${t("prompts.chars", { count: prompt.content.length.toLocaleString() })} · ${prompt.content.trim().split("\n")[0]}`,
							)}
							<Button
								aria-label={`${t("common.edit")} ${prompt.name}`}
								disabled={busy}
								onClick={() => {
									setError(null);
									setEditing(prompt);
								}}
								size="icon-xs"
								title={t("common.edit")}
								variant="ghost"
							>
								<PencilIcon className="size-3.5" />
							</Button>
							<Button
								aria-label={`${t("common.delete")} ${prompt.name}`}
								disabled={busy}
								onClick={() => setRemoving(prompt)}
								size="icon-xs"
								title={t("common.delete")}
								variant="ghost"
							>
								<TrashCanIcon className="size-3.5" />
							</Button>
						</div>
					))}
				</div>
				{snapshot && !snapshot.prompts.length ? <p className={cn("px-1 pt-1", HINT_CLASS_NAME)}>{t("prompts.empty")}</p> : null}
			</div>

			<p className="border-t border-[color:var(--app-surface-divider)] pt-4 text-xs leading-relaxed text-muted-foreground">
				{t("prompts.scopeNote")}
			</p>

			{error && !editing ? (
				<p role="alert" className="rounded-lg bg-destructive/10 p-3 text-destructive">
					{error}
				</p>
			) : null}

			{editing ? (
				<PromptEditor
					prompt={editing === "new" ? undefined : editing}
					active={editing !== "new" && editing.id === activeId}
					busy={busy}
					error={error}
					onClose={() => {
						setEditing(null);
						setError(null);
					}}
					onSave={(request) => run(api.promptsSave(request), () => setEditing(null))}
				/>
			) : null}

			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setRemoving(null);
				}}
				title={t("prompts.removeTitle", { name: removing?.name ?? "" })}
				description={t("prompts.removeDescription")}
				footer={
					<>
						<Button disabled={busy} onClick={() => setRemoving(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button
							disabled={busy}
							onClick={() => removing && run(api.promptsRemove(removing.id), () => setRemoving(null))}
							size="sm"
							variant="destructive"
						>
							{t("common.delete")}
						</Button>
					</>
				}
			/>
		</section>
	);
}
