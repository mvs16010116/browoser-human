# Handoff：反风控双通道 + 读路径省 token

- 日期：2026-11-18
- 状态：代码与单测完成；未提交、未推送、未部署
- 依据：`docs/ADR-001-双通道与读写分离.md`、`docs/spec.md`、`docs/tickets.md`

## 1. 做了什么

### 批 1：策略与路由（P0）
- 新增 `site-policy.js`（纯函数，无 IO）
  - `parseStrictSites(raw)`：解析 `MCP_STRICT_SITES`（逗号分隔，去协议/路径、转小写、去重）
  - `matchStrictSite(url, sites)`：hostname 相等或以 `.` + 后缀结尾即命中，不误伤 `nottaobao.com` / `taobao.com.evil.cn`
  - `routeFor(url, sites)`：返回 `{ channel, strict, matched, reason }`
- `goto`、`new_tab` 的返回文本附通道与判定原因；命中强风控时直接给出 kimi-webbridge 的用法建议
- `page_info` 增加 `route` 字段；`open_browser` 返回当前通道
- 既有工具参数**零变更**（`goto` / `new_tab` / `page_info` 签名不变）

### 批 2：CDP 整改（P1）
- `open_browser({ foreground })`，默认 `false`；`true` 时 `bringToFront()` 并回显「会话页已前置」
- 建页后对页 CDP 会话下发 `Emulation.setFocusEmulationEnabled({ enabled: false })`，消除「hidden 却有焦点」的矛盾
- 所有 `human_*` 公共入口加可见性前置断言：不可见 → 先 `bringToFront` → 仍不可见则抛可读错误
- `human_click` / `human_double_click`：点击前 2~3 段贝塞尔移动（起点取上次落点），不新增工具、不返回中间态；`human_move` 同步更新指针记忆
- `human_type`：按 8~12 字符分块，块间 50~150ms（`usePaste` 与原有兜底不变）
- 建页后采集指纹（`webdriver` / `visibilityState` / `hasFocus` / 通知权限 / `window.chrome`），追加 `logs/fingerprint.log`；`DEBUG_FINGERPRINT=1` 时随 `page_info` 返回

### 批 3：读路径
- `page_text` 新增 `selector`（默认 `body`），`maxChars` 默认 8000，截断时回报总字符数与剩余字符数
- `page_text` / `get_accessibility_tree` / `screenshot` 增加工具级 description，标注读路径优先级

### 文档
- `docs/ADR-001-双通道与读写分离.md`：根因（三条 CDP 命令）、六项决策与依据、未采纳备选
- `docs/glossary.md`：通道/路由/断言/读路径等术语
- `docs/spec.md`：行为契约与 A1~A10 验收标准
- `docs/tickets.md`：T1~T6 工单与依赖
- `README.md`：设计原则、环境变量表、反检测条目 4~6、新增「通道路由」「读路径与 token」两节

## 2. 如何验证

```bash
cd D:\Danny\browser-human
npm test              # 期望 55 pass / 0 fail
node --check browser-human.js
```

已执行结果：`tests 55 / pass 55 / fail 0`（含新增 `test/site-policy.test.mjs` 8 条）；`browser-human.js` 语法检查通过；空 stdin 启动即正常退出（工具注册无异常）。

手工验收（需本机 Chrome 已开 9222）：

```powershell
$env:MCP_STRICT_SITES='taobao.com'
# A1: goto("https://s.taobao.com/x")  → 返回含「通道 kimi」+ 扩展通道建议
# A2: goto("https://example.com")     → 返回含「通道 cdp」
# A3: page_info                        → route.channel 与 A1/A2 一致
# A4: open_browser({foreground:true})  → 回显「会话页已前置」
# A5: 后台页直接 human_click           → 自动前置后成功；不可前置时报可读错误
# A7/A8: page_text 长页 / page_text({selector:"#main"})
# A9: logs/fingerprint.log 出现含 visibilityState / hasFocus 的 JSON 行
```

## 3. 遗留项

1. **A5/A6/A9 尚未在真实浏览器上跑过**：本机未确认 9222 可用，且工具未导出为可直接调用的函数；需要一次真实会话验收。
2. **策略表为空**：`MCP_STRICT_SITES` 默认空，需按实际被拦站点填写；建议每次命中风控后回填并记录到 ADR。
3. **焦点模拟可能被 Playwright 重新打开**：若后续版本在 `bringToFront` 或输入路径重发 `setFocusEmulationEnabled(true)`，`visibilityState`/`hasFocus` 会再次矛盾。指纹日志是发现该回归的入口。
4. **`human_*` 的可见性断言会主动前置页面**：与原「绝不抢焦点」相比是有意取舍（默认仍后台开页），已在 ADR D3 记录。
5. 未做 `code-review` / 未提交 / 未推送：按链约定，推送需用户明确要求。

## 4. 回滚开关

| 变量 | 作用 |
|---|---|
| `MCP_VISIBILITY_GUARD=0` | 关闭可见性断言（回到静默发送） |
| `MCP_FOCUS_EMULATION=1` | 恢复 Playwright 默认焦点模拟 |
| `MCP_POINTER_TRAIL=0` | 关闭点击前贝塞尔轨迹 |
| `MCP_ACTION_JITTER_MS=0` | 关闭动作前抖动 |
| `MCP_STRICT_SITES` 置空 | 路由恒为 `cdp`，行为等同改造前 |

## 5. 下一步建议

1. 在真实 Chrome 上走一遍 A1~A9，把实测被拦的站点回填 `MCP_STRICT_SITES`
2. 连续跑几天后抽查 `logs/fingerprint.log`，确认 `visibilityState` 与 `hasFocus` 不再同时矛盾
3. 若要进一步降 token：把 `capture_network` 的 dump 输出默认收紧（`limit: 20`、`maxChars: 500`），并在工具描述里把「重放优先」写进协议层 instructions
