import { afterAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch as undiciFetch } from "undici";
import { proxyDispatcher } from "../../src/main/network-proxy";

const server = createServer((_req, res) => res.end("direct"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
afterAll(() => server.close());

// Nothing listens on port 9: a request that goes through this proxy fails.
const deadProxy = proxyDispatcher("http://127.0.0.1:9");

test("loopback requests skip the proxy", async () => {
	for (const host of ["127.0.0.1", "localhost"]) {
		const response = await undiciFetch(`http://${host}:${port}/`, { dispatcher: deadProxy });
		expect(await response.text()).toBe("direct");
	}
});

test("other hosts still go through it", async () => {
	await expect(undiciFetch("http://example.invalid/", { dispatcher: deadProxy })).rejects.toThrow();
});
