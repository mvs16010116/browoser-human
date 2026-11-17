/**
 * 直接调用接口时的请求/响应适配：
 * - 剔除由运行时自动生成、沿用会出错的请求头
 * - 把各种形态的 Cookie 统一成 Cookie 请求头的值
 * - 按 content-type 决定响应以文本还是 base64 呈现
 */

// 这些头由 Playwright 运行时生成，沿用抓包值会造成请求异常
const REPLAY_DROP_HEADERS = new Set(["host", "content-length", "connection", "accept-encoding"]);
const TEXTUAL_TYPE = /(json|text|xml|javascript|x-www-form-urlencoded)/i;

/** 从抓包记录的请求头里挑出可安全重放的项 */
export function replayHeaders(headers) {
  const kept = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!REPLAY_DROP_HEADERS.has(name.toLowerCase())) {
      kept[name] = value;
    }
  }
  return kept;
}

/**
 * 统一 Cookie 入参：
 * - 字符串原样返回（已是 `a=1; b=2` 形式）
 * - 数组按 `name=value` 拼接，兼容 capture_network includeCookies 的输出
 * 返回空字符串表示不显式指定，交由浏览器 Cookie 存储自动携带。
 */
export function formatCookies(cookies) {
  if (!cookies) {
    return "";
  }
  if (typeof cookies === "string") {
    return cookies.trim();
  }
  return cookies
    .filter((cookie) => cookie && cookie.name)
    .map((cookie) => `${cookie.name}=${cookie.value ?? ""}`)
    .join("; ");
}

/** 按内容类型读取响应：文本直出，二进制给 base64 前缀 */
export async function readResponse(resp, maxChars) {
  const buffer = await resp.body();
  const contentType = resp.headers()["content-type"] || "";
  const raw = TEXTUAL_TYPE.test(contentType) || !contentType
    ? buffer.toString("utf8")
    : `[二进制响应 ${buffer.length} 字节，以下为 base64 前缀]\n${buffer.toString("base64")}`;
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…（已截断，共 ${raw.length} 字符）` : raw;
}
