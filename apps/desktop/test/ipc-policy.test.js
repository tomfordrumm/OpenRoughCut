import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTrustedSender } from '../src/ipc-policy.js';
test('IPC admits the exact main frame and rejects remote, missing and child frames', () => {
  const url = 'file:///app/dist/index.html';
  const mainFrame = { url };
  const sender = { mainFrame };
  assert.doesNotThrow(() => assertTrustedSender({ sender, senderFrame: mainFrame }, url));
  for (const senderFrame of [null, { url }, { url: 'https://example.com' }]) {
    assert.throws(() => assertTrustedSender({ sender, senderFrame }, url), /Untrusted/);
  }
  assert.throws(() => assertTrustedSender({ sender, senderFrame: mainFrame }, 'file:///other'), /Untrusted/);
});
