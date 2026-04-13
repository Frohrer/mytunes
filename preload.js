const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mytunes', {
  getDevices: () => ipcRenderer.invoke('get-devices'),
  listRingtones: (deviceId, udid) => ipcRenderer.invoke('list-ringtones', deviceId, udid),
  loadRingtoneDetails: (deviceId, udid, fileNames) => ipcRenderer.invoke('load-ringtone-details', deviceId, udid, fileNames),
  getLocalMetadata: (filePath) => ipcRenderer.invoke('get-local-metadata', filePath),
  saveRingtones: (files) => ipcRenderer.invoke('save-ringtones', files),
  restartDevice: (deviceId, udid) => ipcRenderer.invoke('restart-device', deviceId, udid),
  renameRingtone: (deviceId, udid, oldName, newName) => ipcRenderer.invoke('rename-ringtone', deviceId, udid, oldName, newName),
  deleteRingtones: (deviceId, udid, fileNames) => ipcRenderer.invoke('delete-ringtones', deviceId, udid, fileNames),
  transferRingtones: (deviceId, udid, filePaths) => ipcRenderer.invoke('transfer-ringtones', deviceId, udid, filePaths),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  onTransferProgress: (callback) => {
    ipcRenderer.on('transfer-progress', (_event, data) => callback(data));
  }
});
