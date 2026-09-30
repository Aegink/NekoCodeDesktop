import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";
import { APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME } from "../chat/composerPickerStyles";

export type ContextMenuItem =
	| { kind?: "item"; label: string; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
	| { kind: "separator" };

export interface ContextMenuState {
	x: number;
	y: number;
	items: ContextMenuItem[];
}

/**
 * A right-click menu at the pointer. The app's menus are anchored to a trigger
 * element; a context menu has no trigger, only a point, so it is its own small
 * thing — same surface, closed by Escape, a click elsewhere, or a scroll.
 */
export function ContextMenu({ menu, onClose }: { menu: ContextMenuState | null; onClose: () => void }) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	const [highlight, setHighlight] = useState(-1);

	useLayoutEffect(() => {
		if (!menu) {
			setPosition(null);
			return;
		}
		const box = ref.current?.getBoundingClientRect();
		const width = box?.width ?? 200;
		const height = box?.height ?? 200;
		setPosition({
			left: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
			top: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)),
		});
		setHighlight(-1);
	}, [menu]);

	useEffect(() => {
		if (!menu) return;
		const close = (event: Event) => {
			if (event.target instanceof Node && ref.current?.contains(event.target)) return;
			onClose();
		};
		const onKey = (event: KeyboardEvent) => {
			const actionable = menu.items
				.map((item, index) => ({ item, index }))
				.filter(({ item }) => item.kind !== "separator" && !item.disabled);
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
			} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const at = actionable.findIndex(({ index }) => index === highlight);
				const next = event.key === "ArrowDown" ? at + 1 : at - 1;
				const wrapped = actionable[(next + actionable.length) % actionable.length];
				if (wrapped) setHighlight(wrapped.index);
			} else if (event.key === "Enter") {
				const item = menu.items[highlight];
				if (item && item.kind !== "separator" && !item.disabled) {
					event.preventDefault();
					onClose();
					item.onSelect();
				}
			}
		};
		window.addEventListener("mousedown", close, true);
		window.addEventListener("wheel", close, true);
		window.addEventListener("blur", onClose);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("mousedown", close, true);
			window.removeEventListener("wheel", close, true);
			window.removeEventListener("blur", onClose);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [menu, onClose, highlight]);

	if (!menu) return null;
	return createPortal(
		<div
			ref={ref}
			role="menu"
			className={cn(APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME, "fixed z-[70] min-w-48 p-1", !position && "invisible")}
			style={position ?? { left: menu.x, top: menu.y }}
			onContextMenu={(event) => event.preventDefault()}
		>
			{menu.items.map((item, index) =>
				item.kind === "separator" ? (
					<div key={`sep-${index}`} className="mx-1 my-1 h-px bg-[color:var(--app-surface-divider)]" />
				) : (
					<button
						key={item.label}
						type="button"
						role="menuitem"
						disabled={item.disabled}
						onMouseEnter={() => setHighlight(index)}
						onClick={() => {
							onClose();
							item.onSelect();
						}}
						className={cn(
							"flex w-full items-center gap-4 rounded-lg px-2 py-1 text-left text-[length:var(--app-font-size-ui,12px)] outline-none disabled:opacity-50",
							highlight === index && "bg-[var(--color-background-button-secondary-hover)]",
							item.danger && "text-destructive",
						)}
					>
						<span className="flex-1">{item.label}</span>
						{item.shortcut ? (
							<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{item.shortcut}</span>
						) : null}
					</button>
				),
			)}
		</div>,
		document.body,
	);
}
