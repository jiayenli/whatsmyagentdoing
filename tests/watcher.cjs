// Isolated logs only: never read the developer's actual agent history.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const watcherPath = path.join(__dirname, '../src/watcher.js');
const localRequire = createRequire(watcherPath);
const source = fs.readFileSync(watcherPath, 'utf8');
const HOUR = 3600000;
const NOW = Date.parse('2026-10-26T10:00:00Z');

function fixture(t, hours = 24) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-watcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = NOW;
  const reads = [];
  const blocked = new Set();
  const io = new Proxy(fs, {
    get(target, name) {
      if (['openSync', 'readdirSync', 'statSync'].includes(name)) return (file, ...args) => {
        if (blocked.has(String(file))) throw Object.assign(new Error('Fixture access denied'), { code: 'EACCES' });
        if (name === 'openSync') reads.push(String(file));
        return target[name](file, ...args);
      };
      return target[name];
    },
  });
  class Clock extends Date { static now() { return now; } }
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod, Buffer, Date: Clock, process: { env: {} }, setInterval, clearInterval,
    require: name => name === 'os' ? { homedir: () => root } : name === 'fs' ? io : localRequire(name),
  }, { filename: watcherPath });
  const watcher = new mod.exports.Watcher({ hours });
  const event = (type, at, extra = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type, ...extra } }) + '\n';
  const write = (day, n, at) => {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const file = path.join(root, '.codex/sessions', day, `rollout-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ timestamp: '2025-01-01T00:00:00Z', type: 'session_meta', payload: { cwd: '/demo/long-chat' } }) + '\n' + event('task_started', at));
    fs.utimesSync(file, new Date(at), new Date(at));
    return { file, id };
  };
  return { root, watcher, write, reads, blocked,
    advance: ms => { now += ms; },
    append(log, type, extra) {
      fs.appendFileSync(log.file, event(type, now, extra));
      fs.utimesSync(log.file, new Date(now), new Date(now));
    },
  };
}

test('recently active Codex chats in old date folders are discovered without an index', t => {
  const f = fixture(t);
  const old = f.write('2025/01/01', 1, NOW - HOUR);
  const recent = f.write('2026/10/26', 2, NOW - HOUR);
  const inactive = f.write('2026/08/19', 3, NOW - 48 * HOUR);
  f.watcher.tick();
  assert.deepEqual(Array.from(f.watcher.sessions(), s => s.id).sort(), [old.id, recent.id].sort());
  assert.equal(f.reads.includes(inactive.file), false, 'inactive history is not opened');
  assert.equal(f.watcher.sessions().find(s => s.id === old.id).status, 'thinking');
});

test('an old inactive chat is discovered after resuming, then tailed without reopening', t => {
  const f = fixture(t);
  const log = f.write('2026/08/19', 1, NOW - 48 * HOUR);
  f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 0);
  f.advance(6000);f.append(log, 'task_started');f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 1);
  const tracker = f.watcher.trackers.get(log.file);
  f.advance(1000);f.append(log, 'task_complete', { last_agent_message: 'Finished' });f.watcher.tick();
  assert.equal(f.watcher.trackers.get(log.file), tracker, 'reuse incremental tracker');
  assert.equal(f.watcher.sessions()[0].status, 'done');
  assert.equal(f.watcher.sessions()[0].reply, 'Finished');
});

test('custom hours still excludes inactive logs and expires tracked sessions', t => {
  const f = fixture(t, 2);
  const active = f.write('2024/12/31', 1, NOW - HOUR);
  const inactive = f.write('2026/10/26', 2, NOW - 3 * HOUR);
  f.watcher.tick();
  assert.deepEqual(Array.from(f.watcher.sessions(), s => s.id), [active.id]);
  assert.equal(f.reads.includes(inactive.file), false);
  f.advance(3 * HOUR);f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 0);
});

test('an inaccessible historical folder or log does not hide readable active chats', t => {
  const f = fixture(t);
  const hidden = f.write('2025/01/01', 1, NOW - HOUR);
  const blocked = f.write('2025/02/02', 2, NOW - HOUR);
  const good = f.write('2025/03/03', 3, NOW - HOUR);
  f.blocked.add(path.dirname(hidden.file));f.blocked.add(blocked.file);
  assert.doesNotThrow(() => f.watcher.tick());
  assert.deepEqual(Array.from(f.watcher.sessions(), s => s.id), [good.id]);
});

test('historical files outside the window stay out of the one-second polling list', t => {
  const f = fixture(t);
  for (let n = 1; n <= 300; n++) f.write('2025/01/01', n, NOW - 48 * HOUR);
  const active = f.write('2025/01/01', 301, NOW - HOUR);
  f.watcher.tick();
  assert.deepEqual(Array.from(f.watcher.candidates, c => c.file), [active.file]);
  assert.deepEqual(f.reads, [active.file]);
});

test('a large long-lived chat keeps head metadata and reads its current state from the tail', t => {
  const f = fixture(t);
  const log = f.write('2025/01/01', 1, NOW - HOUR);
  const filler = JSON.stringify({ type: 'padding', payload: { text: 'x'.repeat(4096) } }) + '\n';
  fs.appendFileSync(log.file, filler.repeat(300));
  f.append(log, 'task_complete', { last_agent_message: 'Latest reply in the tail' });
  f.watcher.tick();
  const session = f.watcher.sessions()[0];
  assert.equal(session.id, log.id);
  assert.equal(session.cwd, '/demo/long-chat');
  assert.equal(session.status, 'done');
  assert.equal(session.reply, 'Latest reply in the tail');
  assert.equal(f.reads.filter(file => file === log.file).length, 2, 'read only the head and tail');
});

test('legacy Gemini documents reload when their size changes without an mtime change', t => {
  const f = fixture(t);
  const file = path.join(f.root, '.gemini/tmp/demo/chats/session-legacy.json');
  const stamp = new Date(NOW);
  const doc = { sessionId: 'legacy', messages: [
    { type: 'user', timestamp: stamp.toISOString(), content: 'Read the configuration' },
  ] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.utimesSync(file, stamp, stamp);
  f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 1);
  assert.equal(f.watcher.sessions()[0].status, 'thinking');
  const before = fs.statSync(file);

  doc.messages.push({ type: 'gemini', timestamp: stamp.toISOString(),
    toolCalls: [{ name: 'read_file', status: 'executing', args: { path: 'config.json' } }],
  });
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.utimesSync(file, stamp, stamp);
  const after = fs.statSync(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.ok(after.size > before.size);

  f.watcher.tick();
  assert.equal(f.watcher.sessions().length, 1);
  assert.equal(f.watcher.sessions()[0].status, 'tool');
  assert.equal(f.watcher.sessions()[0].activity, 'read_file config.json');
});

// Claude Code: open sessions come from ~/.claude/sessions/<pid>.json plus a live pid.
function claudeFixture(t, alivePids, starts = null) {
  const f = fixture(t);
  const mod = { exports: {} };
  const io = fs;
  class Clock extends Date { static now() { return NOW; } }
  vm.runInNewContext(source, {
    module: mod, Buffer, Date: Clock, process: { env: {} }, setInterval, clearInterval,
    require: name => name === 'os' ? { homedir: () => f.root } : name === 'fs' ? io : localRequire(name),
  }, { filename: watcherPath });
  const watcher = new mod.exports.Watcher({ pidAlive: pid => alivePids.has(pid), ...(starts && { procStartOf: pids => new Map(pids.filter(p => starts[p]).map(p => [p, starts[p]])) }) });
  const log = (id, at, prompt = 'hi', extra = { entrypoint: 'cli' }) => {
    const file = path.join(f.root, '.claude/projects/-demo', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), cwd: '/demo', ...extra, message: { content: prompt } }) + '\n');
    fs.utimesSync(file, new Date(at), new Date(at));
  };
  const pidFile = (pid, sessionId, procStart) => {
    const dir = path.join(f.root, '.claude/sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, ...(procStart && { procStart }) }));
  };
  return { watcher, log, pidFile };
}

test('an open Claude session stays listed past the window; a closed one is marked closed', t => {
  const f = claudeFixture(t, new Set([101]));
  f.log('old-open', NOW - 10 * 24 * HOUR, 'last week');
  f.log('recent-closed', NOW - HOUR);
  f.log('old-closed', NOW - 10 * 24 * HOUR);
  f.pidFile(101, 'old-open');
  f.pidFile(102, 'recent-closed');
  f.watcher.tick();
  const by = Object.fromEntries(f.watcher.sessions().map(s => [s.id, s]));
  assert.deepEqual(Object.keys(by).sort(), ['old-open', 'recent-closed']);
  assert.equal(by['old-open'].open, true);
  assert.equal(by['old-open'].promptAt, NOW - 10 * 24 * HOUR);
  assert.equal(by['old-open'].prompt, 'last week');
  assert.equal(by['recent-closed'].open, false);
});

test('without a Claude sessions folder, open state is unknown and the window applies as before', t => {
  const f = claudeFixture(t, new Set());
  f.log('old', NOW - 10 * 24 * HOUR);
  f.log('recent', NOW - HOUR);
  f.watcher.tick();
  const rows = f.watcher.sessions();
  assert.deepEqual(Array.from(rows, s => s.id), ['recent']);
  assert.equal(rows[0].open, undefined);
});

test('Claude sessions without a pid file (non-cli or old logs) are not marked closed', t => {
  const f = claudeFixture(t, new Set([101]));
  f.log('cli-open', NOW - HOUR);
  f.log('cli-dead', NOW - HOUR);
  f.log('sdk', NOW - HOUR, 'hi', { entrypoint: 'sdk-cli' });
  f.log('legacy', NOW - HOUR, 'hi', {});
  f.pidFile(101, 'cli-open');
  f.pidFile(102, 'cli-dead');
  f.watcher.tick();
  const by = Object.fromEntries(f.watcher.sessions().map(s => [s.id, s]));
  assert.equal(by['cli-open'].open, true);
  assert.equal(by['cli-dead'].open, false);
  assert.equal(by.sdk.open, undefined);
  assert.equal(by.legacy.open, undefined);
});

test('a reused pid (procStart mismatch) counts as closed; matching or missing procStart stays open', t => {
  const T = 'Mon Nov  2 07:16:10 2026';
  const f = claudeFixture(t, new Set([101, 102, 103]), { 101: T, 102: 'Tue Nov  3 01:00:00 2026', 103: T });
  for (const id of ['same', 'reused', 'nostart']) f.log(id, NOW - HOUR);
  f.pidFile(101, 'same', T);
  f.pidFile(102, 'reused', T);
  f.pidFile(103, 'nostart');
  f.watcher.tick();
  const by = Object.fromEntries(f.watcher.sessions().map(s => [s.id, s]));
  assert.equal(by.same.open, true);
  assert.equal(by.reused.open, false);
  assert.equal(by.nostart.open, true);
});

test('a sidechain user line does not move promptAt', () => {
  const { newSession, applyClaude } = require('../src/parsers');
  const s = newSession('claude', 'x', '/x.jsonl');
  const line = (isSidechain, at) => ({ type: 'user', isSidechain, timestamp: new Date(at).toISOString(), message: { content: 'p' } });
  applyClaude(s, line(false, NOW - 2 * HOUR));
  applyClaude(s, line(true, NOW - HOUR));
  assert.equal(s.promptAt, NOW - 2 * HOUR);
});
