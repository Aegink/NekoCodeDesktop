/**
 * Where each conversation sits when several share the chat area.
 *
 * The arrangements follow Windows 11's snap layouts: halves for two, a tall
 * pane beside two stacked ones for three, quarters for four. A layout is a list
 * of rectangles in reading order, as fractions of the area, so the same order
 * of sessions always lands in the same places.
 */

export const MAX_PANES = 4;

export interface PaneRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

const LAYOUTS: readonly (readonly PaneRect[])[] = [
	[],
	[{ x: 0, y: 0, w: 1, h: 1 }],
	[
		{ x: 0, y: 0, w: 0.5, h: 1 },
		{ x: 0.5, y: 0, w: 0.5, h: 1 },
	],
	[
		{ x: 0, y: 0, w: 0.5, h: 1 },
		{ x: 0.5, y: 0, w: 0.5, h: 0.5 },
		{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
	],
	[
		{ x: 0, y: 0, w: 0.5, h: 0.5 },
		{ x: 0.5, y: 0, w: 0.5, h: 0.5 },
		{ x: 0, y: 0.5, w: 0.5, h: 0.5 },
		{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
	],
];

export function paneRects(count: number): readonly PaneRect[] {
	return LAYOUTS[Math.max(0, Math.min(MAX_PANES, count))];
}

/** The rectangle under a point, or the nearest one for a point on an edge. */
function hit(rects: readonly PaneRect[], x: number, y: number): number {
	const inside = rects.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
	if (inside !== -1) return inside;
	let best = 0;
	let bestDistance = Infinity;
	rects.forEach((r, index) => {
		const distance = (r.x + r.w / 2 - x) ** 2 + (r.y + r.h / 2 - y) ** 2;
		if (distance < bestDistance) {
			best = index;
			bestDistance = distance;
		}
	});
	return best;
}

export interface DropPlan {
	/** Session ids in layout order once the drop lands. */
	order: string[];
	/** Where the dropped session ends up in {@link order}. */
	index: number;
	/** Every pane of the resulting layout, the target among them. */
	zones: readonly PaneRect[];
}

/**
 * What dropping a session at a point would do.
 *
 * A session already on screen moves; a new one is inserted and the layout grows
 * by a pane, the point picking which of the new layout's panes it takes. With
 * all four in use there is no pane to add, so a new session replaces the one it
 * is dropped on. `x` and `y` are fractions of the chat area.
 */
export function planDrop(current: readonly string[], dragged: string, x: number, y: number): DropPlan {
	const others = current.filter((id) => id !== dragged);
	if (others.length >= MAX_PANES) {
		const zones = paneRects(MAX_PANES);
		const index = hit(zones, x, y);
		const order = others.slice(0, MAX_PANES);
		order[index] = dragged;
		return { order, index, zones };
	}
	const zones = paneRects(others.length + 1);
	const index = hit(zones, x, y);
	const order = [...others];
	order.splice(index, 0, dragged);
	return { order, index, zones };
}
