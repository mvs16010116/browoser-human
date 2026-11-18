# Spec：反风控双通道 + 读路径省 token

- 依据：`docs/ADR-001-双通道与读写分离.md`
- 范围：`browser-human` 服务本体；不改 MCP 客户端配置，不改 kimi-webbridge
- 目标站点策略：默认空表，用户按实测填入

## 1. 站点策略与路由

### 1.1 策略表来源
- 环境变量 `MCP_STRICT_SITES`，逗号分隔的域名后缀，例如 `taobao.com,x.com`。
- 匹配规则：取目标 URL 的 `hostname`，与其相等或以 `.` + 后缀结尾即命中（大小写不敏感）。
- URL 非法或为空时：不命中。

### 1.2 路由决策
输入 `url`，输出：

```json
{ "channel": "cdp" | "kimi", "strict": true, "matched": "taobao.com", "reason": "命中的强风控后缀" }
```

规则：
1. 命中策略表 → `channel: "kimi"`，`strict: true`；
2. 未命中 → `channel: "cdp"`，`strict: false`，`reason` 说明「未命中策略表」。

### 1.3 暴露点（不新增工具）
- `open_browser`：返回文本附当前通道（初始为空白会话页，恒为 `cdp`）。
- `goto`、`new_tab`：返回文本附 `channel` 与判定原因；`channel: "kimi"` 时额外提示「后续写操作建议改走 kimi-webbridge 的 `navigate` / `click` / `fill`」。
- `page_info`：JSON 增加 `route: { channel, strict, matched, reason }`。

## 2. CDP 通道整改

### 2.1 `open_browser`
- 新增可选参数 `foreground`（boolean，默认 `false`），保持向后兼容。
- `foreground: true` 时：建页后对新页调用 `bringToFront()`，随后返回文本注明「已前置」。

### 2.2 关闭焦点模拟
- 每个新会话页在纳入管理后，通过该页的 CDP 会话发送 `Emulation.setFocusEmulationEnabled({ enabled: false })`；失败静默降级（不影响功能）。

### 2.3 可见性前置断言
- 所有 `human_*` 工具（含 `human_sleep`）在执行前检查 `document.visibilityState`。
- 非 `visible` 时：先 `bringToFront()` 重试一次；仍非 `visible` 则抛出 `页面不可见（visibilityState=hidden），输入会被浏览器丢弃；请先 open_browser({foreground:true}) 或 bringToFront`。
- 断言开销：只在动作前做一次 `evaluate`，不缓存。

### 2.4 指针轨迹
- `human_click` / `human_double_click` 在点击前插入 2~3 段贝塞尔移动（起点为上一次指针位置，未知时用视口内随机点近似），段间停 15~40ms 随机。
- 不新增工具，不返回中间态；`human_move` 显式调用时同样更新指针记忆。

### 2.5 输入节奏
- `human_type`（非 `usePaste` 路径）按 8~12 字符随机分块，块间停 50~150ms。
- 分块后的兜底仍走原有 `p.keyboard.type`。

### 2.6 指纹自检
- 建页成功后采集：`navigator.webdriver`、`document.hasFocus()`、`document.visibilityState`、`navigator.permissions.query({name:"notifications"})` 状态、`window.chrome` 是否存在。
- 追加一行 JSON 到 `logs/fingerprint.log`（目录不存在时创建）；失败不影响主流程。
- `DEBUG_FINGERPRINT=1` 时，把最近一次自检结果放入 `page_info` 返回值。

## 3. 读路径收口

### 3.1 `page_text`
- 参数：`selector`（可选，默认 `body`）、`frame`、`maxChars`（默认 8000）。
- 输出 `innerText`；超限时截断并附 `…（已截断，共 N 字符，剩余 M 字符）`。

### 3.2 工具描述
- `page_text`、`get_accessibility_tree`、`screenshot` 的 description 标注读路径优先级：优先 `capture_network` 重放 / `evaluate` 结构化取值，正文读取是最后手段。

## 4. 非目标
- 不新增 `kimi_*` 写工具（kimi-webbridge 自身已是独立 MCP/Skill）。
- 不伪造 UA / 屏幕 / 插件。
- 不做 JS 层 `Runtime.enable` 对抗。
- 不改 `capture_network` / `http_request` / 标签页管理行为。

## 5. 验收标准

| 编号 | 场景 | 期望 |
|---|---|---|
| A1 | `MCP_STRICT_SITES=taobao.com`，`goto("https://s.taobao.com/x")` | 返回含 `channel: kimi`，并提示改走扩展通道 |
| A2 | 同上，`goto("https://example.com")` | 返回含 `channel: cdp` |
| A3 | `page_info` | 含 `route` 字段，取值与 A1/A2 一致 |
| A4 | `open_browser({foreground:true})` | 会话页被前置；返回文本注明前置 |
| A5 | 后台页调用 `human_click` | 自动激活后成功；激活失败时报错可读，不静默 |
| A6 | `human_type` 输入 30 字符 | 分 3 块左右写入，总耗时明显大于一次性写入 |
| A7 | `page_text` 读长页 | 输出不超过 8000 字符 + 截断提示（含剩余字符数） |
| A8 | `page_text({selector:"#main"})` | 只返回该元素文本 |
| A9 | 建页后 | `logs/fingerprint.log` 追加一行含 `visibilityState` / `hasFocus` |
| A10 | `npm test` | 全绿 |

## 6. 风险与回滚
- 可见性断言在极少数「页面确实不可见但输入仍可送达」的场景会误报；回滚开关：`MCP_VISIBILITY_GUARD=0`。
- 关闭焦点模拟后，若某些站点依赖虚构焦点渲染，可在 `MCP_FOCUS_EMULATION=1` 时恢复默认行为。
- 策略表为空时，行为与改造前完全一致（除读路径截断默认值）。
