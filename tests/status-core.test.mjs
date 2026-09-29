import test from 'node:test';
import assert from 'node:assert/strict';
import { changeTemplates, createStatusController, gameIdFromAppId, hasUnsavedTemplateEdit, initialStatusText, loadProfileAvatar, mergeManualCleanup, parseSteamMiniProfile, resetPluginState, staticAvatarFallback, validateStatus } from '../src/status-core.mjs';

test('Steam miniprofile provides animated avatar, frame, static fallback and nickname', () => {
  const data = JSON.stringify({
    persona_name: 'Blue-Flag',
    avatar_url: 'https://avatars.fastly.steamstatic.com/avatar_full.jpg',
    animated_avatar: 'https://shared.fastly.steamstatic.com/community_assets/images/items/1/animated.gif',
    avatar_frame: 'https://shared.fastly.steamstatic.com/community_assets/images/items/2/frame.png'
  });
  assert.deepEqual(parseSteamMiniProfile(data), {
    avatarUrl: 'https://shared.fastly.steamstatic.com/community_assets/images/items/1/animated.gif',
    avatarReducedUrl: 'https://avatars.fastly.steamstatic.com/avatar_full.jpg',
    frameUrl: 'https://shared.fastly.steamstatic.com/community_assets/images/items/2/frame.png',
    frameReducedUrl: '', personaName: 'Blue-Flag'
  });
  assert.equal(parseSteamMiniProfile('{invalid'), null);
  assert.equal(parseSteamMiniProfile(JSON.stringify({ avatar_url: 'javascript:alert(1)' })), null);
  assert.equal(parseSteamMiniProfile(JSON.stringify({ animated_avatar: 'https://evil.example/avatar.gif' })), null);
});

test('broken animated avatar falls back to miniprofile static image once', () => {
  const assets = parseSteamMiniProfile(JSON.stringify({
    animated_avatar: 'https://shared.fastly.steamstatic.com/animated.gif',
    avatar_url: 'https://avatars.fastly.steamstatic.com/static.jpg',
    avatar_frame: 'https://shared.fastly.steamstatic.com/frame.png'
  }));
  const fallback = staticAvatarFallback(assets);
  assert.equal(fallback.avatarUrl, 'https://avatars.fastly.steamstatic.com/static.jpg');
  assert.equal(fallback.avatarReducedUrl, '');
  assert.equal(fallback.frameUrl, assets.frameUrl);
  assert.equal(staticAvatarFallback(fallback), null);
});

test('startup text uses this account’s last applied name, then the selected template', () => {
  const config = { SelectedProfile: 'second', Profiles: [{ Id: 'first', Text: '模板一' }, { Id: 'second', Text: '模板二' }] };
  const records = { '123': { name: '上次状态' }, '456': { name: '其他账号状态' } };
  assert.equal(initialStatusText(config, records, 123), '上次状态');
  assert.equal(initialStatusText(config, records, 789), '模板二');
  assert.equal(initialStatusText(config, { '123': { name: 42 } }, 123), '模板二');
  assert.equal(initialStatusText(config, { '123': { name: 'x'.repeat(81) } }, 123), '模板二');
});

test('restored last status does not count as an unsaved template edit', () => {
  assert.equal(hasUnsavedTemplateEdit('上次状态', '上次状态', '当前模板'), false);
  assert.equal(hasUnsavedTemplateEdit('新输入', '上次状态', '当前模板'), true);
  assert.equal(hasUnsavedTemplateEdit('当前模板', '上次状态', '当前模板'), false);
});

test('avatar loading prefers direct miniprofile and falls back only to backend miniprofile', async () => {
  const data = JSON.stringify({ animated_avatar: 'https://shared.fastly.steamstatic.com/animated.gif' });
  const calls = [];
  const direct = await loadProfileAvatar({
    directMini: async () => { calls.push('direct'); return data; },
    backendMini: async () => { calls.push('backend'); return data; }
  });
  assert.deepEqual(calls, ['direct']);
  assert.ok(direct.assets?.avatarUrl.endsWith('/animated.gif'));
  const failed = await loadProfileAvatar({
    directMini: async () => { calls.push('direct-fail'); throw new Error('CORS'); },
    backendMini: async () => { calls.push('backend-fail'); throw new Error('Timeout'); }
  });
  assert.equal(failed.assets, null);
  assert.deepEqual(calls.slice(1), ['direct-fail', 'backend-fail']);
  assert.match(failed.failures.join(' '), /CORS.*Timeout/);
});

test('invalid direct data can still use the backend miniprofile', async () => {
  const json = JSON.stringify({ avatar_url: 'https://avatars.fastly.steamstatic.com/avatar.jpg' });
  const result = await loadProfileAvatar({
    directMini: async () => '{}', backendMini: async () => json
  });
  assert.equal(result.assets?.avatarUrl, 'https://avatars.fastly.steamstatic.com/avatar.jpg');
});

test('slow direct avatar request can be overtaken by a fast backend fallback', async () => {
  const calls = [];
  let releaseDirect;
  const direct = new Promise((resolve) => { releaseDirect = resolve; });
  const result = await loadProfileAvatar({
    directMini: () => { calls.push('direct'); return direct; },
    backendMini: () => {
      calls.push('backend');
      return JSON.stringify({ avatar_url: 'https://avatars.fastly.steamstatic.com/fallback.jpg' });
    },
    hedgeDelayMs: 0
  });
  assert.deepEqual(calls, ['direct', 'backend']);
  assert.equal(result.assets.avatarUrl, 'https://avatars.fastly.steamstatic.com/fallback.jpg');
  releaseDirect('{}');
});

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

test('legacy rename-only record gets one verified refresh, then same-name apply is a no-op', async () => {
  const f = fake();
  await f.controller.apply(f.input);
  f.records.set('123', { ...f.records.get('123'), needsRefresh: true });
  const before = f.calls.length;
  await f.controller.apply(f.input);
  assert.deepEqual(f.calls.slice(before), [
    ['stop-runner'], ['stop', gameIdFromAppId(f.id)],
    ['exe', f.id, 'SteamStatusRunner.exe'], ['dir', f.id, 'runner'],
    ['options', f.id, ''], ['run', gameIdFromAppId(f.id)]
  ]);
  assert.equal(f.records.get('123').needsRefresh, undefined);
  const after = f.calls.length;
  await f.controller.apply(f.input);
  assert.equal(f.calls.length, after);
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

test('an out-of-range saved shortcut ID never reaches Steam APIs', async () => {
  const f = fake();
  const invalidId = 4294967296;
  f.records.set('123', { id: invalidId, name: '阅读中', runner: true });
  f.overviews.set(invalidId, { app_type: 1073741824, display_name: '阅读中', local_per_client_data: { display_status: 4 } });
  await assert.rejects(f.controller.apply(f.input), /记录损坏/);
  await assert.rejects(f.controller.stop('123'), /记录损坏/);
  await assert.rejects(f.controller.remove('123'), /记录损坏/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.records.has('123'), true);
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
  f.overviews.set(123456, { app_type: 1, display_name: 'Other game', local_per_client_data: { display_status: 4 } });
  f.runner.isActive = async () => false;
  await assert.rejects(f.controller.apply(f.input), /运行程序未能启动/);
  assert.equal(f.calls.filter(([operation]) => operation === 'run').length, 1);
  assert.deepEqual(f.calls.slice(-1), [['stop', gameIdFromAppId(f.id)]]);
  assert.equal(f.overviews.get(f.id).local_per_client_data.display_status, 9);
  assert.equal(f.overviews.get(123456).local_per_client_data.display_status, 4);
});

test('a partially successful RunGame failure stops only the owned shortcut', async () => {
  const f = fake();
  f.apps.RunGame = async (gameId) => {
    f.calls.push(['run', gameId]);
    f.overviews.get(f.id).local_per_client_data.display_status = 4;
    throw new Error('Steam launch failed');
  };
  await assert.rejects(f.controller.apply(f.input), /Steam launch failed/);
  assert.deepEqual(f.calls.slice(-2), [['run', gameIdFromAppId(f.id)], ['stop', gameIdFromAppId(f.id)]]);
  assert.equal(f.records.get('123').id, f.id);
});

test('failed launch cleanup reports the remaining running shortcut', async () => {
  const f = fake();
  f.runner.isActive = async () => false;
  f.apps.TerminateApp = async () => { throw new Error('Steam refused termination'); };
  await assert.rejects(f.controller.apply(f.input), /自动停止专用条目失败：Steam refused termination/);
  assert.equal(f.overviews.get(f.id).local_per_client_data.display_status, 4);
  assert.equal(f.records.get('123').id, f.id);
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

test('a second controller reads the shared record instead of creating another shortcut', async () => {
  const f = fake();
  const second = createStatusController({
    apps: f.apps, appStore: { GetAppOverviewByAppID: (id) => f.overviews.get(id) },
    storage: f.storage, runner: f.runner, sleep: async () => {}
  });
  await f.controller.apply(f.input);
  await second.apply(f.input);
  assert.equal(f.calls.filter(([operation]) => operation === 'add').length, 1);
});

test('a competing shortcut record is preserved when the new ID cannot be claimed', async () => {
  const f = fake();
  f.storage.set = async (account) => {
    f.records.set(account, { id: 3600000000, name: '另一窗口的状态', runner: true });
    throw new Error('A different shortcut is already recorded for this account');
  };
  await assert.rejects(f.controller.apply(f.input), /different shortcut/);
  assert.equal(f.records.get('123').id, 3600000000);
  assert.deepEqual(f.calls, [['add', '阅读中'], ['remove', f.id]]);
});

test('a failed record write removes the newly-created shortcut', async () => {
  const f = fake();
  f.storage.set = async () => { throw new Error('disk full'); };
  await assert.rejects(f.controller.apply(f.input), /disk full/);
  assert.deepEqual(f.calls, [['add', '阅读中'], ['remove', f.id]]);
  assert.equal(f.overviews.has(f.id), false);
});

test('failed cleanup after a record write error reports the orphaned shortcut ID', async () => {
  const f = fake();
  f.storage.set = async () => { throw new Error('disk full'); };
  f.apps.RemoveShortcut = async (id) => { f.calls.push(['remove', id]); throw new Error('Steam refused deletion'); };
  await assert.rejects(f.controller.apply(f.input), (error) => {
    assert.match(error.message, /disk full/);
    assert.match(error.message, /Steam refused deletion/);
    assert.match(error.message, new RegExp(`App ID ${f.id}`));
    return true;
  });
  assert.deepEqual(f.calls, [['add', '阅读中'], ['remove', f.id]]);
  assert.equal(f.records.has('123'), false);
  assert.equal(f.overviews.has(f.id), true);
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
  assert.throws(() => changeTemplates(config, { type: 'add', id: 'c', text: ' 阅读 ' }), /相同文字/);
  assert.throws(() => changeTemplates(config, { type: 'save', id: 'a', text: '听音乐' }), /相同文字/);
  assert.throws(() => changeTemplates(config, { type: 'save', id: 'a', text: 'x'.repeat(81) }), /80/);
  assert.throws(() => changeTemplates({ Profiles: Array.from({ length: 100 }, (_, i) => ({ Id: String(i), Text: '状态' })) }, { type: 'add', id: 'new', text: '新状态' }), /100/);
});

test('manual cleanup reports survive later resets without accumulating duplicates', () => {
  const old = { account: '123', id: 3500000000, name: '旧状态', reason: 'Steam refused' };
  const updated = { ...old, reason: '请手动移除' };
  const other = { account: '456', id: 3600000000, reason: '请切换账号' };
  assert.deepEqual(mergeManualCleanup([old], [updated, other]), [updated, other]);
  assert.deepEqual(mergeManualCleanup([old], []), [old]);
  assert.deepEqual(mergeManualCleanup({}, [{ account: '123', id: null, name: null, reason: null }]), [
    { account: '123', reason: '原因未知，请检查 Steam 库' }
  ]);
  assert.deepEqual(mergeManualCleanup([], [{ account: '123', id: 3500000000, name: '状态', reason: '请手动删除' }]), [
    { account: '123', reason: '请手动删除', id: 3500000000, name: '状态' }
  ]);
  const [unicode] = mergeManualCleanup([], [{ account: '123', name: '状态😀'.repeat(200), reason: '请手动检查😀'.repeat(200) }]);
  assert.ok(Buffer.byteLength(unicode.name, 'utf8') <= 400);
  assert.ok(Buffer.byteLength(unicode.reason, 'utf8') <= 500);
  assert.ok(!unicode.name.includes('\ufffd'));
  assert.ok(!unicode.reason.includes('\ufffd'));
});

test('full reset removes only the current account shortcut before clearing plugin data', async () => {
  const calls = [];
  const result = await resetPluginState({
    accountId: '123',
    records: { '123': { id: 3500000000, name: '我的状态' }, '456': { id: 3600000000, name: '另一账号' } },
    removeOwned: async (account) => { calls.push(['remove', account]); },
    stopRunner: async () => { calls.push(['stop-runner']); },
    resetData: async (manual) => { calls.push(['reset-data', manual]); return { config: { Profiles: [] }, shortcutIds: {} }; }
  });
  const expectedManual = [{ account: '456', id: 3600000000, name: '另一账号', reason: '请切换到此账号后手动删除' }];
  assert.deepEqual(calls, [['remove', '123'], ['stop-runner'], ['reset-data', expectedManual]]);
  assert.deepEqual(result.manual, expectedManual);
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
