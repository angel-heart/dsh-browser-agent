# dsh-browser-agent（可移植打包版）

让 DeepSeek Harness 会话里的 Agent 拥有一个真实浏览器（15 个 `browser_*` 工具）。

本目录与运行时数据解耦：不包含 `profile/`（登录态）和 `shots/`（截图），
所有路径都从文件自身位置推导，可整体复制到任意 Windows 机器。

## 组成

| 文件 | 作用 |
| --- | --- |
| `browser-agent-plugin.mjs` | Cordis 插件，注册 15 个 browser_* 工具（可移植版） |
| `server.cjs` | Playwright 浏览器服务（stdio JSON 协议） |
| `config.json` | `channel` / `headless` / `executablePath` |
| `package.json` | 声明 playwright-core 1.61.1 依赖 |
| `node_modules/playwright-core/` | 由安装脚本 `npm install` 生成（或手动拷贝） |

## 依赖

- **Node.js**：复用 DSH 自身运行的 node（插件取 `process.execPath`；
  也可用环境变量 `DSH_BROWSER_NODE` 覆盖）。
- **playwright-core 1.61.1**：`npm install --prefix <本目录> playwright-core@1.61.1`
- **浏览器**：`config.json` 默认 `channel: "chrome"`（需本机装有 Chrome）；
  没有 Chrome 时改为 `"msedge"`（Windows 自带 Edge）或设置 `executablePath`。

## 登录态

- 浏览器使用独立持久化 profile（`./profile`，自动生成），登录一次长期有效。
- 需要真人扫码/过验证码时：把 `config.json` 的 `headless` 改为 `false`，
  在真实 Chrome 窗口里手动登录，完成后改回 `true` 依然保留登录态。
- `browser_cookies` 可导出/导入 Cookie（跨机器迁移登录态）。

## 限制

- 默认 headless；强反爬站点（如小红书）仍可能遇到风控/验证码。
- `browser_evaluate` 可在页面执行任意 JS，仅用于可信页面。
- 服务走 stdio 协议，不暴露 HTTP 端口。
