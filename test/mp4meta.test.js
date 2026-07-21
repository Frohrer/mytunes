const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { addRingtoneMetadata } = require('../src/mp4meta');

// --- minimal MP4 atom builders ---
function atom(name, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(name, 4, 4, 'ascii');
  return Buffer.concat([head, body]);
}

function stcoAtom(offsets) {
  const body = Buffer.alloc(8 + offsets.length * 4);
  body.writeUInt32BE(0, 0);               // version + flags
  body.writeUInt32BE(offsets.length, 4);  // entry count
  offsets.forEach((o, i) => body.writeUInt32BE(o, 8 + i * 4));
  return atom('stco', body);
}

// moov -> trak -> mdia -> minf -> stbl -> stco (the containers the writer recurses into)
function moovWithOffsets(offsets) {
  const stbl = atom('stbl', stcoAtom(offsets));
  const minf = atom('minf', stbl);
  const mdia = atom('mdia', minf);
  const trak = atom('trak', mdia);
  return atom('moov', trak);
}

// Read the single stco's offsets back out of a rebuilt file.
function readStcoOffsets(buf) {
  const j = buf.indexOf(Buffer.from('stco', 'ascii'));
  assert.ok(j >= 0, 'stco atom present');
  const count = buf.readUInt32BE(j + 8);
  const offs = [];
  for (let i = 0; i < count; i++) offs.push(buf.readUInt32BE(j + 12 + i * 4));
  return offs;
}

function withTempFile(buf, fn) {
  const p = path.join(os.tmpdir(), `tonedrop-test-${process.pid}-${Math.floor(process.hrtime()[1])}.m4r`);
  fs.writeFileSync(p, buf);
  try { return fn(p); } finally { try { fs.unlinkSync(p); } catch {} }
}

test('mdat AFTER moov: chunk offsets shift by the moov growth', () => {
  const ftyp = atom('ftyp', Buffer.from('M4A mmp42', 'ascii'));
  // Point stco at where the audio will live: just past the moov, inside mdat.
  const moov = moovWithOffsets([0]);       // placeholder, fixed below
  const moovOffset = ftyp.length;
  const mdatDataOffset = moovOffset + moov.length + 8; // +8 = mdat header
  const realMoov = moovWithOffsets([mdatDataOffset]);
  const AUDIO = Buffer.from('AUDIODATA____chunk', 'ascii');
  const mdat = atom('mdat', AUDIO);
  const file = Buffer.concat([ftyp, realMoov, mdat]);

  withTempFile(file, (p) => {
    const before = fs.readFileSync(p);
    addRingtoneMetadata(p, 'Test Tone');
    const after = fs.readFileSync(p);

    const delta = after.length - before.length;
    assert.ok(delta > 0, 'moov grew after adding metadata');

    const [newOff] = readStcoOffsets(after);
    assert.strictEqual(newOff, mdatDataOffset + delta,
      'offset into trailing mdat must move by the moov growth');

    // Audio bytes must still be intact at the new offset.
    assert.strictEqual(after.subarray(newOff, newOff + AUDIO.length).toString('ascii'),
      AUDIO.toString('ascii'), 'audio data preserved');
  });
});

test('mdat BEFORE moov (moov-at-end): chunk offsets are left untouched', () => {
  const ftyp = atom('ftyp', Buffer.from('M4A mmp42', 'ascii'));
  const AUDIO = Buffer.from('AUDIODATA____chunk', 'ascii');
  const mdat = atom('mdat', AUDIO);
  const audioOffset = ftyp.length + 8; // audio sits inside mdat, before moov
  const moov = moovWithOffsets([audioOffset]);
  const file = Buffer.concat([ftyp, mdat, moov]);

  withTempFile(file, (p) => {
    const before = fs.readFileSync(p);
    addRingtoneMetadata(p, 'Test Tone');
    const after = fs.readFileSync(p);

    assert.ok(after.length - before.length > 0, 'moov grew after adding metadata');

    const [newOff] = readStcoOffsets(after);
    assert.strictEqual(newOff, audioOffset,
      'offset into leading mdat must NOT move — this is the corruption bug being guarded');

    assert.strictEqual(after.subarray(audioOffset, audioOffset + AUDIO.length).toString('ascii'),
      AUDIO.toString('ascii'), 'audio data preserved');
  });
});
