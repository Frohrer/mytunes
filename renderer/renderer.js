// Supported audio extensions
const SUPPORTED_EXTENSIONS = [
  '.m4r', '.mp3', '.mp4', '.m4a', '.wav', '.aiff', '.aif',
  '.flac', '.ogg', '.wma', '.aac', '.caf', '.mov', '.m4v'
];

// State
let currentDevice = null;
let currentTab = 'upload';
let queuedFiles = [];
let deviceRingtones = [];     // { name, size, modified, selected, title, artist, duration, audioUrl, loaded }
let isTransferring = false;
let isDeleting = false;
let isLoadingRingtones = false;
let nowPlayingFile = null;     // filename currently playing

// DOM elements
const statusDot = document.getElementById('statusDot');
const deviceName = document.getElementById('deviceName');
const refreshBtn = document.getElementById('refreshBtn');
const dropzone = document.getElementById('dropzone');
const fileList = document.getElementById('fileList');
const actionBar = document.getElementById('actionBar');
const fileCount = document.getElementById('fileCount');
const clearBtn = document.getElementById('clearBtn');
const transferBtn = document.getElementById('transferBtn');
const helpTip = document.getElementById('helpTip');
const tabUpload = document.getElementById('tabUpload');
const tabDevice = document.getElementById('tabDevice');
const uploadView = document.getElementById('uploadView');
const deviceView = document.getElementById('deviceView');
const deviceFileList = document.getElementById('deviceFileList');
const ringtoneCount = document.getElementById('ringtoneCount');
const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
const saveSelectedBtn = document.getElementById('saveSelectedBtn');
const deviceEmpty = document.getElementById('deviceEmpty');
const deviceLoading = document.getElementById('deviceLoading');
const nowPlayingBar = document.getElementById('nowPlaying');
const npPlayBtn = document.getElementById('npPlayBtn');
const npTitle = document.getElementById('npTitle');
const npTime = document.getElementById('npTime');
const npProgress = document.getElementById('npProgress');
const npProgressWrap = document.getElementById('npProgressWrap');
const npClose = document.getElementById('npClose');
const audioPlayer = document.getElementById('audioPlayer');
const disconnectOverlay = document.getElementById('disconnectOverlay');

// ===== Tabs =====

const deviceHeader = document.getElementById('deviceHeader');

function switchTab(tab) {
  currentTab = tab;
  tabUpload.classList.toggle('active', tab === 'upload');
  tabDevice.classList.toggle('active', tab === 'device');
  uploadView.classList.toggle('hidden', tab !== 'upload');
  deviceView.classList.toggle('hidden', tab !== 'device');
  deviceHeader.classList.toggle('hidden', tab !== 'device');
  actionBar.style.display = (tab === 'upload' && queuedFiles.length > 0) ? 'flex' : 'none';

  if (tab === 'device' && currentDevice) {
    loadDeviceRingtones();
  }
}

tabUpload.addEventListener('click', () => switchTab('upload'));
tabDevice.addEventListener('click', () => switchTab('device'));

// ===== Device Polling =====

let pollInterval = null;
let wasConnectedBefore = false;
let reconnecting = false;
let reconnectTimer = null;

async function refreshDevices() {
  refreshBtn.classList.add('spinning');
  statusDot.className = 'status-dot searching';

  try {
    const result = await window.mytunes.getDevices();
    if (result.success && result.devices.length > 0) {
      const wasDisconnected = !currentDevice;
      currentDevice = result.devices[0];
      statusDot.className = 'status-dot connected';
      deviceName.textContent = `${currentDevice.name} (iOS ${currentDevice.iosVersion})`;
      transferBtn.disabled = isTransferring;
      helpTip.classList.add('hidden');
      document.getElementById('deviceWarning').classList.remove('hidden');

      // Hide overlay and switch back to normal polling
      if (reconnecting) {
        reconnecting = false;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        disconnectOverlay.classList.add('hidden');
        startPolling();
      }

      if (!wasConnectedBefore || wasDisconnected) updateDeviceTabCount();
      wasConnectedBefore = true;
    } else {
      const justLost = !!currentDevice || wasConnectedBefore;
      currentDevice = null;
      statusDot.className = 'status-dot';
      transferBtn.disabled = true;
      document.getElementById('deviceWarning').classList.add('hidden');

      if (justLost && wasConnectedBefore) {
        // Device was connected and just disconnected (likely from Sleep reload)
        reconnecting = true;
        disconnectOverlay.classList.remove('hidden');
        document.getElementById('disconnectSubtext').textContent = 'Waiting for device after screen reload';
        deviceName.textContent = 'Reconnecting...';
        reconnectTimer = setTimeout(() => {
          document.getElementById('disconnectSubtext').textContent = 'Make sure it\'s plugged in and unlocked, dummy';
        }, 10000);
        startFastPolling();
      } else {
        deviceName.textContent = result.success
          ? 'No device found \u2014 unlock iPhone & tap "Trust"'
          : result.error;
        helpTip.classList.remove('hidden');
        tabDevice.innerHTML = 'On Device';
      }
    }
  } catch (e) {
    currentDevice = null;
    statusDot.className = 'status-dot';
    deviceName.textContent = 'Cannot connect to usbmuxd';
    transferBtn.disabled = true;
  }

  refreshBtn.classList.remove('spinning');
}

async function updateDeviceTabCount() {
  if (!currentDevice) return;
  try {
    const result = await window.mytunes.listRingtones(currentDevice.id, currentDevice.udid);
    if (result.success) {
      tabDevice.innerHTML = `On Device <span class="tab-count">${result.ringtones.length}</span>`;
    }
  } catch {}
}

function startPolling() {
  stopPolling();
  refreshDevices();
  pollInterval = setInterval(refreshDevices, 5000);
}

function startFastPolling() {
  stopPolling();
  pollInterval = setInterval(refreshDevices, 1500);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// ===== Upload View =====

function getExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.substring(dot).toLowerCase() : '';
}

function addFiles(filePaths) {
  for (const fp of filePaths) {
    if (queuedFiles.some(f => f.path === fp)) continue;
    const name = fp.split('/').pop().split('\\').pop();
    const ext = getExtension(name);
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;
    const baseName = name.replace(/\.[^.]+$/, '');
    queuedFiles.push({ path: fp, name, ext, needsConvert: ext !== '.m4r', status: 'queued', customName: baseName });
  }
  renderUploadList();
}

function removeFile(index) {
  if (isTransferring) return;
  queuedFiles.splice(index, 1);
  renderUploadList();
}

function clearFiles() {
  if (isTransferring) return;
  queuedFiles = [];
  renderUploadList();
}

function renderUploadList() {
  fileList.innerHTML = '';
  for (let i = 0; i < queuedFiles.length; i++) {
    const file = queuedFiles[i];
    const item = document.createElement('div');
    item.className = 'file-item';

    const statusLabel = {
      queued: file.needsConvert ? 'Will convert' : 'Ready',
      converting: 'Converting...', converted: 'Converted',
      'convert-error': 'Convert failed',
      uploading: 'Uploading...', done: 'Done', error: 'Failed'
    }[file.status] || file.status;

    const statusClass = {
      queued: file.needsConvert ? 'converting' : 'queued',
      converting: 'uploading', converted: 'queued', 'convert-error': 'error',
      uploading: 'uploading', done: 'done', error: 'error'
    }[file.status] || 'queued';

    const badge = file.needsConvert && file.status === 'queued'
      ? `<span class="file-badge">${file.ext.slice(1).toUpperCase()}</span>` : '';

    const isEditable = !isTransferring && file.status === 'queued';

    item.innerHTML = `
      <div class="file-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
        </svg>
      </div>
      <div class="file-info">
        ${isEditable
          ? `<input class="upload-name-input" data-index="${i}" value="${file.customName}" title="Edit ringtone name" />`
          : `<div class="file-name" title="${file.path}">${file.customName}</div>`
        }
        <div class="file-meta">${file.name}</div>
      </div>
      ${badge}
      <span class="file-status ${statusClass}">${statusLabel}</span>
      ${!isTransferring ? `<button class="file-remove" data-index="${i}" title="Remove">&times;</button>` : ''}
    `;
    fileList.appendChild(item);
  }

  actionBar.style.display = (currentTab === 'upload' && queuedFiles.length > 0) ? 'flex' : 'none';
  const convertCount = queuedFiles.filter(f => f.needsConvert && f.status === 'queued').length;
  const totalCount = queuedFiles.length;
  fileCount.textContent = convertCount > 0
    ? `${totalCount} file${totalCount !== 1 ? 's' : ''} (${convertCount} to convert)`
    : `${totalCount} file${totalCount !== 1 ? 's' : ''}`;
  transferBtn.disabled = !currentDevice || isTransferring || queuedFiles.length === 0;
  dropzone.style.padding = queuedFiles.length > 0 ? '20px' : '40px 20px';
}

async function startTransfer() {
  if (!currentDevice || isTransferring || queuedFiles.length === 0) return;
  isTransferring = true;
  transferBtn.disabled = true;
  stopPolling();

  try {
    const files = queuedFiles.map(f => ({ path: f.path, customName: f.customName }));
    const result = await window.mytunes.transferRingtones(
      currentDevice.id, currentDevice.udid, files
    );
    if (result.success) {
      for (let i = 0; i < result.results.length; i++) {
        queuedFiles[i].status = result.results[i].success ? 'done' : 'error';
      }
    } else {
      showError(result.error);
      for (const f of queuedFiles) { if (f.status !== 'done' && f.status !== 'error') f.status = 'error'; }
    }
  } catch (e) { showError(e.message); }

  isTransferring = false;
  renderUploadList();
  startPolling();
  updateDeviceTabCount();

}

// ===== Device View =====

async function loadDeviceRingtones() {
  if (!currentDevice || isLoadingRingtones) return;
  isLoadingRingtones = true;
  deviceLoading.classList.remove('hidden');
  deviceEmpty.classList.add('hidden');
  deviceFileList.innerHTML = '';

  try {
    const result = await window.mytunes.listRingtones(currentDevice.id, currentDevice.udid);
    if (result.success) {
      deviceRingtones = result.ringtones.map(r => ({
        ...r, selected: false, title: null, artist: null, duration: null, audioUrl: null, loaded: false
      }));
      deviceRingtones.sort((a, b) => a.name.localeCompare(b.name));
      tabDevice.innerHTML = `On Device <span class="tab-count">${deviceRingtones.length}</span>`;
    } else {
      showError(result.error);
      deviceRingtones = [];
    }
  } catch (e) { showError(e.message); deviceRingtones = []; }

  isLoadingRingtones = false;
  deviceLoading.classList.add('hidden');
  renderDeviceList();

  // Load metadata in background
  if (deviceRingtones.length > 0 && currentDevice) {
    loadRingtoneDetails();
  }
}

async function loadRingtoneDetails() {
  if (!currentDevice || deviceRingtones.length === 0) return;
  const fileNames = deviceRingtones.map(r => r.name);

  try {
    const result = await window.mytunes.loadRingtoneDetails(
      currentDevice.id, currentDevice.udid, fileNames
    );
    if (result.success) {
      for (const detail of result.details) {
        const rt = deviceRingtones.find(r => r.name === detail.file);
        if (rt && detail.success) {
          rt.title = detail.title;
          rt.artist = detail.artist;
          rt.duration = detail.duration;
          rt.audioUrl = detail.audioUrl;
          rt.localPath = detail.localPath;
          rt.loaded = true;
        }
      }
      renderDeviceList();
    }
  } catch {}
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toggleRingtoneSelection(index) {
  if (isDeleting) return;
  deviceRingtones[index].selected = !deviceRingtones[index].selected;
  renderDeviceList();
}

function renderDeviceList() {
  deviceFileList.innerHTML = '';
  deviceEmpty.classList.toggle('hidden', deviceRingtones.length > 0);

  const selectedCount = deviceRingtones.filter(r => r.selected).length;
  ringtoneCount.textContent = selectedCount > 0
    ? `${selectedCount} of ${deviceRingtones.length} selected`
    : `${deviceRingtones.length} ringtone${deviceRingtones.length !== 1 ? 's' : ''}`;
  deleteSelectedBtn.disabled = selectedCount === 0 || isDeleting;
  saveSelectedBtn.disabled = selectedCount === 0 || isDeleting;

  for (let i = 0; i < deviceRingtones.length; i++) {
    const rt = deviceRingtones[i];
    const item = document.createElement('div');
    item.className = `file-item${rt.selected ? ' selected' : ''}`;
    item.dataset.index = i;

    const displayName = rt.title || rt.name.replace(/\.m4r$/i, '');
    const sizeStr = formatSize(rt.size);
    const durStr = formatDuration(rt.duration);
    const metaParts = [rt.artist, durStr, sizeStr].filter(Boolean);
    const metaStr = metaParts.join(' \u00B7 ');
    const isPlaying = nowPlayingFile === rt.name && !audioPlayer.paused;

    item.innerHTML = `
      <input type="checkbox" class="file-checkbox" data-index="${i}" ${rt.selected ? 'checked' : ''}>
      ${rt.audioUrl
        ? `<button class="file-play${isPlaying ? ' playing' : ''}" data-file="${rt.name}" data-url="${rt.audioUrl}" data-title="${displayName}" title="Play">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              ${isPlaying
                ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
                : '<polygon points="5,3 19,12 5,21"/>'}
            </svg>
           </button>`
        : `<div class="file-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>
           </div>`
      }
      <div class="file-info">
        <div class="file-name" data-rename="${i}" title="Double-click to rename">${displayName}</div>
        ${metaStr ? `<div class="file-meta">${metaStr}</div>` : ''}
      </div>
    `;
    deviceFileList.appendChild(item);
  }
}

async function startRename(index) {
  const rt = deviceRingtones[index];
  if (!rt || !currentDevice) return;
  const displayName = rt.title || rt.name.replace(/\.m4r$/i, '');

  const nameEl = deviceFileList.querySelector(`.file-name[data-rename="${index}"]`);
  if (!nameEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = displayName;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newDisplayName = input.value.trim();
    if (!newDisplayName || newDisplayName === displayName) {
      renderDeviceList();
      return;
    }

    const newFileName = newDisplayName + '.m4r';
    if (newFileName === rt.name) { renderDeviceList(); return; }

    try {
      const result = await window.mytunes.renameRingtone(
        currentDevice.id, currentDevice.udid, rt.name, newFileName
      );
      if (result.success) {
        rt.name = newFileName;
        rt.title = null; // Will refresh from metadata
        rt.loaded = false;
        rt.audioUrl = null;
        rt.localPath = null;
      } else {
        showError(result.error);
      }
    } catch (e) { showError(e.message); }

    renderDeviceList();
    // Reload details for the renamed file
    if (currentDevice) loadRingtoneDetails();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { renderDeviceList(); }
  });
}

async function deleteSelected() {
  if (!currentDevice || isDeleting) return;
  const toDelete = deviceRingtones.filter(r => r.selected).map(r => r.name);
  if (toDelete.length === 0) return;

  // Stop playback if deleting the currently playing file
  if (nowPlayingFile && toDelete.includes(nowPlayingFile)) stopPlayback();

  isDeleting = true;
  deleteSelectedBtn.disabled = true;
  ringtoneCount.textContent = `Deleting ${toDelete.length} ringtone${toDelete.length !== 1 ? 's' : ''}...`;

  try {
    const result = await window.mytunes.deleteRingtones(currentDevice.id, currentDevice.udid, toDelete);
    if (result.success) {
      const failed = result.results.filter(r => !r.success);
      if (failed.length > 0) showError(`Failed to delete ${failed.length} file(s)`);
    } else { showError(result.error); }
  } catch (e) { showError(e.message); }

  isDeleting = false;
  loadDeviceRingtones();
  updateDeviceTabCount();
}

// ===== Save / Download =====

async function saveSelected() {
  const selected = deviceRingtones.filter(r => r.selected && r.loaded);
  if (selected.length === 0) return;

  const files = selected.map(r => ({
    name: r.name,
    localPath: r.localPath,
    title: r.title || r.name.replace(/\.m4r$/i, '')
  }));

  // Need localPath - make sure details are loaded
  const missingPaths = files.filter(f => !f.localPath);
  if (missingPaths.length > 0) {
    showError('Some files are still loading. Please wait and try again.');
    return;
  }

  try {
    const result = await window.mytunes.saveRingtones(files);
    if (result.success && result.saved > 0) {
      // Brief deselect to indicate success
      for (const r of deviceRingtones) r.selected = false;
      renderDeviceList();
    }
  } catch (e) {
    showError(e.message);
  }
}

// ===== Audio Playback =====

function playFile(fileName, audioUrl, title) {
  if (nowPlayingFile === fileName && !audioPlayer.paused) {
    audioPlayer.pause();
    renderDeviceList();
    updateNowPlayingUI();
    return;
  }

  nowPlayingFile = fileName;
  audioPlayer.src = audioUrl;
  audioPlayer.play();

  npTitle.textContent = title;
  nowPlayingBar.classList.remove('hidden');
  renderDeviceList();
  updateNowPlayingUI();
}

function stopPlayback() {
  audioPlayer.pause();
  audioPlayer.src = '';
  nowPlayingFile = null;
  nowPlayingBar.classList.add('hidden');
  renderDeviceList();
}

function updateNowPlayingUI() {
  const playing = !audioPlayer.paused;
  npPlayBtn.querySelector('.np-icon-pause').classList.toggle('hidden', !playing);
  npPlayBtn.querySelector('.np-icon-play').classList.toggle('hidden', playing);
}

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

audioPlayer.addEventListener('timeupdate', () => {
  const cur = audioPlayer.currentTime;
  const dur = audioPlayer.duration || 0;
  npTime.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  npProgress.style.width = dur > 0 ? `${(cur / dur) * 100}%` : '0%';
});

audioPlayer.addEventListener('ended', () => {
  nowPlayingFile = null;
  nowPlayingBar.classList.add('hidden');
  renderDeviceList();
});

audioPlayer.addEventListener('pause', updateNowPlayingUI);
audioPlayer.addEventListener('play', updateNowPlayingUI);

npPlayBtn.addEventListener('click', () => {
  if (audioPlayer.paused) audioPlayer.play();
  else audioPlayer.pause();
  renderDeviceList();
});

npProgressWrap.addEventListener('click', (e) => {
  const rect = npProgressWrap.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  if (audioPlayer.duration) audioPlayer.currentTime = pct * audioPlayer.duration;
});

npClose.addEventListener('click', stopPlayback);

// ===== Shared =====

function showError(message) {
  const existing = document.querySelector('.error-banner');
  if (existing) existing.remove();
  const activeView = currentTab === 'upload' ? uploadView : deviceView;
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = message;
  activeView.insertBefore(banner, activeView.firstChild);
  setTimeout(() => banner.remove(), 8000);
}

window.mytunes.onTransferProgress(({ index, fileName, status }) => {
  if (queuedFiles[index]) {
    queuedFiles[index].status = status;
    renderUploadList();
  }
});

// ===== Event Listeners =====

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('drag-over'); });
dropzone.addEventListener('drop', (e) => {
  e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('drag-over');
  const paths = Array.from(e.dataTransfer.files).map(f => f.path).filter(p => p);
  if (paths.length > 0) addFiles(paths);
});
dropzone.addEventListener('click', async () => {
  const result = await window.mytunes.openFileDialog();
  if (!result.canceled && result.files.length > 0) addFiles(result.files);
});

fileList.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.file-remove');
  if (removeBtn) removeFile(parseInt(removeBtn.dataset.index, 10));
});

fileList.addEventListener('input', (e) => {
  const input = e.target.closest('.upload-name-input');
  if (input) {
    const idx = parseInt(input.dataset.index, 10);
    if (queuedFiles[idx]) queuedFiles[idx].customName = input.value;
  }
});

let clickTimer = null;

deviceFileList.addEventListener('click', (e) => {
  const playBtn = e.target.closest('.file-play');
  if (playBtn) {
    e.stopPropagation();
    playFile(playBtn.dataset.file, playBtn.dataset.url, playBtn.dataset.title);
    return;
  }

  // If clicking on a rename-input, do nothing
  if (e.target.closest('.rename-input')) return;

  const nameEl = e.target.closest('.file-name[data-rename]');
  const checkbox = e.target.closest('.file-checkbox');
  const item = e.target.closest('.file-item');

  if (checkbox) {
    toggleRingtoneSelection(parseInt(checkbox.dataset.index, 10));
    return;
  }

  // For name clicks, delay to distinguish from double-click
  if (nameEl) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (item && item.dataset.index !== undefined) {
        toggleRingtoneSelection(parseInt(item.dataset.index, 10));
      }
    }, 250);
    return;
  }

  if (item && item.dataset.index !== undefined) {
    toggleRingtoneSelection(parseInt(item.dataset.index, 10));
  }
});

deviceFileList.addEventListener('dblclick', (e) => {
  const nameEl = e.target.closest('.file-name[data-rename]');
  if (nameEl) {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    e.stopPropagation();
    startRename(parseInt(nameEl.dataset.rename, 10));
  }
});

refreshBtn.addEventListener('click', refreshDevices);
clearBtn.addEventListener('click', clearFiles);
transferBtn.addEventListener('click', startTransfer);
deleteSelectedBtn.addEventListener('click', deleteSelected);
saveSelectedBtn.addEventListener('click', saveSelected);

// Initialize
startPolling();
