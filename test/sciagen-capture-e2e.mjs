/* eslint-disable no-console */
/* global process, URL, setTimeout, Buffer */

// Sciagen capture check: saves a local page with a GIF, video, audio, hidden content and 3D models
// and asserts everything ends up embedded in the saved HTML. Run: node test/sciagen-capture-e2e.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cdp, getTargets, options } from "simple-cdp";

const EXTENSION_PATH = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHROME_PATH = process.env.SF_CHROME_PATH || findFile(join(EXTENSION_PATH, "test", ".browser"), ["chrome.exe", "chrome", "Google Chrome for Testing"]);
const DEBUG_PORT = 21000 + (process.pid % 2000);
// node test/sciagen-capture-e2e.mjs <url> [output.html] saves any page instead of running the checks
const SAVE_URL = process.argv[2];
const SAVE_OUTPUT = resolve(process.argv[3] || "saved-page.html");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const RESOURCES = {
	"/": ["text/html", "<!DOCTYPE html><html><head><title>Sciagen test</title></head><body><h1>Visible</h1>" +
		"<img src=/anim.gif><video src=/clip.webm controls></video><audio src=/sound.wav controls></audio>" +
		"<div style=display:none><p>HIDDEN_TEXT_MARKER</p></div>" +
		"<div id=my-cursor style=position:fixed;pointer-events:none>dot</div>" +
		"<div class=film data-src=/film.mp4></div><picture><source srcset=/still.webp type=image/webp><img src=/timeline.gif></picture>" +
		"<model-viewer src=/models/cube.glb></model-viewer><a href=/models/scene.gltf>scene</a>" +
		// a WebGL scene loaded from ES modules through an import map
		"<canvas data-engine=\"three.js r165\"></canvas><p id=module-result></p>" +
		"<script type=importmap>{\"imports\": {\"scene\": \"/modules/scene.js\"}}</script>" +
		"<script type=module>const { result } = await import(\"scene\"); document.getElementById(\"module-result\").textContent = result + \" \" + location.protocol;</script>" +
		// stands in for UI another extension injects into every page
		"<script>const host = document.createElement('div'); document.body.append(host); host.attachShadow({ mode: 'open' }).innerHTML = '<p>EXT_WIDGET' + '_MARKER</p><img src=chrome-extension://abcdefghijklmnopabcdefghijklmnop/favicon.png>';</script></body></html>"],
	"/anim.gif": ["image/gif", GIF],
	"/clip.webm": ["video/webm", Buffer.from("VIDEO_MARKER")],
	"/film.mp4": ["video/mp4", Buffer.from("FILM_MARKER")],
	"/still.webp": ["image/webp", Buffer.from("RIFF_WEBP_MARKER")],
	"/timeline.gif": ["image/gif", Buffer.concat([GIF, Buffer.from("TIMELINE")])],
	"/sound.wav": ["audio/wav", Buffer.from("AUDIO_MARKER")],
	"/modules/scene.js": ["text/javascript", "import { part } from \"./part.js\"; export const result = \"MODULE_\" + part;"],
	"/modules/part.js": ["text/javascript", "export const part = \"OK\";"],
	"/models/cube.glb": ["model/gltf-binary", Buffer.from("glTF_GLB_MARKER")],
	"/models/scene.gltf": ["model/gltf+json", Buffer.from("{\"asset\":{\"version\":\"2.0\"}}")]
};
const EXPECTED = {
	"GIF embedded intact": "data:image/gif;base64," + GIF.toString("base64"),
	"video embedded": "data:video/webm;base64," + Buffer.from("VIDEO_MARKER").toString("base64"),
	"audio embedded": "data:audio/wav;base64," + Buffer.from("AUDIO_MARKER").toString("base64"),
	"data-src video embedded": "data-src=\"data:video/mp4;base64," + Buffer.from("FILM_MARKER").toString("base64"),
	"<picture> GIF fallback kept": "data:image/gif;base64," + Buffer.concat([GIF, Buffer.from("TIMELINE")]).toString("base64"),
	"custom cursor follower marked": "data-sciagen-cursor",
	"custom cursor CSS reset": "cursor:revert!important",
	"hidden content kept": "HIDDEN_TEXT_MARKER",
	"model-viewer GLB embedded": "data:model/gltf-binary;base64," + Buffer.from("glTF_GLB_MARKER").toString("base64"),
	"linked glTF embedded": "data:model/gltf+json;base64,",
	"CSP allows data: fetch for 3D viewers": "connect-src data: blob:;"
};

const EXPECTED_CHECKS = Object.entries(EXPECTED);
options.apiUrl = "http://127.0.0.1:" + DEBUG_PORT;
let pageRequestCount = 0;
const server = createServer((request, response) => {
	pageRequestCount += request.url == "/" ? 1 : 0;
	const resource = RESOURCES[request.url];
	if (resource) {
		response.writeHead(200, { "content-type": resource[0], "access-control-allow-origin": "*" }).end(resource[1]);
	} else {
		response.writeHead(404).end();
	}
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const pageURL = "http://127.0.0.1:" + server.address().port + "/";
const userDataDir = mkdtempSync(join(tmpdir(), "sciagen-e2e-"));
const downloadDir = mkdtempSync(join(tmpdir(), "sciagen-dl-"));
mkdirSync(join(userDataDir, "Default"));
writeFileSync(join(userDataDir, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false } }));
const chrome = spawn(CHROME_PATH, ["--headless=new", "--remote-debugging-port=" + DEBUG_PORT, "--user-data-dir=" + userDataDir,
	"--load-extension=" + EXTENSION_PATH, "--disable-extensions-except=" + EXTENSION_PATH, "--no-first-run", "--enable-logging=stderr", "about:blank"], { stdio: ["ignore", "ignore", process.env.SF_DEBUG ? "inherit" : "ignore"] });
let failures = 0;
try {
	const extensionId = await waitFor(async () => {
		const target = (await getTargets()).find(target => target.type == "service_worker" && target.url.startsWith("chrome-extension://"));
		return target && target.url.split("/")[2];
	}, "extension loaded");
	const { targetId } = await cdp.Target.createTarget({ url: "chrome-extension://" + extensionId + "/src/ui/pages/pendings.html" });
	const { sessionId } = await cdp.Target.attachToTarget({ targetId, flatten: true });
	await waitFor(async () => (await cdp.Runtime.evaluate({ expression: "document.readyState == 'complete' || undefined" }, sessionId)).result.value, "extension page ready");
	await cdp.Runtime.evaluate({ expression: "chrome.runtime.sendMessage({ method: \"downloads.saveUrls\", urls: [" + JSON.stringify(SAVE_URL || pageURL) + "] })", awaitPromise: true }, sessionId);
	const savedPath = await waitFor(() => {
		const filename = readdirSync(downloadDir).find(filename => filename.endsWith(".html"));
		return filename && join(downloadDir, filename);
	}, "saved page", 300000);
	const content = readFileSync(savedPath, "utf8");
	if (SAVE_URL) {
		copyFileSync(savedPath, SAVE_OUTPUT);
		console.log("saved " + SAVE_URL + " -> " + SAVE_OUTPUT + " (" + Math.round(content.length / 1024) + " KB)");
		EXPECTED_CHECKS.length = 0;
	}
	if (!SAVE_URL) {
		const ok = !content.includes("EXT_WIDGET_MARKER");
		failures += ok ? 0 : 1;
		console.log((ok ? "ok   " : "FAIL ") + "other extensions' UI left out");
		// open the saved copy from disk: the module must run again offline (protocol switches to file:)
		const { targetId: savedTargetId } = await cdp.Target.createTarget({ url: pathToFileURL(savedPath).href });
		const { sessionId: savedSessionId } = await cdp.Target.attachToTarget({ targetId: savedTargetId, flatten: true });
		const moduleResult = await waitFor(async () => (await cdp.Runtime.evaluate({ expression: "(document.getElementById('module-result') || {}).textContent == 'MODULE_OK file:' || undefined" }, savedSessionId)).result.value, "saved page runs its ES modules", 15000).catch(() => false);
		const canvasResult = (await cdp.Runtime.evaluate({ expression: "getComputedStyle(document.querySelector('canvas[data-engine]')).display" }, savedSessionId)).result.value != "none";
		for (const [label, passed] of [["saved page runs ES modules from its import map offline", moduleResult], ["WebGL canvas snapshot kept as fallback", canvasResult]]) {
			failures += passed ? 0 : 1;
			console.log((passed ? "ok   " : "FAIL ") + label);
		}
	}
	for (const [label, expected] of EXPECTED_CHECKS) {
		const ok = content.includes(expected);
		failures += ok ? 0 : 1;
		console.log((ok ? "ok   " : "FAIL ") + label);
		if (!ok && process.env.SF_DEBUG) {
			console.log(content.replace(/data:[^"s>]{60,}/g, "DATAURI").slice(-1500));
		}
	}
	if (!SAVE_URL) {
		// toolbar button path: same as clicking the Sciagen icon
		// the first file stays: deleting it while Chrome saves a same-named one can interrupt that download
		const previousFilenames = readdirSync(downloadDir);
		pageRequestCount = 0;
		const { targetId: pageTargetId } = await cdp.Target.createTarget({ url: pageURL });
		if (process.env.SF_DEBUG) {
			const { sessionId: pageSessionId } = await cdp.Target.attachToTarget({ targetId: pageTargetId, flatten: true });
			cdp.Runtime.addEventListener("consoleAPICalled", ({ params }) => params.sessionId == pageSessionId && console.log("PAGE", params.type, params.args.map(arg => arg.value || arg.description).join(" ")));
			cdp.Runtime.addEventListener("exceptionThrown", ({ params }) => params.sessionId == pageSessionId && console.log("PAGE EXCEPTION", params.exceptionDetails.exception && params.exceptionDetails.exception.description));
			await cdp.Runtime.enable(null, pageSessionId);
		}
		await waitFor(() => pageRequestCount, "test page opened");
		const workerTarget = (await getTargets()).find(target => target.type == "service_worker" && target.url.includes(extensionId));
		const { sessionId: workerSessionId } = await cdp.Target.attachToTarget({ targetId: workerTarget.id, flatten: true });
		await waitFor(async () => (await cdp.Runtime.evaluate({
			expression: "chrome.tabs.query({}).then(tabs => tabs.filter(tab => tab.url == " + JSON.stringify(pageURL) + ").sort((tab1, tab2) => tab2.id - tab1.id)[0]).then(tab => tab && tab.status == 'complete' && tab).then(tab => tab && (chrome.action.onClicked.dispatch(tab), true))",
			awaitPromise: true, returnByValue: true
		}, workerSessionId)).result.value, "toolbar click dispatched");
		const toolbarSavedPath = await waitFor(() => {
			const filename = readdirSync(downloadDir).find(filename => filename.endsWith(".html") && !previousFilenames.includes(filename));
			return filename && join(downloadDir, filename);
		}, "page saved from toolbar", 60000);
		const checks = [["toolbar save kept the page as is (no reload)", pageRequestCount == 1], ["toolbar save embedded the video", readFileSync(toolbarSavedPath, "utf8").includes(EXPECTED["video embedded"])]];
		for (const [label, ok] of checks) {
			failures += ok ? 0 : 1;
			console.log((ok ? "ok   " : "FAIL ") + label);
		}
	}
} catch (error) {
	failures++;
	console.error("FATAL", error);
	if (process.env.SF_DEBUG) {
		console.error("downloads:", readdirSync(downloadDir));
	}
} finally {
	chrome.kill();
	server.close();
	await new Promise(resolve => setTimeout(resolve, 1000));
	rmSync(userDataDir, { recursive: true, force: true });
	rmSync(downloadDir, { recursive: true, force: true });
}
console.log(failures ? "FAILED (" + failures + ")" : "PASSED");
process.exit(failures ? 1 : 0);

async function waitFor(getValue, label, timeout = 30000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			const value = await getValue();
			if (value) {
				return value;
			}
			// eslint-disable-next-line no-unused-vars
		} catch (error) {
			// not ready yet
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error("timeout: " + label);
}

function findFile(root, names) {
	for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && names.includes(entry.name)) {
			return join(entry.parentPath, entry.name);
		}
	}
	throw new Error("Chrome for Testing not found, run: npm run install-test-browser");
}
