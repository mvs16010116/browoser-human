/**
 * 站点策略与通道路由（纯逻辑，无 IO，便于单测）。
 *
 * 背景见 docs/ADR-001：本服务用 CDP 驱动页面，Playwright 附着必然留下协议痕迹，
 * 强风控站点应改走扩展通道。这里只做「该用哪条通道」的判定，不负责执行。
 */

/** 默认策略表：留空，由 MCP_STRICT_SITES 按实测填充 */
export const DEFAULT_STRICT_SITES = Object.freeze([]);

const CHANNEL_CDP = "cdp";
const CHANNEL_KIMI = "kimi";

/**
 * 解析逗号分隔的域名后缀表，去空、去协议前缀、转小写、去重。
 * @param {string|undefined} raw
 * @returns {string[]}
 */
export function parseStrictSites(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  const seen = new Set();
  for (const item of raw.split(",")) {
    const host = item
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^\.+/, "");
    if (host) {
      seen.add(host);
    }
  }
  return [...seen];
}

/** 取 URL 的 hostname；非法 URL 返回空串 */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 判断 URL 是否命中强风控策略表。
 * 匹配规则：hostname 与后缀相等，或以 "." + 后缀结尾。
 * @param {string} url
 * @param {string[]} sites
 * @returns {string|null} 命中的后缀，未命中返回 null
 */
export function matchStrictSite(url, sites = DEFAULT_STRICT_SITES) {
  const host = hostOf(url);
  if (!host) {
    return null;
  }
  for (const site of sites) {
    if (host === site || host.endsWith(`.${site}`)) {
      return site;
    }
  }
  return null;
}

/**
 * 路由决策：命中策略表建议走扩展通道，否则走本服务 CDP 通道。
 * @param {string} url
 * @param {string[]} sites
 * @returns {{channel: "cdp"|"kimi", strict: boolean, matched: string|null, reason: string}}
 */
export function routeFor(url, sites = DEFAULT_STRICT_SITES) {
  const matched = matchStrictSite(url, sites);
  if (matched) {
    return {
      channel: CHANNEL_KIMI,
      strict: true,
      matched,
      reason: `命中强风控站点后缀 ${matched}：CDP 痕迹可能被识别，写操作建议改走 kimi-webbridge`
    };
  }
  return {
    channel: CHANNEL_CDP,
    strict: false,
    matched: null,
    reason: "未命中强风控策略表，使用 CDP 通道"
  };
}

/** 当前进程的强风控策略表（环境变量 MCP_STRICT_SITES） */
export const STRICT_SITES = Object.freeze(
  parseStrictSites(process.env.MCP_STRICT_SITES)
);
