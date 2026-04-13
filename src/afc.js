const tls = require('tls');

// AFC protocol constants
const AFC_MAGIC = Buffer.from('CFA6LPAA', 'ascii');
const AFC_HEADER_SIZE = 40;

// AFC operations
const AFC_OP = {
  STATUS:         0x00000001,
  DATA:           0x00000002,
  READ_DIR:       0x00000003,
  READ_FILE:      0x00000004,
  WRITE_FILE:     0x00000005,
  WRITE_PART:     0x00000006,
  TRUNCATE:       0x00000007,
  REMOVE_PATH:    0x00000008,
  MAKE_DIR:       0x00000009,
  GET_FILE_INFO:  0x0000000A,
  GET_DEV_INFO:   0x0000000B,
  FILE_OPEN:      0x0000000D,
  FILE_OPEN_RES:  0x0000000E,
  FILE_READ:      0x0000000F,
  FILE_WRITE:     0x00000010,
  FILE_SEEK:      0x00000011,
  FILE_TELL:      0x00000012,
  FILE_TELL_RES:  0x00000013,
  FILE_CLOSE:     0x00000014,
  FILE_SET_SIZE:  0x00000015,
  RENAME_PATH:    0x00000018,
  SET_FILE_TIME:  0x0000001D
};

// File open modes
const AFC_FOPEN = {
  RDONLY:   0x00000001,
  RW:       0x00000002,
  WRONLY:   0x00000003,
  WR:       0x00000004,
  APPEND:   0x00000005,
  RDAPPEND: 0x00000006
};

// AFC status codes
const AFC_STATUS = {
  SUCCESS:           0,
  UNKNOWN_ERROR:     1,
  OP_NOT_SUPPORTED:  2,
  NO_SUCH_PATH:      4,
  PERM_DENIED:       10,
  OBJECT_EXISTS:     7
};

class AFCClient {
  constructor(stream) {
    this.stream = stream;
    this.packetNum = 0;
    this._buffer = Buffer.alloc(0);
    this._readResolve = null;
    this._readReject = null;

    this.stream.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._tryResolve();
    });

    this.stream.on('error', (err) => {
      if (this._readReject) {
        this._readReject(err);
        this._readReject = null;
        this._readResolve = null;
      }
    });
  }

  _tryResolve() {
    if (!this._readResolve) return;
    if (this._buffer.length < AFC_HEADER_SIZE) return;

    // Check magic
    if (this._buffer.subarray(0, 8).toString('ascii') !== 'CFA6LPAA') {
      if (this._readReject) {
        this._readReject(new Error('Invalid AFC magic'));
        this._readReject = null;
        this._readResolve = null;
      }
      return;
    }

    // Read lengths (as 64-bit LE, but we only use lower 32 bits for practical sizes)
    const entireLength = Number(this._buffer.readBigUInt64LE(8));
    const thisLength = Number(this._buffer.readBigUInt64LE(16));

    if (this._buffer.length < entireLength) return; // Wait for more data

    const operation = Number(this._buffer.readBigUInt64LE(32));
    const headerPayload = this._buffer.subarray(AFC_HEADER_SIZE, thisLength);
    const data = this._buffer.subarray(thisLength, entireLength);

    this._buffer = this._buffer.subarray(entireLength);

    const resolve = this._readResolve;
    this._readResolve = null;
    this._readReject = null;
    resolve({ operation, headerPayload, data });
  }

  _readResponse() {
    return new Promise((resolve, reject) => {
      this._readResolve = resolve;
      this._readReject = reject;
      // Check if we already have enough data buffered
      this._tryResolve();
    });
  }

  _sendPacket(operation, headerPayload = Buffer.alloc(0), data = Buffer.alloc(0)) {
    const entireLength = AFC_HEADER_SIZE + headerPayload.length + data.length;
    const thisLength = AFC_HEADER_SIZE + headerPayload.length;

    const header = Buffer.alloc(AFC_HEADER_SIZE);
    AFC_MAGIC.copy(header, 0);
    header.writeBigUInt64LE(BigInt(entireLength), 8);
    header.writeBigUInt64LE(BigInt(thisLength), 16);
    header.writeBigUInt64LE(BigInt(this.packetNum++), 24);
    header.writeBigUInt64LE(BigInt(operation), 32);

    this.stream.write(Buffer.concat([header, headerPayload, data]));
  }

  async getDeviceInfo() {
    this._sendPacket(AFC_OP.GET_DEV_INFO);
    const resp = await this._readResponse();

    if (resp.operation === AFC_OP.STATUS) {
      throw new Error(`AFC getDeviceInfo failed with status ${resp.headerPayload.readBigUInt64LE(0)}`);
    }

    // Parse null-separated key-value pairs
    const parts = resp.data.toString('utf8').split('\0').filter(s => s.length > 0);
    const info = {};
    for (let i = 0; i < parts.length - 1; i += 2) {
      info[parts[i]] = parts[i + 1];
    }
    return info;
  }

  async readDirectory(remotePath) {
    const pathBuf = Buffer.from(remotePath + '\0', 'utf8');
    this._sendPacket(AFC_OP.READ_DIR, pathBuf);
    const resp = await this._readResponse();

    if (resp.operation === AFC_OP.STATUS) {
      const status = Number(resp.headerPayload.readBigUInt64LE(0));
      if (status === AFC_STATUS.NO_SUCH_PATH) {
        throw new Error(`Path not found: ${remotePath}`);
      }
      throw new Error(`AFC readDirectory failed with status ${status}`);
    }

    return resp.data.toString('utf8').split('\0').filter(s => s.length > 0 && s !== '.' && s !== '..');
  }

  async fileOpen(remotePath, mode = AFC_FOPEN.RDONLY) {
    const pathBuf = Buffer.from(remotePath + '\0', 'utf8');
    const modeBuf = Buffer.alloc(8);
    modeBuf.writeBigUInt64LE(BigInt(mode));
    this._sendPacket(AFC_OP.FILE_OPEN, Buffer.concat([modeBuf, pathBuf]));
    const resp = await this._readResponse();

    if (resp.operation === AFC_OP.STATUS) {
      const status = Number(resp.headerPayload.readBigUInt64LE(0));
      throw new Error(`AFC fileOpen failed for ${remotePath} with status ${status}`);
    }

    if (resp.operation !== AFC_OP.FILE_OPEN_RES) {
      throw new Error(`Unexpected response operation: ${resp.operation}`);
    }

    return Number(resp.headerPayload.readBigUInt64LE(0));
  }

  async fileRead(handle, length) {
    const payload = Buffer.alloc(16);
    payload.writeBigUInt64LE(BigInt(handle), 0);
    payload.writeBigUInt64LE(BigInt(length), 8);
    this._sendPacket(AFC_OP.FILE_READ, payload);
    const resp = await this._readResponse();

    if (resp.operation === AFC_OP.STATUS) {
      const status = Number(resp.headerPayload.readBigUInt64LE(0));
      if (status !== AFC_STATUS.SUCCESS) {
        throw new Error(`AFC fileRead failed with status ${status}`);
      }
      return Buffer.alloc(0); // EOF
    }

    return resp.data;
  }

  async pullFile(remotePath, localPath) {
    const fs = require('fs');
    const info = await this.getFileInfo(remotePath);
    const fileSize = parseInt(info.st_size || '0', 10);

    const handle = await this.fileOpen(remotePath, AFC_FOPEN.RDONLY);
    const chunks = [];
    let bytesRead = 0;
    const CHUNK_SIZE = 65536;

    while (bytesRead < fileSize) {
      const toRead = Math.min(CHUNK_SIZE, fileSize - bytesRead);
      const data = await this.fileRead(handle, toRead);
      if (data.length === 0) break;
      chunks.push(data);
      bytesRead += data.length;
    }

    await this.fileClose(handle);
    const fullData = Buffer.concat(chunks);
    fs.writeFileSync(localPath, fullData);
    return localPath;
  }

  async fileWrite(handle, data) {
    const handleBuf = Buffer.alloc(8);
    handleBuf.writeBigUInt64LE(BigInt(handle));
    this._sendPacket(AFC_OP.FILE_WRITE, handleBuf, data);
    const resp = await this._readResponse();

    if (resp.operation === AFC_OP.STATUS) {
      const status = Number(resp.headerPayload.readBigUInt64LE(0));
      if (status !== AFC_STATUS.SUCCESS) {
        throw new Error(`AFC fileWrite failed with status ${status}`);
      }
    }
  }

  async fileClose(handle) {
    const handleBuf = Buffer.alloc(8);
    handleBuf.writeBigUInt64LE(BigInt(handle));
    this._sendPacket(AFC_OP.FILE_CLOSE, handleBuf);
    const resp = await this._readResponse();

    if (resp.operation === AFC_OP.STATUS) {
      const status = Number(resp.headerPayload.readBigUInt64LE(0));
      if (status !== AFC_STATUS.SUCCESS) {
        throw new Error(`AFC fileClose failed with status ${status}`);
      }
    }
  }

  async getFileInfo(remotePath) {
    const pathBuf = Buffer.from(remotePath + '\0', 'utf8');
    this._sendPacket(AFC_OP.GET_FILE_INFO, pathBuf);
    const resp = await this._readResponse();

    if (resp.operation === AFC_OP.STATUS) {
      const status = Number(resp.headerPayload.readBigUInt64LE(0));
      throw new Error(`AFC getFileInfo failed with status ${status}`);
    }

    const parts = resp.data.toString('utf8').split('\0').filter(s => s.length > 0);
    const info = {};
    for (let i = 0; i < parts.length - 1; i += 2) {
      info[parts[i]] = parts[i + 1];
    }
    return info;
  }

  async removePath(remotePath) {
    const pathBuf = Buffer.from(remotePath + '\0', 'utf8');
    this._sendPacket(AFC_OP.REMOVE_PATH, pathBuf);
    const resp = await this._readResponse();

    if (resp.operation === AFC_OP.STATUS) {
      const status = Number(resp.headerPayload.readBigUInt64LE(0));
      if (status !== AFC_STATUS.SUCCESS) {
        throw new Error(`AFC removePath failed with status ${status}`);
      }
    }
  }

  async renamePath(oldPath, newPath) {
    const payload = Buffer.from(oldPath + '\0' + newPath + '\0', 'utf8');
    this._sendPacket(AFC_OP.RENAME_PATH, payload);
    const resp = await this._readResponse();

    if (resp.operation === AFC_OP.STATUS) {
      const status = Number(resp.headerPayload.readBigUInt64LE(0));
      if (status !== AFC_STATUS.SUCCESS) {
        throw new Error(`AFC renamePath failed with status ${status}`);
      }
    }
  }

  async makeDirectory(remotePath) {
    const pathBuf = Buffer.from(remotePath + '\0', 'utf8');
    this._sendPacket(AFC_OP.MAKE_DIR, pathBuf);
    const resp = await this._readResponse();

    if (resp.operation === AFC_OP.STATUS) {
      const status = Number(resp.headerPayload.readBigUInt64LE(0));
      if (status !== AFC_STATUS.SUCCESS && status !== AFC_STATUS.OBJECT_EXISTS) {
        throw new Error(`AFC makeDirectory failed with status ${status}`);
      }
    }
  }

  async pushFile(localPath, remotePath) {
    const fs = require('fs');
    const data = fs.readFileSync(localPath);
    const fileName = require('path').basename(localPath);
    const fullRemotePath = remotePath.endsWith('/')
      ? remotePath + fileName
      : remotePath;

    const handle = await this.fileOpen(fullRemotePath, AFC_FOPEN.WR);

    // Write in chunks of 64KB
    const CHUNK_SIZE = 65536;
    for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
      const chunk = data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length));
      await this.fileWrite(handle, chunk);
    }

    await this.fileClose(handle);
    return fullRemotePath;
  }

  close() {
    if (this.stream && !this.stream.destroyed) {
      this.stream.end();
    }
  }
}

async function createAFCClient(usbmuxClient, deviceId, servicePort, enableSSL, pairingRecord) {
  const tunnel = await usbmuxClient.createDeviceTunnel(deviceId, servicePort);

  if (enableSSL && pairingRecord) {
    const hostCert = pairingRecord.HostCertificate;
    const hostKey = pairingRecord.HostPrivateKey;
    const certPem = Buffer.isBuffer(hostCert) ? hostCert : Buffer.from(hostCert, 'base64');
    const keyPem = Buffer.isBuffer(hostKey) ? hostKey : Buffer.from(hostKey, 'base64');

    const tlsStream = await new Promise((resolve, reject) => {
      const sock = tls.connect({
        socket: tunnel,
        cert: certPem,
        key: keyPem,
        rejectUnauthorized: false
      }, () => resolve(sock));
      sock.once('error', reject);
    });

    return new AFCClient(tlsStream);
  }

  return new AFCClient(tunnel);
}

module.exports = { AFCClient, createAFCClient, AFC_FOPEN };
