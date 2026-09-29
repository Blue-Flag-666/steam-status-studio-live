import { useEffect, useState } from 'react';
import { definePlugin } from 'millennium';
import { changeTemplates, createStatusController, hasUnsavedTemplateEdit, initialStatusText, loadProfileAvatar, mergeManualCleanup, resetPluginState, staticAvatarFallback, validateStatus } from './status-core.mjs';

declare const backend: {
  getBootstrap(): Promise<Bootstrap>;
  getPublicMiniProfile(accountId: string): Promise<string>;
  saveTemplates(json: string): Promise<Config>;
  getShortcutId(account: string): Promise<ShortcutRecord | null>;
  setShortcutId(account: string, id: number, name: string, runner: boolean): Promise<boolean>;
  clearShortcutId(account: string): Promise<boolean>;
  isRunnerActive(): Promise<boolean>;
  requestRunnerStop(): Promise<boolean>;
  resetPluginData(manualJson: string): Promise<{ config: Config; shortcutIds: { [account: string]: ShortcutRecord }; manualCleanup: ManualCleanup[] }>;
  clearManualCleanup(): Promise<boolean>;
};

type Profile = { Id: string; Text: string; CreatedAt?: string };
type Config = { Profiles: Profile[]; SelectedProfile: string; [key: string]: unknown };
type ShortcutRecord = { id: number; name: string; runner?: boolean; needsRefresh?: boolean };
type Bootstrap = {
  config: Config;
  shortcutIds: { [account: string]: ShortcutRecord };
  manualCleanup?: ManualCleanup[];
  persistentCleanup?: boolean;
  runnerReady: boolean;
  executable: string;
  startDir: string;
  launchOptions: string;
};
type Notice = { kind: 'info' | 'success' | 'error'; text: string; inProgress?: boolean };
type ManualCleanup = { account: string; id?: number; name?: string; reason?: string };
type ProfileAvatar = { avatarUrl: string; avatarReducedUrl: string; frameUrl: string; frameReducedUrl: string; personaName: string };
const profileCache = new Map<string, { assets: ProfileAvatar; expires: number }>();

const css = `
  .sss { box-sizing:border-box; max-width:680px; margin:auto; padding:22px 18px 30px; color:#dce6f1; font-family:inherit; }
  .sss * { box-sizing:border-box; }
  .sss header { display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px; margin-bottom:20px; }
  .sss-eyebrow { margin:0 0 5px; color:#69b8ed; font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
  .sss h2 { margin:0; color:#fff; font-size:24px; line-height:1.25; }
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
  .sss-preview { margin-top:15px; padding:13px 15px; border:1px solid #303a45; border-radius:9px; background:linear-gradient(#1b1f25,#171b20); }
  .sss-preview-head { display:flex; justify-content:space-between; gap:10px; color:#a8c6d9; font-size:12px; }
  .sss-preview-head span { color:#788895; font-size:11px; }
  .sss-preview-error { margin:10px 0 0; color:#e4a5a5; font-size:11px; line-height:1.4; overflow-wrap:anywhere; }
  .sss-friend-row { display:flex; align-items:center; gap:10px; margin-top:14px; min-width:0; }
  .sss-avatar { position:relative; display:flex; flex:none; align-items:center; justify-content:center; width:42px; height:42px; border:2px solid #497c9c; background:linear-gradient(135deg,#536b7d,#243747); color:#d4e2ec; font-size:17px; }
  .sss-avatar.sss-has-frame { border:0; }
  .sss-avatar-picture { display:block; width:100%; height:100%; overflow:hidden; }
  .sss-avatar-picture img { display:block; width:100%; height:100%; object-fit:cover; }
  .sss-avatar-frame { position:absolute; inset:0; z-index:2; width:100%; height:100%; transform:scale(1.2); pointer-events:none; }
  .sss-avatar-frame img { display:block; width:100%; height:100%; object-fit:contain; }
  .sss-friend-copy { display:flex; flex-direction:column; gap:1px; min-width:0; padding-left:10px; border-left:3px solid #7aaa45; line-height:1.15; }
  .sss-friend-name { overflow:hidden; color:#e3edc8; font-size:15px; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
  .sss-friend-status { color:#83b853; font-size:13px; overflow-wrap:anywhere; }
  .sss-actions { display:flex; flex-wrap:wrap; gap:9px; margin-top:17px; }
  .sss-status-actions { display:flex; justify-content:space-between; gap:9px; margin-top:17px; }
  .sss-status-actions-group { display:flex; gap:9px; }
  .sss-button { min-height:38px; padding:8px 14px; border:1px solid #59738f; border-radius:8px; background:#2c4056; color:#e9f2fb; font:inherit; font-size:13px; font-weight:600; cursor:pointer; transition:background .15s,border-color .15s; }
  .sss-button:hover:not(:disabled) { background:#3a536c; border-color:#86abc9; }
  .sss-button:focus-visible { outline:2px solid #8bcfff; outline-offset:2px; }
  .sss-button:disabled { opacity:.43; cursor:not-allowed; }
  .sss-primary { border-color:#6ec0f1; background:linear-gradient(#4eafe8,#247bb8); color:white; }
  .sss-primary:hover:not(:disabled) { background:linear-gradient(#68bfef,#348fca); }
  .sss-quiet { background:transparent; border-color:#435a73; color:#c0d1e2; }
  .sss-danger { background:#9b4b4b24; border-color:#925f65; color:#f2c0c0; }
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
  const [draft, setDraft] = useState('');
  const [draftBaseline, setDraftBaseline] = useState('');
  const [pendingTemplate, setPendingTemplate] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClearManual, setConfirmClearManual] = useState(false);
  const [manualCleanup, setManualCleanup] = useState<ManualCleanup[]>([]);
  const [personaName, setPersonaName] = useState('当前用户');
  const [avatar, setAvatar] = useState('');
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [profileAvatar, setProfileAvatar] = useState<ProfileAvatar | null>(null);
  const [profileAvatarFailed, setProfileAvatarFailed] = useState(false);
  const [profileFrameFailed, setProfileFrameFailed] = useState(false);
  const [avatarIssue, setAvatarIssue] = useState('');

  const profile = bootstrap?.config.Profiles.find((item) => item.Id === selected);
  const text = draft;
  const length = Array.from(text).length;
  const valid = Boolean(text.trim()) && length <= 80 && !/[\u0000-\u001f]/u.test(text);
  const dirty = Boolean(profile && text !== profile.Text);
  const unsavedEdit = hasUnsavedTemplateEdit(text, draftBaseline, profile?.Text);
  const matchingTemplate = bootstrap?.config.Profiles.find((item) => item.Text === text.trim());
  const duplicateOtherTemplate = Boolean(matchingTemplate && matchingTemplate.Id !== selected);
  const avatarUrl = profileAvatar && !profileAvatarFailed ? profileAvatar.avatarUrl : avatarFailed ? '' : avatar;
  const avatarReducedUrl = profileAvatar && !profileAvatarFailed ? profileAvatar.avatarReducedUrl : '';
  const frameUrl = profileAvatar && !profileFrameFailed ? profileAvatar.frameUrl : '';
  const frameReducedUrl = profileAvatar && !profileFrameFailed ? profileAvatar.frameReducedUrl : '';

  useEffect(() => {
    if (!notice || notice.inProgress) return;
    const timeout = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timeout);
  }, [notice]);

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
        const initial = data.config.Profiles.find((item) => item.Id === data.config.SelectedProfile) ?? data.config.Profiles[0];
        if (!initial) throw new Error('配置中没有可用的状态模板。');
        setBootstrap(data);
        setSelected(initial.Id);
        const initialText = initialStatusText(data.config, data.shortcutIds, accountId);
        setDraft(initialText);
        setDraftBaseline(initialText);
        setManualCleanup(mergeManualCleanup(data.manualCleanup, []));
        if (!data.runnerReady) setNotice({ kind: 'error', text: '运行程序未安装。请按 README 安装 SteamStatusRunner.exe 后重新打开此页。' });
      } catch (error) {
        if (mounted) setNotice({ kind: 'error', text: `加载失败：${String(error)}` });
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!account) return;
    let mounted = true;
    setPersonaName('当前用户');
    setAvatar('');
    setAvatarFailed(false);
    setProfileAvatar(null);
    setProfileAvatarFailed(false);
    setProfileFrameFailed(false);
    setAvatarIssue('');
    const webChat = (window as any).SteamClient?.WebChat;
    if (typeof webChat?.GetLocalPersonaName === 'function') {
      Promise.resolve().then(() => webChat.GetLocalPersonaName()).then((name: unknown) => {
        if (mounted && typeof name === 'string' && name.trim()) setPersonaName(name.trim());
      }).catch(() => {});
    }
    if (typeof webChat?.GetLocalAvatarBase64 === 'function') {
      Promise.resolve().then(() => webChat.GetLocalAvatarBase64()).then((url: unknown) => {
        if (mounted && typeof url === 'string' && /^data:image\/(?:png|jpeg|webp|gif|apng);base64,/iu.test(url)) {
          setAvatar(url);
          setAvatarFailed(false);
        }
      }).catch(() => {});
    }
    const cached = profileCache.get(account);
    if (cached && cached.expires > Date.now()) {
      setProfileAvatar(cached.assets);
      if (cached.assets.personaName) setPersonaName(cached.assets.personaName);
    } else {
      profileCache.delete(account);
      (async () => {
        const { assets, failures } = await loadProfileAvatar({
          directMini: async () => {
            const abort = new AbortController();
            const timeout = setTimeout(() => abort.abort(), 3000);
            try {
              const response = await fetch(`https://steam-chat.com/miniprofile/${account}/json/`, {
                credentials: 'omit', signal: abort.signal
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return await response.text();
            } finally { clearTimeout(timeout); }
          },
          backendMini: typeof backend.getPublicMiniProfile === 'function' ? () => backend.getPublicMiniProfile(account) : null
        });
        if (!mounted) return;
        if (assets) {
          profileCache.set(account, { assets, expires: Date.now() + 120000 });
          setProfileAvatar(assets);
          setAvatarIssue('');
          if (assets.personaName) setPersonaName((current) => current === '当前用户' ? assets.personaName : current);
        } else setAvatarIssue(`动态头像读取失败，已使用客户端静态头像。${failures.join('；').slice(0, 260)}`);
      })();
    }
    return () => { mounted = false; };
  }, [account]);

  function controller() {
    if (!bootstrap || !account) throw new Error('插件尚未初始化。');
    const steam = (window as any).SteamClient;
    const appStore = (window as any).appStore;
    return createStatusController({
      apps: steam?.Apps,
      appStore,
      runner: { isActive: () => backend.isRunnerActive(), requestStop: () => backend.requestRunnerStop() },
      storage: {
        get: async (key: string) => {
          const record = await backend.getShortcutId(key);
          if (record) bootstrap.shortcutIds[key] = record;
          else delete bootstrap.shortcutIds[key];
          return record;
        },
        set: async (key: string, record: ShortcutRecord) => {
          await backend.setShortcutId(key, record.id, record.name, record.runner === true);
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
    setNotice({ kind: 'info', text: `${label}…`, inProgress: true });
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
    setDraft(clean);
    setDraftBaseline(clean);
    setPendingTemplate('');
    setConfirmDelete(false);
    return clean;
  }

  async function selectTemplate(id: string) {
    if (!bootstrap || id === selected || busy) return;
    setBusy(true);
    try {
      const updated = await backend.saveTemplates(JSON.stringify(changeTemplates(bootstrap.config, { type: 'select', id })));
      setBootstrap({ ...bootstrap, config: updated });
      setSelected(id);
      const templateText = updated.Profiles.find((item) => item.Id === id)?.Text ?? '';
      setDraft(templateText);
      setDraftBaseline(templateText);
      setPendingTemplate('');
      setConfirmDelete(false);
      setNotice({ kind: 'info', text: '已载入模板；点击“应用”后好友才会看到新文字。' });
    } catch (error) {
      setNotice({ kind: 'error', text: `切换模板失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
    }
  }

  function chooseTemplate(id: string) {
    if (!bootstrap || id === selected || busy) return;
    setConfirmDelete(false);
    if (unsavedEdit) setPendingTemplate(id);
    else void selectTemplate(id);
  }

  async function createTemplate() {
    if (!bootstrap) throw new Error('插件尚未初始化。');
    const clean = validateStatus(text);
    const id = crypto.randomUUID().replace(/-/g, '');
    const updated = await backend.saveTemplates(JSON.stringify(changeTemplates(bootstrap.config, {
      type: 'add', id, text: clean, createdAt: new Date().toISOString()
    })));
    setBootstrap({ ...bootstrap, config: updated });
    setSelected(id);
    setDraft(clean);
    setDraftBaseline(clean);
    setPendingTemplate('');
    setConfirmDelete(false);
  }

  async function deleteTemplate() {
    if (!bootstrap) throw new Error('插件尚未初始化。');
    const change = changeTemplates(bootstrap.config, { type: 'delete', id: selected });
    const updated = await backend.saveTemplates(JSON.stringify(change));
    setBootstrap({ ...bootstrap, config: updated });
    setSelected(change.SelectedProfile);
    const templateText = updated.Profiles.find((item) => item.Id === change.SelectedProfile)?.Text ?? '';
    setDraft(templateText);
    setDraftBaseline(templateText);
    setPendingTemplate('');
    setConfirmDelete(false);
  }

  async function resetPlugin() {
    if (busy) return;
    if (bootstrap?.persistentCleanup !== true) {
      setNotice({ kind: 'error', text: '当前后端尚未加载新版插件，暂不能安全重置；请在下次正常启动 Steam 后再试。' });
      setConfirmReset(false);
      return;
    }
    setBusy(true);
    setNotice({ kind: 'info', text: '正在重置插件…', inProgress: true });
    try {
      const latest = await backend.getBootstrap();
      const { manual } = await resetPluginState({
        accountId: account,
        records: latest.shortcutIds,
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
        resetData: (freshManual: ManualCleanup[]) => backend.resetPluginData(JSON.stringify(mergeManualCleanup(manualCleanup, freshManual)))
      });
      const data = await backend.getBootstrap();
      setBootstrap(data);
      const unresolved = mergeManualCleanup(data.manualCleanup, manual);
      setManualCleanup(unresolved);
      setSelected(data.config.SelectedProfile);
      const templateText = data.config.Profiles.find((item) => item.Id === data.config.SelectedProfile)?.Text ?? '';
      setDraft(templateText);
      setDraftBaseline(templateText);
      setPendingTemplate('');
      setConfirmDelete(false);
      setConfirmReset(false);
      setConfirmClearManual(false);
      setNotice(unresolved.length
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
      <div><p className="sss-eyebrow">Steam Status Studio</p><h2>自定义状态</h2></div>
      <span className="sss-account" title={account ? `当前账号：${account}` : '未检测到账号'}>账号 {account || '未检测到'}</span>
    </header>

    <section className="sss-card" aria-labelledby="sss-status-title">
      <div className="sss-card-head"><h3 id="sss-status-title">状态文字</h3><span className="sss-muted">最多 80 字</span></div>
      <input id="sss-status-input" className={`sss-input${length > 80 ? ' sss-invalid' : ''}`} value={text} disabled={!bootstrap || busy}
        aria-label="状态文字" aria-invalid={!valid && Boolean(text)} aria-describedby="sss-status-hint"
        onChange={(event) => { setDraft(event.target.value); setPendingTemplate(''); setConfirmDelete(false); }} />
      <div id="sss-status-hint" className="sss-input-meta">
        <span className={!valid || duplicateOtherTemplate ? 'sss-warning' : ''}>{length > 80 ? '文字过长，请删减后重试' : !text.trim() ? '请输入状态文字' : duplicateOtherTemplate ? '已有相同文字的模板' : unsavedEdit ? '当前模板尚未保存' : dirty ? '上次状态未保存到当前模板' : ''}</span>
        <span className={length > 80 ? 'sss-warning' : ''}>{length} / 80</span>
      </div>
      <div className="sss-preview" aria-label="好友列表状态预览">
        <div className="sss-preview-head"><strong>游戏中</strong><span>好友列表预览</span></div>
        <div className="sss-friend-row">
          <span className={`sss-avatar${frameUrl ? ' sss-has-frame' : ''}`} aria-label={avatarUrl ? '当前用户头像' : '头像占位'}>
            {avatarUrl ? <picture className="sss-avatar-picture">
              {avatarReducedUrl && <source media="(prefers-reduced-motion: reduce)" srcSet={avatarReducedUrl} />}
              <img src={avatarUrl} alt="" onError={() => {
                if (profileAvatar && !profileAvatarFailed) {
                  profileCache.delete(account);
                  const fallback = staticAvatarFallback(profileAvatar);
                  if (fallback) {
                    setProfileAvatar(fallback);
                    setAvatarIssue('动态头像图片加载失败，已使用静态头像。');
                  } else {
                    setProfileAvatarFailed(true);
                    setAvatarIssue('头像图片加载失败，已回退到客户端头像。');
                  }
                }
                else setAvatarFailed(true);
              }} />
            </picture> : '你'}
            {frameUrl && <picture className="sss-avatar-frame">
              {frameReducedUrl && <source media="(prefers-reduced-motion: reduce)" srcSet={frameReducedUrl} />}
              <img src={frameUrl} alt="" onError={() => {
                profileCache.delete(account);
                setProfileFrameFailed(true);
                setAvatarIssue('头像框图片加载失败。');
              }} />
            </picture>}
          </span>
          <div className="sss-friend-copy"><strong className="sss-friend-name">{personaName}</strong>
            <span className="sss-friend-status">{text.trim() || '你的状态文字'}</span></div>
        </div>
        {avatarIssue && <p className="sss-preview-error" role="status">{avatarIssue}</p>}
      </div>
      <div className="sss-status-actions">
        <div className="sss-status-actions-group">
          <button type="button" className="sss-button sss-primary" disabled={!bootstrap || busy || !bootstrap.runnerReady || !valid}
          onClick={() => runAction('应用', async () => {
            const clean = validateStatus(text);
            if (!bootstrap) throw new Error('插件尚未初始化。');
            await controller().apply({ accountId: account, text: clean, executable: bootstrap.executable, startDir: bootstrap.startDir, launchOptions: bootstrap.launchOptions });
          })}>应用</button>
          <button type="button" className="sss-button sss-quiet" disabled={!bootstrap || busy} onClick={() => runAction('停止状态', async () => { await controller().stop(account); })}>停止</button>
        </div>
        <button type="button" className="sss-button" disabled={!bootstrap || busy || !dirty || !valid || duplicateOtherTemplate}
          onClick={() => runAction('保存模板', async () => { await saveCurrent(); })}>保存模板</button>
      </div>
    </section>

    <section className="sss-card" aria-labelledby="sss-templates-title">
      <div className="sss-card-head"><h3 id="sss-templates-title">我的模板</h3><span className="sss-muted">{bootstrap?.config.Profiles.length ?? 0} / 100</span></div>
      <label htmlFor="sss-template-select">选择模板</label>
      <div className="sss-select-wrap"><select id="sss-template-select" className="sss-select" value={selected} disabled={!bootstrap || busy} onChange={(event) => void chooseTemplate(event.target.value)}>
        {bootstrap?.config.Profiles.map((item) => <option key={item.Id} value={item.Id}>{item.Text}</option>)}
      </select></div>
      {pendingTemplate && <div className="sss-confirm" role="alertdialog" aria-label="切换模板确认">当前模板的编辑尚未保存。切换模板会丢弃这些修改，继续吗？
        <div className="sss-actions">
          <button type="button" className="sss-button sss-danger" disabled={busy} onClick={() => void selectTemplate(pendingTemplate)}>丢弃修改并切换</button>
          <button type="button" className="sss-button sss-quiet" disabled={busy} onClick={() => setPendingTemplate('')}>继续编辑</button>
        </div>
      </div>}
      <div className="sss-actions">
        <button type="button" className="sss-button" disabled={!bootstrap || busy || !valid || Boolean(matchingTemplate) || bootstrap.config.Profiles.length >= 100} onClick={() => runAction('新建模板', createTemplate)}>新建模板</button>
        <button type="button" className="sss-button sss-quiet" disabled={!bootstrap || busy || bootstrap.config.Profiles.length <= 1} onClick={() => { setPendingTemplate(''); setConfirmDelete(true); }}>删除模板</button>
      </div>
      {confirmDelete && <div className="sss-confirm">删除“{profile?.Text}”模板？未保存的修改也会丢弃，当前正在显示的状态不会因此停止。
        <div className="sss-actions">
          <button type="button" className="sss-button sss-danger" disabled={busy} onClick={() => runAction('删除模板', deleteTemplate)}>确认删除</button>
          <button type="button" className="sss-button sss-quiet" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button>
        </div>
      </div>}
    </section>

    {notice && <div className="sss-notice" data-kind={notice.kind} role="status" aria-live="polite">{notice.text}</div>}
    {manualCleanup.length > 0 && <div className="sss-confirm" role="alert">
      <strong>需要手动检查 Steam 库</strong>
      <p>仅删除确认由本插件创建的非 Steam 条目；可在 Steam 库中右键该条目，通过“管理”移除。不要删除其他同名游戏。</p>
      <ul>{manualCleanup.map((item, index) => <li key={`${item.account}-${index}`}>
        账号 {item.account}{item.name ? ` · 已记录名称“${item.name}”` : ''}{item.id ? ` · App ID ${item.id}` : ''}：{item.reason}
      </li>)}</ul>
      {!confirmClearManual ? <button type="button" className="sss-button sss-quiet" disabled={busy} onClick={() => setConfirmClearManual(true)}>已手动处理，清除此提醒…</button> :
        <div className="sss-confirm">确认已检查并处理上述全部条目？清除后将无法从插件找回这些 App ID。
          <div className="sss-actions">
            <button type="button" className="sss-button sss-danger" disabled={busy} onClick={() => runAction('清除手动处理提醒', async () => {
              await backend.clearManualCleanup();
              setManualCleanup([]);
              setConfirmClearManual(false);
              if (bootstrap) setBootstrap({ ...bootstrap, manualCleanup: [] });
            })}>确认清除</button>
            <button type="button" className="sss-button sss-quiet" disabled={busy} onClick={() => setConfirmClearManual(false)}>取消</button>
          </div>
        </div>}
    </div>}
    <details className="sss-advanced"><summary>高级操作 · 重置插件</summary>
      <p>重置会清空全部模板和快捷方式记录，并尝试停止、移除当前账号的专用状态条目。其他账号的条目无法在当前账号下安全删除，须手动处理。</p>
      {!confirmReset ? <button type="button" className="sss-button sss-danger" disabled={busy} onClick={() => {
        if (bootstrap?.persistentCleanup !== true) setNotice({ kind: 'error', text: '当前后端尚未加载新版插件，暂不能安全重置；请在下次正常启动 Steam 后再试。' });
        else setConfirmReset(true);
      }}>完全重置插件…</button> :
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
