const { app, BrowserWindow, ipcMain, Menu, session } = require("electron");
const { createHash, randomBytes } = require("node:crypto");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
require("dotenv").config({ path: path.join(__dirname, ".env.local") });

const APP_INDEX = path.resolve(__dirname, "www", "index.html");
let mainWindow = null;
const presentationWindows = new Set();
const BAIDU_LANGUAGES = new Set([
  "zh", "en", "jp", "kor", "spa", "fra", "de", "it", "pt", "ru", "vie",
  "th", "ara", "hi", "id", "tr"
]);
const LANGUAGE_CODES = {
  "zh-CN": "zh",
  en: "en",
  ja: "jp",
  ko: "kor",
  es: "spa",
  fr: "fra",
  de: "de",
  it: "it",
  pt: "pt",
  ru: "ru",
  vi: "vie",
  th: "th",
  ar: "ara",
  hi: "hi",
  id: "id",
  tr: "tr"
};

function isAppPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "file:" && path.resolve(fileURLToPath(url)) === APP_INDEX;
  } catch {
    return false;
  }
}

function createWindow({ displayId } = {}) {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (!displayId) mainWindow = window;
  else presentationWindows.add(window);
  window.on("closed", () => {
    presentationWindows.delete(window);
    if (mainWindow === window) mainWindow = null;
  });

  window.setMenu(null);
  window.setMenuBarVisibility(false);
  window.maximize();
  window.once("ready-to-show", () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppPage(url)) return { action: "deny" };
    const target = new URL(url);
    const displayValues = target.searchParams.getAll("display");
    const allowedParams = [...target.searchParams.keys()];
    if (
      displayValues.length !== 1
      || !/^target-[\w-]{1,128}$/.test(displayValues[0])
      || allowedParams.length !== 1
    ) {
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 1440,
        height: 960,
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      }
    };
  });
  window.webContents.on("did-create-window", (childWindow) => {
    presentationWindows.add(childWindow);
    childWindow.on("closed", () => presentationWindows.delete(childWindow));
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });

  const appUrl = pathToFileURL(APP_INDEX);
  if (displayId) appUrl.searchParams.set("display", displayId);
  void window.loadURL(appUrl.href);
  return window;
}

function toBaiduLanguage(language) {
  const code = LANGUAGE_CODES[language];
  if (!code || !BAIDU_LANGUAGES.has(code)) {
    throw new Error(`Unsupported translation language: ${language}`);
  }
  return code;
}

async function translateWithBaidu({ text, sourceLanguage, targetLanguage }) {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 6000) {
    throw new Error("Translation text must be non-empty and no larger than 6000 UTF-8 bytes.");
  }
  const appId = process.env.BAIDU_TRANSLATE_APP_ID;
  const secret = process.env.BAIDU_TRANSLATE_SECRET;
  if (!appId || !secret) {
    throw new Error(
      "Baidu credentials are not configured. Set BAIDU_TRANSLATE_APP_ID and BAIDU_TRANSLATE_SECRET before starting the app."
    );
  }

  const from = toBaiduLanguage(sourceLanguage);
  const to = toBaiduLanguage(targetLanguage);
  const salt = randomBytes(12).toString("hex");
  const sign = createHash("md5").update(`${appId}${text}${salt}${secret}`).digest("hex");
  const params = new URLSearchParams({ q: text, from, to, appid: appId, salt, sign });
  const response = await fetch(`https://fanyi-api.baidu.com/api/trans/vip/translate?${params}`, {
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    throw new Error(`Baidu translation service returned HTTP ${response.status}.`);
  }

  const result = await response.json();
  if (result.error_code) {
    throw new Error(`Baidu translation failed (${result.error_code}): ${result.error_msg || "Unknown error"}`);
  }
  if (!Array.isArray(result.trans_result) || result.trans_result.some((item) => typeof item.dst !== "string")) {
    throw new Error("Baidu translation returned an invalid response.");
  }
  return result.trans_result.map((item) => item.dst).join("");
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === "media"
      && Boolean(webContents)
      && isAppPage(webContents.getURL());
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = permission === "media"
      && details?.mediaTypes?.includes("audio")
      && Boolean(webContents)
      && isAppPage(webContents.getURL());
    callback(Boolean(allowed));
  });
  ipcMain.handle("baidu:translate", async (event, request) => {
    if (!isAppPage(event.sender.getURL())) throw new Error("Translation requests are only allowed from the app window.");
    if (!request || typeof request !== "object") throw new Error("Invalid translation request.");
    return translateWithBaidu({
      text: request.text,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage
    });
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error("Could not start the desktop app.", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});