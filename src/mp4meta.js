// Pure Node.js MP4/M4A metadata writer for ringtone iTunes atoms
// Adds ©nam, ©too, cpil, pgap, tmpo atoms required by iOS

const fs = require('fs');

function readUInt32BE(buf, offset) {
  return buf.readUInt32BE(offset);
}

function writeUInt32BE(val) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(val, 0);
  return buf;
}

// Build an iTunes-style text atom (e.g. ©nam, ©too)
function buildTextAtom(name, text) {
  const textBuf = Buffer.from(text, 'utf8');
  const dataSize = 16 + textBuf.length; // 8 (atom header) + 4 (flags) + 4 (locale) + text
  const atomSize = 8 + dataSize;

  const atom = Buffer.alloc(atomSize);
  let offset = 0;

  // Outer atom
  atom.writeUInt32BE(atomSize, offset); offset += 4;
  atom.write(name, offset, 4, 'ascii'); offset += 4;

  // "data" sub-atom
  atom.writeUInt32BE(dataSize, offset); offset += 4;
  atom.write('data', offset, 4, 'ascii'); offset += 4;

  // Flags: 0x00000001 = UTF-8 text
  atom.writeUInt32BE(1, offset); offset += 4;

  // Locale (null)
  atom.writeUInt32BE(0, offset); offset += 4;

  // Text payload
  textBuf.copy(atom, offset);

  return atom;
}

// Build an iTunes-style boolean atom (cpil, pgap)
function buildBoolAtom(name, value) {
  const dataSize = 16 + 1; // 8 + 4 + 4 + 1 byte
  const atomSize = 8 + dataSize;

  const atom = Buffer.alloc(atomSize);
  let offset = 0;

  atom.writeUInt32BE(atomSize, offset); offset += 4;
  atom.write(name, offset, 4, 'ascii'); offset += 4;

  atom.writeUInt32BE(dataSize, offset); offset += 4;
  atom.write('data', offset, 4, 'ascii'); offset += 4;

  // Flags: 0x00000015 = integer
  atom.writeUInt32BE(0x15, offset); offset += 4;

  // Locale
  atom.writeUInt32BE(0, offset); offset += 4;

  // Value
  atom.writeUInt8(value ? 1 : 0, offset);

  return atom;
}

// Build an iTunes-style uint16 atom (tmpo)
function buildUInt16Atom(name, value) {
  const dataSize = 16 + 2; // 8 + 4 + 4 + 2 bytes
  const atomSize = 8 + dataSize;

  const atom = Buffer.alloc(atomSize);
  let offset = 0;

  atom.writeUInt32BE(atomSize, offset); offset += 4;
  atom.write(name, offset, 4, 'ascii'); offset += 4;

  atom.writeUInt32BE(dataSize, offset); offset += 4;
  atom.write('data', offset, 4, 'ascii'); offset += 4;

  // Flags: 0x00000015 = integer
  atom.writeUInt32BE(0x15, offset); offset += 4;

  // Locale
  atom.writeUInt32BE(0, offset); offset += 4;

  // Value (big-endian uint16)
  atom.writeUInt16BE(value, offset);

  return atom;
}

// Find an atom's position and size in the buffer
function findAtom(buf, name, startOffset, endOffset) {
  let pos = startOffset;
  while (pos < endOffset - 8) {
    const size = buf.readUInt32BE(pos);
    if (size < 8) break;
    const atomName = buf.subarray(pos + 4, pos + 8).toString('ascii');
    if (atomName === name) {
      return { offset: pos, size };
    }
    pos += size;
  }
  return null;
}

// Add ringtone metadata to an m4r/m4a file
function addRingtoneMetadata(filePath, title) {
  const data = fs.readFileSync(filePath);

  // Find moov atom
  const moov = findAtom(data, 'moov', 0, data.length);
  if (!moov) throw new Error('No moov atom found');

  const moovEnd = moov.offset + moov.size;

  // Find udta inside moov
  let udta = findAtom(data, 'udta', moov.offset + 8, moovEnd);

  // Find meta inside udta (meta has 4 extra bytes for version/flags)
  let meta = null;
  let ilst = null;

  if (udta) {
    meta = findAtom(data, 'meta', udta.offset + 8, udta.offset + udta.size);
    if (meta) {
      // meta has 4 bytes version+flags after the 8-byte header
      ilst = findAtom(data, 'ilst', meta.offset + 12, meta.offset + meta.size);
    }
  }

  // Build the new metadata atoms
  const newAtoms = [];

  // ©nam is encoded as bytes 0xA9, 0x6E, 0x61, 0x6D
  const namAtom = buildTextAtom('\xA9nam', title || 'Ringtone');
  const tooAtom = buildTextAtom('\xA9too', 'MyTunes 1.0');
  const cpilAtom = buildBoolAtom('cpil', false);
  const pgapAtom = buildBoolAtom('pgap', false);
  const tmpoAtom = buildUInt16Atom('tmpo', 0);

  newAtoms.push(namAtom, tooAtom, cpilAtom, pgapAtom, tmpoAtom);

  // Collect existing ilst atoms we want to keep (like iTunSMPB)
  const existingIlstContent = [];
  if (ilst) {
    let pos = ilst.offset + 8;
    const ilstEnd = ilst.offset + ilst.size;
    while (pos < ilstEnd - 8) {
      const atomSize = data.readUInt32BE(pos);
      if (atomSize < 8) break;
      const atomName = data.subarray(pos + 4, pos + 8);
      const nameStr = atomName.toString('ascii');

      // Skip atoms we're replacing
      const replacing = ['\xA9nam', '\xA9too', 'cpil', 'pgap', 'tmpo'];
      if (!replacing.includes(nameStr)) {
        existingIlstContent.push(data.subarray(pos, pos + atomSize));
      }
      pos += atomSize;
    }
  }

  // Build new ilst
  const ilstContent = Buffer.concat([...newAtoms, ...existingIlstContent]);
  const newIlstSize = 8 + ilstContent.length;
  const newIlst = Buffer.concat([
    writeUInt32BE(newIlstSize),
    Buffer.from('ilst', 'ascii'),
    ilstContent
  ]);

  // Build new meta (hdlr + ilst)
  // meta needs: 8 byte header + 4 byte version/flags + hdlr atom + ilst
  const hdlrAtom = Buffer.concat([
    writeUInt32BE(33),
    Buffer.from('hdlr', 'ascii'),
    Buffer.alloc(4), // version + flags
    Buffer.alloc(4), // predefined
    Buffer.from('mdir', 'ascii'), // handler type
    Buffer.from('appl', 'ascii'), // handler subtype
    Buffer.alloc(4), // reserved
    Buffer.from('\0', 'ascii') // name (null terminated)
  ]);

  // If existing meta has hdlr, use it; otherwise use our default
  let existingHdlr = null;
  if (meta) {
    existingHdlr = findAtom(data, 'hdlr', meta.offset + 12, meta.offset + meta.size);
  }
  const hdlrToUse = existingHdlr
    ? data.subarray(existingHdlr.offset, existingHdlr.offset + existingHdlr.size)
    : hdlrAtom;

  const metaContent = Buffer.concat([
    Buffer.alloc(4), // version + flags
    hdlrToUse,
    newIlst
  ]);
  const newMetaSize = 8 + metaContent.length;
  const newMeta = Buffer.concat([
    writeUInt32BE(newMetaSize),
    Buffer.from('meta', 'ascii'),
    metaContent
  ]);

  // Build new udta
  // Keep any non-meta atoms from existing udta
  const existingUdtaContent = [];
  if (udta) {
    let pos = udta.offset + 8;
    const udtaEnd = udta.offset + udta.size;
    while (pos < udtaEnd - 8) {
      const atomSize = data.readUInt32BE(pos);
      if (atomSize < 8) break;
      const atomName = data.subarray(pos + 4, pos + 8).toString('ascii');
      if (atomName !== 'meta') {
        existingUdtaContent.push(data.subarray(pos, pos + atomSize));
      }
      pos += atomSize;
    }
  }

  const udtaContent = Buffer.concat([newMeta, ...existingUdtaContent]);
  const newUdtaSize = 8 + udtaContent.length;
  const newUdta = Buffer.concat([
    writeUInt32BE(newUdtaSize),
    Buffer.from('udta', 'ascii'),
    udtaContent
  ]);

  // Build new moov: everything except old udta, plus new udta
  const moovParts = [];
  let pos = moov.offset + 8;
  while (pos < moovEnd - 8) {
    const atomSize = data.readUInt32BE(pos);
    if (atomSize < 8) break;
    const atomName = data.subarray(pos + 4, pos + 8).toString('ascii');
    if (atomName !== 'udta') {
      moovParts.push(data.subarray(pos, pos + atomSize));
    }
    pos += atomSize;
  }
  moovParts.push(newUdta);

  const moovContent = Buffer.concat(moovParts);
  const newMoovSize = 8 + moovContent.length;
  const newMoov = Buffer.concat([
    writeUInt32BE(newMoovSize),
    Buffer.from('moov', 'ascii'),
    moovContent
  ]);

  // Rebuild the file: everything before moov + new moov + everything after moov
  const beforeMoov = data.subarray(0, moov.offset);
  const afterMoov = data.subarray(moovEnd);

  const newFile = Buffer.concat([beforeMoov, newMoov, afterMoov]);
  fs.writeFileSync(filePath, newFile);
}

module.exports = { addRingtoneMetadata };
