/**
 * iframe 定位支持：把 frame 引用（索引 / name / URL 片段）解析成 Playwright 的 Frame。
 * Page 与 Frame 都提供 locator / evaluate / waitForLoadState，因此上层用同一套 API 操作，
 * 不需要区分主文档还是子 frame；跨域 iframe 也走同一条路径（Playwright 在浏览器进程内解析）。
 */

/** 列出当前页全部 frame，索引 0 固定为主文档 */
export function listFrames(page) {
  return page.frames().map((frame, index) => ({
    index,
    name: frame.name() || "",
    url: frame.url()
  }));
}

/**
 * 解析 frame 引用：
 * - 不传（undefined / null）→ 主文档
 * - 数字 → frames() 的下标
 * - 字符串 → 先按 name 精确匹配，再按 URL 包含匹配
 */
export function resolveFrame(page, ref) {
  const frames = page.frames();
  if (ref === undefined || ref === null) {
    return page.mainFrame();
  }
  if (typeof ref === "number") {
    const hit = frames[ref];
    if (!hit) {
      throw new Error(`frame 索引越界：当前共 ${frames.length} 个 frame（0 为主文档）`);
    }
    return hit;
  }
  const byName = frames.find((frame) => frame.name() === ref);
  if (byName) {
    return byName;
  }
  const byUrl = frames.find((frame) => frame.url().includes(ref));
  if (byUrl) {
    return byUrl;
  }
  const available = frames.map((frame, index) => `${index}:${frame.url()}`).join(", ");
  throw new Error(`未找到 frame「${ref}」，可用：${available}`);
}
