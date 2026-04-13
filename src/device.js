const { UsbmuxClient } = require('usbmux-client');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const plist = require('plist');
const { execSync } = require('child_process');
const { startLockdownSession, startService } = require('./lockdown');
const { createAFCClient } = require('./afc');

const RINGTONES_PATH = '/iTunes_Control/Ringtones';
const RINGTONES_PLIST = '/iTunes_Control/iTunes/Ringtones.plist';
const CACHE_DIR = path.join(os.tmpdir(), 'mytunes-cache');

function generateGUID() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

function generatePID() {
  // Random 64-bit signed integer
  const buf = crypto.randomBytes(8);
  return buf.readBigInt64BE(0).toString();
}

class DeviceManager {
  constructor() {
    this.client = new UsbmuxClient();
    this._afcClient = null;
    this._currentDeviceId = null;
  }

  async restartDevice(deviceId, udid) {
    const tls = require('tls');
    const session = await startLockdownSession(this.client, deviceId, udid);
    const svcInfo = await startService(session, 'com.apple.mobile.diagnostics_relay');
    const pairingRecord = session.pairingRecord;
    session.stream.end();

    const tunnel = await this.client.createDeviceTunnel(deviceId, svcInfo.port);

    // Diagnostics relay requires SSL
    let stream = tunnel;
    if (svcInfo.enableSSL) {
      const certPem = Buffer.isBuffer(pairingRecord.HostCertificate)
        ? pairingRecord.HostCertificate : Buffer.from(pairingRecord.HostCertificate, 'base64');
      const keyPem = Buffer.isBuffer(pairingRecord.HostPrivateKey)
        ? pairingRecord.HostPrivateKey : Buffer.from(pairingRecord.HostPrivateKey, 'base64');

      stream = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: tunnel, cert: certPem, key: keyPem, rejectUnauthorized: false }, () => resolve(s));
        s.once('error', reject);
      });
    }

    const msg = plist.build({ Request: 'Restart' });
    const buf = Buffer.from(msg, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(buf.length, 0);
    stream.write(Buffer.concat([header, buf]));

    await new Promise(r => setTimeout(r, 500));
    stream.end();
  }

  // No-op — iOS requires a full reboot to pick up new ringtones.
  // The UI offers a "Restart iPhone" button after transfers.
  async _reloadToneLibrary() {}

  async listDevices() {
    const devices = await this.client.getDevices();
    const result = [];

    for (const [id, props] of Object.entries(devices)) {
      try {
        const values = await this.client.queryAllDeviceValues(id);
        result.push({
          id,
          udid: props.SerialNumber,
          name: values.DeviceName || 'Unknown iPhone',
          model: values.ProductType || 'Unknown',
          iosVersion: values.ProductVersion || 'Unknown',
          connectionType: props.ConnectionType
        });
      } catch (e) {
        // If we can't query values, still include basic info
        result.push({
          id,
          udid: props.SerialNumber,
          name: 'iPhone',
          model: 'Unknown',
          iosVersion: 'Unknown',
          connectionType: props.ConnectionType
        });
      }
    }

    return result;
  }

  async connectAFC(deviceId, udid) {
    // Close existing connection if any
    this.disconnectAFC();

    const session = await startLockdownSession(this.client, deviceId, udid);

    // Start AFC service
    const serviceInfo = await startService(session, 'com.apple.afc');

    // Close the lockdown session stream
    session.stream.end();

    // Create AFC client connected to the service port
    this._afcClient = await createAFCClient(
      this.client,
      deviceId,
      serviceInfo.port,
      serviceInfo.enableSSL,
      session.pairingRecord
    );
    this._currentDeviceId = deviceId;

    return this._afcClient;
  }

  async _readRingtonesPlist(afc) {
    const tmpPath = path.join(os.tmpdir(), 'mytunes-Ringtones.plist');
    try {
      await afc.pullFile(RINGTONES_PLIST, tmpPath);
      // Could be binary plist, convert to XML
      const xml = execSync(`plutil -convert xml1 -o - "${tmpPath}"`, { encoding: 'utf8' });
      return plist.parse(xml);
    } catch {
      // No plist yet, create empty structure
      return { Ringtones: {} };
    }
  }

  async _writeRingtonesPlist(afc, data) {
    const tmpPath = path.join(os.tmpdir(), 'mytunes-Ringtones-out.plist');
    const xml = plist.build(data);
    fs.writeFileSync(tmpPath, xml);
    // Convert to binary plist (iOS prefers this)
    execSync(`plutil -convert binary1 "${tmpPath}"`);
    await afc.pushFile(tmpPath, RINGTONES_PLIST);
  }

  async _registerRingtone(afc, fileName, displayName, durationMs) {
    const data = await this._readRingtonesPlist(afc);
    if (!data.Ringtones) data.Ringtones = {};

    data.Ringtones[fileName] = {
      GUID: generateGUID(),
      Name: displayName,
      PID: parseInt(generatePID(), 10),
      'Protected Content': false,
      'Total Time': durationMs || 0
    };

    await this._writeRingtonesPlist(afc, data);
  }

  async _unregisterRingtone(afc, fileName) {
    const data = await this._readRingtonesPlist(afc);
    if (data.Ringtones && data.Ringtones[fileName]) {
      delete data.Ringtones[fileName];
      await this._writeRingtonesPlist(afc, data);
    }
  }

  async listRingtones(deviceId, udid) {
    const afc = await this.connectAFC(deviceId, udid);
    try {
      const files = await afc.readDirectory(RINGTONES_PATH);
      const m4rFiles = files.filter(f => f.toLowerCase().endsWith('.m4r'));

      // Get file info for each ringtone
      const ringtones = [];
      for (const fileName of m4rFiles) {
        try {
          const info = await afc.getFileInfo(`${RINGTONES_PATH}/${fileName}`);
          ringtones.push({
            name: fileName,
            size: parseInt(info.st_size || '0', 10),
            modified: parseInt(info.st_mtime || '0', 10)
          });
        } catch {
          ringtones.push({ name: fileName, size: 0, modified: 0 });
        }
      }

      return ringtones;
    } catch (e) {
      if (e.message.includes('not found')) {
        return [];
      }
      throw e;
    } finally {
      this.disconnectAFC();
    }
  }

  async pullRingtone(deviceId, udid, fileName) {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const localPath = path.join(CACHE_DIR, fileName);

    // Use cache if file exists
    if (fs.existsSync(localPath)) return localPath;

    const afc = await this.connectAFC(deviceId, udid);
    try {
      await afc.pullFile(`${RINGTONES_PATH}/${fileName}`, localPath);
      return localPath;
    } finally {
      this.disconnectAFC();
    }
  }

  async pullAllRingtones(deviceId, udid, fileNames) {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const afc = await this.connectAFC(deviceId, udid);
    const results = [];
    try {
      for (const fileName of fileNames) {
        const localPath = path.join(CACHE_DIR, fileName);
        if (fs.existsSync(localPath)) {
          results.push({ file: fileName, localPath, success: true });
          continue;
        }
        try {
          await afc.pullFile(`${RINGTONES_PATH}/${fileName}`, localPath);
          results.push({ file: fileName, localPath, success: true });
        } catch (e) {
          results.push({ file: fileName, localPath: null, success: false, error: e.message });
        }
      }
    } finally {
      this.disconnectAFC();
    }
    return results;
  }

  clearCache() {
    try {
      if (fs.existsSync(CACHE_DIR)) {
        for (const f of fs.readdirSync(CACHE_DIR)) {
          fs.unlinkSync(path.join(CACHE_DIR, f));
        }
      }
    } catch {}
  }

  async renameRingtone(deviceId, udid, oldName, newName) {
    const afc = await this.connectAFC(deviceId, udid);
    try {
      await afc.renamePath(`${RINGTONES_PATH}/${oldName}`, `${RINGTONES_PATH}/${newName}`);

      // Update Ringtones.plist
      const data = await this._readRingtonesPlist(afc);
      if (data.Ringtones && data.Ringtones[oldName]) {
        const entry = data.Ringtones[oldName];
        delete data.Ringtones[oldName];
        entry.Name = newName.replace(/\.m4r$/i, '');
        data.Ringtones[newName] = entry;
        await this._writeRingtonesPlist(afc, data);
      }

      // Update cache
      const oldCache = path.join(CACHE_DIR, oldName);
      const newCache = path.join(CACHE_DIR, newName);
      if (fs.existsSync(oldCache)) fs.renameSync(oldCache, newCache);
    } finally {
      this.disconnectAFC();
    }
    await this._reloadToneLibrary(deviceId, udid);
  }

  async deleteRingtone(deviceId, udid, fileName) {
    const afc = await this.connectAFC(deviceId, udid);
    try {
      await afc.removePath(`${RINGTONES_PATH}/${fileName}`);
      await this._unregisterRingtone(afc, fileName);
    } finally {
      this.disconnectAFC();
    }
    await this._reloadToneLibrary(deviceId, udid);
  }

  async deleteMultipleRingtones(deviceId, udid, fileNames) {
    const afc = await this.connectAFC(deviceId, udid);
    const results = [];
    try {
      for (const fileName of fileNames) {
        try {
          await afc.removePath(`${RINGTONES_PATH}/${fileName}`);
          results.push({ file: fileName, success: true });
        } catch (e) {
          results.push({ file: fileName, success: false, error: e.message });
        }
      }

      const data = await this._readRingtonesPlist(afc);
      let changed = false;
      for (const r of results) {
        if (r.success && data.Ringtones && data.Ringtones[r.file]) {
          delete data.Ringtones[r.file];
          changed = true;
        }
      }
      if (changed) await this._writeRingtonesPlist(afc, data);
    } finally {
      this.disconnectAFC();
    }
    await this._reloadToneLibrary(deviceId, udid);
    return results;
  }

  async pushRingtone(deviceId, udid, localFilePath, onProgress, meta) {
    const afc = await this.connectAFC(deviceId, udid);
    try {
      try { await afc.readDirectory(RINGTONES_PATH); } catch { await afc.makeDirectory(RINGTONES_PATH); }

      if (onProgress) onProgress('uploading');
      const remotePath = await afc.pushFile(localFilePath, RINGTONES_PATH + '/');

      // Register in Ringtones.plist
      const fileName = path.basename(localFilePath);
      const displayName = (meta && meta.title) || fileName.replace(/\.m4r$/i, '');
      const durationMs = (meta && meta.duration) ? Math.round(meta.duration * 1000) : 0;
      await this._registerRingtone(afc, fileName, displayName, durationMs);

      if (onProgress) onProgress('done');
      return remotePath;
    } finally {
      this.disconnectAFC();
    }
    await this._reloadToneLibrary(deviceId, udid);
  }

  async pushMultipleRingtones(deviceId, udid, filePaths, onFileProgress, metadataList) {
    const afc = await this.connectAFC(deviceId, udid);
    const results = [];

    try {
      // Ensure ringtones directory exists
      try {
        await afc.readDirectory(RINGTONES_PATH);
      } catch {
        await afc.makeDirectory(RINGTONES_PATH);
      }

      // Read existing plist
      const data = await this._readRingtonesPlist(afc);
      if (!data.Ringtones) data.Ringtones = {};

      for (let i = 0; i < filePaths.length; i++) {
        const localPath = filePaths[i];
        const fileName = path.basename(localPath);
        const meta = metadataList ? metadataList[i] : null;

        try {
          if (onFileProgress) onFileProgress(i, fileName, 'uploading');
          const remotePath = await afc.pushFile(localPath, RINGTONES_PATH + '/');

          // Register in Ringtones.plist
          const displayName = (meta && meta.title) || fileName.replace(/\.m4r$/i, '');
          const durationMs = (meta && meta.duration) ? Math.round(meta.duration * 1000) : 0;

          data.Ringtones[fileName] = {
            GUID: generateGUID(),
            Name: displayName,
            PID: parseInt(generatePID(), 10),
            'Protected Content': false,
            'Total Time': durationMs
          };

          if (onFileProgress) onFileProgress(i, fileName, 'done');
          results.push({ file: fileName, success: true, remotePath });
        } catch (e) {
          if (onFileProgress) onFileProgress(i, fileName, 'error');
          results.push({ file: fileName, success: false, error: e.message });
        }
      }

      // Write updated plist
      await this._writeRingtonesPlist(afc, data);
    } finally {
      this.disconnectAFC();
    }

    // Notify iOS to reload tone library
    await this._reloadToneLibrary(deviceId, udid);

    return results;
  }

  disconnectAFC() {
    if (this._afcClient) {
      this._afcClient.close();
      this._afcClient = null;
      this._currentDeviceId = null;
    }
  }

  async close() {
    this.disconnectAFC();
    await this.client.close();
  }
}

module.exports = { DeviceManager };
