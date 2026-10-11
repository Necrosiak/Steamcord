const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync('src/components/DmPinButton.tsx', 'utf8');
// DOM focus does not validate Steam gamepad focus: never trap directions here.
assert.ok(!source.includes('onGamepadDirection='));
assert.ok(!source.includes('preventDefault('));
assert.ok(!source.includes('stopPropagation('));
assert.ok(source.includes('channel.pinned &&'));
assert.ok(source.includes('move(-1)'));
assert.ok(source.includes('move(1)'));
const text = fs.readFileSync('src/components/TextChat.tsx', 'utf8');
assert.ok(text.includes('resetNavOnEntry: true'));
assert.match(text, /key=\{ch.id\} flow-children="row" navEntryPreferPosition=\{NavEntryPositionPreferences.FIRST\}/);
const vocal = fs.readFileSync('src/components/DMBrowser.tsx', 'utf8');
assert.ok(vocal.includes('flow-children="column"'));
assert.ok(vocal.includes('navEntryPreferPosition={NavEntryPositionPreferences.MAINTAIN_X}'));
console.log('Native navigation unblocked; pinned-only reorder controls present');
