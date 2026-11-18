# 术语表（browser-human）

| 术语 | 定义 | 备注 |
|---|---|---|
| **CDP 通道** | 通过 `chromium.connectOverCDP()` 附着用户 Chrome 后，由 Playwright 驱动页面的工作方式 | 本项目原生通道；写事件 `isTrusted=true`；存在 `Runtime.enable` 等协议痕迹 |
| **扩展通道** | 通过 kimi-webbridge（扩展 + 127.0.0.1:10086 daemon）驱动页面的工作方式 | 无 CDP 会话；写事件 `isTrusted=false` |
| **强风控站点** | 实测会因 CDP 痕迹拒绝或降级服务的站点；在策略表中以域名后缀登记 | 见 `MCP_STRICT_SITES` |
| **路由决策** | 给定目标 URL，判定建议通道（`cdp` / `kimi`）与判定原因 | 只给建议与告警，不擅自切换执行者 |
| **策略表** | 强风控站点域名后缀集合，支持子域匹配 | 默认空表，需按实际观测填入 |
| **可见性前置断言** | 执行输入类动作前检查 `document.visibilityState`，非 `visible` 先激活页面，失败即报错 | 避免静默丢弃输入 |
| **焦点模拟** | Playwright 默认注入的 `Emulation.setFocusEmulationEnabled(true)`，让后台页伪装成有焦点 | 本服务建页后显式关闭 |
| **指纹自检** | 在页面内采集 `webdriver` / `hasFocus` / `visibilityState` / `permissions` 等可观测值并落盘 | 供排障，不参与运行时决策 |
| **读路径** | 把页面信息带回给 agent 的手段，按成本从低到高：抓包重放 → `evaluate` → `snapshot` → `page_text` | 优先低成本的路径 |
| **token 截断** | 输出超过 `maxChars` 时截断，并回报剩余字符数 | 由 agent 决定是否继续读 |
