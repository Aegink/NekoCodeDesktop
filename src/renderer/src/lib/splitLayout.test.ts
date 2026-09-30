import { describe, expect, test } from "bun:test";
import { MAX_PANES, paneRects, planDrop } from "./splitLayout";

describe("paneRects", () => {
	test("each layout tiles the whole area", () => {
		for (let count = 1; count <= MAX_PANES; count++) {
			const area = paneRects(count).reduce((sum, r) => sum + r.w * r.h, 0);
			expect(area).toBeCloseTo(1);
		}
	});
});

describe("planDrop", () => {
	test("a session dropped on an empty area fills it", () => {
		expect(planDrop([], "a", 0.5, 0.5)).toMatchObject({ order: ["a"], index: 0 });
	});

	test("the half under the pointer decides the side", () => {
		expect(planDrop(["a"], "b", 0.2, 0.5).order).toEqual(["b", "a"]);
		expect(planDrop(["a"], "b", 0.8, 0.5).order).toEqual(["a", "b"]);
	});

	test("a third pane stacks on the right or takes the tall left", () => {
		expect(planDrop(["a", "b"], "c", 0.7, 0.8)).toMatchObject({ order: ["a", "b", "c"], index: 2 });
		expect(planDrop(["a", "b"], "c", 0.1, 0.1)).toMatchObject({ order: ["c", "a", "b"], index: 0 });
	});

	test("a full grid swaps out the pane dropped on", () => {
		expect(planDrop(["a", "b", "c", "d"], "e", 0.2, 0.8)).toMatchObject({ order: ["a", "b", "e", "d"], index: 2 });
	});

	test("a session already on screen moves instead of doubling", () => {
		expect(planDrop(["a", "b"], "a", 0.9, 0.5).order).toEqual(["b", "a"]);
		expect(planDrop(["a", "b", "c", "d"], "a", 0.9, 0.9).order).toEqual(["b", "c", "d", "a"]);
	});
});
