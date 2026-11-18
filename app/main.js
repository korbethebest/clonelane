import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";

import { call, createHandlers } from "./handlers.js";

const flag = process.argv.find((item) => item.startsWith("--config="));
const config = flag
	? flag.slice("--config=".length)
	: join(homedir(), ".config", "clonelane", "registry.json");

const handlers = {
	...createHandlers(config),
	pickFolder: async () => {
		const picked = await dialog.showOpenDialog({
			properties: ["openDirectory"],
		});
		return picked.canceled ? null : picked.filePaths[0];
	},
};

app.whenReady().then(() => {
	// The page needs no camera, notifications or other browser permissions.
	session.defaultSession.setPermissionRequestHandler((_web, _kind, answer) =>
		answer(false),
	);
	ipcMain.handle("clonelane", (event, name, input) =>
		// Only our own window's top frame may drive the handlers.
		event.sender === window.webContents &&
		event.senderFrame === window.webContents.mainFrame
			? call(handlers, name, input)
			: { ok: false, error: "USAGE", message: "Unknown sender." },
	);
	const window = new BrowserWindow({
		width: 1180,
		height: 800,
		minWidth: 720,
		minHeight: 520,
		title: "Clonelane",
		webPreferences: {
			preload: join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});
	window.removeMenu();
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	for (const block of [
		"will-navigate",
		"will-frame-navigate",
		"will-redirect",
		"will-attach-webview",
	])
		window.webContents.on(block, (event) => event.preventDefault());
	window.loadFile(join(import.meta.dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
