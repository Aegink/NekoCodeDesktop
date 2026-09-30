import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PaneSlot } from "../hooks/useSplitPanes";
import { PANE_EXIT_MS } from "../hooks/useSplitPanes";
import { draggedSession, endSessionDrag, isSessionDrag, type DraggedSession } from "../lib/sessionDrag";
import { paneRects, planDrop, type DropPlan, type PaneRect } from "../lib/splitLayout";
import { cn } from "../lib/utils";

/** Room around the panes and between them while the area is split, in px. */
const OUTER = 6;
const GAP = 6;
/**
 * Windows 11's snap curve: a fast start that settles gently, with no overshoot.
 * Every pane movement and the snap preview share it, so they read as one motion.
 */
const SNAP_EASE = "cubic-bezier(0.1, 0.9, 0.2, 1)";
const MOVE_MS = 380;
const ENTER_MS = 320;

interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A rectangle of the area as CSS, with the outer margin and half a gap on each inner edge. */
function placement(rect: PaneRect, split: boolean): React.CSSProperties {
	const edge = (start: number, size: number) => {
		const lead = !split ? 0 : start <= 0 ? OUTER : GAP / 2;
		const trail = !split ? 0 : start + size >= 1 ? OUTER : GAP / 2;
		return { start: `calc(${start * 100}% + ${lead}px)`, size: `calc(${size * 100}% - ${lead + trail}px)` };
	};
	const x = edge(rect.x, rect.w);
	const y = edge(rect.y, rect.h);
	return { left: x.start, top: y.start, width: x.size, height: y.size };
}

function measure(element: HTMLElement): Box {
	// Offsets ignore transforms, so a pane mid-animation still reports where it is headed.
	return { x: element.offsetLeft, y: element.offsetTop, w: element.offsetWidth, h: element.offsetHeight };
}

/** Where a pane is actually drawn: its last box, moved by whatever animation is playing on it. */
function visualBox(element: HTMLElement, box: Box): Box {
	const transform = getComputedStyle(element).transform;
	if (!transform || transform === "none") return box;
	const matrix = new DOMMatrixReadOnly(transform);
	return { x: box.x + matrix.e, y: box.y + matrix.f, w: box.w * matrix.a, h: box.h * matrix.d };
}

function reducedMotion(): boolean {
	return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** A scale about the centre, written for the top-left origin the FLIP transforms need. */
function centredScale(box: Box, scale: number): string {
	return `translate(${(box.w * (1 - scale)) / 2}px, ${(box.h * (1 - scale)) / 2}px) scale(${scale})`;
}

interface SplitGridProps {
	/** Every pane, leaving ones included, in stable DOM order. */
	slots: PaneSlot[];
	/** Live panes in layout order. */
	live: PaneSlot[];
	focused: string;
	/** Sessions on screen in layout order; empty on the welcome screen. */
	sessions: string[];
	acceptDrops: boolean;
	renderPane: (slot: PaneSlot) => ReactNode;
	onFocus: (key: string) => void;
	onDrop: (session: DraggedSession, plan: DropPlan) => void;
}

/**
 * The chat area as up to four panes, and the snap preview for dropping more in.
 *
 * Panes are absolutely placed and never re-ordered in the DOM: a pane that
 * moves keeps its element, so the chat inside it neither remounts nor loses
 * its scroll position. Movement is FLIP — the pane is laid out at its new place
 * at once and a transform carries it there from the old one — which keeps the
 * transcripts from reflowing on every frame of the animation.
 */
export function SplitGrid({ slots, live, focused, sessions, acceptDrops, renderPane, onFocus, onDrop }: SplitGridProps) {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const elements = useRef(new Map<string, HTMLDivElement>());
	const boxes = useRef(new Map<string, Box>());
	const mounted = useRef(false);
	const [plan, setPlan] = useState<DropPlan | null>(null);
	const split = live.length > 1;
	const layout = paneRects(live.length);
	const liveRef = useRef(live);
	liveRef.current = live;

	const signature = `${slots.map((slot) => `${slot.key}:${slot.leaving ?? ""}`).join(",")}|${live.map((slot) => slot.key).join(",")}`;
	useLayoutEffect(() => {
		const animate = mounted.current && !reducedMotion();
		mounted.current = true;
		for (const slot of slots) {
			const element = elements.current.get(slot.key);
			if (!element) continue;
			const previous = boxes.current.get(slot.key);
			if (slot.leaving !== undefined) {
				if (element.dataset.leaving) continue;
				element.dataset.leaving = "1";
				if (!animate || !previous) continue;
				const from = visualBox(element, previous);
				element.getAnimations().forEach((animation) => animation.cancel());
				element.animate(
					[
						{ opacity: 1, transform: `translate(${from.x - previous.x}px, ${from.y - previous.y}px) scale(${from.w / previous.w}, ${from.h / previous.h})` },
						{ opacity: 0, transform: centredScale(previous, 0.94) },
					],
					{ duration: PANE_EXIT_MS, easing: "cubic-bezier(0.7, 0, 0.84, 0)", fill: "forwards" },
				);
				continue;
			}
			const next = measure(element);
			boxes.current.set(slot.key, next);
			if (!animate) continue;
			if (!previous) {
				element.animate(
					[
						{ opacity: 0, transform: centredScale(next, 0.94) },
						{ opacity: 1, transform: "none" },
					],
					{ duration: ENTER_MS, easing: SNAP_EASE },
				);
				continue;
			}
			if (previous.x === next.x && previous.y === next.y && previous.w === next.w && previous.h === next.h) continue;
			const from = visualBox(element, previous);
			element.getAnimations().forEach((animation) => animation.cancel());
			element.animate(
				[
					{ transform: `translate(${from.x - next.x}px, ${from.y - next.y}px) scale(${from.w / next.w}, ${from.h / next.h})` },
					{ transform: "none" },
				],
				{ duration: MOVE_MS, easing: SNAP_EASE },
			);
		}
		for (const key of [...boxes.current.keys()]) if (!slots.some((slot) => slot.key === key)) boxes.current.delete(key);
	}, [signature]);

	// A window resize moves every pane without animating; the boxes the next
	// animation starts from have to follow.
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const observer = new ResizeObserver(() => {
			for (const slot of liveRef.current) {
				const element = elements.current.get(slot.key);
				if (element && element.getAnimations().length === 0) boxes.current.set(slot.key, measure(element));
			}
		});
		observer.observe(root);
		return () => observer.disconnect();
	}, []);

	// A drag that ends anywhere — dropped elsewhere, or cancelled — takes the preview with it.
	useEffect(() => {
		if (!plan) return;
		const clear = () => setPlan(null);
		window.addEventListener("dragend", clear);
		window.addEventListener("drop", clear);
		return () => {
			window.removeEventListener("dragend", clear);
			window.removeEventListener("drop", clear);
		};
	}, [plan]);

	// Native listeners, not React props: each pane's chat is portalled in from
	// App, and React routes a portal's events through App rather than through
	// this grid. Captured on the way down, before the composer — whose own drop
	// target takes images, and a session is not one — can see them.
	const latest = useRef({ sessions, acceptDrops, onDrop, onFocus });
	latest.current = { sessions, acceptDrops, onDrop, onFocus };
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const planAt = (event: DragEvent): DropPlan | null => {
			const session = draggedSession();
			if (!session) return null;
			const rect = root.getBoundingClientRect();
			const x = (event.clientX - rect.left) / Math.max(1, rect.width);
			const y = (event.clientY - rect.top) / Math.max(1, rect.height);
			return planDrop(latest.current.sessions, session.id, x, y);
		};
		const accepts = (event: DragEvent) => latest.current.acceptDrops && isSessionDrag(event);
		const onDragOver = (event: DragEvent) => {
			if (!accepts(event)) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
			const next = planAt(event);
			if (!next) return;
			setPlan((current) =>
				current && current.index === next.index && current.order.join() === next.order.join() ? current : next,
			);
		};
		const onDragLeave = (event: DragEvent) => {
			if (!root.contains(event.relatedTarget as Node | null)) setPlan(null);
		};
		const onDropEvent = (event: DragEvent) => {
			if (!accepts(event)) return;
			event.preventDefault();
			event.stopPropagation();
			const session = draggedSession();
			const next = planAt(event);
			setPlan(null);
			endSessionDrag();
			if (session && next) latest.current.onDrop(session, next);
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element | null;
			const pane = target?.closest<HTMLElement>("[data-pane-key]");
			// Closing a pane is not a reason to open its session first.
			if (!pane || pane.dataset.leaving || target?.closest("[data-pane-control]")) return;
			latest.current.onFocus(pane.dataset.paneKey!);
		};
		root.addEventListener("dragenter", onDragOver, true);
		root.addEventListener("dragover", onDragOver, true);
		root.addEventListener("dragleave", onDragLeave);
		root.addEventListener("drop", onDropEvent, true);
		root.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			root.removeEventListener("dragenter", onDragOver, true);
			root.removeEventListener("dragover", onDragOver, true);
			root.removeEventListener("dragleave", onDragLeave);
			root.removeEventListener("drop", onDropEvent, true);
			root.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, []);

	const previewSplit = plan ? plan.zones.length > 1 : false;

	return (
		<div
			ref={rootRef}
			data-split={split ? "" : undefined}
			data-dragging={plan ? "" : undefined}
			className={cn("split-grid relative min-h-0 min-w-0 flex-1", split && "split-grid-split")}
		>
			{slots.map((slot) => {
				const index = live.indexOf(slot);
				const leaving = slot.leaving !== undefined;
				const box = leaving ? boxes.current.get(slot.key) : undefined;
				const style: React.CSSProperties = leaving
					? box
						? { left: box.x, top: box.y, width: box.w, height: box.h }
						: { display: "none" }
					: placement(layout[index] ?? layout[0], split);
				return (
					<div
						key={slot.key}
						ref={(element) => {
							if (element) elements.current.set(slot.key, element);
							else elements.current.delete(slot.key);
						}}
						aria-hidden={leaving || undefined}
						inert={leaving || undefined}
						data-focused={split && slot.key === focused ? "" : undefined}
						className={cn("split-pane absolute flex min-h-0 min-w-0 flex-col", leaving && "pointer-events-none z-0")}
						data-pane-key={slot.key}
						style={style}
					>
						{renderPane(slot)}
					</div>
				);
			})}
			{plan ? (
				<div aria-hidden="true" className="split-snap-layer pointer-events-none absolute inset-0 z-40">
					{plan.zones.map((zone, index) =>
						index === plan.index ? null : (
							<div
								className="split-snap-zone absolute"
								key={`${plan.zones.length}:${index}`}
								style={placement(zone, previewSplit)}
							/>
						),
					)}
					<div className="split-snap-preview absolute" style={placement(plan.zones[plan.index], previewSplit)} />
				</div>
			) : null}
		</div>
	);
}
