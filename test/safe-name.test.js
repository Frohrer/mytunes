const { test } = require('node:test');
const assert = require('node:assert');
const { safeRingtoneName } = require('../src/device');

test('accepts a plain ringtone basename', () => {
  assert.strictEqual(safeRingtoneName('Marimba.m4r'), 'Marimba.m4r');
});

test('rejects path traversal and separators', () => {
  for (const bad of [
    '../../../etc/passwd',
    '..',
    '.',
    'a/b.m4r',
    'a\\b.m4r',
    '/iTunes_Control/x.m4r',
    'sub/dir/file.m4r'
  ]) {
    assert.throws(() => safeRingtoneName(bad), /Invalid ringtone name/, `should reject ${bad}`);
  }
});
