import { describe, expect, test } from "bun:test";
import { declaredIcon } from "./favicon";

describe("declaredIcon", () => {
	test("prefers a small declared icon over a touch icon, resolved against the page", () => {
		const html = `<head>
			<link rel="apple-touch-icon" href="/apple.png">
			<link rel="icon" sizes="192x192" href="/big.png">
			<link rel="icon" sizes="32x32" href="img/32.png">
		</head>`;
		expect(declaredIcon(html, "https://example.com/docs/")).toBe("https://example.com/docs/img/32.png");
	});

	test("accepts the legacy rel and reports none when there is none", () => {
		expect(declaredIcon(`<link rel="shortcut icon" href="https://cdn.example/f.ico">`, "https://example.com/")).toBe("https://cdn.example/f.ico");
		expect(declaredIcon(`<link rel="stylesheet" href="/a.css">`, "https://example.com/")).toBeNull();
	});
});
