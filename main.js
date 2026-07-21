const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { DeviceManager, CACHE_DIR } = require('./src/device');
const { convertToM4R, cleanupTemp, SUPPORTED_EXTENSIONS } = require('./src/converter');

// Strip a user-supplied name down to a plain basename usable as a filename.
function safeBaseName(name) {
  return path.basename(String(name)).replace(/[/\\]/g, '').trim();
}

let mainWindow;
let deviceManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 680,
    height: 560,
    minWidth: 500,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('renderer/index.html');

  // Log renderer errors to stdout
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[RENDERER ERROR] ${sourceId}:${line} ${message}`);
  });
}

// Register custom protocol to serve cached audio files
protocol.registerSchemesAsPrivileged([
  { scheme: 'tonedrop-audio', privileges: { stream: true, supportFetchAPI: true } }
]);

app.whenReady().then(() => {
  deviceManager = new DeviceManager();

  // Handle tonedrop-audio:// URLs - serves cached files for playback.
  // Confined to the ringtone cache dir so the renderer can't fetch arbitrary
  // files off disk through this scheme.
  const cacheRoot = path.resolve(CACHE_DIR);
  protocol.handle('tonedrop-audio', (request) => {
    const filePath = path.resolve(decodeURIComponent(request.url.slice('tonedrop-audio://'.length)));
    if (filePath !== cacheRoot && !filePath.startsWith(cacheRoot + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Pulled ringtones and converted files live in temp dirs and must not outlive
// the session. Both cleanup steps are synchronous, so they complete even during
// teardown; `close()` is fire-and-forget since the socket dies with the process.
let cleanedUp = false;
function cleanupSession() {
  if (cleanedUp) return;
  cleanedUp = true;
  cleanupTemp();
  if (deviceManager) {
    deviceManager.clearCache();
    deviceManager.close().catch(() => {});
  }
}

// `will-quit` covers every quit path (Cmd+Q, menu Quit, last window closed).
// `window-all-closed` alone does NOT fire on an explicit quit on macOS, which
// previously left the user's ringtones cached in temp after every session.
app.on('will-quit', cleanupSession);

app.on('window-all-closed', () => {
  cleanupSession();
  if (process.platform !== 'darwin') app.quit();
});

// ===== Metadata helper =====

async function readMetadata(filePath) {
  try {
    const mm = await import('music-metadata');
    const metadata = await mm.parseFile(filePath);
    return {
      title: metadata.common.title || null,
      artist: metadata.common.artist || null,
      duration: metadata.format.duration || null
    };
  } catch {
    return { title: null, artist: null, duration: null };
  }
}

// ===== IPC Handlers =====

ipcMain.handle('get-devices', async () => {
  try {
    const devices = await deviceManager.listDevices();
    return { success: true, devices };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('list-ringtones', async (_event, deviceId, udid) => {
  try {
    const ringtones = await deviceManager.listRingtones(deviceId, udid);
    return { success: true, ringtones };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('load-ringtone-details', async (event, deviceId, udid, fileNames) => {
  try {
    // Pull files from device to cache
    const pulled = await deviceManager.pullAllRingtones(deviceId, udid, fileNames);

    // Read metadata for each pulled file
    const details = [];
    for (const item of pulled) {
      if (item.success && item.localPath) {
        const meta = await readMetadata(item.localPath);
        details.push({
          file: item.file,
          localPath: item.localPath,
          audioUrl: `tonedrop-audio://${encodeURIComponent(item.localPath)}`,
          title: meta.title,
          artist: meta.artist,
          duration: meta.duration,
          success: true
        });
      } else {
        details.push({ file: item.file, success: false });
      }
    }
    return { success: true, details };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-local-metadata', async (_event, filePath) => {
  try {
    const meta = await readMetadata(filePath);
    return { success: true, ...meta };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('save-ringtones', async (_event, files) => {
  // files: [{ name, localPath, title }]
  try {
    if (files.length === 1) {
      // Single file - "Save As" dialog
      const f = files[0];
      const defaultName = (f.title || f.name.replace(/\.m4r$/i, '')) + '.m4r';
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Ringtone',
        defaultPath: defaultName,
        filters: [{ name: 'iPhone Ringtone', extensions: ['m4r'] }]
      });
      if (result.canceled) return { success: true, saved: 0 };
      fs.copyFileSync(f.localPath, result.filePath);
      return { success: true, saved: 1 };
    } else {
      // Multiple files - pick a folder
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Save Ringtones to Folder',
        properties: ['openDirectory', 'createDirectory']
      });
      if (result.canceled) return { success: true, saved: 0 };
      const destDir = result.filePaths[0];
      let saved = 0;
      for (const f of files) {
        const destName = (f.title || f.name.replace(/\.m4r$/i, '')) + '.m4r';
        const destPath = path.join(destDir, destName);
        fs.copyFileSync(f.localPath, destPath);
        saved++;
      }
      return { success: true, saved };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('restart-device', async (_event, deviceId, udid) => {
  try {
    await deviceManager.restartDevice(deviceId, udid);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('rename-ringtone', async (_event, deviceId, udid, oldName, newName) => {
  try {
    await deviceManager.renameRingtone(deviceId, udid, oldName, newName);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('delete-ringtones', async (_event, deviceId, udid, fileNames) => {
  try {
    const results = await deviceManager.deleteMultipleRingtones(deviceId, udid, fileNames);
    // Clear cache for deleted files (r.file is already a validated basename)
    for (const r of results) {
      if (r.success) {
        const cached = path.join(CACHE_DIR, path.basename(r.file));
        try { fs.unlinkSync(cached); } catch {}
      }
    }
    return { success: true, results };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('transfer-ringtones', async (event, deviceId, udid, fileEntries) => {
  // fileEntries: [{ path, customName }]
  try {
    const convertedPaths = [];
    for (let i = 0; i < fileEntries.length; i++) {
      const entry = fileEntries[i];
      const fp = entry.path;
      // Sanitize: customName becomes part of the output filename.
      const customName = entry.customName ? safeBaseName(entry.customName) : null;
      const fileName = path.basename(fp);
      const ext = path.extname(fp).toLowerCase();

      const displayName = customName || path.basename(fp, path.extname(fp));

      if (ext === '.m4r') {
        // Process m4r: ensure metadata + correct sample rate, rename if needed
        event.sender.send('transfer-progress', { index: i, fileName, status: 'converting' });
        try {
          const processed = await convertToM4R(fp, displayName);
          if (customName && customName + '.m4r' !== path.basename(processed)) {
            const renamedPath = path.join(path.dirname(processed), customName + '.m4r');
            fs.renameSync(processed, renamedPath);
            convertedPaths.push(renamedPath);
          } else {
            convertedPaths.push(processed);
          }
        } catch (e) {
          event.sender.send('transfer-progress', { index: i, fileName, status: 'error' });
          convertedPaths.push(null);
        }
      } else {
        event.sender.send('transfer-progress', { index: i, fileName, status: 'converting' });
        try {
          const converted = await convertToM4R(fp, displayName);
          if (customName) {
            const renamedPath = path.join(path.dirname(converted), customName + '.m4r');
            if (renamedPath !== converted) {
              fs.renameSync(converted, renamedPath);
              convertedPaths.push(renamedPath);
            } else {
              convertedPaths.push(converted);
            }
          } else {
            convertedPaths.push(converted);
          }
        } catch (e) {
          event.sender.send('transfer-progress', { index: i, fileName, status: 'error' });
          convertedPaths.push(null);
        }
      }
    }

    const validPaths = convertedPaths.filter(p => p !== null);
    const validIndices = convertedPaths.map((p, i) => p !== null ? i : -1).filter(i => i !== -1);

    // Read metadata for each converted file (for Ringtones.plist registration)
    const metadataList = [];
    for (const fp of validPaths) {
      const meta = await readMetadata(fp);
      metadataList.push(meta);
    }

    const results = await deviceManager.pushMultipleRingtones(
      deviceId, udid, validPaths,
      (transferIdx, fileName, status) => {
        const originalIdx = validIndices[transferIdx];
        event.sender.send('transfer-progress', { index: originalIdx, fileName, status });
      },
      metadataList
    );

    const fullResults = fileEntries.map((entry, i) => {
      const validIdx = validIndices.indexOf(i);
      if (validIdx === -1) return { file: path.basename(entry.path), success: false, error: 'Conversion failed' };
      return results[validIdx];
    });

    return { success: true, results: fullResults };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-file-dialog', async () => {
  const audioExts = SUPPORTED_EXTENSIONS.map(e => e.slice(1));
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Audio Files',
    filters: [
      { name: 'Audio Files', extensions: audioExts },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  });

  if (result.canceled) return { canceled: true, files: [] };
  return { canceled: false, files: result.filePaths };
});
