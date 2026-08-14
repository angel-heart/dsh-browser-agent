# dsh-browser-agent

> 让 DeepSeek Harness 会话里的 Agent 拥有一个**真实浏览器**：15 个 `browser_*` 工具 + 「浏览器调研模式」预设（`browser-pro`）。
> Give DeepSeek Harness agents a real browser: 15 `browser_*` tools + the `browser-pro` preset.

本项目把"浏览器调研能力"打包为一个可移植的开源套件：单文件安装器、Cordis 插件、
Playwright 服务端、DSH 预设。在任何装有 DeepSeek Harness 的 Windows 机器上，一条命令即可启用。

## 能力一览（15 个工具）

| 工具 | 能力 |
| --- | --- |
| `browser_status` | 查询服务状态、当前 URL、标题 |
| `browser_open` | 打开任意 URL（可控制加载等待） |
| `browser_search` | Bing / Google 搜索，返回结果链接 |
| `browser_content` | 提取页面可见文本 |
| `browser_html` | 提取页面 HTML 源码 |
| `browser_click` | 点击元素（CSS / 文本选择器） |
| `browser_type` | 输入框填文字（可回车提交） |
| `browser_press` | 按键（Enter / 快捷键等） |
| `browser_scroll` | 滚动页面 |
| `browser_links` | 提取页面链接（可过滤） |
| `browser_screenshot` | 截图（整页 / 指定元素） |
| `browser_evaluate` | 在页面内执行任意 JS |
| `browser_cookies` | 读写 Cookie（登录态导入导出） |
| `browser_nav` | 后退 / 前进 / 刷新 / 关闭 |
| `browser_close` | 关闭浏览器（登录态保留） |

核心特性：**持久化登录态**（独立 Chrome profile，登录一次长期有效）、
真人验证兜底（`headless: false` 弹真实窗口手动登录）、Cookie 可跨机器迁移。

## 快速安装（单文件）

```powershell
# 复制 scripts/install-browser-pro.ps1 到目标机器后运行：
powershell -ExecutionPolicy Bypass -File .\install-browser-pro.ps1
```

安装器自动完成：
1. 解析 DSH 主目录（`$env:DSH_HOME`，其次 `~\.dsh`）
2. 写入预设 `.<DSH_HOME>\.agent-presets\browser-pro\`（自动填好插件路径）
3. 写入插件 `<DSH_HOME>\browser-agent\`（插件 + 服务端 + 配置）
4. 自动 `npm install playwright-core@1.61.1`（可 `-NoNpm` 跳过）
5. 检测 Chrome，未安装时提示改用 Edge

参数：`-DshHome <dir>`、`-NoNpm`、`-Force`。完成后**重启 DSH**，新会话选择预设「浏览器调研模式」。

## 手动安装 / 开发

```powershell
# 1. 放置插件目录（任意位置）
mkdir %USERPROFILE%\.dsh\browser-agent
copy browser-agent\* %USERPROFILE%\.dsh\browser-agent\
cd %USERPROFILE%\.dsh\browser-agent
npm install playwright-core@1.61.1

# 2. 安装预设（agent.cordis.yml 中的 {{PLUGIN_PATH}} 需替换为实际插件路径）
mkdir %USERPROFILE%\.dsh\.agent-presets\browser-pro
copy preset\* %USERPROFILE%\.dsh\.agent-presets\browser-pro\

# 3. 重新构建单文件安装器（可选，改过源码后执行）
powershell -File scripts\build-installer.ps1
```

## 目录结构

```
dsh-browser-agent/
├── README.md
├── LICENSE                    # CC BY-NC 4.0 + 附加条款（保留项目名）
├── browser-agent/             # 插件本体（Cordis 插件 + Playwright 服务）
│   ├── browser-agent-plugin.mjs
│   ├── server.cjs
│   ├── config.json            # channel / headless / executablePath
│   ├── package.json           # playwright-core@1.61.1
│   └── README.md
├── preset/                    # DSH 预设（浏览器调研模式）
│   ├── preset.yml
│   └── agent.cordis.yml       # 含 {{PLUGIN_PATH}} 占位符
└── scripts/
    ├── install-browser-pro.ps1      # 单文件安装器（交付物）
    ├── installer.template.ps1       # 安装器模板
    └── build-installer.ps1          # 重新生成安装器
```

## 架构

```
Agent
  └─ browser_* 工具（Cordis 插件，Host 端）
       └─ subprocess 服务派生 node server.cjs   ← DSH 主机进程，不受 pwsh 沙箱限制
            └─ playwright-core 1.61.1
                 └─ Chrome（channel: chrome / msedge）
                      ├─ 持久化 profile ./profile   ← 登录态跨重启保留
                      └─ 截图输出 ./shots
```

插件与服务间使用 **stdio 换行分隔 JSON 协议**（服务不暴露 HTTP 端口）。
可移植性：Node 取 `process.execPath`（可用 `DSH_BROWSER_NODE` 覆盖），
所有路径由插件自身位置推导，整个目录可复制到任意机器。

## 配置说明（config.json）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `channel` | `chrome` | 无 Chrome 时改为 `msedge`（Windows 自带） |
| `headless` | `true` | 需要真人扫码/验证码时改为 `false` |
| `executablePath` | `""` | 指定浏览器可执行文件路径（可选） |

## 许可证

本项目采用 **CC BY-NC 4.0（署名-非商业性使用 4.0 国际版）**，并附加条款：
**任何修改/衍生/再分发版本必须保留原项目名称 `dsh-browser-agent`**，不可商用、不可改名。
详见 [LICENSE](LICENSE)。

> 说明：CC BY-NC 4.0 为非 OSI 认证协议，禁止任何商业使用（包括商用衍生品）。

## 免责声明

- 默认 headless；强反爬站点（如小红书、TikTok 等）仍可能触发风控/验证码，请放慢操作节奏。
- `browser_evaluate` 可在页面内执行任意 JS，请勿对不可信页面执行敏感操作。
- 高频自动化操作第三方平台可能违反其服务条款，请自行评估合规风险。
