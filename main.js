const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');

const PILL_HEIGHT = 30;
const PANEL_HEIGHT = 30;
const MIN_WIDTH = 68;
const MAX_WIDTH = 180;
const DOCK_REFRESH_MS = 60 * 1000;
const TOPMOST_REFRESH_MS = 250;
const PROCESS_REFRESH_MS = 3000;
const PROVIDER_USAGE_TTL_MS = 5 * 60 * 1000;
const CLI_USAGE_TIMEOUT_MS = 60 * 1000;
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const APP_VERSION = '0.48.0';
const TOPMOST_LEVEL = 'screen-saver';

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const AUTOSTART_MARKER = path.join(app.getPath('userData'), 'autostart-initialized');

const exePath = path.join(__dirname, 'dist', 'CodexBar-0.48.0-portable.exe');
const checksumPath = `${exePath}.sha256`;

let win;
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
  providers: [
    { id: 'loading', label: 'Loading usage', percent: 35, state: 'ready', detail: 'Loading AI usage' },
  ],
};
let providerUsageCache = { providers: [], readAt: 0 };
let providerRefreshInFlight = false;
let settings = {
  width: 88,
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

  settings.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(Number(settings.width) || 88)));
  if (!Number.isFinite(settings.dockX)) settings.dockX = null;
  if (!Number.isFinite(settings.dockDisplayId)) settings.dockDisplayId = null;
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
    const hasTaskbar = rect.taskbarLeft < rect.taskbarRight && rect.taskbarTop < rect.taskbarBottom;
    const hasTrayCluster = rect.trayLeft < rect.trayRight && rect.trayTop < rect.trayBottom;
    if (hasTaskbar && hasTrayCluster) taskbarRect = rect;
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
  win.setAlwaysOnTop(true, TOPMOST_LEVEL);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('renderer/index.html');
  win.on('closed', () => (win = null));
  win.on('show', () => win.setAlwaysOnTop(true, TOPMOST_LEVEL));
  win.on('blur', () => win.setAlwaysOnTop(true, TOPMOST_LEVEL));
  setInterval(() => win && win.setAlwaysOnTop(true, TOPMOST_LEVEL), TOPMOST_REFRESH_MS);
}

function redock() {
  refreshTaskbarRect();
  if (!win || win.getBounds().height > PILL_HEIGHT) return;
  const { x, y } = currentDockPosition(collapsedSize().width, PILL_HEIGHT);
  moveWindow({ x, y, ...collapsedSize() });
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


function tokenLabel(totalTokens) {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return 'no usage yet';
  if (totalTokens >= 1_000_000) return `${(totalTokens / 1_000_000).toFixed(1)}M tok`;
  if (totalTokens >= 1_000) return `${(totalTokens / 1_000).toFixed(1)}K tok`;
  return `${Math.round(totalTokens)} tok`;
}

function providerDisplayName(id) {
  const names = {
    codex: 'Codex',
    claude: 'Claude',
    copilot: 'Copilot',
    cursor: 'Cursor',
    gemini: 'Gemini',
    openaiapi: 'OpenAI',
    openrouter: 'OpenRouter',
  };
  return names[id] || id.replace(/(^|[-_])(\w)/g, (_m, _sep, chr) => chr.toUpperCase());
}

function windowPercent(window) {
  const value = Number(window?.used_percent ?? window?.usedPercent ?? window?.percent ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function normalizeProviderRecord(raw, index = 0) {
  const id = String(raw.id || raw.provider || raw.name || raw.label || `provider-${index}`).toLowerCase();
  const label = raw.label || raw.display_name || raw.displayName || raw.name || raw.provider || providerDisplayName(id);

  if (raw.error) {
    return {
      id,
      label: String(label),
      percent: 100,
      state: 'error',
      detail: String(raw.error).slice(0, 160),
      hasUsage: false,
      hasError: true,
    };
  }

  const windows = [];
  if (raw.usage?.primary) windows.push({ name: 'primary', window: raw.usage.primary });
  if (raw.usage?.secondary) windows.push({ name: 'secondary', window: raw.usage.secondary });
  for (const extra of raw.usage?.extra_rate_windows || raw.usage?.extraRateWindows || []) {
    windows.push({ name: extra.title || extra.id || 'extra', window: extra.window || extra });
  }

  const directPercent = Number(raw.percent ?? raw.percentage ?? raw.usage_percent ?? raw.usagePercent ?? raw.used_percent);
  const used = Number(raw.used ?? raw.current ?? raw.tokens ?? raw.total_tokens ?? raw.totalTokens ?? raw.usage ?? raw.input_tokens ?? 0);
  const limit = Number(raw.limit ?? raw.max ?? raw.quota ?? raw.total ?? raw.allowed ?? 0);

  let percent = 0;
  if (windows.length) {
    const nonInformational = windows.filter((entry) => !entry.window?.is_informational && !entry.window?.isInformational);
    const candidates = (nonInformational.length ? nonInformational : windows).map((entry) => windowPercent(entry.window));
    percent = Math.max(...candidates, 0);
  } else if (Number.isFinite(directPercent)) {
    percent = directPercent;
  } else if (limit > 0) {
    percent = (used / limit) * 100;
  } else if (Number.isFinite(used) && used > 0) {
    percent = Math.min(100, Math.max(8, Math.log10(used + 1) * 18));
  }

  const detailParts = windows
    .filter((entry) => Number.isFinite(windowPercent(entry.window)))
    .slice(0, 3)
    .map((entry) => `${entry.name} ${Math.round(windowPercent(entry.window))}%`);
  const detail = raw.detail || raw.summary || detailParts.join(' · ') || tokenLabel(used);

  return {
    id,
    label: String(label),
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    state: percent > 0 ? 'active' : 'ready',
    detail,
    hasUsage: true,
    hasError: false,
  };
}
function flattenUsagePayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const key of ['providers', 'items', 'usage', 'results', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (typeof payload === 'object') {
    return Object.entries(payload)
      .filter(([, value]) => value && typeof value === 'object')
      .map(([key, value]) => ({ id: key, provider: key, ...value }));
  }
  return [];
}

function cliCandidates() {
  const candidates = [
    path.join(__dirname, 'dist', 'codexbar-cli.exe'),
    path.join(__dirname, 'dist', 'codexbar.exe'),
    path.join(path.dirname(exePath), 'codexbar-cli.exe'),
    path.join(path.dirname(exePath), 'codexbar.exe'),
  ];

  for (const command of ['codexbar-cli', 'codexbar']) {
    try {
      const resolved = execFileSync('where.exe', [command], { timeout: 2000, windowsHide: true })
        .toString()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      candidates.push(...resolved);
    } catch {}
  }

  return [...new Set(candidates)].filter((candidate) => fs.existsSync(candidate));
}

function readProvidersFromCli() {
  for (const cli of cliCandidates()) {
    try {
      const out = execFileSync(cli, ['usage', '-p', 'all', '-f', 'json'], {
        timeout: 20000,
        windowsHide: true,
      }).toString().trim();
      if (!out) continue;
      const payload = JSON.parse(out);
      const records = flattenUsagePayload(payload).map(normalizeProviderRecord).filter(Boolean);
      if (records.length) return records;
    } catch {}
  }
  return [];
}

function readProvidersFromCliAsync() {
  const candidates = cliCandidates();
  let index = 0;

  return new Promise((resolve) => {
    const tryNext = () => {
      const cli = candidates[index++];
      if (!cli) {
        resolve([]);
        return;
      }

      execFile(cli, ['usage', '-p', 'all', '-f', 'json'], {
        timeout: CLI_USAGE_TIMEOUT_MS,
        windowsHide: true,
      }, (error, stdout) => {
        if (!error && stdout?.trim()) {
          try {
            const payload = JSON.parse(stdout.trim());
            const records = flattenUsagePayload(payload).map(normalizeProviderRecord).filter(Boolean);
            if (records.length) {
              resolve(records);
              return;
            }
          } catch {}
        }
        tryNext();
      });
    };

    tryNext();
  });
}

async function readClaudeUsageFallback() {
  const credentialDirs = [
    process.env.CLAUDE_CONFIG_DIR,
    path.join(app.getPath('home'), '.claude'),
  ].filter(Boolean);

  for (const dir of [...new Set(credentialDirs)]) {
    try {
      const credentials = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'));
      const token = credentials?.claudeAiOauth?.accessToken;
      if (!token) continue;

      const response = await fetch(CLAUDE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;

      const usage = await response.json();
      const fiveHour = Number(usage?.five_hour?.utilization);
      const sevenDay = Number(usage?.seven_day?.utilization);
      if (!Number.isFinite(fiveHour) && !Number.isFinite(sevenDay)) continue;

      const windows = [
        Number.isFinite(fiveHour) && `5h ${Math.round(fiveHour)}%`,
        Number.isFinite(sevenDay) && `7d ${Math.round(sevenDay)}%`,
      ].filter(Boolean);
      return {
        id: 'claude',
        label: 'Claude',
        percent: Math.max(fiveHour || 0, sevenDay || 0),
        detail: windows.join(' · '),
      };
    } catch {}
  }
  return null;
}

function readCodexCostCacheProvider() {
  const cachePath = path.join(process.env.LOCALAPPDATA || '', 'CodexBar', 'cost-usage', 'codex-v1.json');
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const days = cache.days || {};
    const dayKeys = Object.keys(days).sort();
    const latestDay = dayKeys.at(-1);
    if (!latestDay) return null;

    const models = days[latestDay] || {};
    let input = 0;
    let cached = 0;
    let output = 0;
    for (const totals of Object.values(models)) {
      if (!Array.isArray(totals)) continue;
      input += Number(totals[0] || 0);
      cached += Number(totals[1] || 0);
      output += Number(totals[2] || 0);
    }

    const totalTokens = input + output;
    if (totalTokens <= 0) return null;
    const modelCount = Object.keys(models).length;
    return {
      id: 'codex',
      label: 'Codex',
      percent: Math.max(12, Math.min(100, Math.round(Math.log10(totalTokens + 1) * 16))),
      state: 'active',
      detail: `${tokenLabel(totalTokens)} today · ${modelCount} model${modelCount === 1 ? '' : 's'}`,
      input,
      cached,
      output,
    };
  } catch {
    return null;
  }
}

function isNotableProviderError(provider) {
  if (!provider?.hasError) return false;
  if (/Provider not installed|No cookies available/i.test(provider.detail || '')) return false;
  return ['claude', 'cursor', 'codex', 'copilot', 'openaiapi', 'openrouter', 'gemini'].includes(provider.id);
}

function readProviderUsage() {
  const now = Date.now();
  if (providerUsageCache.providers.length && now - providerUsageCache.readAt < PROVIDER_USAGE_TTL_MS) {
    return providerUsageCache.providers;
  }

  const fallbackCodex = readCodexCostCacheProvider();
  const immediate = providerUsageCache.providers.length
    ? providerUsageCache.providers
    : [fallbackCodex || {
      id: 'loading',
      label: 'Loading usage',
      percent: 35,
      state: 'ready',
      detail: 'Loading AI usage',
      hasUsage: true,
      hasError: false,
    }];

  refreshProviderUsageAsync();
  return immediate.slice(0, 12);
}

async function refreshProviderUsageAsync() {
  if (providerRefreshInFlight) return;
  const now = Date.now();
  if (providerUsageCache.providers.length && now - providerUsageCache.readAt < PROVIDER_USAGE_TTL_MS) return;

  providerRefreshInFlight = true;
  try {
    const cliProviders = await readProvidersFromCliAsync();
    const usageProviders = cliProviders.filter((provider) => provider.hasUsage);
    const notableErrors = cliProviders.filter(isNotableProviderError);
    const claudeFallback = await readClaudeUsageFallback();
    const fallbackCodex = readCodexCostCacheProvider();

    const merged = [];
    for (const provider of [...usageProviders, claudeFallback, ...notableErrors, fallbackCodex].filter(Boolean)) {
      if (merged.some((existing) => existing.id === provider.id)) continue;
      merged.push(provider);
    }

    if (merged.length) {
      providerUsageCache = { providers: merged.slice(0, 12), readAt: Date.now() };
      statusCache.providers = providerUsageCache.providers;
      if (win) win.webContents.send('status-updated', statusCache);
    }
  } finally {
    providerRefreshInFlight = false;
  }
}
function refreshStatus() {
  statusCache.running = isCodexBarRunning();
  statusCache.providers = readProviderUsage();
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
ipcMain.handle('resize-window', (_event, { width, height }) => {
  if (!win) return { flipped: false };
  const anchor = pillAnchor();
  const workArea = screen.getDisplayNearestPoint(anchor).workArea;
  let x = anchor.x + collapsedSize().width - width;
  x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
  moveWindow({ x, y: anchor.y, width, height });
  flipped = false;
  return { flipped: false };
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
  refreshStatus();
  setInterval(refreshStatus, PROCESS_REFRESH_MS);
  setInterval(redock, DOCK_REFRESH_MS);
  screen.on('display-added', redock);
  screen.on('display-removed', redock);
  screen.on('display-metrics-changed', redock);
});

app.on('window-all-closed', () => app.quit());

