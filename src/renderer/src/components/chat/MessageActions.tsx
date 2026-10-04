import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { AssistantCellData } from "../../../../shared/transcript";
import { useTranslation } from "../../i18n";
import { CheckIcon, CopyIcon, GaugeIcon, GitForkIcon, Loader2Icon } from "../../lib/icons";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "../../surfaceStyles";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageDetails } from "./UsagePanel";

function ActionButton({
	label,
	onClick,
	disabled,
	pressed,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	pressed?: boolean;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-label={label}
						aria-pressed={pressed}
						disabled={disabled}
						onClick={onClick}
						className={cn(
							"inline-flex size-6 items-center justify-center rounded-md transition-colors",
							MUTED_LABEL_TEXT_CLASS_NAME,
							"hover:bg-[var(--color-background-elevated-secondary)] hover:text-foreground",
							"disabled:pointer-events-none disabled:opacity-50",
							pressed && "bg-[var(--color-background-elevated-secondary)] text-foreground",
						)}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipPopup>{label}</TooltipPopup>
		</Tooltip>
	);
}

/**
 * What can be done with the reply that closes a turn, Codex-style: copy it,
 * branch the conversation from it, and open what the turn cost.
 */
export function MessageActions({
	cell,
	onFork,
}: {
	cell: AssistantCellData;
	/** Branch the conversation at this reply; absent where branching is not offered. */
	onFork?: (cellId: string) => Promise<void> | void;
}) {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	const [forking, setForking] = useState(false);
	const [usageOpen, setUsageOpen] = useState(false);
	const usageId = useId();
	const reset = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(reset.current), []);

	const copy = () => {
		void copyText(cell.text)
			.then(() => {
				setCopied(true);
				window.clearTimeout(reset.current);
				reset.current = window.setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => undefined);
	};

	const fork = () => {
		if (!onFork || forking) return;
		setForking(true);
		void Promise.resolve(onFork(cell.id)).finally(() => setForking(false));
	};

	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="-ml-1 flex items-center gap-0.5">
				<ActionButton label={t(copied ? "message.copied" : "message.copy")} onClick={copy}>
					{copied ? <CheckIcon className="tool-settle size-3.5" /> : <CopyIcon className="size-3.5" />}
				</ActionButton>
				{onFork ? (
					<ActionButton label={t("message.branch")} onClick={fork} disabled={forking}>
						{forking ? <Loader2Icon className="size-3.5 animate-spin" /> : <GitForkIcon className="size-3.5" />}
					</ActionButton>
				) : null}
				{cell.usage ? (
					<ActionButton label={t("usage.title")} pressed={usageOpen} onClick={() => setUsageOpen((value) => !value)}>
						<GaugeIcon className="size-3.5" />
					</ActionButton>
				) : null}
			</div>
			{usageOpen && cell.usage ? (
				<div id={usageId} className="tool-expand">
					<UsageDetails usage={cell.usage} />
				</div>
			) : null}
		</div>
	);
}
