const tls = require('tls');
const net = require('net');
const plist = require('plist');
const bplistParser = require('bplist-parser');

const LOCKDOWN_PORT = 62078;

const USBMUX_ADDRESS = process.platform === 'win32'
  ? { port: 27015, autoSelectFamily: true }
  : { path: '/var/run/usbmuxd' };

function readLockdownMessage(stream) {
  return new Promise((resolve, reject) => {
    let headerBuf = Buffer.alloc(0);

    const onReadable = () => {
      // Read 4-byte header first
      if (headerBuf.length < 4) {
        const chunk = stream.read(4 - headerBuf.length);
        if (!chunk) return;
        headerBuf = Buffer.concat([headerBuf, chunk]);
        if (headerBuf.length < 4) return;
      }

      const payloadLength = headerBuf.readUInt32BE(0);
      const payload = stream.read(payloadLength);
      if (!payload) return;

      stream.removeListener('readable', onReadable);
      stream.removeListener('error', reject);

      try {
        const data = plist.parse(payload.toString('utf8'));
        if (data.Error) {
          reject(new Error(`Lockdown error: ${data.Error}`));
        } else {
          resolve(data);
        }
      } catch (e) {
        reject(e);
      }
    };

    stream.on('readable', onReadable);
    stream.once('error', reject);
    onReadable();
  });
}

function writeLockdownMessage(stream, data) {
  const plistStr = plist.build(data);
  const plistBuf = Buffer.from(plistStr, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(plistBuf.length, 0);
  stream.write(Buffer.concat([header, plistBuf]));
}

// Send a usbmuxd plist message and read the response
function sendUsbmuxMessage(msg) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(USBMUX_ADDRESS);

    conn.once('connect', () => {
      const plistStr = plist.build(msg);
      const plistBuf = Buffer.from(plistStr, 'utf8');
      const header = Buffer.alloc(16);
      header.writeUInt32LE(16 + plistBuf.length, 0);
      header.writeUInt32LE(1, 4);  // version
      header.writeUInt32LE(8, 8);  // plist type
      header.writeUInt32LE(1, 12); // tag
      conn.write(Buffer.concat([header, plistBuf]));
    });

    let buf = Buffer.alloc(0);
    conn.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 16) {
        const totalLen = buf.readUInt32LE(0);
        if (buf.length >= totalLen) {
          const payload = buf.subarray(16, totalLen);
          conn.end();
          try {
            resolve(plist.parse(payload.toString('utf8')));
          } catch (e) {
            reject(e);
          }
        }
      }
    });

    conn.once('error', reject);
    setTimeout(() => { conn.destroy(); reject(new Error('usbmuxd timeout')); }, 5000);
  });
}

async function getPairingRecord(udid) {
  // Use usbmuxd's ReadPairRecord API instead of reading from filesystem
  const resp = await sendUsbmuxMessage({
    MessageType: 'ReadPairRecord',
    PairRecordID: udid,
    ClientVersionString: 'mytunes',
    ProgName: 'mytunes'
  });

  if (!resp.PairRecordData) {
    throw new Error(
      `No pairing record found for device ${udid}. ` +
      `Please connect your iPhone and tap "Trust" when prompted.`
    );
  }

  // PairRecordData can be XML or binary plist
  const recordBuf = Buffer.isBuffer(resp.PairRecordData)
    ? resp.PairRecordData
    : Buffer.from(resp.PairRecordData, 'base64');

  const str = recordBuf.toString('utf8');
  if (str.startsWith('<?xml') || str.startsWith('<plist')) {
    return plist.parse(str);
  }

  // Fall back to binary plist
  const parsed = bplistParser.parseBuffer(recordBuf);
  if (!parsed || parsed.length === 0) {
    throw new Error('Failed to parse pairing record');
  }
  return parsed[0];
}

async function getSystemBUID() {
  const resp = await sendUsbmuxMessage({
    MessageType: 'ReadBUID',
    ClientVersionString: 'mytunes',
    ProgName: 'mytunes'
  });

  if (!resp.BUID) {
    throw new Error('Cannot read SystemBUID from usbmuxd');
  }

  return resp.BUID;
}

async function startLockdownSession(usbmuxClient, deviceId, udid) {
  const tunnel = await usbmuxClient.createDeviceTunnel(deviceId, LOCKDOWN_PORT);

  // Query type
  writeLockdownMessage(tunnel, { Label: 'mytunes', Request: 'QueryType' });
  const typeResp = await readLockdownMessage(tunnel);
  if (typeResp.Type !== 'com.apple.mobile.lockdown') {
    tunnel.end();
    throw new Error(`Unexpected lockdown type: ${typeResp.Type}`);
  }

  // Get pairing record via usbmuxd API (no filesystem access needed)
  const pairingRecord = await getPairingRecord(udid);
  const systemBUID = await getSystemBUID();

  // Start session
  writeLockdownMessage(tunnel, {
    Label: 'mytunes',
    Request: 'StartSession',
    HostID: pairingRecord.HostID,
    SystemBUID: systemBUID
  });
  const sessionResp = await readLockdownMessage(tunnel);

  if (!sessionResp.SessionID) {
    tunnel.end();
    throw new Error('Failed to start lockdown session');
  }

  // Upgrade to SSL if requested
  let activeStream = tunnel;
  if (sessionResp.EnableSessionSSL) {
    const hostCert = pairingRecord.HostCertificate;
    const hostKey = pairingRecord.HostPrivateKey;

    // The pairing record stores certs as Buffer (binary data)
    const certPem = Buffer.isBuffer(hostCert) ? hostCert : Buffer.from(hostCert, 'base64');
    const keyPem = Buffer.isBuffer(hostKey) ? hostKey : Buffer.from(hostKey, 'base64');

    activeStream = await new Promise((resolve, reject) => {
      const tlsSocket = tls.connect({
        socket: tunnel,
        cert: certPem,
        key: keyPem,
        rejectUnauthorized: false // Device uses self-signed cert
      }, () => {
        resolve(tlsSocket);
      });
      tlsSocket.once('error', reject);
    });
  }

  return {
    stream: activeStream,
    sessionId: sessionResp.SessionID,
    pairingRecord
  };
}

async function startService(session, serviceName) {
  writeLockdownMessage(session.stream, {
    Label: 'mytunes',
    Request: 'StartService',
    Service: serviceName
  });
  const resp = await readLockdownMessage(session.stream);

  if (!resp.Port) {
    throw new Error(`Failed to start service ${serviceName}: ${JSON.stringify(resp)}`);
  }

  return {
    port: resp.Port,
    enableSSL: resp.EnableServiceSSL || false
  };
}

module.exports = {
  startLockdownSession,
  startService,
  getPairingRecord,
  getSystemBUID
};
