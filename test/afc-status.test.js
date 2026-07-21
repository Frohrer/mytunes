const { test } = require('node:test');
const assert = require('node:assert');
const { AFC_STATUS } = require('../src/afc');

// These are wire values chosen by the device, not by us. If they drift, the
// error branches that depend on them silently stop matching — the failure is
// not a crash but wrong behaviour (see the NO_SUCH_PATH case below), so pin
// them explicitly.
test('AFC status codes match the wire protocol', () => {
  assert.strictEqual(AFC_STATUS.SUCCESS, 0);
  assert.strictEqual(AFC_STATUS.UNKNOWN_ERROR, 1);
  assert.strictEqual(AFC_STATUS.OP_HEADER_INVALID, 2);
  assert.strictEqual(AFC_STATUS.READ_ERROR, 4);
  assert.strictEqual(AFC_STATUS.INVALID_ARG, 7);
  assert.strictEqual(AFC_STATUS.NO_SUCH_PATH, 8);
  assert.strictEqual(AFC_STATUS.PERM_DENIED, 10);
  assert.strictEqual(AFC_STATUS.OP_NOT_SUPPORTED, 15);
  assert.strictEqual(AFC_STATUS.OBJECT_EXISTS, 16);
});

// A device with no Ringtones.plist yet reports 8. _readRingtonesPlist treats
// exactly this code as "no ringtones registered", returning an empty structure
// instead of throwing — so a first-ever transfer to a fresh device works.
test('NO_SUCH_PATH is distinct from the codes it was once confused with', () => {
  assert.notStrictEqual(AFC_STATUS.NO_SUCH_PATH, AFC_STATUS.READ_ERROR);
  assert.notStrictEqual(AFC_STATUS.OBJECT_EXISTS, AFC_STATUS.INVALID_ARG);
  assert.notStrictEqual(AFC_STATUS.OP_NOT_SUPPORTED, AFC_STATUS.OP_HEADER_INVALID);
});
