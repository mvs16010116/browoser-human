# browser-human

一个附着到**你本机正在运行的 Chrome** 上的 MCP 服务。它不另起浏览器、不新建 profile，直接复用你的登录态、Cookie 和扩展，用拟人化输入操作页面，并支持后台开标签与网络抓包。

## 设计原则

| 原则 | 实现 |
|---|---|
| 复用真实登录态 | 通过 CDP 附着用户 Chrome，`browser.contexts()[0]` 就是真实 profile |
| 绝不抢焦点 | 新页面用 `Target.createTarget({ background: true, focus: false })`，输入走 CDP `Input` 域，不调用 `bringToFront` |
| 不与用户标签混在一起 | 优先借扩展把标签加入独立分组；扩展不可用时退化为同窗口后台标签 |
| 不启动替代浏览器 | 调试端口不可用时直接报错并给出修复指引，绝不降级到 Playwright 自带浏览器 |

## 前置条件

### Node 与 npm

需要 Node.js >= 18 和 npm。项目依赖由下面“安装”章节的命令自动下载并生成 `node_modules`，不需要手工创建该目录。

### Chrome 调试配置

Chrome 136+ 会**忽略**指向默认 `User Data` 目录的 `--remote-debugging-port`。解决办法是建一个目录联接指向同一个 profile：路径不是默认值（通过 Chrome 检查），文件仍是同一份（登录态天然共享）。

```powershell
New-Item -ItemType Junction `
  -Path  "$env:LOCALAPPDATA\ChromeDebugUserData" `
  -Target "$env:LOCALAPPDATA\Google\Chrome\User Data"
```

然后用带调试端口的参数启动（或直接调用 `restart_chrome_with_debugging` 工具，它会完成同样的动作）：

```
chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\ChromeDebugUserData" --restore-last-session
```

验证：`curl http://127.0.0.1:9222/json/version` 有返回即就绪。

## 安装

从零创建项目时，按以下顺序执行；`node_modules` 会在 `npm install` 阶段自动生成：

```bash
mkdir browser-human && cd browser-human
npm init -y
npm install playwright @humanjs/playwright zod
# 安装浏览器 chromium
npx playwright install chromium
npm install @modelcontextprotocol/sdk
node browser-human.js
```

其中 `npx playwright install chromium` 安装的 Chromium 供 Playwright 测试使用；本服务运行时仍通过 CDP 复用你本机正在运行的 Chrome，不会启动替代浏览器。

如果使用本仓库现有代码，根目录已有 `package.json` / `package-lock.json`，在项目根目录执行 `npm install`（或 `npm ci` 严格按锁文件还原）即可生成 `node_modules`，再运行 `node browser-human.js`。

> 当前 `browser-human.js` 未直接 import `playwright-stealth`；上面的命令保留从零搭建时的原始步骤，若仅需运行本项目可省略该包。

### `node_modules` 目录从哪里来

`node_modules` 不是手工编写或需要提交到 Git 的源码目录，而是在项目根目录执行 `npm install` 时，由 npm 根据本项目根目录的 `package.json` 和 `package-lock.json` 自动下载并生成的本地依赖目录。

该目录已经写入 `.gitignore`，因此不会推送到 Git 仓库。新克隆仓库后，在项目根目录执行下面任一命令即可重新得到 `node_modules`：

```bash
npm install
# 或严格按 package-lock.json 还原依赖版本
npm ci
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "browser-human": {
      "command": "node",
      "args": ["D:/path/to/browser-human.js"]
    }
  }
}
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_CHROME_CDP` | `http://127.0.0.1:9222` | 调试端口地址 |
| `MCP_CHROME_PATH` | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Chrome 可执行文件路径 |
| `MCP_CHROME_PROFILE` | `%LOCALAPPDATA%\Google\Chrome\User Data` | 真实 profile 路径 |
| `MCP_DEBUG_PROFILE` | `%LOCALAPPDATA%\ChromeDebugUserData` | 目录联接路径 |
| `MCP_KIMI_BRIDGE` | `http://127.0.0.1:10086` | 扩展桥地址（用于 tab 分组，可选） |
| `MCP_KIMI_SESSION` | `browser-human` | 分组会话名 |

## 工具清单（35 个）

**生命周期**

`open_browser` `close_browser` `restart_chrome_with_debugging` `goto` `page_info` `list_tabs` `new_tab` `switch_tab`

**页面探查**

`page_text` `get_accessibility_tree` `evaluate` `screenshot` `wait_for`

**拟人化输入**

`human_click` `human_double_click` `human_right_click` `human_hover` `human_move` `human_drag` `human_type` `human_paste` `human_clear` `human_press` `human_check` `human_uncheck` `human_select_option` `human_upload` `human_select_text` `human_scroll` `human_read` `human_sleep`

**其他**

`dialog_settings`（alert/confirm 策略）`download_file`（带 Referer 下载到任意路径）`capture_network`（网络抓包）`http_request`（直接调用接口）

## iframe（frame）支持

先调 `page_info`，返回的 `frames` 列出当前页全部 frame（`index` / `name` / `url`，索引 0 为主文档）。

再把 `frame` 传给目标工具，取值三种：

```text
1            索引（0 是主文档）
panel        frame 的 name 属性
/frame       子串匹配 frame 的 URL（跨域 iframe 同样命中）
```

覆盖工具：`page_text` `get_accessibility_tree` `wait_for` `evaluate` 与全部元素类 `human_*`（点击、双击、右键、悬停、拖拽、输入、粘贴、清空、勾选、下拉、上传、选中文本、滚动、阅读）。

```json
{ "tool": "human_type", "args": { "frame": "panel", "selector": "#kw", "text": "hello" } }
```

指定 `frame` 时必须用 `selector`（视口坐标无法跨 frame 定位）；跨域 iframe 由浏览器进程内部解析，不需要任何切换动作。键盘类 `human_press` 按键发往当前焦点元素，焦点在 iframe 内时可直接使用。

## 程序化调用接口

抓包看到接口后可以不用手工抄参数直接调用：`capture_network` 的 dump 结果每行都带 `index`，把它交给 `http_request` 即可沿用该请求的 url / method / body / headers。

```json
{ "tool": "capture_network", "args": { "action": "dump", "includeHeaders": true } }
{ "tool": "http_request", "args": { "captureIndex": 3 } }
```

也可以完全手工指定：

```json
{ "tool": "http_request", "args": { "method": "POST", "url": "https://x/v1/query", "body": "{\"page\":1}" } }
```

- 请求由 Playwright 的 `APIRequestContext` 发出，与浏览器**共享 Cookie 存储**（含 HttpOnly），因此登录态天然可用，且**不受 CORS 限制**
- 需要显式指定 Cookie 时传 `cookies`：字符串按 `a=1; b=2` 原样作为 `Cookie` 头，数组 `[{name,value}]` 会自动拼接（可直接用 `capture_network` 带 `includeCookies` 的 dump 结果）；显式传入会覆盖自动携带的 Cookie
- `Referer` 默认取当前页地址；`headers` 可覆盖任意头（如 `x-token`）
- 自动剔除 `host` / `content-length` / `connection` / `accept-encoding` 这些由运行时生成的头
- 响应按 `content-type` 判断：文本直出，二进制给 base64 前缀；`status` 与响应头一并返回
- Token 若存在 `localStorage`（而非 Cookie）里，先用 `evaluate` 取出来，再通过 `headers` 传入

## 网络抓包

`capture_network` 的动作由 `action` 区分：

```text
start   清空缓冲并开始录制，可带 filter（URL 正则）与 captureBody
stop    停止录制但保留数据
dump    取结果，可带 filter / limit / includeHeaders / includeCookies / includeBody / maxChars
clear   清空缓冲
```

典型用法 —— 找出某个页面刷新时调用的接口：

```text
capture_network({ action: "start", filter: "order", captureBody: true })
→ 刷新页面或点击查询按钮
capture_network({ action: "dump", includeHeaders: true, includeCookies: true })
```

返回每条请求的 `method` / `url` / `type` / `status` / `postData` / `requestHeaders` / `responseHeaders`，开启 `includeBody` 后附带响应体。

说明：

- 同源请求的 `requestHeaders` 里通常没有 `cookie`，需要 Cookie 时用 `includeCookies: true`，模块会按 URL 从浏览器 Cookie 库补齐（含 HttpOnly）
- 内存缓冲上限 500 条，超出部分计入 `dropped` 字段，不会静默丢弃
- 缓冲只存在内存中，进程结束即销毁，不落盘

## 已知限制

- **CDP 没有标签组能力**：真正的 tab 分组只能靠扩展（`chrome.tabs.group`）。本服务优先调用本机扩展桥完成分组，扩展不可用时退化为同窗口后台标签——不会新开窗口
- **frame 需显式指定**：iframe 内的元素不会自动降级到主文档查找，必须先 `page_info` 查 `frames` 再传 `frame`；多层嵌套的 frame 用其自身索引/name/URL 定位
- **无 PDF/MHTML 另存**：需要归档时请自行扩展
- **Windows 专用**：进程探测、Chrome 路径、目录联接均基于 Windows

## 测试

```bash
npm test
```

覆盖三类行为：抓包模块的录制开关、URL 过滤、条数上限、字段开关、事件解绑（用假 Page 驱动，不依赖真实浏览器）；frame 解析的索引/name/URL 匹配与报错；跨域 iframe 内拟人点击与输入的真实端到端验证（需本机 Playwright Chromium，缺失时自动跳过）。

## 注意

- 本服务复用你的真实浏览器 profile，具备等同你本人的操作能力。不要让不可信的 MCP 客户端连接它
- `session.json`、`.env`、日志等运行产物已在 `.gitignore` 中屏蔽，请勿提交
