import { expect, test } from "bun:test";
import { AppInstallService, type InstallUpdater } from "../../src/main/app-updates";
import type { UpdateInstallState } from "../../src/shared/updates";

function fakeUpdater(metadataVersion = "0.1.0", failDownload = false) {
	const calls: string[] = [];
	let progress: ((p: { transferred: number; total: number }) => void) | null = null;
	const updater: InstallUpdater = {
		autoDownload: true,
		autoInstallOnAppQuit: false,
		setFeedURL: (options) => { calls.push(`feed ${options.url} multi=${options.useMultipleRangeRequest}`); },
		checkForUpdates: async () => ({ updateInfo: { version: metadataVersion } }),
		downloadUpdate: async () => {
			progress?.({ transferred: 5, total: 10 });
			if (failDownload) throw new Error("HttpError: 404\nheaders…");
			return [];
		},
		quitAndInstall: (silent, run) => { calls.push(`install silent=${silent} run=${run}`); },
		on: (_event, listener) => { progress = listener; },
	};
	return { updater, calls };
}

function service(updater: InstallUpdater, supported = true) {
	const published: UpdateInstallState[] = [];
	let loads = 0;
	const install = new AppInstallService({
		supported,
		currentVersion: () => "0.0.9",
		loadUpdater: async () => { loads++; return updater; },
		publish: (state) => published.push(state),
	});
	return { install, published, loads: () => loads };
}

test("downloads the checked release from its own tag and installs silently on request", async () => {
	const { updater, calls } = fakeUpdater();
	const { install, published } = service(updater);
	expect(install.state()).toEqual({ phase: "idle" });
	const [first, second] = await Promise.all([install.download("v0.1.0"), install.download("v0.1.0")]);
	expect(first).toEqual({ phase: "downloaded", version: "0.1.0" });
	expect(second).toBe(first);
	expect(updater.autoDownload).toBe(false);
	expect(updater.autoInstallOnAppQuit).toBe(true);
	expect(calls).toEqual(["feed https://github.com/ChuxinNeko/NekoCodeDesktop/releases/download/v0.1.0 multi=false"]);
	expect(published.map((s) => s.phase)).toEqual(["downloading", "downloading", "downloaded"]);
	expect(published[1]).toEqual({ phase: "downloading", version: "0.1.0", transferred: 5, total: 10 });
	// Already downloaded: no second fetch.
	await install.download("v0.1.0");
	expect(calls).toHaveLength(1);
	install.install();
	await Promise.resolve();
	expect(calls.at(-1)).toBe("install silent=true run=true");
});

test("rejects versions that are not a newer stable release", async () => {
	const { install } = service(fakeUpdater().updater);
	for (const tag of ["v0.0.9", "v0.0.8", "v0.2.0-beta.1", "latest", 42])
		await expect(install.download(tag)).rejects.toThrow("Invalid update version");
	expect(() => install.install()).toThrow("No downloaded update");
});

test("a failed or mismatched download becomes a retryable error state", async () => {
	const failing = service(fakeUpdater("0.1.0", true).updater);
	expect(await failing.install.download("v0.1.0")).toEqual({ phase: "error", version: "0.1.0", message: "HttpError: 404" });
	const mismatched = service(fakeUpdater("0.0.9").updater);
	const state = await mismatched.install.download("v0.1.0");
	expect(state.phase).toBe("error");
	await mismatched.install.download("v0.1.0");
	expect(mismatched.loads()).toBe(1);
});

test("unsupported builds never load the updater", async () => {
	const { install, loads } = service(fakeUpdater().updater, false);
	expect(await install.download("v0.1.0")).toEqual({ phase: "unsupported" });
	expect(loads()).toBe(0);
});
