import React, { useEffect, useState } from 'react';
import { definePlugin } from 'millennium';
import { changeTemplates, createStatusController, resetPluginState, validateStatus } from './status-core.mjs';

declare const backend: {
  getBootstrap(): Promise<Bootstrap>;
  saveTemplates(json: string): Promise<Config>;
  setShortcutId(account: string, id: number, name: string, runner: boolean, needsRefresh: boolean): Promise<boolean>;
  clearShortcutId(account: string): Promise<boolean>;
  isRunnerActive(): Promise<boolean>;
  requestRunnerStop(): Promise<boolean>;
  resetPluginData(): Promise<{ config: Config; shortcutIds: { [account: string]: ShortcutRecord } }>;
};

type Profile = { Id: string; Text: string; CreatedAt?: string };
type Config = { Profiles: Profile[]; SelectedProfile: string; [key: string]: unknown };
type ShortcutRecord = { id: number; name: string; runner?: boolean; needsRefresh?: boolean };
type Bootstrap = {
  config: Config;
  shortcutIds: { [account: string]: ShortcutRecord };
  runnerReady: boolean;
  executable: string;
  startDir: string;
  launchOptions: string;
};
type Notice = { kind: 'info' | 'success' | 'error'; text: string };
type ManualCleanup = { account: string; id?: number; name?: string; reason?: string };

const css = `
  .sss { box-sizing:border-box; max-width:680px; margin:auto; padding:22px 18px 30px; color:#dce6f1; font-family:inherit; }
  .sss * { box-sizing:border-box; }
  .sss header { display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px; margin-bottom:20px; }
  .sss-eyebrow { margin:0 0 5px; color:#69b8ed; font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
  .sss h2 { margin:0; color:#fff; font-size:24px; line-height:1.25; }
  .sss-subtitle { margin:7px 0 0; color:#9dacc0; font-size:13px; line-height:1.5; }
  .sss-account { max-width:100%; padding:7px 10px; border:1px solid #394a5f; border-radius:20px; background:#223044; color:#b6c8da; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sss-card { margin-top:14px; padding:19px; border:1px solid #394b60; border-radius:13px; background:linear-gradient(145deg,#233145,#1b2736); box-shadow:0 8px 22px #0002; }
  .sss-card-head { display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:16px; }
  .sss h3 { margin:0; color:#f3f8ff; font-size:16px; }
  .sss-muted { color:#96aabd; font-size:12px; }
  .sss label { display:block; margin-bottom:8px; color:#cbd8e6; font-size:12px; font-weight:600; }
  .sss-input,.sss-select { width:100%; height:44px; border:1px solid #536a82; border-radius:9px; background:#111c2b; color:#f4f8fd; font:inherit; font-size:15px; outline:none; transition:border-color .15s,box-shadow .15s; }
  .sss-input { padding:0 14px; }
  .sss-input::placeholder { color:#8396aa; }
  .sss-input:hover,.sss-select:hover { border-color:#7e9bb8; }
  .sss-input:focus,.sss-select:focus { border-color:#73c3f4; box-shadow:0 0 0 3px #65b8ef33; }
  .sss-input.sss-invalid { border-color:#de8484; }
  .sss-select-wrap { position:relative; }
  .sss-select { appearance:none; padding:0 38px 0 14px; cursor:pointer; }
  .sss-select-wrap::after { content:'⌄'; position:absolute; top:6px; right:13px; color:#b2c7dc; font-size:24px; pointer-events:none; }
  .sss-select option { background:#1b2736; }
  .sss-input-meta { display:flex; justify-content:space-between; gap:12px; min-height:22px; margin-top:7px; color:#94a9bd; font-size:12px; }
  .sss-warning { color:#f0ad91; }
  .sss-preview { display:flex; gap:12px; align-items:center; margin-top:14px; padding:13px 14px; border:1px solid #345c78; border-radius:9px; background:#28628725; }
  .sss-dot { flex:none; width:8px; height:8px; border-radius:50%; background:#72ca90; box-shadow:0 0 0 4px #72ca9024; }
  .sss-preview small { display:block; margin-bottom:3px; color:#8eb2ce; font-size:11px; }
  .sss-preview strong { color:#edf7ff; font-size:14px; font-weight:500; overflow-wrap:anywhere; }
  .sss-actions { display:flex; flex-wrap:wrap; gap:9px; margin-top:17px; }
  .sss-button { min-height:38px; padding:8px 14px; border:1px solid #59738f; border-radius:8px; background:#2c4056; color:#e9f2fb; font:inherit; font-size:13px; font-weight:600; cursor:pointer; transition:background .15s,border-color .15s; }
  .sss-button:hover:not(:disabled) { background:#3a536c; border-color:#86abc9; }
  .sss-button:focus-visible { outline:2px solid #8bcfff; outline-offset:2px; }
  .sss-button:disabled { opacity:.43; cursor:not-allowed; }
  .sss-primary { border-color:#6ec0f1; background:linear-gradient(#4eafe8,#247bb8); color:white; }
  .sss-primary:hover:not(:disabled) { background:linear-gradient(#68bfef,#348fca); }
  .sss-quiet { background:transparent; border-color:#435a73; color:#c0d1e2; }
  .sss-danger { background:#9b4b4b24; border-color:#925f65; color:#f2c0c0; }
  .sss-note { margin:12px 0 0; color:#91a6bb; font-size:12px; line-height:1.5; }
  .sss-confirm { margin-top:13px; padding:13px; border:1px solid #946e62; border-radius:9px; background:#a05d4824; color:#f1c9bd; font-size:12px; line-height:1.5; }
  .sss-confirm .sss-actions { margin-top:10px; }
  .sss-notice { margin-top:16px; padding:11px 13px; border:1px solid #416684; border-radius:9px; background:#2b66812c; color:#b0daf5; font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
  .sss-notice[data-kind='success'] { border-color:#508066; background:#35774e29; color:#b6e5c2; }
  .sss-notice[data-kind='error'] { border-color:#985f67; background:#a34c542b; color:#ffb9bf; }
  .sss-advanced { margin:18px 3px 0; color:#99adc2; font-size:12px; }
  .sss-advanced summary { cursor:pointer; }
  .sss-advanced p { line-height:1.5; }
  @media(max-width:560px) { .sss { padding:18px 12px 28px; } .sss-card { padding:15px; } .sss h2 { font-size:21px; } }
`;

function SettingsContent() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [account, setAccount] = useState('');
  const [selected, setSelected] = useState('');
  const [drafts, setDrafts] = useState<{ [id: string]: string }>({});
  const [notice, setNotice] = useState<Notice>({ kind: 'info', text: '正在加载…' });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [manualCleanup, setManualCleanup] = useState<ManualCleanup[]>([]);

  const profile = bootstrap?.config.Profiles.find((item) => item.Id === selected);
  const text = drafts[selected] ?? profile?.Text ?? '';
  const length = Array.from(text).length;
  const valid = Boolean(text.trim()) && length <= 80 && !/[\u0000-\u001f]/u.test(text);
  const dirty = Boolean(profile && text !== profile.Text);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const steam = (window as any).SteamClient;
        const accountId = await steam?.WebChat?.GetCurrentUserAccountID?.();
        if (!accountId || !Number.isInteger(accountId)) throw new Error('无法读取当前 Steam 账号 ID。');
        if (mounted) setAccount(String(accountId));
        const data = await backend.getBootstrap();
        if (!mounted) return;
        setBootstrap(data);
        setSelected((data.config.Profiles.find((item) => item.Id === data.config.SelectedProfile) ?? data.config.Profiles[0]).Id);
        setNotice(data.runnerReady
          ? { kind: 'info', text: '已就绪。修改并应用状态，无需重启 Steam。' }
          : { kind: 'error', text: '运行程序未安装。请按 README 安装 SteamStatusRunner.exe 后重新打开此页。' });
      } catch (error) {
        if (mounted) setNotice({ kind: 'error', text: `加载失败：${String(error)}` });
      }
    })();
    return () => { mounted = false; };
  }, []);

  function controller() {
    if (!bootstrap || !account) throw new Error('插件尚未初始化。');
    const steam = (window as any).SteamClient;
    const appStore = (window as any).appStore;
    return createStatusController({
      apps: steam?.Apps,
      appStore,
      runner: { isActive: () => backend.isRunnerActive(), requestStop: () => backend.requestRunnerStop() },
      storage: {
        get: async (key: string) => bootstrap.shortcutIds[key] ?? null,
        set: async (key: string, record: ShortcutRecord) => {
          await backend.setShortcutId(key, record.id, record.name, record.runner === true, record.needsRefresh === true);
          bootstrap.shortcutIds[key] = record;
        },
        clear: async (key: string) => {
          await backend.clearShortcutId(key);
          delete bootstrap.shortcutIds[key];
        }
      }
    });
  }

  async function runAction(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice({ kind: 'info', text: `${label}…` });
    try {
      await action();
      setNotice({ kind: 'success', text: `${label}完成。` });
    } catch (error) {
      setNotice({ kind: 'error', text: `${label}失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrent() {
    if (!bootstrap || !profile) throw new Error('插件尚未初始化。');
    const clean = validateStatus(text);
    if (clean !== profile.Text || bootstrap.config.SelectedProfile !== selected) {
      const updated = await backend.saveTemplates(JSON.stringify(changeTemplates(bootstrap.config, { type: 'save', id: selected, text: clean })));
      setBootstrap({ ...bootstrap, config: updated });
    }
    setDrafts((current) => {
      const next = { ...current };
      delete next[selected];
      return next;
    });
    return clean;
  }

  async function chooseTemplate(id: string) {
    if (!bootstrap || id === selected || busy) return;
    setBusy(true);
    try {
      const updated = await backend.saveTemplates(JSON.stringify(changeTemplates(bootstrap.config, { type: 'select', id })));
      setBootstrap({ ...bootstrap, config: updated });
      setSelected(id);
      setConfirmDelete(false);
      setNotice({ kind: 'info', text: '已切换模板；未保存的修改会在本次打开界面期间保留。' });
    } catch (error) {
      setNotice({ kind: 'error', text: `切换模板失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function createTemplate() {
    if (!bootstrap) throw new Error('插件尚未初始化。');
    const id = crypto.randomUUID().replaceAll('-', '');
    const updated = await backend.saveTemplates(JSON.stringify(changeTemplates(bootstrap.config, {
      type: 'add', id, text, createdAt: new Date().toISOString()
    })));
    setBootstrap({ ...bootstrap, config: updated });
    setSelected(id);
    setConfirmDelete(false);
  }

  async function deleteTemplate() {
    if (!bootstrap) throw new Error('插件尚未初始化。');
    const change = changeTemplates(bootstrap.config, { type: 'delete', id: selected });
    const updated = await backend.saveTemplates(JSON.stringify(change));
    setBootstrap({ ...bootstrap, config: updated });
    setDrafts((current) => {
      const next = { ...current };
      delete next[selected];
      return next;
    });
    setSelected(change.SelectedProfile);
    setConfirmDelete(false);
  }

  async function resetPlugin() {
    if (busy) return;
    setBusy(true);
    setNotice({ kind: 'info', text: '正在重置插件…' });
    try {
      const { manual } = await resetPluginState({
        accountId: account,
        records: bootstrap?.shortcutIds,
        removeOwned: (key: string) => controller().remove(key),
        stopRunner: async () => {
          if (!await backend.isRunnerActive()) return;
          await backend.requestRunnerStop();
          for (let attempt = 0; attempt < 40; attempt += 1) {
            if (!await backend.isRunnerActive()) return;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          throw new Error('退出请求超时');
        },
        resetData: () => backend.resetPluginData()
      });
      setManualCleanup(manual);
      const data = await backend.getBootstrap();
      setBootstrap(data);
      setSelected(data.config.SelectedProfile);
      setDrafts({});
      setConfirmDelete(false);
      setConfirmReset(false);
      setNotice(manual.length
        ? { kind: 'error', text: '插件数据已重置，但下列 Steam 条目无法确认已删除，请按提示手动处理。' }
        : { kind: 'success', text: '插件已重置：模板和快捷方式记录已恢复初始状态。' });
    } catch (error) {
      setNotice({ kind: 'error', text: `重置未完成，请重试：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  }

  return <div className="sss">
    <style>{css}</style>
    <header>
      <div><p className="sss-eyebrow">Steam Status Studio</p><h2>自定义正在玩状态</h2>
        <p className="sss-subtitle">编辑好友看到的游戏名称，切换无需重启 Steam。</p></div>
      <span className="sss-account" title={account ? `当前账号：${account}` : '未检测到账号'}>账号 {account || '未检测到'}</span>
    </header>

    <section className="sss-card" aria-labelledby="sss-status-title">
      <div className="sss-card-head"><h3 id="sss-status-title">状态文字</h3><span className="sss-muted">最多 80 字</span></div>
      <label htmlFor="sss-status-input">好友会看到的游戏名称</label>
      <input id="sss-status-input" className={`sss-input${length > 80 ? ' sss-invalid' : ''}`} value={text} disabled={!bootstrap || busy}
        aria-invalid={!valid && Boolean(text)} aria-describedby="sss-status-hint"
        placeholder="例如：机器的直播间" onChange={(event) => setDrafts((current) => ({ ...current, [selected]: event.target.value }))} />
      <div id="sss-status-hint" className="sss-input-meta">
        <span className={!valid ? 'sss-warning' : ''}>{length > 80 ? '文字过长，请删减后再应用' : !text.trim() ? '请输入状态文字' : dirty ? '当前模板有未保存修改' : '可直接应用当前模板'}</span>
        <span className={length > 80 ? 'sss-warning' : ''}>{length} / 80</span>
      </div>
      <div className="sss-preview" aria-label="好友可见状态预览"><span className="sss-dot" aria-hidden="true" />
        <div><small>好友列表预览</small><strong>正在玩 {text.trim() || '你的状态文字'}</strong></div>
      </div>
      <div className="sss-actions">
        <button type="button" className="sss-button sss-primary" disabled={!bootstrap || busy || !bootstrap.runnerReady || !valid}
          onClick={() => runAction('应用状态', async () => {
            const clean = await saveCurrent();
            if (!bootstrap) throw new Error('插件尚未初始化。');
            await controller().apply({ accountId: account, text: clean, executable: bootstrap.executable, startDir: bootstrap.startDir, launchOptions: bootstrap.launchOptions });
          })}>保存并应用</button>
        <button type="button" className="sss-button sss-quiet" disabled={!bootstrap || busy} onClick={() => runAction('停止状态', async () => { await controller().stop(account); })}>停止显示</button>
      </div>
      <p className="sss-note">应用时会保存当前模板；只会管理本插件创建的专用非 Steam 条目。</p>
    </section>

    <section className="sss-card" aria-labelledby="sss-templates-title">
      <div className="sss-card-head"><h3 id="sss-templates-title">我的模板</h3><span className="sss-muted">{bootstrap?.config.Profiles.length ?? 0} / 100</span></div>
      <label htmlFor="sss-template-select">选择已保存的状态</label>
      <div className="sss-select-wrap"><select id="sss-template-select" className="sss-select" value={selected} disabled={!bootstrap || busy} onChange={(event) => void chooseTemplate(event.target.value)}>
        {bootstrap?.config.Profiles.map((item) => <option key={item.Id} value={item.Id}>{drafts[item.Id] !== undefined && drafts[item.Id] !== item.Text ? '● ' : ''}{item.Text}</option>)}
      </select></div>
      <div className="sss-actions">
        <button type="button" className="sss-button" disabled={!bootstrap || busy || !dirty || !valid} onClick={() => runAction('保存模板', async () => { await saveCurrent(); })}>保存修改</button>
        <button type="button" className="sss-button sss-quiet" disabled={!bootstrap || busy || !valid || bootstrap.config.Profiles.length >= 100} onClick={() => runAction('新建模板', createTemplate)}>另存为新模板</button>
        <button type="button" className="sss-button sss-quiet" disabled={!bootstrap || busy || bootstrap.config.Profiles.length <= 1} onClick={() => setConfirmDelete(true)}>删除模板</button>
      </div>
      <p className="sss-note">先在上方输入文字，再保存到当前模板或另存为新模板。</p>
      {confirmDelete && <div className="sss-confirm">删除“{profile?.Text}”模板？当前正在显示的状态不会因此停止。
        <div className="sss-actions">
          <button type="button" className="sss-button sss-danger" disabled={busy} onClick={() => runAction('删除模板', deleteTemplate)}>确认删除</button>
          <button type="button" className="sss-button sss-quiet" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button>
        </div>
      </div>}
    </section>

    <div className="sss-notice" data-kind={notice.kind} role="status" aria-live="polite">{notice.text}</div>
    {manualCleanup.length > 0 && <div className="sss-confirm" role="alert">
      <strong>需要手动检查 Steam 库</strong>
      <p>仅删除确认由本插件创建的非 Steam 条目；可在 Steam 库中右键该条目，通过“管理”移除。不要删除其他同名游戏。</p>
      <ul>{manualCleanup.map((item, index) => <li key={`${item.account}-${index}`}>
        账号 {item.account}{item.name ? ` · 已记录名称“${item.name}”` : ''}{item.id ? ` · App ID ${item.id}` : ''}：{item.reason}
      </li>)}</ul>
    </div>}
    <details className="sss-advanced"><summary>高级操作 · 仅改名与重置插件</summary>
      <p>试验性“仅改名”不会重启后台进程，但目前无法保证好友列表会立即刷新。请用另一个账号确认；如果没有更新，再点上方“保存并应用”强制刷新。</p>
      <button type="button" className="sss-button sss-quiet" disabled={!bootstrap || busy || !valid || !bootstrap.shortcutIds[account]}
        onClick={() => runAction('仅修改条目名称（好友显示待验证）', async () => {
          const clean = await saveCurrent();
          await controller().renameOnly({ accountId: account, text: clean });
        })}>试验：仅改名，不重启进程</button>
      <p>重置会清空全部模板和快捷方式记录，并尝试停止、移除当前账号的专用状态条目。其他账号的条目无法在当前账号下安全删除，须手动处理。</p>
      {!confirmReset ? <button type="button" className="sss-button sss-danger" disabled={busy} onClick={() => setConfirmReset(true)}>完全重置插件…</button> :
        <div className="sss-confirm">确认重置全部模板和记录？此操作不能通过插件撤销。若自动删除条目失败，重置后会显示手动删除提示。
          <div className="sss-actions">
            <button type="button" className="sss-button sss-danger" disabled={busy} onClick={() => void resetPlugin()}>确认完全重置</button>
            <button type="button" className="sss-button sss-quiet" disabled={busy} onClick={() => setConfirmReset(false)}>取消</button>
          </div>
        </div>}
    </details>
  </div>;
}

export default definePlugin(() => ({
  title: 'Steam Status Studio Live',
  icon: <span aria-hidden="true">🎮</span>,
  content: <SettingsContent />
}));
