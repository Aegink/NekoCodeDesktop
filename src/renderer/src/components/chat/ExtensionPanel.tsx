import { useEffect, useRef, useState } from "react";
import type { ExtensionDialog, ExtensionUiAnswer, ExtensionUiSnapshot } from "../../../../shared/agent";
import { errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { CHAT_COLUMN_FRAME_CLASS_NAME, CHAT_COLUMN_GUTTER_CLASS_NAME } from "./composerPickerStyles";
import { cn } from "../../lib/utils";

/**
 * A plugin's question, answered in place. One at a time: the oldest waiting
 * dialog is the one shown, and its card says how many are behind it.
 */
function DialogCard({
	dialog,
	queued,
	onAnswer,
}: {
	dialog: ExtensionDialog;
	queued: number;
	onAnswer: (answer: ExtensionUiAnswer) => Promise<unknown>;
}) {
	const { t } = useTranslation();
	const [value, setValue] = useState(dialog.prefill ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

	useEffect(() => {
		field.current?.focus();
	}, []);

	const send = async (answer: Omit<ExtensionUiAnswer, "id">) => {
		setBusy(true);
		setError("");
		try {
			await onAnswer({ id: dialog.id, ...answer });
		} catch (cause) {
			setError(errorMessage(cause));
			setBusy(false);
		}
	};
	const cancel = () => void send({ cancelled: true });

	return (
		<form
			aria-label={dialog.title}
			className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-muted/30"
			onSubmit={(event) => {
				event.preventDefault();
				if (dialog.kind === "input" || dialog.kind === "editor") void send({ value });
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					cancel();
				}
			}}
		>
			<div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/40 px-3 py-2">
				<span className="shrink-0 text-muted-foreground">{t("extension.dialog")}</span>
				<h3 className="min-w-0 flex-1 truncate font-medium" title={dialog.title}>
					{dialog.title}
				</h3>
				{queued > 0 ? (
					<span className="shrink-0 text-muted-foreground">{t("extension.queued", { count: queued })}</span>
				) : null}
			</div>

			<fieldset disabled={busy} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5">
				{dialog.kind === "confirm" && dialog.message ? (
					<p className="whitespace-pre-wrap break-words">{dialog.message}</p>
				) : null}
				{dialog.kind === "select"
					? (dialog.options ?? []).map((option, index) => (
							<button
								key={`${index}:${option}`}
								type="button"
								onClick={() => void send({ value: option })}
								className="rounded border border-border/60 px-2 py-1.5 text-left whitespace-pre-wrap break-words hover:bg-muted/60 focus:outline-none focus:ring-1 focus:ring-ring"
							>
								{option}
							</button>
						))
					: null}
				{dialog.kind === "input" ? (
					<input
						ref={(element) => {
							field.current = element;
						}}
						value={value}
						placeholder={dialog.placeholder ?? t("extension.inputPlaceholder")}
						onChange={(event) => setValue(event.target.value)}
						className="w-full rounded border border-border bg-background p-2 outline-none focus:ring-1 focus:ring-ring"
					/>
				) : null}
				{dialog.kind === "editor" ? (
					<textarea
						ref={(element) => {
							field.current = element;
						}}
						value={value}
						rows={8}
						onChange={(event) => setValue(event.target.value)}
						className="w-full resize-y rounded border border-border bg-background p-2 font-mono outline-none focus:ring-1 focus:ring-ring"
					/>
				) : null}
			</fieldset>

			<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-muted/40 px-3 py-2">
				{error ? (
					<p role="alert" className="mr-auto min-w-0 truncate text-destructive">
						{error}
					</p>
				) : null}
				{dialog.kind === "confirm" ? (
					<>
						<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void send({ confirmed: false })}>
							{t("extension.no")}
						</Button>
						<Button type="button" size="xs" variant="prominent" disabled={busy} onClick={() => void send({ confirmed: true })}>
							{t("extension.yes")}
						</Button>
					</>
				) : (
					<>
						<Button type="button" size="xs" variant="outline" disabled={busy} onClick={cancel}>
							{t("common.cancel")}
						</Button>
						{dialog.kind === "input" || dialog.kind === "editor" ? (
							<Button type="submit" size="xs" variant="prominent" disabled={busy}>
								{t("extension.ok")}
							</Button>
						) : null}
					</>
				)}
			</div>
		</form>
	);
}

function Widgets({ widgets }: { widgets: ExtensionUiSnapshot["widgets"] }) {
	if (!widgets.length) return null;
	return (
		<>
			{widgets.map((widget) => (
				<pre
					key={widget.key}
					className="max-h-40 shrink-0 overflow-auto rounded-lg border border-border bg-muted/20 px-3 py-2 font-mono text-[length:var(--app-font-size-ui,12px)] whitespace-pre-wrap break-words text-muted-foreground"
				>
					{widget.lines.join("\n")}
				</pre>
			))}
		</>
	);
}

/**
 * What a session's pi plugins put on screen, above the composer: their dialogs,
 * text widgets, status lines and working message — the parts of pi's terminal
 * UI that have a DOM equivalent.
 */
export function ExtensionPanel({
	ui,
	streaming,
	onAnswer,
}: {
	ui: ExtensionUiSnapshot | undefined;
	streaming: boolean;
	/** Absent where nothing can answer — the phone shows that the desktop is waiting. */
	onAnswer?: (answer: ExtensionUiAnswer) => Promise<unknown>;
}) {
	const { t } = useTranslation();
	if (!ui) return null;
	const above = ui.widgets.filter((widget) => widget.placement !== "belowEditor");
	const working = streaming ? ui.working : undefined;
	if (!ui.dialog && !above.length && !ui.statuses.length && !working) return null;
	return (
		<div className={cn("shrink-0 pb-1", CHAT_COLUMN_GUTTER_CLASS_NAME)}>
			<div
				className={cn(
					CHAT_COLUMN_FRAME_CLASS_NAME,
					"flex max-h-[45vh] flex-col gap-2 text-[length:var(--app-font-size-ui,12px)]",
				)}
			>
				{ui.dialog ? (
					onAnswer ? (
						<DialogCard key={ui.dialog.id} dialog={ui.dialog} queued={ui.queued} onAnswer={onAnswer} />
					) : (
						<p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-muted-foreground">
							{t("extension.remote")}
						</p>
					)
				) : null}
				<Widgets widgets={above} />
				{ui.statuses.length || working ? (
					<div aria-label={t("extension.status")} className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
						{working ? <span className="animate-pulse">{working}</span> : null}
						{ui.statuses.map((status) => (
							<span key={status.key} className="min-w-0 truncate" title={status.text}>
								{status.text}
							</span>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

/** Widgets a plugin asked to show below the composer. */
export function ExtensionWidgetsBelow({ ui }: { ui: ExtensionUiSnapshot | undefined }) {
	const below = ui?.widgets.filter((widget) => widget.placement === "belowEditor") ?? [];
	if (!below.length) return null;
	return (
		<div className={cn("shrink-0 pb-2", CHAT_COLUMN_GUTTER_CLASS_NAME)}>
			<div className={cn(CHAT_COLUMN_FRAME_CLASS_NAME, "flex flex-col gap-2")}>
				<Widgets widgets={below} />
			</div>
		</div>
	);
}
