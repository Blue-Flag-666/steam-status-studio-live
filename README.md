# Steam Status Studio Live

一个用于 Windows Steam 的 [Millennium](https://docs.steambrew.app/users/getting-started/installation) 插件，可在 Steam 内自定义好友看到的“正在玩”文字、保存模板并随时切换，无需重启 Steam。

[下载最新版本](https://github.com/Blue-Flag-666/steam-status-studio-live/releases/latest)

## 安装

1. 安装 [Millennium](https://docs.steambrew.app/users/getting-started/installation)。
2. 从 [Releases](https://github.com/Blue-Flag-666/steam-status-studio-live/releases/latest) 下载 `com.steamstatusstudio.live.star` 和 `SteamStatusRunner.exe`。
3. 将 `.star` 文件放入 `<Steam 安装目录>\millennium\plugins\`，将 `.exe` 文件放入 `%APPDATA%\SteamStatusStudio\runner\`。
4. 首次安装后重启 Steam，在 **Steam → Millennium → Plugins → Steam Status Studio Live → 配置** 中打开插件。更新插件时只需替换文件，新版本会在下次正常启动 Steam 后加载。

输入文字后点击“应用”即可更新好友可见状态，不会自动保存模板。“保存模板”只修改当前模板；还可以用当前文字新建模板或删除所选模板。点击“停止”会隐藏状态，但保留上次应用的文字；后台进程会随 Steam 退出，下次启动时状态默认停止。重复应用相同文字不会重启后台进程；切换为不同文字时，只会刷新插件专用的非 Steam 条目，不会重启 Steam。

预览会从 Steam 的公开 miniprofile 数据读取动态头像和头像框；动态头像加载失败时先回退到静态头像。“完全重置插件”会清空模板和记录，并尝试移除专用条目；删除失败时的手动清理提示会保留，直到你确认已处理。

## 构建

需要 Windows、[Bun](https://bun.sh/) 和 .NET Framework 4.x 开发工具：

```powershell
bun install --frozen-lockfile
bun run check:types
bun run build
bun test
```

构建产物位于 `dist/`。插件使用非官方 Steam 客户端接口，可能随 Steam 更新失效；不支持游戏图标或原生 Rich Presence。
