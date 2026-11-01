const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../defaults/webrtc_client.js'), 'utf8');
const start = source.indexOf('    const directDesktop = async () => {');
const end = source.indexOf('\n    };', start) + '\n    };'.length;
assert.ok(start >= 0 && end > start);

for (const platform of ['windows', 'linux']) {
  test(`${platform} capture uses its source without leaking the Linux audio bridge into Windows`, async () => {
    const calls = [];
    const attached = [];
    const stream = { getVideoTracks: () => [{}], addTrack: t => attached.push(t) };
    const audio = { kind: 'audio' };
    const capture = vm.runInNewContext(source.slice(start, end) + '\ndirectDesktop', {
      window: { STEAMCORD_HOST: platform },
      readStreamQuality: () => ({ resolution: 720, frameRate: 30 }),
      navigator: { mediaDevices: {
        getUserMedia: async constraints => {
          calls.push(constraints);
          return constraints.video ? stream : { getAudioTracks: () => [audio] };
        },
        enumerateDevices: async () => [{ kind: 'audioinput', label: 'vencord-screen-share', deviceId: 'bridge' }]
      } }
    });
    assert.equal(await capture(), stream);
    assert.equal(calls[0].video.mandatory.chromeMediaSourceId, platform === 'windows' ? 'screen:-1:0' : 'screen:0:0');
    assert.equal(calls[0].video.mandatory.maxHeight, 720);
    assert.equal(calls[0].video.mandatory.maxFrameRate, 30);
    assert.equal(calls.length, platform === 'windows' ? 1 : 2);
    assert.equal(attached.length, platform === 'windows' ? 0 : 1);
  });
}

const pickerSource = fs.readFileSync(path.join(__dirname, '../defaults/steamcord_client.js'), 'utf8');
const pickerStart = pickerSource.indexOf('    const submitWindowsPicker = (dlg, button) => {');
const pickerEnd = pickerSource.indexOf('\n    };', pickerStart) + '\n    };'.length;
test('Windows picker selects a display, then submits without Linux audio APIs', () => {
  let chosen = '', submitted = 0;
  const choose = vm.runInNewContext(pickerSource.slice(pickerStart, pickerEnd) + '\nsubmitWindowsPicker', {
    scReactClick: () => submitted++
  });
  const dialog = { dataset: {}, querySelectorAll: () => [
    { value: 'window:123', click: () => { chosen = 'window'; } },
    { value: 'screen:0:0', click: () => { chosen = 'screen'; } }
  ] };
  assert.equal(choose(dialog, null), false);
  assert.equal(chosen, 'screen');
  assert.equal(submitted, 0);
  assert.equal(choose(dialog, {}), true);
  assert.equal(submitted, 1);
  assert.equal(dialog.dataset.scAuto, '1');
});

const gdmStart = source.indexOf('    const steamcordGDM = async (constraints) => {');
const gdmEnd = source.indexOf('\n    };', gdmStart) + '\n    };'.length;
for (const fails of [false, true]) {
  test(`Windows uses native audio capture${fails ? ' with a video-only fallback' : ''}`, async () => {
    let nativeCalls = 0, directCalls = 0, constraints;
    const native = { native: true }, videoOnly = { videoOnly: true };
    const capture = vm.runInNewContext(source.slice(gdmStart, gdmEnd) + '\nsteamcordGDM', {
      window: { STEAMCORD_HOST: 'windows', STEAMCORD_GOLIVE_DIRECT: true },
      nativeGetDisplayMedia: () => {}, nativePortalDead: false,
      nativeFirst: async c => { nativeCalls++; constraints = c; if (fails) throw Error('native unavailable'); return native; },
      directDesktop: async () => { directCalls++; return videoOnly; },
      keepShareStream: s => s,
      getRTCStream: () => { throw Error('Linux relay must not run'); }
    });
    assert.equal(await capture({ video: true }), fails ? videoOnly : native);
    assert.equal(nativeCalls, 1);
    assert.equal(constraints.audio, true);
    assert.equal(directCalls, fails ? 1 : 0);
  });
}
