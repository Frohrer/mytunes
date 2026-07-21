// End-to-end conversion tests against the real macOS audio tools.
// Covers: resample -> AAC encode -> iTunes metadata injection -> decode-back.
// Skipped automatically where afconvert/afinfo aren't available (non-macOS).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { convertToM4R } = require('../src/converter');

function hasAudioTools() {
  try {
    execFileSync('which', ['afconvert', 'afinfo'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

const SKIP = !hasAudioTools();
let WORK;

before(() => { WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tonedrop-convtest-')); });
after(() => { if (WORK) fs.rmSync(WORK, { recursive: true, force: true }); });

// 3s 440Hz stereo WAV at 48kHz — deliberately not 44.1k, so the resample path runs.
function makeWav(file, seconds = 3, rate = 48000) {
  const ch = 2, bits = 16, n = seconds * rate;
  const data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin(2 * Math.PI * 440 * (i / rate)) * 12000);
    data.writeInt16LE(s, i * 4);
    data.writeInt16LE(s, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * bits / 8, 28); h.writeUInt16LE(ch * bits / 8, 32);
  h.writeUInt16LE(bits, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

const parse = async (f) => (await import('music-metadata')).parseFile(f);

test('converts arbitrary audio to a 44100 Hz AAC ringtone with metadata', { skip: SKIP }, async () => {
  const src = path.join(WORK, 'E2E Source Tone.wav');
  makeWav(src);
  const out = await convertToM4R(src, 'E2E Test Tone');

  assert.ok(fs.existsSync(out), 'output file produced');
  const info = execFileSync('afinfo', [out], { encoding: 'utf8' });
  assert.match(info, /44100 Hz/, 'resampled to 44100 Hz');
  assert.match(info, /aac/i, 'encoded as AAC');

  const meta = await parse(out);
  assert.strictEqual(meta.common.title, 'E2E Test Tone', 'title atom embedded');
  assert.ok(Math.abs((meta.format.duration || 0) - 3) < 0.35,
    `duration ~3s (got ${(meta.format.duration || 0).toFixed(2)}s)`);
});

// The real regression test for the stco/co64 chunk-offset fix: if offsets are
// corrupted by the metadata rewrite, the decoder errors or emits silence.
test('audio still decodes correctly after metadata injection', { skip: SKIP }, async () => {
  const src = path.join(WORK, 'Decode Check.wav');
  makeWav(src);
  const out = await convertToM4R(src, 'Decode Check');

  const back = path.join(WORK, 'decoded.wav');
  execFileSync('afconvert', [out, back, '-d', 'LEI16@44100', '-f', 'WAVE', '-c', '2'], { timeout: 60000 });

  const decoded = fs.readFileSync(back);
  const frames = (decoded.length - 44) / 4;
  assert.ok(Math.abs(frames / 44100 - 3) < 0.35,
    `decoded duration ~3s (got ${(frames / 44100).toFixed(2)}s)`);

  let peak = 0;
  for (let i = 44; i + 1 < decoded.length; i += 2) {
    peak = Math.max(peak, Math.abs(decoded.readInt16LE(i)));
  }
  assert.ok(peak > 3000, `decoded audio is not silent (peak ${peak})`);
});

test('re-processing an existing .m4r retitles it and keeps it valid', { skip: SKIP }, async () => {
  const src = path.join(WORK, 'Passthrough Source.wav');
  makeWav(src);
  const first = await convertToM4R(src, 'First Name');

  const existing = path.join(WORK, 'Existing Ringtone.m4r');
  fs.copyFileSync(first, existing);
  const out = await convertToM4R(existing, 'Renamed Tone');

  assert.ok(fs.existsSync(out), 'passthrough produced a file');
  const meta = await parse(out);
  assert.strictEqual(meta.common.title, 'Renamed Tone', 'retitled');
  assert.match(execFileSync('afinfo', [out], { encoding: 'utf8' }), /44100 Hz/);
});

test('a filename containing shell metacharacters cannot execute commands', { skip: SKIP }, async () => {
  const src = path.join(WORK, 'Injection Source.wav');
  makeWav(src);
  const clean = await convertToM4R(src, 'Injection Source');

  // The canary name must contain no '/', or it would just be an unwritable
  // path rather than a filename. An injected `touch` lands in the cwd.
  const CANARY = 'tonedrop-injection-canary';
  const canary = path.join(process.cwd(), CANARY);
  fs.rmSync(canary, { force: true });

  // Reaches the .m4r branch, which previously built a shell string from this name.
  const evil = path.join(WORK, `evil"; touch ${CANARY}; echo ".m4r`);
  fs.copyFileSync(clean, evil);
  try { await convertToM4R(evil, 'Evil'); } catch { /* conversion outcome irrelevant */ }

  const fired = fs.existsSync(canary);
  fs.rmSync(canary, { force: true }); // never leave it behind
  assert.ok(!fired, 'no shell command executed from the filename');
});
