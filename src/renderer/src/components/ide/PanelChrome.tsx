import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "../ui/icon-button";

/** The title row every side panel opens with: a small caps label and its actions. */
export function PanelHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex h-9 shrink-0 items-center gap-0.5 pl-3 pr-1.5">
			<span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-xs,10px)] font-semibold uppercase tracking-wide text-muted-foreground">
				{title}
			</span>
			{children}
		</div>
	);
}

export function PanelIconButton({
	label,
	onClick,
	active,
	disabled,
	children,
	className,
}: {
	label: string;
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
	active?: boolean;
	disabled?: boolean;
	children: ReactNode;
	className?: string;
}) {
	return (
		<IconButton
			label={label}
			tooltip={label}
			tooltipSide="bottom"
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"size-6 text-muted-foreground [&_svg]:size-3.5",
				active && "bg-[var(--color-background-button-secondary-hover)] text-foreground",
				className,
			)}
		>
			{children}
		</IconButton>
	);
}
