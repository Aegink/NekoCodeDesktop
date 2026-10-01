/**
 * Dragging a splitter to resize a pane.
 *
 * Three things make a naive mousemove → setState resize lag behind the pointer,
 * and this handles all of them:
 * - Every move re-rendering the app and re-laying out heavy panes (webviews,
 *   Monaco, xterm) more often than the screen can show it. Moves are folded
 *   into one per frame, and the caller writes the size to the DOM directly,
 *   committing to React state only once, on release.
 * - The pointer crossing a `<webview>` or iframe, which swallows the moves and
 *   stalls the drag. The handle captures the pointer, and the `app-resizing`
 *   class on the root takes those embeds out of hit testing for the duration.
 * - The cursor and text selection flickering as the pointer crosses elements
 *   with their own; the same class pins both.
 */
export interface ResizeDragOptions {
	axis: "x" | "y";
	/** +1 when moving right/down grows the pane, -1 when it shrinks it. */
	sign: 1 | -1;
	initial: number;
	min: number;
	/** Read at every frame: the window can change size mid-drag. */
	max: () => number;
	/** Each frame's size, already clamped and rounded. Write it to the DOM here. */
	onFrame: (size: number) => void;
	/** The final size, once, on release or cancel. Commit and persist it here. */
	onEnd: (size: number) => void;
}

export function startResizeDrag(event: React.PointerEvent<HTMLElement>, options: ResizeDragOptions): void {
	if (event.button !== 0) return;
	event.preventDefault();
	const handle = event.currentTarget;
	const pointerId = event.pointerId;
	const start = options.axis === "x" ? event.clientX : event.clientY;
	const clamp = (value: number) =>
		Math.round(Math.min(Math.max(options.min, options.max()), Math.max(options.min, value)));
	let latest = clamp(options.initial);
	let pending: number | null = null;
	let frame = 0;

	const root = document.documentElement;
	root.classList.add("app-resizing");
	root.dataset.resizeAxis = options.axis;
	try {
		handle.setPointerCapture(pointerId);
	} catch {
		// The pointer is already gone; the window listeners below still see it out.
	}

	const flush = () => {
		frame = 0;
		if (pending === null) return;
		const next = clamp(pending);
		pending = null;
		if (next === latest) return;
		latest = next;
		options.onFrame(next);
	};
	const onMove = (move: PointerEvent) => {
		if (move.pointerId !== pointerId) return;
		pending = options.initial + ((options.axis === "x" ? move.clientX : move.clientY) - start) * options.sign;
		if (!frame) frame = requestAnimationFrame(flush);
	};
	// Captured events still bubble to the window, and without capture the window
	// is the only place they all reach.
	const onEnd = (end: PointerEvent) => {
		if (end.pointerId !== pointerId) return;
		window.removeEventListener("pointermove", onMove);
		window.removeEventListener("pointerup", onEnd);
		window.removeEventListener("pointercancel", onEnd);
		handle.removeEventListener("lostpointercapture", onEnd);
		if (frame) cancelAnimationFrame(frame);
		flush();
		root.classList.remove("app-resizing");
		delete root.dataset.resizeAxis;
		if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
		options.onEnd(latest);
	};
	window.addEventListener("pointermove", onMove);
	window.addEventListener("pointerup", onEnd);
	window.addEventListener("pointercancel", onEnd);
	handle.addEventListener("lostpointercapture", onEnd);
}
