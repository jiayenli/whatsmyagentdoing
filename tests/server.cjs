// Each case owns a child process so an uncaught request error fails the test.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

for (const scenario of ['assets', 'scenes', 'guards']) {
  test(`HTTP ${scenario}: malformed paths and resource boundaries`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-server-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/server.cjs'), scenario, home], {
      env: { ...process.env, HOME: home, USERPROFILE: home, WMAD_NO_UPDATE_CHECK: '1' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}

test('silent active sessions are flagged as stuck, with minutes, until they time out to idle', () => {
  const { snapshot } = require('../src/server');
  const now = Date.now(), min = 60_000;
  const s = (key, status, ago) => ({ agent: 'claude', id: key, status, lastEventAt: now - ago, cwd: '/w' });
  const rows = snapshot({ sessions: () => [s('a', 'tool', 9 * min), s('b', 'tool', 12 * min), s('c', 'thinking', 9 * min),
    s('d', 'thinking', 20 * min), s('e', 'waiting', 30 * min), s('f', 'tool', 50 * min)] }, { privacy: false }).sessions;
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by.a.stuck, 0);
  assert.equal(by.b.stuck, 12);
  assert.equal(by.c.stuck, 9);
  assert.equal(by.d.status, 'idle'); assert.equal(by.d.stuck, 0);
  assert.equal(by.e.stuck, 0, 'waiting for you is not stuck');
  assert.equal(by.f.status, 'idle'); assert.equal(by.f.stuck, 0);
});

test('a finished subagent drops off the list but still counts in today\'s totals', () => {
  const { snapshot } = require('../src/server');
  const now = Date.now();
  const d = new Date(now), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const snap = snapshot({ sessions: () => [
    { agent: 'claude', id: 'main', status: 'done', lastEventAt: now, cwd: '/w' },
    { agent: 'claude', id: 'busy', parentId: 'main', subagent: true, status: 'tool', lastEventAt: now, cwd: '/w' },
    { agent: 'claude', id: 'over', parentId: 'main', subagent: true, status: 'done', lastEventAt: now, cwd: '/w', daily: { day, turns: 2, tokens: 50 } },
  ] }, { privacy: false });
  assert.deepEqual(snap.sessions.map(s => s.id).sort(), ['busy', 'main']);
  assert.equal(snap.summary.tokens, 50);
});

test('a Claude session whose process exited is shown as closed, with its open state and prompt time', () => {
  const { snapshot } = require('../src/server');
  const now = Date.now();
  const rows = snapshot({ sessions: () => [
    { agent: 'claude', id: 'gone', status: 'thinking', open: false, lastEventAt: now, promptAt: now - 1000, cwd: '/w' },
    { agent: 'claude', id: 'live', status: 'done', open: true, lastEventAt: now, promptAt: now - 1000, cwd: '/w' },
    { agent: 'codex', id: 'other', status: 'done', lastEventAt: now, cwd: '/w' },
  ] }, { privacy: false }).sessions;
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by.gone.status, 'closed');
  assert.equal(by.gone.open, false);
  assert.equal(by.live.status, 'done');
  assert.equal(by.live.open, true);
  assert.equal(by.live.promptAt, now - 1000);
  assert.equal(by.other.open, null);
});
