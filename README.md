# Steam Status Studio Live

一个用于 Windows Steam 的 [Millennium](https://docs.steambrew.app/users/getting-started/installation) 插件，可在 Steam 内自定义好友看到的状态文字、保存模板并随时切换。

[下载最新版本](https://github.com/Blue-Flag-666/steam-status-studio-live/releases/latest)

## 安装

1. 安装 [Millennium](https://docs.steambrew.app/users/getting-started/installation)。
2. 从 [Releases](https://github.com/Blue-Flag-666/steam-status-studio-live/releases/latest) 下载 `com.steamstatusstudio.live.star` 和 `SteamStatusRunner.exe`。
3. 将 `.star` 文件放入 `<Steam 安装目录>\millennium\plugins\`，将 `.exe` 文件放入 `%APPDATA%\SteamStatusStudio\runner\`。
4. 首次安装后重启 Steam，在 **Steam → Millennium → Plugins → Steam Status Studio Live → 配置** 中打开插件。更新插件时只需替换文件，新版本会在下次正常启动 Steam 后加载。

## 构建

需要 Windows、[Bun](https://bun.sh/) 和 .NET Framework 4.x 开发工具：

```powershell
bun install --frozen-lockfile
bun run check:types
bun run build
bun test
```

构建产物位于 `dist/`。插件使用非官方 Steam 客户端接口，可能随 Steam 更新失效；不支持游戏图标或原生 Rich Presence。
