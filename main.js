const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');

const PILL_HEIGHT = 46;
const PANEL_HEIGHT = 260;
const MIN_WIDTH = 240;
const MAX_WIDTH = 360;
const DOCK_REFRESH_MS = 60 * 1000;
const TOPMOST_REFRESH_MS = 250;
const PROCESS_REFRESH_MS = 3000;
const APP_VERSION = '0.48.0';

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const AUTOSTART_MARKER = path.join(app.getPath('userData'), 'autostart-initialized');

const exePath = path.join(__dirname, 'dist', 'CodexBar-0.48.0-portable.exe');
const checksumPath = `${exePath}.sha256`;

let win;
let tray;
let taskbarRect = null;
let flipped = false;
let dragStartBounds = null;
let statusCache = {
  running: false,
  verified: false,
  hash: null,
  version: APP_VERSION,
  exePath,
  lastError: null,
};
let settings = {
  width: 300,
  dockDisplayId: null,
  dockX: null,
};

const TASKBAR_PROBE_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AiUsageBarWin32 {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$tray = [AiUsageBarWin32]::FindWindow("Shell_TrayWnd", $null)
$rectTray = New-Object AiUsageBarWin32+RECT
[AiUsageBarWin32]::GetWindowRect($tray, [ref]$rectTray) | Out-Null
$notify = [AiUsageBarWin32]::FindWindowEx($tray, [IntPtr]::Zero, "TrayNotifyWnd", $null)
$rectNotify = New-Object AiUsageBarWin32+RECT
[AiUsageBarWin32]::GetWindowRect($notify, [ref]$rectNotify) | Out-Null
[PSCustomObject]@{
  taskbarLeft=$rectTray.Left; taskbarTop=$rectTray.Top; taskbarRight=$rectTray.Right; taskbarBottom=$rectTray.Bottom;
  trayLeft=$rectNotify.Left; trayTop=$rectNotify.Top; trayRight=$rectNotify.Right; trayBottom=$rectNotify.Bottom;
} | ConvertTo-Json -Compress
`;

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {}
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings));
}

function refreshTaskbarRect() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', TASKBAR_PROBE_SCRIPT], {
      timeout: 3000,
      windowsHide: true,
    });
    const rect = JSON.parse(out.toString());
    if (rect.trayLeft < rect.trayRight) taskbarRect = rect;
  } catch {}
}

function taskbarRectForDisplay(display) {
  const b = display.bounds;
  const w = display.workArea;
  const top = w.y + w.height;
  const bottom = b.y + b.height;
  if (bottom - top < 8) return null;
  return { left: b.x, top, right: b.x + b.width, bottom };
}

function defaultDockPosition(width, height) {
  const primary = screen.getPrimaryDisplay();
  if (taskbarRect) {
    const x = Math.min(
      Math.max(taskbarRect.trayLeft - width, taskbarRect.taskbarLeft),
      taskbarRect.taskbarRight - width
    );
    const barHeight = taskbarRect.taskbarBottom - taskbarRect.taskbarTop;
    const y = taskbarRect.taskbarTop + Math.round((barHeight - height) / 2);
    return { x, y, displayId: primary.id };
  }
  const { width: screenWidth } = primary.workAreaSize;
  return { x: screenWidth - width - 24, y: 24, displayId: primary.id };
}

function snapToTaskbar(displayId, x, width, height) {
  const display = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  const tb = taskbarRectForDisplay(display);
  if (!tb) return defaultDockPosition(width, height);
  let clampedX = Math.min(Math.max(x, tb.left), tb.right - width);
  if (display.id === screen.getPrimaryDisplay().id && taskbarRect) {
    clampedX = Math.min(clampedX, taskbarRect.trayLeft - width);
  }
  const y = tb.top + Math.round((tb.bottom - tb.top - height) / 2);
  return { x: clampedX, y, displayId: display.id };
}

function currentDockPosition(width, height) {
  return settings.dockDisplayId != null
    ? snapToTaskbar(settings.dockDisplayId, settings.dockX, width, height)
    : defaultDockPosition(width, height);
}

function collapsedSize() {
  return { width: settings.width, height: PILL_HEIGHT };
}

function moveWindow(bounds) {
  if (win) win.setBounds(bounds, true);
}

function pillAnchor() {
  const b = win.getBounds();
  return {
    x: b.x + b.width - collapsedSize().width,
    y: flipped ? b.y + b.height - PILL_HEIGHT : b.y,
  };
}

function getIcon() {
  const icon = nativeImage.createFromPath(exePath);
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

function createWindow() {
  const { x, y } = currentDockPosition(collapsedSize().width, PILL_HEIGHT);
  win = new BrowserWindow({
    ...collapsedSize(),
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    icon: exePath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('renderer/index.html');
  win.on('closed', () => (win = null));
  win.on('show', () => win.setAlwaysOnTop(true, 'screen-saver'));
  win.on('blur', () => win.setAlwaysOnTop(true, 'screen-saver'));
  setInterval(() => win && win.setAlwaysOnTop(true, 'screen-saver'), TOPMOST_REFRESH_MS);
}

function redock() {
  refreshTaskbarRect();
  if (!win || win.getBounds().height > PILL_HEIGHT) return;
  const { x, y } = currentDockPosition(collapsedSize().width, PILL_HEIGHT);
  moveWindow({ x, y, ...collapsedSize() });
}

function createTray() {
  tray = new Tray(getIcon());
  tray.setToolTip('AI Usage Bar');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open CodexBar', click: launchCodexBar },
      { label: 'Show/Hide Bar', click: () => (win.isVisible() ? win.hide() : win.show()) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', () => (win.isVisible() ? win.hide() : win.show()));
}

function isCodexBarRunning() {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      "Get-Process | Where-Object { $_.ProcessName -eq 'CodexBar-0.48.0-portable' } | Select-Object -First 1 -ExpandProperty Id",
    ], { timeout: 3000, windowsHide: true });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}

function verifyArtifact() {
  if (!fs.existsSync(exePath)) throw new Error(`Executable not found: ${exePath}`);
  if (!fs.existsSync(checksumPath)) throw new Error(`Checksum file not found: ${checksumPath}`);
  const actual = execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-FileHash -LiteralPath '${exePath.replace(/'/g, "''")}' -Algorithm SHA256).Hash.ToLowerInvariant()`,
  ], { timeout: 10000, windowsHide: true }).toString().trim();
  const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  if (actual !== expected) throw new Error(`Checksum mismatch. Expected ${expected}, got ${actual}`);
  statusCache.verified = true;
  statusCache.hash = actual;
  statusCache.version = fs.existsSync(exePath) ? '0.48.0' : APP_VERSION;
  statusCache.lastError = null;
  return statusCache;
}

function refreshStatus() {
  statusCache.running = isCodexBarRunning();
  try {
    if (!statusCache.verified) verifyArtifact();
  } catch (error) {
    statusCache.verified = false;
    statusCache.lastError = error.message;
  }
  if (win) win.webContents.send('status-updated', statusCache);
  return statusCache;
}

function launchCodexBar() {
  try {
    verifyArtifact();
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(exePath),
    });
    child.unref();
    statusCache.lastError = null;
    setTimeout(refreshStatus, 700);
    return { ok: true };
  } catch (error) {
    statusCache.lastError = error.message;
    refreshStatus();
    return { ok: false, error: error.message };
  }
}

ipcMain.handle('get-status', () => refreshStatus());
ipcMain.handle('launch-codexbar', () => launchCodexBar());
ipcMain.handle('verify-artifact', () => {
  try {
    verifyArtifact();
    return refreshStatus();
  } catch (error) {
    statusCache.lastError = error.message;
    return refreshStatus();
  }
});
ipcMain.handle('open-folder', () => shell.openPath(path.dirname(exePath)));
ipcMain.handle('get-settings', () => ({
  width: settings.width,
  minWidth: MIN_WIDTH,
  maxWidth: MAX_WIDTH,
  autostart: app.getLoginItemSettings().openAtLogin,
}));
ipcMain.handle('set-settings', (_event, patch) => {
  if (typeof patch.autostart === 'boolean') app.setLoginItemSettings({ openAtLogin: patch.autostart });
  if (typeof patch.width === 'number') {
    settings.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(patch.width)));
    if (win) {
      const b = win.getBounds();
      const rightEdge = b.x + b.width;
      moveWindow({ x: rightEdge - settings.width, y: b.y, width: settings.width, height: b.height });
    }
  }
  saveSettings();
  return {
    width: settings.width,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    autostart: app.getLoginItemSettings().openAtLogin,
  };
});
ipcMain.handle('resize-window', (_event, { width, height, expanding }) => {
  if (!win) return { flipped: false };
  const anchor = pillAnchor();
  const workArea = screen.getDisplayNearestPoint(anchor).workArea;
  let nextFlipped = false;
  let y = anchor.y;
  if (expanding) {
    const panelHeight = height - PILL_HEIGHT;
    const spaceBelow = workArea.y + workArea.height - (anchor.y + PILL_HEIGHT);
    if (panelHeight > spaceBelow) {
      nextFlipped = true;
      y = Math.max(workArea.y, anchor.y - panelHeight);
    }
  }
  let x = anchor.x + collapsedSize().width - width;
  x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
  moveWindow({ x, y, width, height });
  flipped = nextFlipped;
  return { flipped };
});
ipcMain.on('pill-drag-start', () => {
  if (win) dragStartBounds = win.getBounds();
});
ipcMain.on('pill-drag-move', (_event, { dx, dy }) => {
  if (!win || !dragStartBounds) return;
  const targetX = dragStartBounds.x + dx;
  const targetY = dragStartBounds.y + dy;
  const display = screen.getDisplayNearestPoint({
    x: targetX + collapsedSize().width / 2,
    y: targetY + PILL_HEIGHT / 2,
  });
  const pos = snapToTaskbar(display.id, targetX, collapsedSize().width, PILL_HEIGHT);
  moveWindow({ x: pos.x, y: pos.y, ...collapsedSize() });
});
ipcMain.on('pill-drag-end', () => {
  if (!win || !dragStartBounds) return;
  const b = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  settings.dockDisplayId = display.id;
  settings.dockX = b.x;
  saveSettings();
  dragStartBounds = null;
});
ipcMain.on('quit', () => app.quit());

app.whenReady().then(() => {
  if (!fs.existsSync(AUTOSTART_MARKER)) {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.mkdirSync(path.dirname(AUTOSTART_MARKER), { recursive: true });
    fs.writeFileSync(AUTOSTART_MARKER, '');
  }
  loadSettings();
  refreshTaskbarRect();
  createWindow();
  createTray();
  refreshStatus();
  setInterval(refreshStatus, PROCESS_REFRESH_MS);
  setInterval(redock, DOCK_REFRESH_MS);
  screen.on('display-metrics-changed', redock);
});

app.on('window-all-closed', () => app.quit());
