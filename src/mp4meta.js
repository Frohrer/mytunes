// Pure Node.js MP4/M4A metadata writer for ringtone iTunes atoms
// Adds ©nam, ©too, cpil, pgap, tmpo atoms required by iOS

const fs = require('fs');

function writeUInt32BE(val) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(val, 0);
  return buf;
}

function buildTextAtom(name, text) {
  const textBuf = Buffer.from(text, 'utf8');
  const dataSize = 16 + textBuf.length;
  const atomSize = 8 + dataSize;
  const atom = Buffer.alloc(atomSize);
  let o = 0;
  atom.writeUInt32BE(atomSize, o); o += 4;
  atom.write(name, o, 4, 'latin1'); o += 4;
  atom.writeUInt32BE(dataSize, o); o += 4;
  atom.write('data', o, 4, 'ascii'); o += 4;
  atom.writeUInt32BE(1, o); o += 4; // UTF-8 flag
  atom.writeUInt32BE(0, o); o += 4; // locale
  textBuf.copy(atom, o);
  return atom;
}

function buildBoolAtom(name, value) {
  // iTunes format: 25 bytes total = 8 (outer) + 17 (data: 8 header + 4 flags + 4 locale + 1 byte)
  const atom = Buffer.alloc(25);
  let o = 0;
  atom.writeUInt32BE(25, o); o += 4;
  atom.write(name, o, 4, 'ascii'); o += 4;
  atom.writeUInt32BE(17, o); o += 4; // data atom size
  atom.write('data', o, 4, 'ascii'); o += 4;
  atom.writeUInt32BE(0x15, o); o += 4; // integer flag
  atom.writeUInt32BE(0, o); o += 4; // locale
  atom.writeUInt8(value ? 1 : 0, o);
  return atom;
}

function buildUInt16Atom(name, value) {
  // iTunes format: 26 bytes total = 8 (outer) + 18 (data: 8 header + 4 flags + 4 locale + 2 bytes)
  const atom = Buffer.alloc(26);
  let o = 0;
  atom.writeUInt32BE(26, o); o += 4;
  atom.write(name, o, 4, 'ascii'); o += 4;
  atom.writeUInt32BE(18, o); o += 4; // data atom size
  atom.write('data', o, 4, 'ascii'); o += 4;
  atom.writeUInt32BE(0x15, o); o += 4;
  atom.writeUInt32BE(0, o); o += 4;
  atom.writeUInt16BE(value, o);
  return atom;
}

function findAtom(buf, name, start, end) {
  let pos = start;
  while (pos < end - 8) {
    const size = buf.readUInt32BE(pos);
    if (size < 8 || pos + size > end) break;
    const atomName = buf.subarray(pos + 4, pos + 8).toString('ascii');
    if (atomName === name) return { offset: pos, size };
    pos += size;
  }
  return null;
}

// Update stco (32-bit) and co64 (64-bit) chunk offset atoms
function updateChunkOffsets(moovBuf, delta) {
  let pos = 0;
  while (pos < moovBuf.length - 8) {
    const size = moovBuf.readUInt32BE(pos);
    if (size < 8 || pos + size > moovBuf.length) break;
    const name = moovBuf.subarray(pos + 4, pos + 8).toString('ascii');

    if (name === 'stco') {
      // stco: 8 header + 4 version/flags + 4 entry count + 4*N offsets
      const entryCount = moovBuf.readUInt32BE(pos + 12);
      for (let i = 0; i < entryCount; i++) {
        const off = pos + 16 + i * 4;
        const oldVal = moovBuf.readUInt32BE(off);
        moovBuf.writeUInt32BE(oldVal + delta, off);
      }
    } else if (name === 'co64') {
      const entryCount = moovBuf.readUInt32BE(pos + 12);
      for (let i = 0; i < entryCount; i++) {
        const off = pos + 16 + i * 8;
        const oldVal = Number(moovBuf.readBigUInt64BE(off));
        moovBuf.writeBigUInt64BE(BigInt(oldVal + delta), off);
      }
    }

    // Recurse into container atoms
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(name)) {
      updateChunkOffsets(moovBuf.subarray(pos + 8, pos + size), delta);
    }

    pos += size;
  }
}

function addRingtoneMetadata(filePath, title) {
  const data = fs.readFileSync(filePath);

  const moov = findAtom(data, 'moov', 0, data.length);
  if (!moov) throw new Error('No moov atom found');
  const moovEnd = moov.offset + moov.size;
  const oldMoovSize = moov.size;

  let udta = findAtom(data, 'udta', moov.offset + 8, moovEnd);
  let meta = null;
  let ilst = null;

  if (udta) {
    meta = findAtom(data, 'meta', udta.offset + 8, udta.offset + udta.size);
    if (meta) {
      ilst = findAtom(data, 'ilst', meta.offset + 12, meta.offset + meta.size);
    }
  }

  // Build new metadata atoms
  const namAtom = buildTextAtom('\xA9nam', title || 'Ringtone');
  const tooAtom = buildTextAtom('\xA9too', 'MyTunes 1.0');
  const cpilAtom = buildBoolAtom('cpil', false);
  const pgapAtom = buildBoolAtom('pgap', false);
  const tmpoAtom = buildUInt16Atom('tmpo', 0);
  const newAtoms = [namAtom, tooAtom, cpilAtom, pgapAtom, tmpoAtom];

  // Keep existing ilst atoms we're not replacing
  const existingIlstContent = [];
  if (ilst) {
    let pos = ilst.offset + 8;
    const ilstEnd = ilst.offset + ilst.size;
    const replacing = ['\xA9nam', '\xA9too', 'cpil', 'pgap', 'tmpo'];
    while (pos < ilstEnd - 8) {
      const atomSize = data.readUInt32BE(pos);
      if (atomSize < 8) break;
      const atomName = data.subarray(pos + 4, pos + 8).toString('latin1');
      if (!replacing.includes(atomName)) {
        existingIlstContent.push(data.subarray(pos, pos + atomSize));
      }
      pos += atomSize;
    }
  }

  const ilstContent = Buffer.concat([...newAtoms, ...existingIlstContent]);
  const newIlst = Buffer.concat([writeUInt32BE(8 + ilstContent.length), Buffer.from('ilst', 'ascii'), ilstContent]);

  // Build hdlr
  let existingHdlr = meta ? findAtom(data, 'hdlr', meta.offset + 12, meta.offset + meta.size) : null;
  const hdlrToUse = existingHdlr
    ? data.subarray(existingHdlr.offset, existingHdlr.offset + existingHdlr.size)
    : Buffer.concat([writeUInt32BE(33), Buffer.from('hdlr', 'ascii'), Buffer.alloc(4), Buffer.alloc(4),
        Buffer.from('mdir', 'ascii'), Buffer.from('appl', 'ascii'), Buffer.alloc(4), Buffer.from('\0', 'ascii')]);

  // Build meta
  const metaContent = Buffer.concat([Buffer.alloc(4), hdlrToUse, newIlst]);
  const newMeta = Buffer.concat([writeUInt32BE(8 + metaContent.length), Buffer.from('meta', 'ascii'), metaContent]);

  // Build udta (keep non-meta children)
  const existingUdtaContent = [];
  if (udta) {
    let pos = udta.offset + 8;
    while (pos < udta.offset + udta.size - 8) {
      const atomSize = data.readUInt32BE(pos);
      if (atomSize < 8) break;
      if (data.subarray(pos + 4, pos + 8).toString('ascii') !== 'meta') {
        existingUdtaContent.push(data.subarray(pos, pos + atomSize));
      }
      pos += atomSize;
    }
  }
  const udtaContent = Buffer.concat([newMeta, ...existingUdtaContent]);
  const newUdta = Buffer.concat([writeUInt32BE(8 + udtaContent.length), Buffer.from('udta', 'ascii'), udtaContent]);

  // Build new moov
  const moovParts = [];
  let pos = moov.offset + 8;
  while (pos < moovEnd - 8) {
    const atomSize = data.readUInt32BE(pos);
    if (atomSize < 8) break;
    if (data.subarray(pos + 4, pos + 8).toString('ascii') !== 'udta') {
      moovParts.push(data.subarray(pos, pos + atomSize));
    }
    pos += atomSize;
  }
  moovParts.push(newUdta);

  const moovContent = Buffer.concat(moovParts);
  const newMoovSize = 8 + moovContent.length;
  const newMoov = Buffer.concat([writeUInt32BE(newMoovSize), Buffer.from('moov', 'ascii'), moovContent]);

  // Calculate how much moov grew
  const sizeDelta = newMoovSize - oldMoovSize;

  if (sizeDelta !== 0) {
    // Update stco/co64 offsets inside the new moov to account for the shift
    // The moov content starts at offset 8 in newMoov (after the 8-byte header)
    updateChunkOffsets(newMoov.subarray(8), sizeDelta);
  }

  // Rebuild file
  const beforeMoov = data.subarray(0, moov.offset);
  const afterMoov = data.subarray(moovEnd);
  const newFile = Buffer.concat([beforeMoov, newMoov, afterMoov]);
  fs.writeFileSync(filePath, newFile);
}

module.exports = { addRingtoneMetadata };
