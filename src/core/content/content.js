/*
 * Copyright 2010-2020 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 * 
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or 
 *   modify it under the terms of the GNU Affero General Public License 
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 * 
 *   The code in this file is distributed in the hope that it will be useful, 
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may 
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
 *   AGPL normally required by section 4, provided you include this license 
 *   notice and a URL through which recipients can access the Corresponding 
 *   Source.
 */

/* global browser, document, location, navigator, setTimeout, addEventListener, URL, setInterval, clearInterval */

import * as download from "./../common/download.js";
import { fetch, frameFetch } from "./../../lib/single-file/fetch/content/content-fetch.js";
import * as ui from "./../../ui/content/content-ui.js";
import { onError, getOpenFileBar, openFile, setLabels } from "./../../ui/common/common-content-ui.js";
import * as yabson from "./../../lib/yabson/yabson.js";

const singlefile = globalThis.singlefile;
const bootstrap = globalThis.singlefileBootstrap;

const MOZ_EXTENSION_PROTOCOL = "moz-extension:";
const EMBEDDED_IMAGE_BUTTON_MESSAGE = browser.i18n.getMessage("topPanelEmbeddedImageButton");
const SHARE_PAGE_BUTTON_MESSAGE = browser.i18n.getMessage("topPanelSharePageButton");
const SHARE_SELECTION_BUTTON_MESSAGE = browser.i18n.getMessage("topPanelShareSelectionButton");
const ERROR_TITLE_MESSAGE = browser.i18n.getMessage("topPanelError");
const COPY_DETAILS_BUTTON_MESSAGE = browser.i18n.getMessage("topPanelCopyDetailsButton");

const SINGLE_FILE_PREFIX = "single-file-";
const WAIT_FOR_USERSCRIPT_PROPERTY_NAME = "_singleFile_waitForUserScript";
const ON_INIT_CAPTURE_EVENT_NAME = SINGLE_FILE_PREFIX + "on-init-capture";

let processor, processing, downloadParser, openFileInfobar, scrollY, transform, overflow, lastStep;

setLabels({
	EMBEDDED_IMAGE_BUTTON_MESSAGE,
	SHARE_PAGE_BUTTON_MESSAGE,
	SHARE_SELECTION_BUTTON_MESSAGE,
	ERROR_TITLE_MESSAGE,
	COPY_DETAILS_BUTTON_MESSAGE
});

if (!bootstrap || !bootstrap.initializedSingleFile) {
	singlefile.init({ fetch, frameFetch });
	browser.runtime.onMessage.addListener(message => {
		if (message.method == "content.save" ||
			message.method == "content.capture" ||
			message.method == "content.cancelSave" ||
			message.method == "content.download" ||
			message.method == "content.getSelectedLinks" ||
			message.method == "content.error" ||
			message.method == "content.prompt" ||
			message.method == "content.beginScrollTo" ||
			message.method == "content.scrollTo" ||
			message.method == "content.endScrollTo") {
			return onMessage(message).catch(error => rejectWithStack(error));
		}
	});
	if (bootstrap) {
		bootstrap.initializedSingleFile = true;
	} else {
		globalThis.singlefileBootstrap = { initializedSingleFile: true };
		addEventListener("keydown", cancelSaveKeyListener, true);
		addEventListener("keyup", cancelSaveKeyListener, true);
	}
}

async function onMessage(message) {
	if (!location.href.startsWith(MOZ_EXTENSION_PROTOCOL)) {
		if (message.method == "content.save") {
			await savePage(message);
			return {};
		}
		if (message.method == "content.capture") {
			return capturePage(message);
		}
		if (message.method == "content.cancelSave") {
			if (processor) {
				processor.cancel();
				ui.onEndPage();
				if (openFileInfobar) {
					openFileInfobar.cancel();
					openFileInfobar = null;
				}
				browser.runtime.sendMessage({ method: "ui.processCancelled" });
			}
			if (message.options.loadDeferredContent) {
				singlefile.processors.lazy.resetZoomLevel(message.options);
			}
			return {};
		}
		if (message.method == "content.getSelectedLinks") {
			return {
				urls: ui.getSelectedLinks()
			};
		}
		if (message.method == "content.download") {
			if (!downloadParser) {
				downloadParser = yabson.getParser();
			}
			const result = await downloadParser.next(message.data);
			if (result.done) {
				downloadParser = null;
				try {
					await download.downloadPageForeground(result.value, {
						foregroundSave: result.value.foregroundSave,
						sharePage: result.value.sharePage,
					});
				} catch (error) {
					return {
						error: error && (error.message || error.toString())
					};
				} finally {
					await browser.runtime.sendMessage({ method: "downloads.end", taskId: result.value.taskId });
				}
			}
			return {};
		}
		if (message.method == "content.error") {
			const [errorMessage, ...stackLines] = String(message.error).split("\n");
			const stack = stackLines.concat(message.stack || []).join("\n");
			onError(errorMessage, message.link, getErrorDetails({ message: errorMessage, stack }));
			return {};
		}
		if (message.method == "content.prompt") {
			return ui.prompt(message.message, message.value);
		}
		if (message.method == "content.beginScrollTo") {
			scrollY = globalThis.scrollY;
			transform = document.documentElement.style.getPropertyValue("transform");
			overflow = document.documentElement.style.getPropertyValue("overflow");
			globalThis.scrollTo(0, 0);
			document.documentElement.style.setProperty("transform", "translateY(0px)");
			document.documentElement.style.setProperty("overflow", "hidden");
			return {};
		}
		if (message.method == "content.scrollTo") {
			document.documentElement.style.setProperty("transform", "translateY(-" + message.y + "px)");
			await new Promise(resolve => setTimeout(resolve, 500));
			return {};
		}
		if (message.method == "content.endScrollTo") {
			globalThis.scrollTo(0, scrollY);
			document.documentElement.style.setProperty("transform", transform);
			document.documentElement.style.setProperty("overflow", overflow);
			return {};
		}
	}
}

async function savePage(message) {
	const pingInterval = setInterval(() => {
		browser.runtime.sendMessage({ method: "ping" }).then(() => { });
	}, 15000);
	const options = message.options;
	let selectionFound;
	if (options.selected || options.optionallySelected) {
		selectionFound = await ui.markSelection(options.optionallySelected);
	}
	if (!processing && (!bootstrap || !bootstrap.pageInfo.processing)) {
		options.updatedResources = bootstrap ? bootstrap.pageInfo.updatedResources : {};
		options.visitDate = bootstrap ? bootstrap.pageInfo.visitDate : new Date();
		Object.keys(options.updatedResources).forEach(url => options.updatedResources[url].retrieved = false);
		if (options.optionallySelected && selectionFound) {
			options.selected = true;
		}
		if (!options.selected || selectionFound) {
			if (bootstrap) {
				bootstrap.pageInfo.processing = true;
			}
			processing = true;
			try {
				const pageData = await processPage(options);
				if (pageData) {
					await download.downloadPage(pageData, options);
				}
			} catch (error) {
				if (!processor.cancelled) {
					console.error(error); // eslint-disable-line no-console
					const errorMessage = error && (error.message || error.toString());
					const errorDetails = getErrorDetails(error);
					browser.runtime.sendMessage({ method: "ui.processError", error: errorMessage, details: errorDetails });
					onError(errorMessage, undefined, errorDetails);
				}
			} finally {
				ui.onEndPage();
			}
		} else {
			browser.runtime.sendMessage({ method: "ui.processCancelled" });
		}
		processing = false;
		if (bootstrap) {
			bootstrap.pageInfo.processing = false;
		}
	}
	clearInterval(pingInterval);
}

function cancelSave() {
	browser.runtime.sendMessage({ method: "downloads.cancel" });
}

function getErrorDetails(error) {
	const details = ["SingleFile " + browser.runtime.getManifest().version, navigator.userAgent, location.href];
	if (lastStep !== undefined) {
		details.push(lastStep < 3 ? "Step " + (lastStep + 1) + " / 3" : "Steps completed");
	}
	if (error) {
		const errorMessage = error.message || error.toString();
		let errorText = (error.name ? error.name + ": " : "") + errorMessage;
		if (error.stack) {
			errorText = error.stack.includes(errorMessage) ? error.stack : errorText + "\n" + error.stack;
		}
		if (error.remoteStack) {
			errorText += "\n" + error.remoteStack;
		}
		details.push(errorText);
	}
	return details.join("\n");
}

async function sendMessage(message) {
	try {
		return await browser.runtime.sendMessage(message);
	} catch (error) {
		const [errorMessage, ...stackLines] = String(error && (error.message || error.toString())).split("\n");
		const wrappedError = new Error(errorMessage + " (" + message.method + ")");
		wrappedError.remoteStack = stackLines.join("\n");
		throw wrappedError;
	}
}

function rejectWithStack(error) {
	const message = (error && (error.message || error.toString())) || "Unexpected error";
	const wrappedError = new Error(error && error.stack ? message + "\n" + error.stack : message);
	wrappedError.__singleFileError = true;
	return Promise.reject(wrappedError);
}

function cancelSaveKeyListener(event) {
	if (event.key == "Escape" && globalThis.singlefileBootstrap.cancelSave) {
		event.preventDefault();
		event.stopPropagation();
		if (event.type == "keyup") {
			globalThis.singlefileBootstrap.cancelSave();
		}
	}
}

async function capturePage(message) {
	const pingInterval = setInterval(() => {
		browser.runtime.sendMessage({ method: "ping" }).then(() => { });
	}, 15000);
	const options = message.options;
	let selectionFound;
	if (options.selected || options.optionallySelected) {
		selectionFound = await ui.markSelection(options.optionallySelected);
	}
	if (processing || bootstrap && bootstrap.pageInfo.processing) {
		clearInterval(pingInterval);
		throw new Error("SingleFile is already processing this page");
	}
	options.updatedResources = bootstrap ? bootstrap.pageInfo.updatedResources : {};
	options.visitDate = bootstrap ? bootstrap.pageInfo.visitDate : new Date();
	Object.keys(options.updatedResources).forEach(url => options.updatedResources[url].retrieved = false);
	if (options.optionallySelected && selectionFound) {
		options.selected = true;
	}
	if (options.selected && !selectionFound) {
		clearInterval(pingInterval);
		throw new Error("No selected content found");
	}
	if (bootstrap) {
		bootstrap.pageInfo.processing = true;
	}
	processing = true;
	try {
		return await processPage(options);
	} finally {
		processing = false;
		if (bootstrap) {
			bootstrap.pageInfo.processing = false;
		}
		clearInterval(pingInterval);
	}
}

async function processPage(options) {
	const restoreFiles = await embedLinkedFiles(options);
	const restoreCursors = options.removeCustomCursors && markCursorElements();
	try {
		const page = await runProcessor(options);
		if (restoreFiles && page && typeof page.content == "string") {
			// let the kept page scripts (e.g. <model-viewer>, video players) fetch() their data: URI files
			page.content = page.content.replace("default-src 'none';", "default-src 'none'; connect-src data: blob:;");
		}
		if (options.removeCustomCursors && page && typeof page.content == "string") {
			page.content = page.content.replace(/<body|$/i, CUSTOM_CURSOR_RESET_STYLE + "$&");
		}
		return page;
	} finally {
		if (restoreFiles) {
			restoreFiles();
		}
		if (restoreCursors) {
			restoreCursors();
		}
	}
}

// Custom cursors: CSS cursor images/cursor:none are reset to the browser defaults, and JS cursor followers
// (fixed, click-through elements named like "cursor-dot") are hidden.
// ponytail: followers are found by name, unnamed ones stay visible
const CURSOR_ATTRIBUTE_NAME = "data-sciagen-cursor";
const CUSTOM_CURSOR_RESET_STYLE = "<style>*,*::before,*::after{cursor:revert!important}[" + CURSOR_ATTRIBUTE_NAME + "],[class*=cursor-dot],[class*=cursor-ring],[class*=cursor-follower],[class*=custom-cursor]:not(body):not(html){display:none!important}</style>";

function markCursorElements() {
	const elements = Array.from(document.body ? document.body.querySelectorAll("*") : []).filter(element => {
		const name = (element.id + " " + element.getAttribute("class")).toLowerCase();
		if (name.includes("cursor")) {
			const style = globalThis.getComputedStyle(element);
			return style.position == "fixed" && style.pointerEvents == "none";
		}
	});
	elements.forEach(element => element.setAttribute(CURSOR_ATTRIBUTE_NAME, ""));
	return () => elements.forEach(element => element.removeAttribute(CURSOR_ATTRIBUTE_NAME));
}

// 3D, video, audio and GIF files referenced from attributes SingleFile does not process (<model-viewer src>,
// <a-asset-item src>, gltf-model="url(...)", <div data-src="film.mp4">, <a href="x.glb">...) are fetched and
// swapped for data: URIs on the live DOM during the capture, then restored.
// ponytail: only attribute references are found, files whose URLs only exist in JS code (e.g. three.js loaders) are not.
const LINKED_FILE_REGEXP = /[^\s"'()]+\.(?:glb|gltf|obj|mtl|stl|fbx|usdz|usd|ply|3ds|dae|3mf|splat|ktx2|hdr|mp4|m4v|webm|mov|ogv|mp3|m4a|wav|ogg|oga|flac|aac|gif)(?:[?#][^\s"'()]*)?(?=$|[\s"'()])/i;
const LINKED_FILE_MIME_TYPES = {
	glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "model/obj", stl: "model/stl", usdz: "model/vnd.usdz+zip", "3mf": "model/3mf",
	mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
	mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", aac: "audio/aac", gif: "image/gif"
};
// already embedded by SingleFile itself
const PROCESSED_ATTRIBUTE_NAMES = ["src", "srcset", "poster"];
const PROCESSED_TAG_NAMES = ["IMG", "SOURCE", "VIDEO", "AUDIO", "TRACK", "INPUT", "EMBED", "OBJECT", "IFRAME", "FRAME", "SCRIPT", "LINK"];

async function embedLinkedFiles(options) {
	const restores = [];
	const tasks = [];
	let scriptsNeeded = false;
	document.querySelectorAll("*").forEach(element => {
		Array.from(element.attributes).forEach(({ name, value }) => {
			// SingleFile replaces <img src> with the displayed variant (e.g. the WebP of a <picture>), so a GIF
			// fallback is kept by adding it as one more <source> of the <picture>
			const pictureFallback = element.tagName == "IMG" && name == "src" && element.parentElement && element.parentElement.tagName == "PICTURE" && element.currentSrc != element.src;
			if (!pictureFallback && PROCESSED_TAG_NAMES.includes(element.tagName) && PROCESSED_ATTRIBUTE_NAMES.includes(name)) {
				return;
			}
			const match = !value.startsWith("data:") && value.match(LINKED_FILE_REGEXP);
			if (match) {
				tasks.push((async () => {
					const url = new URL(match[0], document.baseURI).href;
					const response = await fetch(url, { cache: "no-cache" });
					if (response.status >= 400) {
						return;
					}
					const extension = match[0].match(/\.([a-z0-9]+)(?:[?#]|$)/i)[1].toLowerCase();
					const contentType = LINKED_FILE_MIME_TYPES[extension] || response.headers.get("content-type") || "application/octet-stream";
					const blob = new globalThis.Blob([await response.arrayBuffer()], { type: contentType });
					const dataURI = await new Promise((resolve, reject) => {
						const reader = new globalThis.FileReader();
						reader.onload = () => resolve(reader.result);
						reader.onerror = reject;
						reader.readAsDataURL(blob);
					});
					if (pictureFallback) {
						const sourceElement = document.createElement("source");
						sourceElement.setAttribute("srcset", dataURI);
						sourceElement.setAttribute("type", contentType);
						element.before(sourceElement);
						restores.push(() => sourceElement.remove());
						return;
					}
					element.setAttribute(name, value.replace(match[0], dataURI));
					restores.push(() => element.setAttribute(name, value));
					// only a plain link works without the page scripts, 3D viewers and data-* players need them
					scriptsNeeded = scriptsNeeded || !(element.tagName == "A" && name == "href");
				})().catch(() => { }));
			}
		});
	});
	await Promise.all(tasks);
	if (scriptsNeeded) {
		options.blockScripts = false;
	}
	if (restores.length) {
		return () => restores.forEach(restore => restore());
	}
}

async function runProcessor(options) {
	const frames = singlefile.processors.frameTree;
	let framesSessionId;
	singlefile.helper.initDoc(document);
	ui.onStartPage(options, cancelSave);
	lastStep = undefined;
	processor = new singlefile.SingleFile(options);
	const preInitializationPromises = [];
	let index = 0, maxIndex = 0, initializing;
	options.onprogress = async event => {
		const { options } = event.detail;
		if (!processor.cancelled) {
			if (event.type == event.RESOURCES_INITIALIZING) {
				if (!initializing && options.insertEmbeddedScreenshotImage && options.compressContent) {
					initializing = true;
					ui.setVisible(false);
					const screenshotBlobURI = await sendMessage({
						method: "tabs.getScreenshot",
						width: document.documentElement.scrollWidth,
						height: document.documentElement.scrollHeight,
						innerHeight: globalThis.innerHeight
					});
					ui.setVisible(true);
					ui.onInsertingEmbeddedImage(options);
					options.embeddedImage = new Uint8Array(await (await fetch(screenshotBlobURI)).arrayBuffer());
					URL.revokeObjectURL(screenshotBlobURI);
					ui.onInsertEmbeddedImage(options);
				}
			}
			if (event.type == event.RESOURCES_INITIALIZED) {
				maxIndex = event.detail.max;
				if (options.loadDeferredContent) {
					singlefile.processors.lazy.resetZoomLevel(options);
				}
			}
			if (event.type == event.RESOURCES_INITIALIZED || event.type == event.RESOURCE_LOADED) {
				if (event.type == event.RESOURCE_LOADED) {
					index++;
				}
				if (!options.silent) {
					await sendMessage({ method: "ui.processProgress", index, maxIndex });
				}
				ui.onLoadResource(index, maxIndex, options);
			} else if (!event.detail.frame) {
				if (event.type == event.PAGE_LOADING) {
					ui.onPageLoading();
				} else if (event.type == event.PAGE_LOADED) {
					ui.onLoadPage();
				} else if (event.type == event.STAGE_STARTED) {
					if (event.detail.step < 3) {
						lastStep = event.detail.step;
						ui.onStartStage(event.detail.step, options);
					}
				} else if (event.type == event.STAGE_ENDED) {
					if (event.detail.step < 3) {
						lastStep = event.detail.step + 1;
						ui.onEndStage(event.detail.step, options);
					}
				}
			}
		}
	};
	const waitForUserScript = globalThis[WAIT_FOR_USERSCRIPT_PROPERTY_NAME];
	if (options.userScriptEnabled && waitForUserScript) {
		await waitForUserScript(ON_INIT_CAPTURE_EVENT_NAME, options);
	}
	const cancelProcessor = processor.cancel.bind(processor);
	if (options.insertEmbeddedImage && options.compressContent) {
		ui.onInsertingEmbeddedImage(options);
		openFileInfobar = getOpenFileBar();
		const cancelled = await openFileInfobar.display();
		if (!cancelled) {
			options.embeddedImage = await openFile({ accept: "image/*" });
			openFileInfobar.hide();
		}
		ui.onInsertEmbeddedImage(options);
	}
	if (!options.saveRawPage && !processor.cancelled) {
		let lazyLoadPromise;
		if (options.loadDeferredContent) {
			lazyLoadPromise = singlefile.processors.lazy.process(options);
			ui.onLoadingDeferResources(options);
			lazyLoadPromise.then(() => {
				if (!processor.cancelled) {
					ui.onLoadDeferResources(options);
				}
			});
			if (options.loadDeferredContentBeforeFrames) {
				await lazyLoadPromise;
			}
		}
		if (!options.removeFrames && frames && globalThis.frames) {
			let frameTreePromise;
			if (options.loadDeferredContent) {
				frameTreePromise = new Promise(resolve => globalThis.setTimeout(() => resolve(frames.getAsync(options)), options.loadDeferredContentBeforeFrames || !options.loadDeferredContent ? 0 : options.loadDeferredContentMaxIdleTime));
			} else {
				frameTreePromise = frames.getAsync(options);
			}
			ui.onLoadingFrames(options);
			frameTreePromise.then(() => {
				if (!processor.cancelled) {
					ui.onLoadFrames(options);
				}
			});
			if (options.loadDeferredContentBeforeFrames) {
				options.frames = await new Promise(resolve => {
					processor.cancel = function () {
						cancelProcessor();
						resolve([]);
					};
					frameTreePromise.then(resolve);
				});
			} else {
				preInitializationPromises.push(frameTreePromise);
			}
		}
		if (options.loadDeferredContent && !options.loadDeferredContentBeforeFrames) {
			preInitializationPromises.push(lazyLoadPromise);
		}
	}
	if (!options.loadDeferredContentBeforeFrames && !processor.cancelled) {
		[options.frames] = await new Promise(resolve => {
			const preInitializationAllPromises = Promise.all(preInitializationPromises);
			processor.cancel = function () {
				cancelProcessor();
				resolve([[]]);
			};
			preInitializationAllPromises.then(() => resolve(preInitializationAllPromises));
		});
	}
	if (options.delayBeforeProcessing) {
		await new Promise(resolve => setTimeout(resolve, options.delayBeforeProcessing * 1000));
	}
	framesSessionId = options.frames && options.frames.sessionId;
	const selectedFrame = options.frames && options.frames.find(frameData => frameData.requestedFrame);
	options.win = globalThis;
	if (selectedFrame) {
		options.content = selectedFrame.content;
		options.url = selectedFrame.baseURI;
		options.canvases = selectedFrame.canvases;
		options.fonts = selectedFrame.fonts;
		options.stylesheets = selectedFrame.stylesheets;
		options.images = selectedFrame.images;
		options.posters = selectedFrame.posters;
		options.videos = selectedFrame.videos;
		options.usedFonts = selectedFrame.usedFonts;
		options.shadowRoots = selectedFrame.shadowRoots;
		options.adoptedStyleSheets = selectedFrame.adoptedStyleSheets;
		options.worklets = selectedFrame.worklets;
	} else {
		options.doc = document;
	}
	if (!processor.cancelled) {
		await processor.run();
	}
	if (framesSessionId) {
		frames.cleanup(framesSessionId);
	}
	let page;
	if (!processor.cancelled) {
		if (options.confirmInfobarContent) {
			options.infobarContent = ui.prompt("Infobar content", options.infobarContent) || "";
		}
		page = await processor.getPageData();
		if (options.selected || options.optionallySelected) {
			ui.unmarkSelection();
		}
		ui.onEndPage();
		if (options.displayStats) {
			console.log("SingleFile stats"); // eslint-disable-line no-console
			console.table(page.stats); // eslint-disable-line no-console
		}
	}
	if (options.delayAfterProcessing) {
		await new Promise(resolve => setTimeout(resolve, options.delayAfterProcessing * 1000));
	}
	return page;
}
