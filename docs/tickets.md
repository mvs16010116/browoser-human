# 工单（browser-human 双通道改造）

依赖关系：T1 → T2 → T3；T4 独立；T5 依赖 T1。

## 批 1（P0 止损，只加策略与路由，不改既有签名）

### T1 抽出策略模块 `site-policy.js`
- 产出：`STRICT_SITES` 解析（`MCP_STRICT_SITES`）、`matchStrictSite(url, sites)`、`routeFor(url, sites)`
- 单测：`test/site-policy.test.mjs`（后缀匹配、子域、大小写、非法 URL、空表）
- 完成判据：纯函数、无 IO、`node --test` 覆盖

### T2 把路由接进 `goto` / `new_tab` / `page_info` / `open_browser`
- `goto`、`new_tab` 返回文本附 `channel` 与原因；`kimi` 时给出扩展通道用法提示
- `page_info` 增加 `route` 字段
- `open_browser` 返回文本附当前通道
- 完成判据：A1/A2/A3 通过；既有工具参数无变化

## 批 2（P1 CDP 整改）

### T3 `foreground` 参数 + 关闭焦点模拟 + 指纹自检
- `open_browser({ foreground })`，默认 `false`；`true` 时 `bringToFront()`
- 新页建好后 `Emulation.setFocusEmulationEnabled({enabled:false})`
- `fingerprintReport()` 采集并追加 `logs/fingerprint.log`；`DEBUG_FINGERPRINT=1` 时进入 `page_info`
- 完成判据：A4/A9 通过；关闭焦点模拟失败时不报错

### T4 `human_*` 可见性断言 + 指针轨迹 + 输入分块
- 公共入口 `ensurePageVisible(p)`（`MCP_VISIBILITY_GUARD=0` 可关）
- `human_click` / `human_double_click` 前插入 2~3 段贝塞尔移动
- `human_type` 8~12 字符分块，块间 50~150ms
- 完成判据：A5/A6 通过；不新增工具、不返回中间态

## 批 3（Token）

### T5 `page_text` 收口
- 增加 `selector`，`maxChars` 默认 8000，截断回报剩余字符数
- 三个读类工具的 description 标注读路径优先级
- 完成判据：A7/A8 通过

## 收尾

### T6 文档与交接
- README 的「反检测对齐」与「环境变量」表同步新版行为
- `docs/handoff.md`
- 全量 `npm test`
