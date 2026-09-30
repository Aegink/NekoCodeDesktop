import { useLayoutEffect, useRef } from "react";

/**
 * Where a conversation view is shown.
 *
 * Each chat pane is rendered once, through a portal, into a detached host
 * element; each layout has a slot for it, and the active slot adopts that element. Moving the
 * DOM node instead of rendering the chat twice is what lets it cross between
 * the Agent and IDE layouts with its draft, scroll position and streaming turn
 * intact — a remount would lose all three.
 */
export function ChatSlot({ host, active }: { host: HTMLElement; active: boolean }) {
	const ref = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const slot = ref.current;
		// Replacing rather than appending: the IDE's slot is handed another pane's
		// host when the focus moves, and must not go on showing the last one too.
		if (active && slot && host.parentNode !== slot) slot.replaceChildren(host);
	}, [active, host]);
	return <div ref={ref} className="flex min-h-0 min-w-0 flex-1 flex-col" />;
}

/** The element the chat is portalled into; created once per window. */
export function createChatHost(): HTMLElement {
	const host = document.createElement("div");
	host.className = "flex min-h-0 min-w-0 flex-1 flex-col";
	return host;
}
