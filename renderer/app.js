const PILL_HEIGHT = 46;
const PANEL_HEIGHT = 260;
const DRAG_THRESHOLD = 4;

let expanded = false;
let appSettings = {
  width: 300,
  minWidth: 240,
  maxWidth: 360,
  autostart: false,
};

const els = {
  pill: document.getElementById('pill'),
  panel: document.getElementById('panel'),
  statusDot: document.getElementById('status-dot'),
  pillSubtitle: document.getElementById('pill-subtitle'),
  pillVersion: document.getElementById('pill-version'),
  pillState: document.getElementById('pill-state'),
  heroStatus: document.getElementById('hero-status'),
  heroDetail: document.getElementById('hero-detail'),
  versionValue: document.getElementById('version-value'),
  checksumValue: document.getElementById('checksum-value'),
  openBtn: document.getElementById('open-btn'),
  verifyBtn: document.getElementById('verify-btn'),
  folderBtn: document.getElementById('folder-btn'),
  quitBtn: document.getElementById('quit-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  collapseBtn: document.getElementById('collapse-btn'),
  mainView: document.getElementById('main-view'),
  settingsView: document.getElementById('settings-view'),
  widthSlider: document.getElementById('width-slider'),
  widthValue: document.getElementById('width-value'),
  autostartToggle: document.getElementById('autostart-toggle'),
};

function shortHash(hash) {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : 'pending';
}

function renderStatus(status) {
  const hasError = !!status.lastError;
  els.statusDot.classList.toggle('running', status.running && !hasError);
  els.statusDot.classList.toggle('error', hasError);

  els.pillVersion.textContent = `v${status.version || '0.48.0'}`;
  els.pillState.textContent = hasError ? 'Error' : status.running ? 'Running' : 'Ready';
  els.pillSubtitle.textContent = hasError ? 'Verification failed' : status.verified ? 'Verified portable app' : 'Needs verify';

  els.heroStatus.textContent = hasError ? 'Action needed' : status.running ? 'CodexBar running' : 'Ready to open';
  els.heroDetail.textContent = status.lastError || (status.verified ? 'Portable executable verified.' : 'Run Verify before launch.');
  els.versionValue.textContent = status.version || '0.48.0';
  els.checksumValue.textContent = shortHash(status.hash);
}

async function refreshStatus() {
  renderStatus(await window.aiUsageBar.getStatus());
}

async function refreshSettings() {
  appSettings = await window.aiUsageBar.getSettings();
  els.widthSlider.min = appSettings.minWidth;
  els.widthSlider.max = appSettings.maxWidth;
  els.widthSlider.value = appSettings.width;
  els.widthValue.textContent = `${appSettings.width}px`;
  els.autostartToggle.checked = appSettings.autostart;
}

async function setExpanded(next) {
  expanded = next;
  const height = expanded ? PANEL_HEIGHT : PILL_HEIGHT;
  const { flipped } = await window.aiUsageBar.resizeWindow(appSettings.width, height, expanded);
  document.body.classList.toggle('flipped', expanded && flipped);
  els.panel.classList.toggle('hidden', !expanded);
}

let dragStart = null;
let dragging = false;

els.pill.addEventListener('pointerdown', (event) => {
  dragStart = { x: event.screenX, y: event.screenY };
  dragging = false;
  els.pill.setPointerCapture(event.pointerId);
});

els.pill.addEventListener('pointermove', (event) => {
  if (!dragStart) return;
  const dx = event.screenX - dragStart.x;
  const dy = event.screenY - dragStart.y;
  if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
    dragging = true;
    window.aiUsageBar.dragPillStart();
  }
  if (dragging) window.aiUsageBar.dragPillMove(dx, dy);
});

els.pill.addEventListener('pointerup', (event) => {
  if (dragStart && !dragging) setExpanded(!expanded);
  if (dragging) window.aiUsageBar.dragPillEnd();
  dragStart = null;
  dragging = false;
  els.pill.releasePointerCapture(event.pointerId);
});

els.openBtn.addEventListener('click', async () => {
  await window.aiUsageBar.launchCodexBar();
  refreshStatus();
});
els.verifyBtn.addEventListener('click', async () => renderStatus(await window.aiUsageBar.verifyArtifact()));
els.folderBtn.addEventListener('click', () => window.aiUsageBar.openFolder());
els.quitBtn.addEventListener('click', () => window.aiUsageBar.quit());
els.collapseBtn.addEventListener('click', () => setExpanded(false));
els.settingsBtn.addEventListener('click', () => {
  const showingSettings = els.settingsView.classList.toggle('hidden') === false;
  els.mainView.classList.toggle('hidden', showingSettings);
});
els.widthSlider.addEventListener('input', async (event) => {
  const width = Number(event.target.value);
  els.widthValue.textContent = `${width}px`;
  appSettings = await window.aiUsageBar.setSettings({ width });
});
els.autostartToggle.addEventListener('change', async (event) => {
  appSettings = await window.aiUsageBar.setSettings({ autostart: event.target.checked });
});

window.aiUsageBar.onStatusUpdated(renderStatus);

refreshSettings();
refreshStatus();
