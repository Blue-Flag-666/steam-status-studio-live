const SHORTCUT_FLAG = 1073741824;
const RUNNING = 4;

// Steam's launch/terminate calls use the 64-bit non-Steam game ID, not the
// 32-bit shortcut App ID returned by AddShortcut.
export function gameIdFromAppId(appId) {
  if (!Number.isInteger(appId) || appId < 2147483648 || appId > 4294967295) {
    throw new Error('无效的非 Steam 条目 ID。');
  }
  return ((BigInt(appId) << 32n) | 0x02000000n).toString();
}

export function validateStatus(text) {
  if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 80 || /[\u0000-\u001f]/u.test(text)) {
    throw new Error('状态文字须为 1–80 个字符，且不能包含换行或控制字符。');
  }
  return text.trim();
}

export function changeTemplates(config, change) {
  const profiles = config?.Profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) throw new Error('没有可用的状态模板。');
  const index = profiles.findIndex((profile) => profile.Id === change.id);

  if (change.type === 'select') {
    if (index < 0) throw new Error('所选模板不存在。');
    return { Profiles: profiles, SelectedProfile: change.id };
  }
  if (change.type === 'save') {
    if (index < 0) throw new Error('当前模板不存在。');
    const text = validateStatus(change.text);
    return {
      Profiles: profiles.map((profile) => profile.Id === change.id ? { ...profile, Text: text } : profile),
      SelectedProfile: change.id
    };
  }
  if (change.type === 'add') {
    if (profiles.length >= 100) throw new Error('最多只能保存 100 个模板。');
    if (!change.id || profiles.some((profile) => profile.Id === change.id)) throw new Error('新模板 ID 无效。');
    return {
      Profiles: [...profiles, { Id: change.id, Text: validateStatus(change.text), CreatedAt: change.createdAt }],
      SelectedProfile: change.id
    };
  }
  if (change.type === 'delete') {
    if (index < 0) throw new Error('当前模板不存在。');
    if (profiles.length <= 1) throw new Error('至少保留一个模板。');
    const remaining = profiles.filter((profile) => profile.Id !== change.id);
    return { Profiles: remaining, SelectedProfile: remaining[Math.min(index, remaining.length - 1)].Id };
  }
  throw new Error('未知的模板操作。');
}

export async function resetPluginState({ accountId, records, removeOwned, stopRunner, resetData }) {
  const manual = [];
  if (records && typeof records === 'object') {
    for (const [key, record] of Object.entries(records)) {
      if (key !== accountId) manual.push({ account: key, id: record?.id, name: record?.name, reason: '请切换到此账号后手动删除' });
    }
    if (accountId && Object.prototype.hasOwnProperty.call(records, accountId)) {
      const record = records[accountId];
      try {
        if (!record || typeof record !== 'object') throw new Error('条目记录损坏，无法安全自动删除');
        await removeOwned(accountId);
      } catch (error) {
        manual.push({ account: accountId, id: record?.id, name: record?.name,
          reason: error instanceof Error ? error.message : String(error) });
      }
    }
  } else {
    manual.push({ account: accountId || '未知', reason: '原有记录无法读取，无法确认是否存在专用状态条目' });
  }
  try {
    await stopRunner();
  } catch (error) {
    manual.push({ account: accountId || '未知', reason: `后台进程未能停止，请从系统托盘手动退出：${error instanceof Error ? error.message : String(error)}` });
  }
  const data = await resetData();
  return { data, manual };
}

export function createStatusController({ apps, appStore, storage, runner, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  function requireApi(...names) {
    for (const name of names) {
      if (typeof apps?.[name] !== 'function') throw new Error(`Steam 内部接口不可用：Apps.${name}`);
    }
    if (typeof appStore?.GetAppOverviewByAppID !== 'function') {
      throw new Error('Steam 应用列表接口不可用，未执行任何修改。');
    }
    if (typeof runner?.isActive !== 'function' || typeof runner?.requestStop !== 'function') {
      throw new Error('状态运行程序检测接口不可用，未执行任何修改。');
    }
  }

  function overview(id) {
    return appStore.GetAppOverviewByAppID(id) ?? null;
  }

  function running(id) {
    const data = overview(id)?.local_per_client_data;
    if (!data || typeof data.display_status !== 'number') {
      throw new Error('无法确认专用状态条目的运行状态，已停止操作。');
    }
    return data.display_status === RUNNING;
  }

  async function runnerActive() {
    if (await runner.isActive()) return true;
    // The heartbeat file may be observed during its short write window.
    await sleep(100);
    return Boolean(await runner.isActive());
  }

  async function waitFor(predicate, message, attempts = 40) {
    for (let i = 0; i < attempts; i += 1) {
      if (await predicate()) return;
      await sleep(250);
    }
    throw new Error(message);
  }

  function ownedOverview(record) {
    const data = overview(record.id);
    if (!data || (data.app_type & SHORTCUT_FLAG) === 0 || data.display_name !== record.name) {
      throw new Error('已记录的条目不存在或名称被外部修改；为避免误操作其他游戏，已停止。');
    }
    return data;
  }

  async function getOwned(accountId) {
    const record = await storage.get(accountId);
    if (!record) return null;
    if (!Number.isInteger(record.id) || record.id < 2147483648 || typeof record.name !== 'string') {
      throw new Error('专用状态条目记录损坏；为避免误操作其他游戏，已停止。');
    }
    // A missing overview can also mean Steam has not finished loading its library.
    // Never discard an owned ID on a timeout: doing so can create duplicates.
    for (let i = 0; i < 40 && !overview(record.id); i += 1) {
      await sleep(250);
    }
    if (!overview(record.id)) {
      throw new Error('暂时找不到已记录的状态条目；请等待 Steam 库加载完成后重试。记录已保留，未创建重复条目。');
    }
    ownedOverview(record);
    return record;
  }

  async function stopOwned(record) {
    // Let the runner remove its heartbeat before Steam can terminate it.
    // A forced termination leaves a fresh but orphaned heartbeat and makes
    // each status switch wait for the heartbeat expiry window.
    if (record.runner === true && await runnerActive()) {
      await runner.requestStop();
      await waitFor(async () => !await runnerActive(), '后台状态进程未能退出；已停止切换，避免留下多个任务。', 40);
    }
    if (running(record.id)) {
      await apps.TerminateApp(gameIdFromAppId(record.id), false);
      await waitFor(() => !running(record.id), '专用状态条目未能停止；Steam 客户端未重启。');
    }
  }

  async function apply({ accountId, text, executable, startDir, launchOptions }) {
    const name = validateStatus(text);
    requireApi('AddShortcut', 'SetShortcutName', 'SetShortcutExe', 'SetShortcutStartDir', 'SetShortcutLaunchOptions', 'TerminateApp', 'RunGame');
    if (!accountId || !/^[0-9]+$/u.test(String(accountId))) throw new Error('无法确定当前 Steam 账号。');
    if (!executable || !startDir || typeof launchOptions !== 'string') throw new Error('状态运行程序未安装。');

    let record = await getOwned(accountId);
    if (!record) {
      const id = await apps.AddShortcut(name, executable, startDir, launchOptions);
      if (!Number.isInteger(id) || id < 2147483648 || id > 4294967295) {
        throw new Error('Steam 未返回有效的非 Steam 条目 ID。');
      }
      // Persist Steam's returned ID before waiting for its library index. A
      // delayed overview must not turn the next click into a second shortcut.
      record = { id, name, runner: true };
      try {
        await storage.set(accountId, record);
      } catch (error) {
        // This ID came directly from AddShortcut and has not been launched.
        // Do not strand an unrecorded shortcut if persistence fails.
        if (typeof apps.RemoveShortcut === 'function') {
          try { await apps.RemoveShortcut(id); } catch { /* Preserve the storage failure. */ }
        }
        throw error;
      }
      await waitFor(() => overview(id), 'Steam 尚未注册新状态条目；App ID 已保存，请稍后重试，勿重复创建。');
      const data = overview(id);
      if ((data.app_type & SHORTCUT_FLAG) === 0) throw new Error('Steam 返回的条目并非非 Steam 快捷方式。');
      if (data.display_name !== name) {
        await apps.SetShortcutName(id, name);
        await waitFor(() => overview(id)?.display_name === name, 'Steam 未确认状态名称更新。');
      }
    } else {
      // A confirmed current runner with the same visible name needs no refresh.
      // Older records must still pass through migration away from PowerShell.
      if (record.name === name && record.runner === true && record.needsRefresh !== true && running(record.id) && await runnerActive()) return record;
      // Renaming a running shortcut can change Steam's overview before the
      // process is actually gone. Stop it while the old name/state is intact.
      await stopOwned(record);
      if (record.name !== name) {
        const previous = record;
        await apps.SetShortcutName(record.id, name);
        await waitFor(() => overview(record.id)?.display_name === name, 'Steam 未确认状态名称更新。');
        const renamed = { ...record, name };
        try {
          await storage.set(accountId, renamed);
        } catch (error) {
          try {
            await apps.SetShortcutName(previous.id, previous.name);
            await waitFor(() => overview(previous.id)?.display_name === previous.name, '无法恢复原状态名称。');
          } catch {
            throw new Error('状态名称已修改，但条目记录保存与回滚均失败；请勿操作其他游戏条目。');
          }
          throw error;
        }
        record = renamed;
      }
      // Also migrates shortcuts created by older releases that launched PowerShell.
      await apps.SetShortcutExe(record.id, executable);
      await apps.SetShortcutStartDir(record.id, startDir);
      await apps.SetShortcutLaunchOptions(record.id, launchOptions);
      if (record.runner !== true) {
        record = { ...record, runner: true };
        await storage.set(accountId, record);
      }
    }

    await apps.RunGame(gameIdFromAppId(record.id), '', -1, 100);
    await waitFor(() => running(record.id), '状态条目未启动；请检查 Steam 库中的该条目。', 60);
    await waitFor(() => runnerActive(), '状态运行程序未能启动；请检查安装的 SteamStatusRunner.exe。', 60);
    if (record.needsRefresh === true) {
      record = { ...record, needsRefresh: false };
      await storage.set(accountId, record);
    }
    return record;
  }

  async function renameOnly({ accountId, text }) {
    const name = validateStatus(text);
    requireApi('SetShortcutName');
    const record = await getOwned(accountId);
    if (!record || record.runner !== true || !running(record.id) || !await runnerActive()) {
      throw new Error('专用状态条目尚未运行；请先使用“保存并应用”。');
    }
    if (record.name === name) return record;
    await apps.SetShortcutName(record.id, name);
    await waitFor(() => overview(record.id)?.display_name === name, 'Steam 未确认状态名称更新。');
    const renamed = { ...record, name, needsRefresh: true };
    try {
      await storage.set(accountId, renamed);
    } catch (error) {
      try {
        await apps.SetShortcutName(record.id, record.name);
        await waitFor(() => overview(record.id)?.display_name === record.name, '无法恢复原状态名称。');
      } catch {
        throw new Error('状态名称已修改，但条目记录保存与回滚均失败；请勿操作其他游戏条目。');
      }
      throw error;
    }
    return renamed;
  }

  async function stop(accountId) {
    requireApi('TerminateApp');
    const record = await getOwned(accountId);
    if (!record) return false;
    await stopOwned(record);
    return true;
  }

  async function remove(accountId) {
    requireApi('TerminateApp', 'RemoveShortcut');
    const record = await getOwned(accountId);
    if (!record) return false;
    await stopOwned(record);
    await apps.RemoveShortcut(record.id);
    await waitFor(() => !overview(record.id), 'Steam 未确认删除专用状态条目。');
    await storage.clear(accountId);
    return true;
  }

  return { apply, renameOnly, stop, remove };
}
