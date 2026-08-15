const DRAG_THRESHOLD = 4;

const pillEl = document.getElementById('pill');
const stripEl = document.getElementById('usage-strip');

let dragStart = null;
let dragging = false;
let latestStatus = null;

function normalizeBars(status) {
  if (Array.isArray(status?.providers) && status.providers.length) {
    return status.providers.slice(0, 12).map((provider) => ({
      id: provider.id || provider.name || 'provider',
      label: provider.label || provider.name || provider.id || 'AI',
      percent: Number.isFinite(provider.percent) ? provider.percent : 0,
      state: provider.state || 'ready',
    }));
  }

  if (status?.lastError) {
    return [{ id: 'error', label: 'CodexBar error', percent: 100, state: 'error' }];
  }

  if (status?.running) {
    return [{ id: 'codexbar', label: 'CodexBar running', percent: 100, state: 'active' }];
  }

  if (status?.verified) {
    return [{ id: 'codexbar', label: 'CodexBar ready', percent: 42, state: 'ready' }];
  }

  return [{ id: 'codexbar', label: 'CodexBar inactive', percent: 18, state: 'inactive' }];
}

function renderStatus(status) {
  latestStatus = status;
  const bars = normalizeBars(status);
  stripEl.innerHTML = '';

  for (const bar of bars) {
    const value = Math.max(8, Math.min(100, Math.round(bar.percent || 0)));
    const item = document.createElement('div');
    item.className = `usage-bar ${bar.state}`;
    item.title = `${bar.label}: ${value}%`;

    const fill = document.createElement('div');
    fill.className = 'usage-fill';
    fill.style.height = `${value}%`;

    item.appendChild(fill);
    stripEl.appendChild(item);
  }
}

async function refreshStatus() {
  renderStatus(await window.aiUsageBar.getStatus());
}

pillEl.addEventListener('pointerdown', (event) => {
  dragStart = { x: event.screenX, y: event.screenY };
  dragging = false;
  pillEl.setPointerCapture(event.pointerId);
});

pillEl.addEventListener('pointermove', (event) => {
  if (!dragStart) return;
  const dx = event.screenX - dragStart.x;
  const dy = event.screenY - dragStart.y;
  if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
    dragging = true;
    window.aiUsageBar.dragPillStart();
  }
  if (dragging) window.aiUsageBar.dragPillMove(dx, dy);
});

pillEl.addEventListener('pointerup', async (event) => {
  if (dragging) {
    window.aiUsageBar.dragPillEnd();
  } else {
    await window.aiUsageBar.launchCodexBar();
    refreshStatus();
  }
  dragStart = null;
  dragging = false;
  pillEl.releasePointerCapture(event.pointerId);
});

window.aiUsageBar.onStatusUpdated(renderStatus);
refreshStatus();

