// ─── Auth Check ───
(async function checkAuth() {
  try {
    const res = await fetch('/api/auth-status');
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login.html';
      return;
    }
    // Set username in header
    const userNameEl = document.getElementById('user-name');
    if (userNameEl) userNameEl.textContent = data.username;
  } catch (_) {
    window.location.href = '/login.html';
  }
})();

// ─── State ───
let isConnected = false;
let statusPollTimer = null;
let allBranches = [];

// ─── DOM References ───
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');

const repoUrlInput = document.getElementById('repoUrl');
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const statusBadge = document.getElementById('status-badge');
const repoStatus = document.getElementById('repo-status');
const panelsOverlay = document.getElementById('panels-overlay');
const queueBanner = document.getElementById('queue-banner');
const queueText = document.getElementById('queue-text');

const formIncrement = document.getElementById('form-increment');
const formCherryPick = document.getElementById('form-cherry-pick');
const formPublish = document.getElementById('form-publish');

const resultIncrement = document.getElementById('result-increment');
const resultCherryPick = document.getElementById('result-cherry-pick');
const resultPublish = document.getElementById('result-publish');

const confirmModal = document.getElementById('confirm-modal');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');

// ─── Tab Switching ───
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ─── Helpers ───
function setLoading(btn, loading) {
  const text = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.spinner');
  if (loading) {
    btn.disabled = true;
    if (text) text.style.display = 'none';
    if (spinner) spinner.classList.remove('hidden');
  } else {
    btn.disabled = false;
    if (text) text.style.display = '';
    if (spinner) spinner.classList.add('hidden');
  }
}

function showResult(container, success, message, details) {
  const type = success ? 'success' : 'error';
  const icon = success ? '✅' : '❌';
  let detailsHtml = '';

  if (details) {
    try {
      const formatted = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
      detailsHtml = `<pre>${escapeHtml(formatted)}</pre>`;
    } catch (_) {
      detailsHtml = '';
    }
  }

  container.innerHTML = `
    <div class="result-box ${type}">
      <strong>${icon} ${escapeHtml(message)}</strong>
      ${detailsHtml}
    </div>
  `;
}

function clearResult(container) {
  container.innerHTML = '';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function apiCall(url, body, method = 'POST') {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  // If 401, redirect to login
  if (response.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Session expired');
  }
  const data = await response.json();
  return data;
}

// ─── Logout ───
document.getElementById('btn-logout').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (_) {}
  window.location.href = '/login.html';
});

// ══════════════════════════════════════════════
// Searchable Select Component
// ══════════════════════════════════════════════
class SearchSelect {
  constructor(containerEl, onSelectCallback) {
    this.container = containerEl;
    this.input = containerEl.querySelector('.ss-input');
    this.hiddenInput = containerEl.querySelector('.ss-value');
    this.dropdown = containerEl.querySelector('.ss-dropdown');
    this.list = containerEl.querySelector('.ss-list');
    this.items = [];
    this.selectedValue = '';
    this.highlightedIndex = -1;
    this.isOpen = false;
    this.onSelectCallback = onSelectCallback || null;

    this._bindEvents();
  }

  _bindEvents() {
    // Open on focus
    this.input.addEventListener('focus', () => {
      this._open();
      this.input.select();
    });

    // Filter on input
    this.input.addEventListener('input', () => {
      this.selectedValue = '';
      this.hiddenInput.value = '';
      this.input.classList.remove('has-value');
      this.highlightedIndex = -1;
      this._render(this.input.value);
      this._open();
    });

    // Keyboard navigation
    this.input.addEventListener('keydown', (e) => {
      const visible = this.list.querySelectorAll('.ss-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.highlightedIndex = Math.min(this.highlightedIndex + 1, visible.length - 1);
        this._updateHighlight(visible);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.highlightedIndex = Math.max(this.highlightedIndex - 1, 0);
        this._updateHighlight(visible);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.highlightedIndex >= 0 && visible[this.highlightedIndex]) {
          this._select(visible[this.highlightedIndex].dataset.value);
        }
      } else if (e.key === 'Escape') {
        this._close();
        this.input.blur();
      }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target)) {
        this._close();
        // If no valid selection, reset
        if (!this.selectedValue && this.input.value) {
          // Try to match exactly
          const match = this.items.find((b) => b === this.input.value);
          if (match) {
            this._select(match);
          } else {
            this.input.value = '';
          }
        }
      }
    });
  }

  setItems(items) {
    this.items = items;
    this.selectedValue = '';
    this.hiddenInput.value = '';
    this.input.value = '';
    this.input.classList.remove('has-value');
    this.input.disabled = items.length === 0;
    this.input.placeholder = items.length === 0 ? 'No branches available' : 'Search branches…';
    this._render('');
  }

  setLoading() {
    this.items = [];
    this.selectedValue = '';
    this.hiddenInput.value = '';
    this.input.value = '';
    this.input.disabled = true;
    this.input.placeholder = 'Loading branches…';
    this.list.innerHTML = '';
    this._close();
  }

  setEmpty() {
    this.items = [];
    this.selectedValue = '';
    this.hiddenInput.value = '';
    this.input.value = '';
    this.input.disabled = true;
    this.input.placeholder = 'Connect a repo first';
    this.list.innerHTML = '';
    this._close();
  }

  getValue() {
    return this.selectedValue;
  }

  _open() {
    if (this.items.length === 0) return;
    this.isOpen = true;
    this.dropdown.classList.remove('hidden');
    this._render(this.input.value);
  }

  _close() {
    this.isOpen = false;
    this.dropdown.classList.add('hidden');
    this.highlightedIndex = -1;
  }

  _select(value) {
    this.selectedValue = value;
    this.hiddenInput.value = value;
    this.input.value = value;
    this.input.classList.add('has-value');
    this._close();
    if (this.onSelectCallback) {
      this.onSelectCallback(value);
    }
  }

  _render(filter) {
    const query = (filter || '').toLowerCase();
    const filtered = this.items.filter((b) => b.toLowerCase().includes(query));

    if (filtered.length === 0) {
      this.list.innerHTML = `<div class="ss-empty">No matching branches</div>`;
      return;
    }

    this.list.innerHTML = filtered
      .map((b) => {
        const isSelected = b === this.selectedValue ? ' selected' : '';
        return `<div class="ss-item${isSelected}" data-value="${escapeHtml(b)}">${escapeHtml(b)}</div>`;
      })
      .join('');

    // Attach click handlers
    this.list.querySelectorAll('.ss-item').forEach((el) => {
      el.addEventListener('click', () => {
        this._select(el.dataset.value);
      });
    });
  }

  _updateHighlight(visible) {
    visible.forEach((el, i) => {
      el.classList.toggle('highlighted', i === this.highlightedIndex);
    });
    // Scroll into view
    if (visible[this.highlightedIndex]) {
      visible[this.highlightedIndex].scrollIntoView({ block: 'nearest' });
    }
  }
}

// ─── Version field references ───
const incVersionInput = document.getElementById('inc-version');
const incVersionHint = document.getElementById('inc-version-hint');
const incCheckinId = document.getElementById('inc-checkin-id');
const incMessage = document.getElementById('inc-message');
let incOriginalVersion = '';

// ─── Auto-generate commit message ───
function updateCommitMessage() {
  const checkinId = incCheckinId.value.trim();
  const newVersion = incVersionInput.value.trim();
  let msg = '';
  if (checkinId) {
    msg += `checkin id : ${checkinId}`;
  }
  if (incOriginalVersion && newVersion) {
    if (msg) msg += ' , ';
    msg += `version update from ${incOriginalVersion} to ${newVersion}`;
  }
  incMessage.value = msg;
}

// Only allow numbers in checkin ID
incCheckinId.addEventListener('input', () => {
  incCheckinId.value = incCheckinId.value.replace(/[^0-9]/g, '');
  updateCommitMessage();
});

incVersionInput.addEventListener('input', () => {
  updateCommitMessage();
});

// ─── Fetch version when branch is selected ───
async function onIncBranchSelected(branch) {
  incVersionInput.value = '';
  incVersionInput.disabled = true;
  incOriginalVersion = '';
  incVersionHint.textContent = 'Loading version…';
  incVersionHint.className = 'field-hint loading';

  try {
    const data = await apiCall('/api/get-version', { branch });
    if (data.success && data.version) {
      incOriginalVersion = data.version;
      incVersionInput.value = data.version;
      incVersionInput.disabled = false;
      incVersionHint.textContent = `Actual version: ${data.version}`;
      incVersionHint.className = 'field-hint';
      updateCommitMessage();
    } else {
      incVersionInput.value = '';
      incVersionInput.disabled = false;
      incVersionInput.placeholder = 'e.g. 1.0.0';
      incVersionHint.textContent = data.message || 'Could not read version. Enter manually.';
      incVersionHint.className = 'field-hint error';
    }
  } catch (_) {
    incVersionInput.value = '';
    incVersionInput.disabled = false;
    incVersionInput.placeholder = 'e.g. 1.0.0';
    incVersionHint.textContent = 'Failed to fetch version. Enter manually.';
    incVersionHint.className = 'field-hint error';
  }
}

// Create instances
const ssIncBranch = new SearchSelect(document.getElementById('ss-inc-branch'), onIncBranchSelected);
const ssCpBranch = new SearchSelect(document.getElementById('ss-cp-branch'));
const ssPubBranch = new SearchSelect(document.getElementById('ss-pub-branch'));
const allSearchSelects = [ssIncBranch, ssCpBranch, ssPubBranch];

// ─── Connection UI State ───
function setConnectionUI(connected, url) {
  isConnected = connected;
  if (connected) {
    statusBadge.textContent = 'Connected';
    statusBadge.className = 'status-badge connected';
    repoUrlInput.disabled = true;
    btnConnect.classList.add('hidden');
    btnDisconnect.classList.remove('hidden');
    panelsOverlay.classList.add('hidden');
    repoStatus.textContent = `Connected to ${url}`;
    repoStatus.className = 'repo-status success';
  } else {
    statusBadge.textContent = 'Disconnected';
    statusBadge.className = 'status-badge disconnected';
    repoUrlInput.disabled = false;
    btnConnect.classList.remove('hidden');
    btnDisconnect.classList.add('hidden');
    panelsOverlay.classList.remove('hidden');
    repoStatus.textContent = '';
    repoStatus.className = 'repo-status';
  }
}

function setConnectingUI() {
  statusBadge.textContent = 'Connecting…';
  statusBadge.className = 'status-badge connecting';
  repoUrlInput.disabled = true;
  repoStatus.textContent = 'Cloning repository… this may take a moment.';
  repoStatus.className = 'repo-status';
}

// ─── Queue Status Polling ───
function startQueuePolling() {
  if (statusPollTimer) return;
  statusPollTimer = setInterval(async () => {
    try {
      const data = await apiCall('/api/status', null, 'GET');
      if (data.queue.busy) {
        queueBanner.classList.remove('hidden');
        const waiting = data.queue.waiting;
        queueText.textContent = waiting > 0
          ? `An operation is running. ${waiting} request(s) queued…`
          : 'An operation is currently in progress…';
      } else {
        queueBanner.classList.add('hidden');
      }
    } catch (_) {
      // ignore polling errors
    }
  }, 1500);
}

function stopQueuePolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
  queueBanner.classList.add('hidden');
}

// ─── Branch Fetching ───
async function fetchBranches() {
  allSearchSelects.forEach((ss) => ss.setLoading());
  try {
    const data = await apiCall('/api/branches', null, 'GET');
    if (data.success && data.branches) {
      allBranches = data.branches;
      allSearchSelects.forEach((ss) => ss.setItems(data.branches));
    } else {
      allBranches = [];
      allSearchSelects.forEach((ss) => ss.setItems([]));
    }
  } catch (_) {
    allBranches = [];
    allSearchSelects.forEach((ss) => ss.setItems([]));
  }
}

function resetBranches() {
  allBranches = [];
  allSearchSelects.forEach((ss) => ss.setEmpty());
}

// ─── Connect ───
btnConnect.addEventListener('click', async () => {
  const repoUrl = repoUrlInput.value.trim();
  if (!repoUrl) {
    repoStatus.textContent = 'Please select a Git repository URL.';
    repoStatus.className = 'repo-status error';
    return;
  }

  setConnectingUI();
  setLoading(btnConnect, true);

  try {
    const data = await apiCall('/api/connect', { repoUrl });
    if (data.success) {
      setConnectionUI(true, repoUrl);
      startQueuePolling();
      await fetchBranches();
    } else {
      setConnectionUI(false);
      resetBranches();
      repoStatus.textContent = data.message || 'Failed to connect.';
      repoStatus.className = 'repo-status error';
    }
  } catch (err) {
    setConnectionUI(false);
    resetBranches();
    repoStatus.textContent = 'Network error. Is the server running?';
    repoStatus.className = 'repo-status error';
  } finally {
    setLoading(btnConnect, false);
  }
});

// ─── Disconnect ───
btnDisconnect.addEventListener('click', async () => {
  try {
    await apiCall('/api/disconnect', {});
  } catch (_) {
    // disconnect even on error
  }
  setConnectionUI(false);
  resetBranches();
  stopQueuePolling();
  clearResult(resultIncrement);
  clearResult(resultCherryPick);
  clearResult(resultPublish);
});

// ─── Check initial status on page load ───
(async function checkInitialStatus() {
  try {
    const data = await apiCall('/api/status', null, 'GET');
    if (data.repo.ready && data.repo.url) {
      repoUrlInput.value = data.repo.url;
      setConnectionUI(true, data.repo.url);
      startQueuePolling();
      await fetchBranches();
    } else {
      resetBranches();
    }
  } catch (_) {
    resetBranches();
  }
})();

// ─── 1. Increment Version ───
formIncrement.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearResult(resultIncrement);

  if (!isConnected) {
    showResult(resultIncrement, false, 'Please connect a repository first.');
    return;
  }

  const branch = ssIncBranch.getValue();
  if (!branch) {
    showResult(resultIncrement, false, 'Please select a branch.');
    return;
  }

  const newVersion = incVersionInput.value.trim();
  if (!newVersion) {
    showResult(resultIncrement, false, 'Please enter the new version.');
    return;
  }

  if (!/^\d+\.\d+\.\d+/.test(newVersion)) {
    showResult(resultIncrement, false, 'Invalid version format. Expected something like 1.2.3');
    return;
  }

  const message = document.getElementById('inc-message').value.trim();
  if (!message) {
    showResult(resultIncrement, false, 'Please enter a commit message.');
    return;
  }

  const btn = document.getElementById('btn-increment');
  setLoading(btn, true);

  try {
    const data = await apiCall('/api/increment-version', { branch, message, newVersion });
    showResult(resultIncrement, data.success, data.message, data.details);
  } catch (err) {
    showResult(resultIncrement, false, 'Network error. Is the server running?');
  } finally {
    setLoading(btn, false);
  }
});

// ─── 2. Cherry Pick ───
formCherryPick.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearResult(resultCherryPick);

  if (!isConnected) {
    showResult(resultCherryPick, false, 'Please connect a repository first.');
    return;
  }

  const branch = ssCpBranch.getValue();
  if (!branch) {
    showResult(resultCherryPick, false, 'Please select a target branch.');
    return;
  }

  const commitId = document.getElementById('cp-commit').value.trim();
  if (!commitId) {
    showResult(resultCherryPick, false, 'Please enter a commit ID.');
    return;
  }

  const btn = document.getElementById('btn-cherry-pick');
  setLoading(btn, true);

  try {
    const data = await apiCall('/api/cherry-pick', { branch, commitId });
    showResult(resultCherryPick, data.success, data.message, data.details);
  } catch (err) {
    showResult(resultCherryPick, false, 'Network error. Is the server running?');
  } finally {
    setLoading(btn, false);
  }
});

// ─── 3. Publish (with confirmation modal) ───
formPublish.addEventListener('submit', (e) => {
  e.preventDefault();
  clearResult(resultPublish);

  if (!isConnected) {
    showResult(resultPublish, false, 'Please connect a repository first.');
    return;
  }

  const branch = ssPubBranch.getValue();
  if (!branch) {
    showResult(resultPublish, false, 'Please select a branch.');
    return;
  }

  // Show confirmation modal
  confirmModal.classList.remove('hidden');

  const onConfirm = async () => {
    cleanup();
    confirmModal.classList.add('hidden');

    const btn = document.getElementById('btn-publish');
    setLoading(btn, true);

    try {
      const tagging = document.getElementById('pub-tagging').value;
      const data = await apiCall('/api/publish', { branch, tagging });
      showResult(resultPublish, data.success, data.message, data.details);
    } catch (err) {
      showResult(resultPublish, false, 'Network error. Is the server running?');
    } finally {
      setLoading(btn, false);
    }
  };

  const onCancel = () => {
    cleanup();
    confirmModal.classList.add('hidden');
  };

  const cleanup = () => {
    modalConfirm.removeEventListener('click', onConfirm);
    modalCancel.removeEventListener('click', onCancel);
  };

  modalConfirm.addEventListener('click', onConfirm);
  modalCancel.addEventListener('click', onCancel);
});

// Close modal on overlay click
confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal) {
    confirmModal.classList.add('hidden');
  }
});