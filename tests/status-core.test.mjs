import test from 'node:test';
import assert from 'node:assert/strict';
import { changeTemplates, createStatusController, gameIdFromAppId, resetPluginState, validateStatus } from '../src/status-core.mjs';

function fake() {
  const calls = [];
  const records = new Map();
  const overviews = new Map();
  let runnerActive = false;
  const id = 3500000000;
  const apps = {
    AddShortcut: async (name) => {
      calls.push(['add', name]);
      overviews.set(id, { app_type: 1073741824, display_name: name, local_per_client_data: { display_status: 9 } });
      return id;
    },
    SetShortcutName: (appId, name) => { calls.push(['rename', appId, name]); overviews.get(appId).display_name = name; },
    SetShortcutExe: (appId, path) => { calls.push(['exe', appId, path]); },
    SetShortcutStartDir: (appId, path) => { calls.push(['dir', appId, path]); },
    SetShortcutLaunchOptions: (appId, options) => { calls.push(['options', appId, options]); },
    TerminateApp: (gameId) => { calls.push(['stop', gameId]); overviews.get(Number(BigInt(gameId) >> 32n)).local_per_client_data.display_status = 9; runnerActive = false; },
    RunGame: (gameId) => { calls.push(['run', gameId]); overviews.get(Number(BigInt(gameId) >> 32n)).local_per_client_data.display_status = 4; runnerActive = true; },
    RemoveShortcut: (appId) => { calls.push(['remove', appId]); overviews.delete(appId); }
  };
  const storage = {
    get: async (account) => records.get(account),
    set: async (account, record) => records.set(account, record),
    clear: async (account) => records.delete(account)
  };
  const appStore = { GetAppOverviewByAppID: (appId) => overviews.get(appId) };
  const runner = { isActive: async () => runnerActive, requestStop: async () => { calls.push(['stop-runner']); runnerActive = false; } };
  const controller = createStatusController({ apps, appStore, storage, runner, sleep: async () => {} });
  const input = { accountId: '123', text: '阅读中', executable: 'SteamStatusRunner.exe', startDir: 'runner', launchOptions: '' };
  return { calls, records, overviews, apps, runner, storage, controller, input, id, setRunnerActive: (value) => { runnerActive = value; } };
}

test('creates once, switches by stopping only its own shortcut', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  await f.controller.apply({ ...f.input, text: '听音乐 🎵' });
  assert.deepEqual(f.calls, [
    ['add', '阅读中'], ['run', gameIdFromAppId(f.id)],
    ['stop-runner'], ['stop', gameIdFromAppId(f.id)], ['rename', f.id, '听音乐 🎵'],
    ['exe', f.id, 'SteamStatusRunner.exe'], ['dir', f.id, 'runner'], ['options', f.id, ''],
    ['run', gameIdFromAppId(f.id)]
  ]);
});

test('reapplying the same running status keeps the runner and shortcut untouched', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  const callsBefore = f.calls.length;
  await f.controller.apply(f.input);
  assert.equal(f.calls.length, callsBefore);
  assert.equal(f.records.get('123').runner, true);
});

test('experimental rename keeps the runner, and ordinary apply can force a verified refresh', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  const before = f.calls.length;
  await f.controller.renameOnly({ accountId: '123', text: '听音乐 🎵' });
  assert.deepEqual(f.calls.slice(before), [['rename', f.id, '听音乐 🎵']]);
  assert.equal(f.records.get('123').needsRefresh, true);
  assert.equal(f.overviews.get(f.id).local_per_client_data.display_status, 4);
  await f.controller.apply({ ...f.input, text: '听音乐 🎵' });
  assert.deepEqual(f.calls.slice(before + 1), [
    ['stop-runner'], ['stop', gameIdFromAppId(f.id)],
    ['exe', f.id, 'SteamStatusRunner.exe'], ['dir', f.id, 'runner'],
    ['options', f.id, ''], ['run', gameIdFromAppId(f.id)]
  ]);
  assert.equal(f.records.get('123').needsRefresh, false);
});

test('experimental rename refuses a stopped shortcut and rolls back on storage failure', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  f.overviews.get(f.id).local_per_client_data.display_status = 9;
  await assert.rejects(f.controller.renameOnly({ accountId: '123', text: '新状态' }), /尚未运行/);
  assert.equal(f.calls.some(([operation]) => operation === 'rename'), false);
  f.overviews.get(f.id).local_per_client_data.display_status = 4;
  f.storage.set = async () => { throw new Error('disk full'); };
  await assert.rejects(f.controller.renameOnly({ accountId: '123', text: '新状态' }), /disk full/);
  assert.equal(f.overviews.get(f.id).display_name, '阅读中');
  assert.equal(f.records.get('123').name, '阅读中');
  assert.equal(f.calls.some(([operation]) => operation === 'stop'), false);
});

test('reapplying the same stopped status starts it again', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  f.overviews.get(f.id).local_per_client_data.display_status = 9;
  await f.controller.apply(f.input);
  assert.deepEqual(f.calls.slice(-4), [
    ['exe', f.id, 'SteamStatusRunner.exe'], ['dir', f.id, 'runner'],
    ['options', f.id, ''], ['run', gameIdFromAppId(f.id)]
  ]);
  assert.equal(f.calls.some(([operation]) => operation === 'stop'), false);
});

test('same-name older shortcut still migrates before reusing a runner', async () => {
  const f = fake();
  f.records.set('123', { id: f.id, name: '阅读中' });
  f.overviews.set(f.id, { app_type: 1073741824, display_name: '阅读中', local_per_client_data: { display_status: 4 } });
  await f.controller.apply(f.input);
  assert.deepEqual(f.calls, [
    ['stop', gameIdFromAppId(f.id)],
    ['exe', f.id, 'SteamStatusRunner.exe'], ['dir', f.id, 'runner'],
    ['options', f.id, ''], ['run', gameIdFromAppId(f.id)]
  ]);
  assert.equal(f.records.get('123').runner, true);
});

test('migrates an existing owned PowerShell shortcut without changing its App ID', async () => {
  const f = fake();
  f.records.set('123', { id: f.id, name: '旧状态' });
  f.overviews.set(f.id, { app_type: 1073741824, display_name: '旧状态', local_per_client_data: { display_status: 4 } });
  await f.controller.apply({ ...f.input, text: '新状态' });
  assert.equal(f.records.get('123').id, f.id);
  assert.equal(f.calls.some(([operation]) => operation === 'add'), false);
  assert.deepEqual(f.calls.slice(-4), [
    ['exe', f.id, 'SteamStatusRunner.exe'], ['dir', f.id, 'runner'], ['options', f.id, ''],
    ['run', gameIdFromAppId(f.id)]
  ]);
});

test('stop and remove touch only the recorded shortcut', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  await f.controller.stop('123');
  await f.controller.remove('123');
  assert.deepEqual(f.calls.slice(-2), [['stop', gameIdFromAppId(f.id)], ['remove', f.id]]);
  assert.equal(f.records.has('123'), false);
});

test('stop requests a graceful runner exit before terminating the Steam shortcut', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  f.apps.TerminateApp = (gameId) => {
    f.calls.push(['stop', gameId]);
    f.overviews.get(f.id).local_per_client_data.display_status = 9;
  };
  await f.controller.stop('123');
  assert.deepEqual(f.calls.slice(-2), [['stop-runner'], ['stop', gameIdFromAppId(f.id)]]);
});

test('graceful runner exit avoids redundant Steam termination when Steam already noticed it', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  f.runner.requestStop = async () => {
    f.calls.push(['stop-runner']);
    f.setRunnerActive(false);
    f.overviews.get(f.id).local_per_client_data.display_status = 9;
  };
  await f.controller.stop('123');
  assert.deepEqual(f.calls.slice(-1), [['stop-runner']]);
  assert.equal(f.calls.some(([operation]) => operation === 'stop'), false);
});

test('stop also cleans an orphan runner when Steam already reports stopped', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  f.overviews.get(f.id).local_per_client_data.display_status = 9;
  await f.controller.stop('123');
  assert.deepEqual(f.calls.slice(-1), [['stop-runner']]);
});

test('a missing runner heartbeat prevents a false successful launch', async () => {
  const f = fake();
  f.runner.isActive = async () => false;
  await assert.rejects(f.controller.apply(f.input), /运行程序未能启动/);
  assert.equal(f.calls.filter(([operation]) => operation === 'run').length, 1);
});

test('failed runner exit prevents rename and relaunch', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  f.apps.TerminateApp = (gameId) => {
    f.calls.push(['stop', gameId]);
    f.overviews.get(f.id).local_per_client_data.display_status = 9;
  };
  f.runner.requestStop = async () => { f.calls.push(['stop-runner']); };
  await assert.rejects(f.controller.apply({ ...f.input, text: '新状态' }), /后台状态进程未能退出/);
  assert.equal(f.calls.some(([operation]) => operation === 'rename'), false);
  assert.equal(f.calls.some(([operation]) => operation === 'stop'), false);
  assert.equal(f.calls.filter(([operation]) => operation === 'run').length, 1);
});

test('fails closed when recorded name is changed externally', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  f.overviews.get(f.id).display_name = 'Some other app';
  await assert.rejects(f.controller.apply({ ...f.input, text: '新状态' }), /避免误操作/);
  assert.equal(f.calls.some(([operation]) => operation === 'rename'), false);
});

test('does not create a duplicate when the owned shortcut is temporarily missing', async () => {
  const f = fake();
  f.records.set('123', { id: 3600000000, name: '旧状态' });
  f.overviews.set(123456, { app_type: 1, display_name: 'Other game' });
  await assert.rejects(f.controller.apply(f.input), /记录已保留/);
  assert.equal(f.records.get('123').id, 3600000000);
  assert.equal(f.overviews.get(123456).display_name, 'Other game');
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.controller.remove('123'), /记录已保留/);
  assert.equal(f.records.get('123').id, 3600000000);
});

test('missing API causes no changes; failed stop never relaunches or restarts Steam', async () => {
  const f = fake();
  f.apps.AddShortcut = undefined;
  await assert.rejects(f.controller.apply(f.input), /接口不可用/);
  assert.equal(f.calls.length, 0);
  const missingSetter = fake();
  missingSetter.apps.SetShortcutExe = undefined;
  await assert.rejects(missingSetter.controller.apply(missingSetter.input), /SetShortcutExe/);
  assert.equal(missingSetter.calls.length, 0);
  const g = fake();
  await g.controller.apply(g.input);
  g.apps.TerminateApp = () => {};
  await assert.rejects(g.controller.apply({ ...g.input, text: '新状态' }), /未能停止/);
  assert.equal(g.calls.filter(([operation]) => operation === 'run').length, 1);
  assert.equal(g.records.get('123').name, '阅读中');
  assert.equal(g.calls.some(([operation]) => operation === 'rename'), false);
});

test('shortcut creation failure leaves other apps and stored IDs untouched', async () => {
  const f = fake();
  f.overviews.set(123456, { app_type: 1, display_name: 'Other game' });
  f.apps.AddShortcut = async () => { throw new Error('Steam refused shortcut'); };
  await assert.rejects(f.controller.apply(f.input), /Steam refused shortcut/);
  assert.equal(f.records.size, 0);
  assert.equal(f.overviews.get(123456).display_name, 'Other game');
  assert.equal(f.calls.length, 0);
});

test('a slow Steam overview keeps the new ID so retry cannot duplicate it', async () => {
  const f = fake();
  f.apps.AddShortcut = async (name) => { f.calls.push(['add', name]); return f.id; };
  await assert.rejects(f.controller.apply(f.input), /App ID 已保存/);
  assert.equal(f.records.get('123').id, f.id);
  await assert.rejects(f.controller.apply(f.input), /记录已保留/);
  assert.deepEqual(f.calls, [['add', '阅读中']]);
});

test('a failed record write removes the newly-created shortcut', async () => {
  const f = fake();
  f.storage.set = async () => { throw new Error('disk full'); };
  await assert.rejects(f.controller.apply(f.input), /disk full/);
  assert.deepEqual(f.calls, [['add', '阅读中'], ['remove', f.id]]);
  assert.equal(f.overviews.has(f.id), false);
});

test('a failed record write after rename restores the prior name', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  f.storage.set = async () => { throw new Error('disk full'); };
  await assert.rejects(f.controller.apply({ ...f.input, text: '新状态' }), /disk full/);
  assert.equal(f.overviews.get(f.id).display_name, '阅读中');
  assert.equal(f.records.get('123').name, '阅读中');
  assert.equal(f.calls.filter(([operation]) => operation === 'run').length, 1);
});

test('validates Unicode and 80-character limit', () => {
  assert.equal(gameIdFromAppId(3309951712), '14216134354412765184');
  assert.equal(validateStatus(' 你好 🎮 '), '你好 🎮');
  assert.equal(Array.from(validateStatus('🎮'.repeat(80))).length, 80);
  assert.throws(() => validateStatus('a'.repeat(81)));
  assert.throws(() => validateStatus('a\nb'));
});

test('template edits preserve other entries and selection', () => {
  const config = { Profiles: [{ Id: 'a', Text: '阅读' }, { Id: 'b', Text: '听音乐' }], SelectedProfile: 'a' };
  const edited = changeTemplates(config, { type: 'save', id: 'b', text: '  玩游戏  ' });
  assert.deepEqual(edited, { Profiles: [{ Id: 'a', Text: '阅读' }, { Id: 'b', Text: '玩游戏' }], SelectedProfile: 'b' });
  assert.equal(config.Profiles[1].Text, '听音乐');
  assert.equal(changeTemplates(config, { type: 'select', id: 'b' }).SelectedProfile, 'b');
});

test('new and deleted templates select the expected entry', () => {
  const config = { Profiles: [{ Id: 'a', Text: '阅读' }, { Id: 'b', Text: '听音乐' }], SelectedProfile: 'a' };
  const added = changeTemplates(config, { type: 'add', id: 'c', text: '  新状态  ', createdAt: 'now' });
  assert.equal(added.SelectedProfile, 'c');
  assert.deepEqual(added.Profiles[2], { Id: 'c', Text: '新状态', CreatedAt: 'now' });
  const deleted = changeTemplates(added, { type: 'delete', id: 'b' });
  assert.deepEqual(deleted.Profiles.map((item) => item.Id), ['a', 'c']);
  assert.equal(deleted.SelectedProfile, 'c');
  assert.equal(changeTemplates(deleted, { type: 'delete', id: 'c' }).SelectedProfile, 'a');
  assert.throws(() => changeTemplates({ Profiles: [{ Id: 'a', Text: '阅读' }] }, { type: 'delete', id: 'a' }), /至少保留/);
  assert.throws(() => changeTemplates(config, { type: 'add', id: 'a', text: '重复' }), /ID/);
  assert.throws(() => changeTemplates(config, { type: 'save', id: 'a', text: 'x'.repeat(81) }), /80/);
  assert.throws(() => changeTemplates({ Profiles: Array.from({ length: 100 }, (_, i) => ({ Id: String(i), Text: '状态' })) }, { type: 'add', id: 'new', text: '新状态' }), /100/);
});

test('full reset removes only the current account shortcut before clearing plugin data', async () => {
  const calls = [];
  const result = await resetPluginState({
    accountId: '123',
    records: { '123': { id: 3500000000, name: '我的状态' }, '456': { id: 3600000000, name: '另一账号' } },
    removeOwned: async (account) => { calls.push(['remove', account]); },
    stopRunner: async () => { calls.push(['stop-runner']); },
    resetData: async () => { calls.push(['reset-data']); return { config: { Profiles: [] }, shortcutIds: {} }; }
  });
  assert.deepEqual(calls, [['remove', '123'], ['stop-runner'], ['reset-data']]);
  assert.deepEqual(result.manual, [{ account: '456', id: 3600000000, name: '另一账号', reason: '请切换到此账号后手动删除' }]);
});

test('full reset still clears plugin data and reports manual cleanup when shortcut deletion fails', async () => {
  const calls = [];
  const result = await resetPluginState({
    accountId: '123', records: { '123': { id: 3500000000, name: '原状态' } },
    removeOwned: async () => { calls.push('remove'); throw new Error('Steam refused'); },
    stopRunner: async () => { calls.push('stop-runner'); },
    resetData: async () => { calls.push('reset-data'); return {}; }
  });
  assert.deepEqual(calls, ['remove', 'stop-runner', 'reset-data']);
  assert.deepEqual(result.manual, [{ account: '123', id: 3500000000, name: '原状态', reason: 'Steam refused' }]);
  const missing = await resetPluginState({
    accountId: '123', records: null,
    removeOwned: async () => { throw new Error('must not run'); },
    stopRunner: async () => { throw new Error('exit timeout'); },
    resetData: async () => ({})
  });
  assert.match(missing.manual[0].reason, /无法读取/);
  assert.match(missing.manual[1].reason, /后台进程未能停止/);
  const malformed = await resetPluginState({
    accountId: '123', records: { '123': null, '456': null },
    removeOwned: async () => { throw new Error('must not run'); },
    stopRunner: async () => {}, resetData: async () => ({})
  });
  assert.equal(malformed.manual.length, 2);
  assert.match(malformed.manual.find((item) => item.account === '123').reason, /记录损坏/);
});

test('full reset reports a data-write failure instead of claiming success', async () => {
  await assert.rejects(resetPluginState({
    accountId: '123', records: {},
    removeOwned: async () => { throw new Error('must not run'); },
    stopRunner: async () => {},
    resetData: async () => { throw new Error('disk full'); }
  }), /disk full/);
});
