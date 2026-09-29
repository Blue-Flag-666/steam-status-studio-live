# Steam Status Studio Live

一个用于 Windows Steam 的 [Millennium](https://docs.steambrew.app/users/getting-started/installation) 插件，可在 Steam 内自定义好友看到的“正在玩”文字、保存模板并随时切换，无需重启 Steam。

[下载最新版本](https://github.com/Blue-Flag-666/steam-status-studio-live/releases/latest)

## 安装

1. 安装 [Millennium](https://docs.steambrew.app/users/getting-started/installation)。
2. 从 [Releases](https://github.com/Blue-Flag-666/steam-status-studio-live/releases/latest) 下载 `com.steamstatusstudio.live.star` 和 `SteamStatusRunner.exe`。
3. 将 `.star` 文件放入 `<Steam 安装目录>\millennium\plugins\`，将 `.exe` 文件放入 `%APPDATA%\SteamStatusStudio\runner\`。
4. 重启 Steam，在 **Steam → Millennium → Plugins → Steam Status Studio Live → 配置** 中打开插件。

输入状态文字后点击“保存并应用”。重复应用相同文字不会重启后台进程；切换为不同文字时，只会刷新插件专用的非 Steam 条目，不会重启 Steam。可以保存多个模板，也可以随时停止显示。

高级操作中的“仅改名”不重启后台进程，但好友端是否立即刷新仍待验证；如未刷新，请使用“保存并应用”。“完全重置插件”会清空模板和记录，并尝试移除专用条目；删除失败时会提示手动处理。

## 构建

需要 Windows、[Bun](https://bun.sh/) 和 .NET Framework 4.x 开发工具：

```powershell
bun install --frozen-lockfile
bun run build
bun test
```

构建产物位于 `dist/`。插件使用非官方 Steam 客户端接口，可能随 Steam 更新失效；不支持游戏图标或原生 Rich Presence。
