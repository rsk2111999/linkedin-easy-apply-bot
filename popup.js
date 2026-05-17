const FIELDS  = ['fullName','email','phone','city','currentTitle','currentCompany','linkedinUrl','websiteUrl','coverLetter','yearsOfExperience','expectedSalary','noticePeriod','education'];
const TOGGLES = ['workAuthorized','requireSponsorship','willingToRelocate','currentlyEmployed'];
const FILTERS = ['includeKeywords','excludeKeywords'];
const FILTER_TOGGLES = ['remoteOnly'];

// ── Edit your defaults here ───────────────────────────────────────────────────
const DEFAULTS = {
  fullName:          'Ritwik Kadu',
  email:             '',
  phone:             '',
  city:              'Bangalore, India',
  currentTitle:      'Product Manager',
  currentCompany:    'Razorpay',
  linkedinUrl:       '',
  websiteUrl:        '',
  coverLetter:       '',
  yearsOfExperience: '',
  expectedSalary:    '',
  noticePeriod:      '1 month',
  education:         "Bachelor's Degree",
  workAuthorized:    true,
  requireSponsorship:false,
  willingToRelocate: false,
  currentlyEmployed: true,
  stepDelay:         900,
  // filters
  includeKeywords:   '',
  excludeKeywords:   '',
  remoteOnly:        false,
};
// ─────────────────────────────────────────────────────────────────────────────

// --- Tab switching ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Load saved data ---
function loadProfile(data) {
  [...FIELDS, ...FILTERS].forEach(f => {
    const el = document.getElementById(f);
    if (!el) return;
    el.value = data[f] !== undefined ? data[f] : (DEFAULTS[f] ?? '');
  });
  [...TOGGLES, ...FILTER_TOGGLES].forEach(f => {
    const el = document.getElementById(f);
    if (!el) return;
    el.checked = data[f] !== undefined ? data[f] : (DEFAULTS[f] ?? false);
  });
  const d = data.stepDelay ?? DEFAULTS.stepDelay;
  document.getElementById('stepDelay').value = d;
  document.getElementById('delayValue').textContent = `${d}ms`;
}

if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.local.get([...FIELDS, ...TOGGLES, ...FILTERS, ...FILTER_TOGGLES, 'stepDelay'], loadProfile);
} else {
  loadProfile({});
}

// --- Save ---
document.getElementById('saveBtn').addEventListener('click', () => {
  chrome.storage.local.set(collectAll(), () => {
    const btn = document.getElementById('saveBtn');
    btn.textContent = '✓ Saved!';
    setTimeout(() => btn.textContent = 'Save Profile', 1500);
  });
});

function collectAll() {
  const out = {};
  [...FIELDS, ...FILTERS].forEach(f => { out[f] = document.getElementById(f)?.value || ''; });
  [...TOGGLES, ...FILTER_TOGGLES].forEach(f => { out[f] = document.getElementById(f)?.checked || false; });
  out.stepDelay = parseInt(document.getElementById('stepDelay').value);
  return out;
}

function getProfile() {
  const d = collectAll();
  return { ...d, autoSubmit: true };
}

function getFilters() {
  return {
    includeKeywords: document.getElementById('includeKeywords')?.value || '',
    excludeKeywords: document.getElementById('excludeKeywords')?.value || '',
    remoteOnly:      document.getElementById('remoteOnly')?.checked || false,
  };
}

// --- Delay slider ---
document.getElementById('stepDelay').addEventListener('input', e => {
  document.getElementById('delayValue').textContent = `${e.target.value}ms`;
});

// --- Batch Apply ---
document.getElementById('batchBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url.includes('linkedin.com')) {
    addLog('Go to LinkedIn Jobs search first.', 'error'); return;
  }
  setRunning(true);
  resetProgress();
  addLog('Starting batch apply on this page...', 'info');
  chrome.tabs.sendMessage(tab.id, { action: 'batchApply', profile: getProfile(), filters: getFilters() },
    err => { if (chrome.runtime.lastError) { addLog(chrome.runtime.lastError.message, 'error'); setRunning(false); } }
  );
});

// --- Single Apply ---
document.getElementById('applyBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url.includes('linkedin.com')) {
    addLog('Go to a LinkedIn job page first.', 'error'); return;
  }
  setRunning(true);
  addLog('Applying to this job...', 'info');
  chrome.tabs.sendMessage(tab.id, { action: 'startApply', profile: getProfile() },
    err => { if (chrome.runtime.lastError) { addLog(chrome.runtime.lastError.message, 'error'); setRunning(false); } }
  );
});

// --- Stop ---
document.getElementById('stopBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'stopApply' });
  setRunning(false);
  addLog('Stopped.', 'warn');
});

// --- Clear log ---
document.getElementById('clearLog').addEventListener('click', () => {
  document.getElementById('activityLog').innerHTML = '';
});

// --- Messages from content script ---
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'log')       addLog(msg.text, msg.level || 'info');
  if (msg.type === 'error')     { setRunning(false); addLog(`Error: ${msg.text}`, 'error'); }
  if (msg.type === 'status')    updateStatus(msg.text);
  if (msg.type === 'progress')  updateProgress(msg.applied, msg.skipped, msg.failed, msg.total);
  if (msg.type === 'batchDone') {
    setRunning(false);
    updateStatus('Done');
    addLog(`Batch complete — Applied: ${msg.applied} | Skipped: ${msg.skipped} | Failed: ${msg.failed}`, 'success');
    showStats(msg.applied, msg.skipped, msg.failed, msg.total);
  }
  if (msg.type === 'done') { setRunning(false); updateStatus('Done'); }
});

// --- UI helpers ---
function setRunning(on) {
  document.getElementById('batchBtn').disabled = on;
  document.getElementById('applyBtn').disabled = on;
  document.getElementById('stopBtn').disabled  = !on;
  updateStatus(on ? 'Running' : 'Idle');
  if (on) document.getElementById('progressWrap').style.display = 'block';
}

function updateStatus(text) {
  const b = document.getElementById('statusBadge');
  b.textContent = text;
  b.className = 'status-badge';
  if (text === 'Running') b.classList.add('running');
  else if (text.includes('Error')) b.classList.add('error');
  else if (text === 'Done') b.classList.add('done');
}

function resetProgress() {
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressLabel').textContent = '0 / 0';
  document.getElementById('progressWrap').style.display = 'block';
}

function updateProgress(applied, skipped, failed, total) {
  const done = applied + skipped + failed;
  const pct  = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('progressFill').style.width  = `${pct}%`;
  document.getElementById('progressLabel').textContent = `${done} / ${total} (${applied} applied)`;
  showStats(applied, skipped, failed, total);
}

function showStats(applied, skipped, failed, total) {
  const row = document.getElementById('statsRow');
  row.style.display = 'flex';
  document.getElementById('statApplied').textContent = applied;
  document.getElementById('statSkipped').textContent = skipped;
  document.getElementById('statFailed').textContent  = failed;
  document.getElementById('statTotal').textContent   = total;
  // Switch to filters tab so stats are visible
  document.querySelector('[data-tab="filters"]').click();
}

function addLog(text, level = 'info') {
  const log   = document.getElementById('activityLog');
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  const time = new Date().toLocaleTimeString('en', { hour12: false });
  entry.textContent = `[${time}] ${text}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}
