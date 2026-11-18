import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium } from "playwright";
import { z } from "zod";
import { createHuman } from "@humanjs/playwright";
import { createNetworkCapture } from "./network-capture.js";
import { listFrames, resolveFrame } from "./frame-support.js";
import { formatCookies, readResponse, replayHeaders } from "./http-client.js";
import { createTabManager, DEFAULT_MAX_TABS, DEFAULT_IDLE_CLOSE_MS } from "./tab-manager.js";
import { routeFor, STRICT_SITES } from "./site-policy.js";
import { patchChromeAutolaunch, patchChromeShortcuts } from "./chrome-shortcuts.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 唯一工作方式：附着用户的 Chrome，复用真实登录态；禁止另起任何浏览器实例
const CDP_ENDPOINT = process.env.MCP_CHROME_CDP || "http://127.0.0.1:9222";
// 实际使用的端点：默认 9222；若用户 Chrome 已用其他调试端口启动，附着前会自动切换到该端口
let cdpEndpoint = CDP_ENDPOINT;
const CHROME_PATH =
  process.env.MCP_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// 用户真实 profile（登录态所在），与桌面快捷方式一致
const CHROME_PROFILE =
  process.env.MCP_CHROME_PROFILE ||
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
// Chrome 136+ 会忽略"默认目录"上的 --remote-debugging-port，必须换成非默认路径。
// 这里用目录联接（junction）指向同一个 profile：路径不是默认值，文件仍是同一份，
// 所以 Cookie / 登录态 / 扩展与用户日常浏览器完全一致。
const DEBUG_PROFILE =
  process.env.MCP_DEBUG_PROFILE ||
  path.join(process.env.LOCALAPPDATA || "", "ChromeDebugUserData");
// CDP 协议没有 tab 组能力，只能借已安装的 kimi-webbridge 扩展建组：
// 页面仍由 CDP 控制（真实输入事件），扩展只负责"在用户窗口里开一个分组标签"。
const KIMI_BRIDGE = process.env.MCP_KIMI_BRIDGE || "http://127.0.0.1:10086";
const KIMI_SESSION = process.env.MCP_KIMI_SESSION || "browser-human";
const TAB_GROUP_TITLE = "BROWSER-HUMAN";
// 扩展对 about:blank 会等到 30s 超时才返回失败（tab 其实已建出来），
// 用 data: 空白页替代：加载即完成，百毫秒级返回
const IDLE_PAGE = "data:text/html,<title>BROWSER HUMAN</title>";

let browser = null;
let page = null;
let human = null;
let mcpWindowId = null;           // 兜底模式下的 MCP 专属窗口
let tabGroupMode = false;         // true 表示标签开在用户窗口的「BROWSER-HUMAN」分组里
// 标签页上限：超过后按最久未使用顺序回收，避免 agent 反复开页造成标签泛滥
const MAX_TABS = Number(process.env.MCP_MAX_TABS) || DEFAULT_MAX_TABS;
// 空闲回收阈值：0 表示不启用；闲置超时后关闭全部会话标签并断开
const IDLE_CLOSE_MS =
  process.env.MCP_IDLE_CLOSE_MS === undefined
    ? DEFAULT_IDLE_CLOSE_MS
    : Number(process.env.MCP_IDLE_CLOSE_MS);
let capture = null;               // 网络抓包器，绑定当前页
let capturePage = null;           // 抓包器绑定的页，换页时重建
const tabs = createTabManager({ maxTabs: MAX_TABS, idleCloseMs: IDLE_CLOSE_MS });

// 探测指定端点（默认当前端点）的调试端口是否可用
async function isCdpUp(endpoint = cdpEndpoint) {
  try {
    const res = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(1500)
    });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 反风控：humanjs 默认会在页面里注入可视化鼠标助手：
//   <div data-humanjs-cursor> + <style>@keyframes humanjs-ripple</style> + mousemove 监听
// 这是可被站点直接 querySelector 到的 DOM 痕迹，Kimi 不注入这类元素。
// 关闭 cursor 后仍保留 CDP Input 的真实键鼠事件（isTrusted=true），不损失拟人输入能力。
const HUMAN_OPTIONS = { personality: "careful", seed: 12345, cursor: false };
const ACTION_JITTER_MS = Number(process.env.MCP_ACTION_JITTER_MS ?? 180);
// 可见性断言：后台页发送输入会被浏览器丢弃，动作前必须确认页面可见。MCP_VISIBILITY_GUARD=0 关闭
const VISIBILITY_GUARD = process.env.MCP_VISIBILITY_GUARD !== "0";
// Playwright 默认给后台页伪造焦点；关掉后 hasFocus 与 visibilityState 不再矛盾。MCP_FOCUS_EMULATION=1 恢复默认
const DISABLE_FOCUS_EMULATION = process.env.MCP_FOCUS_EMULATION !== "1";
// 点击前的贝塞尔轨迹：补掉「瞬移点击」这一行为特征。MCP_POINTER_TRAIL=0 关闭
const POINTER_TRAIL = process.env.MCP_POINTER_TRAIL !== "0";
// 输入分块：整段一次性注入是最易被行为风控统计的节奏特征
const TYPE_CHUNK_MIN = 8;
const TYPE_CHUNK_MAX = 12;
const TYPE_GAP_MIN_MS = 50;
const TYPE_GAP_MAX_MS = 150;
// 指纹自检：落盘供排障，DEBUG_FINGERPRINT=1 时随 page_info 返回
const DEBUG_FINGERPRINT = process.env.DEBUG_FINGERPRINT === "1";
const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "logs");
const FINGERPRINT_LOG = path.join(LOG_DIR, "fingerprint.log");
let lastFingerprint = null;

function createStealthHuman(page) {
  return createHuman(page, HUMAN_OPTIONS);
}

async function stealthPause() {
  if (ACTION_JITTER_MS <= 0) return;
  await sleep(Math.floor(Math.random() * ACTION_JITTER_MS));
}

// 通道路由的可读描述：把「该不该用这条通道」变成显式信息，而不是静默失败
function describeRoute(url) {
  const route = routeFor(url, STRICT_SITES);
  return route.strict
    ? `通道 ${route.channel}（${route.reason}；写操作建议改用 kimi-webbridge：navigate / snapshot / click / fill）`
    : `通道 ${route.channel}（${route.reason}）`;
}

// 关掉 Playwright 的焦点模拟：后台页不该同时表现为 hidden 且有焦点
async function relaxFocusEmulation(target) {
  if (!DISABLE_FOCUS_EMULATION) {
    return;
  }
  try {
    const cdp = await target.context().newCDPSession(target);
    try {
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch {
    // 会话建立失败不影响主流程
  }
}

// 采集页面内可观测的自动化特征，用于确认改造后还有哪些矛盾值
async function collectFingerprint(target) {
  return target.evaluate(async () => {
    let notificationPermission = "unsupported";
    try {
      const status = await navigator.permissions.query({ name: "notifications" });
      notificationPermission = status.state;
    } catch {
      // 部分上下文不支持该权限查询
    }
    return {
      webdriver: navigator.webdriver,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      notificationPermission,
      chromeObject: typeof window.chrome
    };
  });
}

// 指纹自检落盘：失败只影响日志，不影响业务动作
async function recordFingerprint(target) {
  try {
    const snapshot = { at: new Date().toISOString(), url: target.url(), ...(await collectFingerprint(target)) };
    lastFingerprint = snapshot;
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(FINGERPRINT_LOG, `${JSON.stringify(snapshot)}\n`);
  } catch {
    // 页面已关闭或不支持 evaluate 时忽略
  }
}

/**
 * 输入类动作的前置断言：后台标签页的输入事件会被浏览器丢弃。
 * 不可见时先尝试前置，仍不可见则明确报错，不静默发送。
 */
async function ensurePageVisible(target) {
  if (!VISIBILITY_GUARD) {
    return;
  }
  const stateOf = () => target.evaluate(() => document.visibilityState).catch(() => "unknown");
  if ((await stateOf()) === "visible") {
    return;
  }
  await target.bringToFront().catch(() => {});
  if ((await stateOf()) === "visible") {
    return;
  }
  throw new Error(
    "页面当前不可见（visibilityState 非 visible），输入事件会被浏览器丢弃：请调用 open_browser({foreground:true}) 或先切换到该标签页"
  );
}

// 用户的 Chrome 是否已在运行：按可执行文件绝对路径判断，
// 避免把 Playwright 自带的同名 chrome.exe 误认成用户的浏览器
async function isBrowserRunning() {
  const script = `$p = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*--type=*' -and $_.ExecutablePath -eq '${CHROME_PATH}' }; if ($p) { '1' } else { '0' }`;
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
    return stdout.trim() === "1";
  } catch {
    return false;
  }
}

// 用户的 Chrome 已在运行、但调试端口不是默认 9222 时，从进程命令行里提取真实的
// --remote-debugging-port 并逐个探测：命中即直接附着该实例，无需重启、无需改动 profile。
async function detectRunningDebugPort() {
  const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -like '*--remote-debugging-port=*' } | ForEach-Object { $_.CommandLine }`;
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script]));
  } catch {
    return null;
  }
  const ports = [...new Set([...stdout.matchAll(/--remote-debugging-port=(\d+)/g)].map((m) => m[1]))];
  for (const port of ports) {
    const endpoint = `http://127.0.0.1:${port}`;
    if (await isCdpUp(endpoint)) {
      return { endpoint, port };
    }
  }
  return null;
}

// 轮询等待调试端口就绪
async function waitCdp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpUp()) {
      return true;
    }
    await sleep(400);
  }
  return false;
}

// 建立指向真实 profile 的目录联接：路径不是默认值（绕过 Chrome 136+ 限制），
// 文件却是同一份，登录态天然共享。已有可用联接时直接复用。
async function ensureProfileLink() {
  try {
    await fs.access(path.join(DEBUG_PROFILE, "Local State"));
    return true;
  } catch {
    // 不存在或不是有效的 profile 联接，尝试重建
  }
  try {
    // 只删除联接本身，不会触碰真实 profile 内的任何文件
    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      `if (Test-Path -LiteralPath '${DEBUG_PROFILE}') { [System.IO.Directory]::Delete('${DEBUG_PROFILE}', $false) }`
    ]);
  } catch {
    // 联接不存在时忽略
  }
  try {
    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      `New-Item -ItemType Junction -Path '${DEBUG_PROFILE}' -Target '${CHROME_PROFILE}' | Out-Null`
    ]);
  } catch {
    return false;
  }
  try {
    await fs.access(path.join(DEBUG_PROFILE, "Local State"));
    return true;
  } catch {
    return false;
  }
}

// 用户没开 Chrome 时，用真实 profile（经联接）启动并开启调试端口，再附着。
// 禁止使用任何自带浏览器，保证 Cookie / 扩展 / 登录态与用户日常浏览器完全一致。
async function launchUserChrome() {
  try {
    await fs.access(CHROME_PATH);
  } catch {
    return false;
  }
  if (!(await ensureProfileLink())) {
    return false;
  }
  const port = new URL(CDP_ENDPOINT).port || "9222";
  const child = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${DEBUG_PROFILE}`,
      "--restore-last-session",
      "--no-first-run",
      "--no-default-browser-check"
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  return waitCdp();
}

// 结束会话：只关本会话开出的页；CDP 附着下 browser.close() 只断开连接，不会杀掉用户 Chrome
async function detachOrClose() {
  // 只在本进程真的开过会话时才清扩展会话，避免刚启动就退出时误清别的客户端标签
  const hadSession = Boolean(browser) || tabs.size() > 0;
  await tabs.closeAll();
  // 已跟踪的页关完后，再让扩展清一次会话：兜住 Playwright 侧丢失的页（如进程内换页失败）
  if (hadSession) {
    await kimiCall("close_session", {}, 8000);
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      // 连接已断开时忽略
    }
  }
  browser = null;
  page = null;
  human = null;
  mcpWindowId = null;
  tabGroupMode = false;
  capture?.dispose();
  capture = null;
  capturePage = null;
}

// 优雅关闭用户的 Chrome：只发 WM_CLOSE，不强制杀进程，避免丢失未保存内容。
// 返回是否在超时前完全退出。
async function closeChromeGracefully(timeoutMs = 25000) {
  const script = "$p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }; $p | ForEach-Object { [void]$_.CloseMainWindow() }; 'ok'";
  try {
    await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isBrowserRunning())) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

// JS 弹窗策略：未处理 alert/confirm 会让后续所有操作卡死
let dialogPolicy = "accept";
let lastDialog = null;

/**
 * 在用户窗口里后台新建一个属于「BROWSER-HUMAN」分组的标签页，不新开窗口、不抢焦点。
 * 建组只能借 kimi-webbridge 扩展（CDP 协议无 tab 组能力）；
 * 扩展不可用时退回用户已有窗口建后台标签，任何情况下都不新开窗口。
 */
async function createBackgroundPage(url = "about:blank") {
  const ctx = browser.contexts()[0];
  const before = new Set(ctx.pages());
  const beforeTabIds = await kimiTabIds();

  const opened = await openInTabGroup(url === "about:blank" ? IDLE_PAGE : url);
  // 请求超时但 daemon 可能已经把标签建出来了，先核对 session 里是否真的多了一个标签
  if (opened || (await kimiHasNewTab(beforeTabIds))) {
    const grouped = await waitForNewPage(before, 25000);
    if (grouped) {
      tabGroupMode = true;
      return finishCreation(grouped);
    }
  }

  tabGroupMode = false;
  return finishCreation(await openInUserWindow(url, before));
}

// 最近一次建页时因超限被关闭的数量，用于给 agent 明确反馈
let lastEvicted = 0;

// 新页就绪后统一做数量收敛：超出上限时关闭最久未使用的页，当前页始终保留
async function finishCreation(created) {
  const evicted = await tabs.enforceLimit();
  lastEvicted = evicted.length;
  if (evicted.length) {
    tabs.markReclaimed(evicted.length);
  }
  await relaxFocusEmulation(created);
  await recordFingerprint(created);
  return created;
}

// 扩展桥的唯一调用入口：daemon 未运行、超时、非 2xx 一律返回 null，由调用方决定兜底
async function kimiCall(action, args = {}, timeoutMs = 8000) {
  try {
    const res = await fetch(`${KIMI_BRIDGE}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, args, session: KIMI_SESSION }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// 调 kimi 扩展在用户窗口内建分组标签；扩展未运行或报错时返回 false 交给兜底
async function openInTabGroup(url) {
  const body = await kimiCall(
    "navigate",
    { url, newTab: true, group_title: TAB_GROUP_TITLE },
    45000
  );
  return Boolean(body?.ok && body?.data?.success);
}

// 用 session 清单确认是否真的新增了标签，用于兜住 daemon 慢半拍的超时误判
async function kimiHasNewTab(beforeIds) {
  if (!beforeIds) {
    return false;
  }
  const now = await kimiTabIds();
  if (!now) {
    return false;
  }
  for (const id of now) {
    if (!beforeIds.has(id)) {
      return true;
    }
  }
  return false;
}

// 读取当前 session 的标签 id 集合；daemon 不可用时返回 null
async function kimiTabIds() {
  const body = await kimiCall("list_tabs");
  if (!body?.ok) {
    return null;
  }
  const list = body?.data?.tabs || [];
  return new Set(list.map((t) => t.tabId));
}

/**
 * 清扫上一个进程残留的会话标签：
 * 本进程尚未开过任何页（tabs.size() === 0）而扩展会话里已有标签，
 * 说明它们是上一个 browser-human 进程被强杀后留下的孤儿页，直接整会话关闭。
 * 返回清理条数；扩展不可用时返回 0，不做任何猜测性关闭。
 */
async function sweepOrphanTabs() {
  if (tabs.size() > 0) {
    return 0;
  }
  const body = await kimiCall("list_tabs");
  if (!body?.ok) {
    return 0;
  }
  const leftover = body.data?.tabs?.length || 0;
  if (leftover === 0) {
    return 0;
  }
  const closed = await kimiCall("close_session", {}, 15000);
  return closed?.data?.closed || 0;
}

// 兜底：扩展不可用时用 CDP 在用户已有窗口里后台开标签，绝不新开窗口；
// background + focus:false 保证不激活、不切走用户当前标签
async function openInUserWindow(url, before) {
  const cdp = await browser.newBrowserCDPSession();
  let targetId;
  try {
    ({ targetId } = await cdp.send("Target.createTarget", {
      url,
      background: true,
      focus: false,
      newWindow: false
    }));
    mcpWindowId = (await cdp.send("Browser.getWindowForTarget", { targetId })).windowId;
  } finally {
    await cdp.detach().catch(() => {});
  }
  const created = await waitForNewPage(before);
  if (!created) {
    throw new Error("后台标签页创建超时");
  }
  return created;
}

// 等待新页进入 Playwright 上下文，并纳入本会话管理
async function waitForNewPage(before, timeoutMs = 15000) {
  const ctx = browser.contexts()[0];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = ctx.pages().find((p) => !before.has(p) && p.url() !== "chrome://newtab/");
    if (fresh) {
      fresh.setDefaultTimeout(30000);
      attachDialogHandler(fresh);
      tabs.add(fresh);
      return fresh;
    }
    await sleep(100);
  }
  return null;
}

function attachDialogHandler(p) {
  p.on("dialog", async (dialog) => {
    lastDialog = { type: dialog.type(), message: dialog.message() };
    try {
      if (dialogPolicy === "accept") {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    } catch {
      // 弹窗已被其他处理器消费时忽略
    }
  });
}

/**
 * 在所有页面加载前安装最小反检测脚本：
 * 1) 删除 navigator.webdriver（若运行时被注入），避免自动化布尔值被读取；
 * 2) 兜底清理历史页面可能残留的 humanjs 鼠标助手 DOM 与样式。
 * 注意：不伪造 UA / 屏幕 / 插件等真实硬件特征——本服务跑在用户真实 Chrome 上，
 * 这些值本来就是真的，伪造反而会制造新的不一致。
 */
async function installStealthInitScript(ctx) {
  await ctx.addInitScript(() => {
    const drop = (obj, key) => {
      try {
        const d = Object.getOwnPropertyDescriptor(obj, key);
        if (d && d.configurable) delete obj[key];
      } catch {
        // 不可配置属性无法删除，保持原样即可
      }
    };
    drop(Navigator.prototype, "webdriver");
    drop(navigator, "webdriver");
    drop(window, "webdriver");

    const cleanHumanjsArtifacts = () => {
      document.querySelectorAll("[data-humanjs-cursor]").forEach((el) => el.remove());
      document.querySelectorAll("style").forEach((el) => {
        if (el.textContent && el.textContent.includes("humanjs-ripple")) el.remove();
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", cleanHumanjsArtifacts, { once: true });
    } else {
      cleanHumanjsArtifacts();
    }
  }).catch(() => {});
}

/**
 * 取当前可用页面，浏览器未启动或页面已关闭时给出可操作的提示。
 */
function requirePage() {
  if (!browser) {
    throw new Error("请先调用 open_browser 打开浏览器");
  }
  if (!page || page.isClosed()) {
    throw new Error("当前页面已关闭，请重新调用 open_browser");
  }
  tabs.touch();
  return page;
}

/**
 * 把工具参数解析成 humanjs 的目标：
 * - 传 selector 时返回选择器字符串（hover/type/paste 等只接受 Locator|string）
 * - 传 x/y 时返回坐标点（click/rightClick/doubleClick/move/drag 接受 Point）
 */
function resolveTarget({ selector, x, y }) {
  if (typeof selector === "string" && selector.trim()) {
    return selector;
  }
  if (typeof x === "number" && typeof y === "number") {
    return { x, y };
  }
  throw new Error("请提供 selector，或同时提供 x 和 y");
}

// iframe 定位：数字为 frame 索引（0 为主文档），字符串按 name 或 URL 片段匹配
const frameShape = z.union([z.number(), z.string()]).optional()
  .describe("iframe 定位：索引（0 为主文档）、name 或 URL 片段；不传则操作主文档");

// 指针类工具的公共入参
const pointerShape = {
  selector: z.string().optional().describe("CSS 选择器，与 x/y 二选一"),
  x: z.number().optional().describe("视口坐标 X，需与 y 同时提供"),
  y: z.number().optional().describe("视口坐标 Y，需与 x 同时提供"),
  frame: frameShape
};

/** 取操作作用域：传了 frame 就返回对应 Frame，否则返回 Page（两者都有 locator/evaluate） */
function scopeOf(page, frame) {
  return resolveFrame(page, frame);
}

/** 在指定 frame 内把选择器解析成 Locator；未指定 frame 时返回 selector 原值 */
function frameLocator(page, frame, selector) {
  return frame === undefined ? selector : scopeOf(page, frame).locator(selector);
}

/** 指定 frame 时元素只能用选择器定位：坐标是主文档视口坐标，无法跨 frame 生效 */
function requireSelector(args) {
  const selector = typeof args?.selector === "string" ? args.selector.trim() : "";
  if (!selector) {
    throw new Error("指定 frame 时必须提供 selector（坐标无法定位到 iframe 内的元素）");
  }
  return selector;
}

/** 指针类工具的目标：指定 frame 时解析成该 frame 内的 Locator，否则沿用 selector/坐标 */
function scopedTarget(page, args) {
  if (args.frame === undefined) {
    return resolveTarget(args);
  }
  return scopeOf(page, args.frame).locator(requireSelector(args));
}

/** 目标的可读描述，用于回显；Locator 不能直接 JSON 序列化（内部持有循环引用） */
function describeTarget(args) {
  if (args.selector) {
    return args.frame === undefined ? args.selector : `${args.selector} @frame(${args.frame})`;
  }
  return `(${args.x},${args.y})`;
}

const server = new McpServer(
  { name: "browser-human", version: "1.1.0" },
  {
    // agent 的默认行为是"用完就放着"，这里把释放约定写进协议层，随每次会话下发
    instructions: [
      "标签页是有主资源：任务一结束就归还，不要留到会话结束。",
      "每完成一个任务（信息已取到 / 表单已提交 / 页面已无需保留）后立即调用 close_browser，释放本会话标签并从 Chrome 断开。",
      "单个任务内开了多个页探查时，用完先调用 close_tab（不传 index）关掉除当前页外的全部，再继续下一步。",
      "只有需要跨轮次保留状态（如等待人工登录、等待异步结果）时才可暂不关闭，并应在下一轮开头补一次 close_tab。",
      "不要反复用 new_tab 打开同一站点：相同 URL 会自动复用，但仍应优先 goto。"
    ].join("\n")
  }
);

/* ------------------------------ 生命周期 ------------------------------ */

server.tool("open_browser", {
  foreground: z.boolean().default(false)
    .describe("true 时把会话页置前（写操作需要真实焦点时使用）；默认后台打开，不抢用户焦点")
}, async ({ foreground }) => {
  if (browser && page && !page.isClosed()) {
    return {
      content: [{ type: "text", text: `浏览器已经打开；${describeRoute(page.url())}` }]
    };
  }
  if (browser) {
    await detachOrClose();
  }

  // 只允许附着用户 Chrome，任何情况下都不启动替代浏览器
  let launchedByUs = false;
  let portTip = "";
  if (!(await isCdpUp())) {
    if (await isBrowserRunning()) {
      // 已在运行的进程无法事后开端口；但若它启动时用的是其他调试端口，可直接改附该端口
      const found = await detectRunningDebugPort();
      if (!found) {
        // 已在运行的 Chrome 无法事后开启调试端口，只能整体重启一次（标签页可恢复）
        return {
          content: [{
            type: "text",
            text: `❌ Chrome 正在运行，但未发现可用的调试端口（已检查默认 9222 与进程命令行中的其他端口），无法复用登录态。\n一次性修复：调用 migrate_chrome_launch（会把原快捷方式改成自带端口，并只重启这一次，之后从原图标启动即可随时被接管）。\n临时办法：调用 restart_chrome_with_debugging 重启本次，但换回原图标启动后仍会复发。本工具不会启动替代浏览器。`
          }]
        };
      }
      cdpEndpoint = found.endpoint;
      portTip = `；Chrome 运行在非默认调试端口 ${found.port}，已自动改附该实例`;
    } else {
      launchedByUs = await launchUserChrome();
      if (!launchedByUs) {
        return {
          content: [{
            type: "text",
            text: `❌ 无法在 ${cdpEndpoint} 上拉起用户 Chrome（exe：${CHROME_PATH}，profile 联接：${DEBUG_PROFILE}）。请确认 Chrome 已安装、profile 可读。本工具不会启动替代浏览器。`
          }]
        };
      }
    }
  }

  browser = await chromium.connectOverCDP(cdpEndpoint);
  // 默认上下文即用户真实 profile，Cookie / localStorage / IndexedDB 全部直接复用
  const ctx = browser.contexts()[0];
  // 必须在建页前安装：init script 会对本上下文所有新页面生效
  await installStealthInitScript(ctx);
  // human.paste 依赖剪贴板权限，真实 profile 未授权时静默失败
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

  // 上一次进程被强杀时扩展分组里会留下孤儿页，先清掉再开新页
  const swept = await sweepOrphanTabs();

  // 在独立窗口后台开页：不与用户标签混在一起，也不把用户当前标签切走
  page = await createBackgroundPage();
  if (foreground) {
    // 写操作需要真实焦点时，把会话页真正置前，让 visibilityState 与 hasFocus 一致
    await page.bringToFront().catch(() => {});
  }
  human = await createStealthHuman(page);
  startIdleReaper();

  const cookieCount = (await ctx.cookies().catch(() => [])).length;
  const tip = launchedByUs
    ? `Chrome 未运行，已用真实 profile 启动并附着（${DEBUG_PROFILE}），Cookie ${cookieCount} 条`
    : `已附着到本机 Chrome（${cdpEndpoint}），复用真实 profile，Cookie ${cookieCount} 条${portTip}`;
  const cleaned = swept ? `；已清理上次残留标签 ${swept} 个` : "";
  const focusTip = foreground ? "；会话页已前置" : "";
  const limit = `标签上限 ${MAX_TABS} 个（超出自动关闭最久未使用的页），任务结束请调用 close_browser 释放标签页`;
  return {
    content: [{
      type: "text",
      text: `✅ ${tip}${cleaned}${focusTip}；${describeRoute(page.url())}；${limit}`
    }]
  };
});

/**
 * 空闲回收：agent 用完不关页时，闲置超过阈值就关闭全部会话标签并断开，
 * 避免标签页越积越多。定时器只在有会话时生效，不阻塞进程退出。
 */
let idleTimer = null;
function startIdleReaper() {
  if (idleTimer || IDLE_CLOSE_MS <= 0) {
    return;
  }
  idleTimer = setInterval(async () => {
    if (!browser || !tabs.shouldReclaim()) {
      return;
    }
    const closed = await tabs.closeAll();
    tabs.markReclaimed(closed);
    await detachOrClose();
  }, 60000);
  idleTimer.unref?.();
}

server.tool("close_browser", {}, async () => {
  if (browser) {
    await detachOrClose();
  }
  return {
    content: [{ type: "text", text: "✅ 已关闭本会话打开的标签页并从 Chrome 断开（你的浏览器未被关闭）" }]
  };
});

// 让用户 Chrome 具备可附着能力：已在运行的实例无法事后开端口，只能优雅重启一次
async function restartChromeOnce() {
  if (browser) {
    await detachOrClose();
  }
  let closed = !(await isBrowserRunning());
  if (!closed) {
    closed = await closeChromeGracefully();
  }
  if (!closed) {
    return { ok: false, reason: "timeout" };
  }
  const ok = await launchUserChrome();
  return { ok, reason: ok ? null : "launch_failed" };
}

server.tool("restart_chrome_with_debugging", {}, async () => {
  if (await isCdpUp()) {
    return { content: [{ type: "text", text: `✅ 调试端口已就绪：${CDP_ENDPOINT}` }] };
  }
  const result = await restartChromeOnce();
  if (result.reason === "timeout") {
    return {
      content: [{
        type: "text",
        text: "❌ Chrome 未能在超时内退出（可能弹出了关闭多标签页的确认框）。请在任务栏手动退出 Chrome 后重试。"
      }]
    };
  }
  return {
    content: [{
      type: "text",
      text: result.ok
        ? `✅ 已用真实 profile 重启 Chrome 并开启调试端口（${DEBUG_PROFILE}），已尝试恢复上次标签页`
        : `❌ 重启后调试端口仍未就绪。请检查 ${DEBUG_PROFILE} 是否为可创建的联接路径、以及 ${CDP_ENDPOINT} 是否被占用。`
    }]
  };
});

// 一次性迁移：把桌面/开始菜单/任务栏的 Chrome 快捷方式改成自带调试端口的形态。
// 迁移后用户照旧点原图标启动，MCP 随时可附着，不必再关闭浏览器。
server.tool("migrate_chrome_launch", {
  restart: z.boolean().default(true)
    .describe("true 时若端口未就绪，立即重启一次 Chrome 让迁移生效（会恢复上次标签页）")
}, async ({ restart }) => {
  let patched;
  try {
    patched = await patchChromeShortcuts({
      debugProfile: DEBUG_PROFILE,
      port: new URL(CDP_ENDPOINT).port || "9222"
    });
  } catch (error) {
    return {
      content: [{ type: "text", text: `❌ 快捷方式迁移失败：${error.message}` }]
    };
  }

  // 开机自启项也要同步：否则每次开机先起一个无端口的默认 profile 实例，问题复发
  let autolaunch;
  try {
    autolaunch = await patchChromeAutolaunch({
      debugProfile: DEBUG_PROFILE,
      port: new URL(CDP_ENDPOINT).port || "9222"
    });
  } catch (error) {
    autolaunch = { patched: [], skipped: [], failed: [{ name: "Runner", error: error.message }] };
  }

  const summary =
    patched.patched.length > 0
      ? `已改造 ${patched.patched.length} 个快捷方式（原文件备份为 .bak${patched.elevated ? "，已通过管理员授权写入系统目录" : ""}）`
      : "没有需要改造的快捷方式";
  const skippedTip = patched.skipped.length > 0 ? `；${patched.skipped.length} 个已带端口，跳过` : "";
  const autolaunchTip =
    autolaunch.patched.length > 0
      ? `；开机自启项已同步 ${autolaunch.patched.length} 个（避免每次开机先起无端口实例）`
      : "";
  const failedTip =
    patched.failed.length > 0 || autolaunch.failed.length > 0
      ? `\n⚠️ 写入失败：\n${[
          ...patched.failed.map((row) => `- ${row.file}：${row.error}`),
          ...autolaunch.failed.map((row) => `- ${row.name}：${row.error}`)
        ].join("\n")}`
      : "";

  if (await isCdpUp()) {
    return {
      content: [{
        type: "text",
        text: `✅ ${summary}${skippedTip}${autolaunchTip}；调试端口已就绪（${CDP_ENDPOINT}），之后无需再关闭浏览器${failedTip}`
      }]
    };
  }
  if (!restart) {
    return {
      content: [{
        type: "text",
        text: `✅ ${summary}${skippedTip}${autolaunchTip}；当前 Chrome 仍是旧启动方式，下次从原图标启动即生效，或传 restart=true 立即重启生效${failedTip}`
      }]
    };
  }
  const result = await restartChromeOnce();
  if (result.reason === "timeout") {
    return {
      content: [{
        type: "text",
        text: `✅ ${summary}${skippedTip}${autolaunchTip}；但 Chrome 未能自动退出（可能有未保存内容或未确认的弹窗），请手动退出后再次调用 open_browser${failedTip}`
      }]
    };
  }
  return {
    content: [{
      type: "text",
      text: result.ok
        ? `✅ ${summary}${skippedTip}${autolaunchTip}；已重启 Chrome 并开启调试端口（${DEBUG_PROFILE}），之后从原图标启动也自带端口，无需再关闭浏览器${failedTip}`
        : `✅ ${summary}${skippedTip}${autolaunchTip}；但重启后端口仍未就绪，请手动从原图标启动一次再调用 open_browser${failedTip}`
    }]
  };
});

/* ------------------------------ 导航与观测 ------------------------------ */

server.tool("goto", { url: z.string() }, async ({ url }) => {
  await requirePage().goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });
  return {
    content: [{ type: "text", text: `✅ 已打开: ${url}；${describeRoute(url)}` }]
  };
});

server.tool("page_info", {}, async () => {
  const p = requirePage();
  const info = {
    url: p.url(),
    title: await p.title(),
    tabs: p.context().pages().length,
    mode: "attached",
    tabGroup: tabGroupMode ? TAB_GROUP_TITLE : null,
    mcpWindowId,
    sessionTabs: tabs.size(),
    maxTabs: MAX_TABS,
    frames: listFrames(p),
    route: routeFor(p.url(), STRICT_SITES)
  };
  if (DEBUG_FINGERPRINT && lastFingerprint) {
    info.fingerprint = lastFingerprint;
  }
  return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
});

// Playwright 1.49+ 用 ariaSnapshot，page.accessibility() 已移除
server.tool(
  "get_accessibility_tree",
  "读路径优先级最低之一：优先用 capture_network 重放或 evaluate 取结构化数据，无障碍树仅在需要定位交互元素时使用。",
  { frame: frameShape },
  async ({ frame }) => {
    const snapshot = await scopeOf(requirePage(), frame).locator("body").ariaSnapshot();
    return { content: [{ type: "text", text: snapshot || "（页面无可访问性内容）" }] };
  }
);

// 页面可见文本，比无障碍树更简洁，适合 AI 快速理解页面
server.tool(
  "page_text",
  "读路径最后手段：优先 capture_network 重放 / evaluate 结构化取值；确实要读正文时用 selector 限定区域，并用 maxChars 控制回传体积。",
  {
    selector: z.string().default("body").describe("要读取的元素选择器，默认整页 body；限定区域可显著降低 token"),
    frame: frameShape,
    maxChars: z.number().default(8000).describe("回传字符上限，超出截断并回报剩余字符数")
  },
  async ({ selector, frame, maxChars }) => {
    const text = await scopeOf(requirePage(), frame).locator(selector).first().innerText();
    if (text.length <= maxChars) {
      return { content: [{ type: "text", text }] };
    }
    const rest = text.length - maxChars;
    return {
      content: [{
        type: "text",
        text: `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字符，剩余 ${rest} 字符未读；可用 selector 缩小范围或继续分段读取）`
      }]
    };
  }
);

server.tool(
  "screenshot",
  "读路径成本最高：截图体积远大于文本，仅在必须看视觉布局时使用。",
  { fullPage: z.boolean().default(false) },
  async ({ fullPage }) => {
    const buf = await requirePage().screenshot({ fullPage });
    return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
  }
);

// 显式等待：元素出现 / 页面加载态，避免 AI 盲等
server.tool("wait_for", {
  selector: z.string().optional(),
  frame: frameShape,
  loadState: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
  timeoutMs: z.number().default(15000)
}, async ({ selector, frame, loadState, timeoutMs }) => {
  const scope = scopeOf(requirePage(), frame);
  if (selector) {
    await scope.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs });
    return { content: [{ type: "text", text: `✅ 元素已出现: ${selector}` }] };
  }
  await scope.waitForLoadState(loadState || "domcontentloaded", { timeout: timeoutMs });
  return { content: [{ type: "text", text: `✅ 加载态就绪: ${loadState || "domcontentloaded"}` }] };
});

server.tool("evaluate", {
  expression: z.string(),
  frame: frameShape,
  maxChars: z.number().default(200000)
}, async ({ expression, frame, maxChars }) => {
  const result = await scopeOf(requirePage(), frame).evaluate(expression);
  const text = JSON.stringify(result, null, 2) ?? "null";
  return {
    content: [{
      type: "text",
      text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字符）` : text
    }]
  };
});

/* ------------------------------ 拟人指针操作 ------------------------------ */

// 所有拟人动作前插入随机抖动，避免固定节奏被行为风控统计识别。
// 同时做可见性前置断言：后台页的输入会被浏览器丢弃，静默失败比报错更难排查。
// MCP_ACTION_JITTER_MS=0 可关闭抖动，MCP_VISIBILITY_GUARD=0 可关闭断言。
function humanTool(name, schema, handler) {
  server.tool(name, schema, async (...args) => {
    await ensurePageVisible(requirePage());
    await stealthPause();
    return handler(...args);
  });
}

// 指针记忆：贝塞尔轨迹的起点取上一次落点，未知时按相对位置近似
let pointer = null;

function pointerTargetOf(p, target) {
  return typeof target === "string" ? p.locator(target).first() : target;
}

/** 把目标解析成视口坐标；解析失败返回 null（轨迹只是补充，失败不阻塞点击） */
async function centerOf(p, target) {
  try {
    const box = await pointerTargetOf(p, target).boundingBox();
    if (!box) {
      return null;
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  } catch {
    return null;
  }
}

/** 点击前的 2~3 段贝塞尔移动，消除「瞬移点击」的轨迹特征；不返回中间态 */
async function approachByCurve(p, target) {
  if (!POINTER_TRAIL) {
    return;
  }
  const end = await centerOf(p, target);
  if (!end) {
    return;
  }
  const start = pointer || { x: Math.max(0, end.x - 160), y: Math.max(0, end.y - 120) };
  const segments = 2 + Math.floor(Math.random() * 2);
  const cx = (start.x + end.x) / 2 + (Math.random() - 0.5) * 120;
  const cy = (start.y + end.y) / 2 + (Math.random() - 0.5) * 120;
  try {
    for (let i = 1; i <= segments; i += 1) {
      const t = i / segments;
      const x = (1 - t) ** 2 * start.x + 2 * (1 - t) * t * cx + t ** 2 * end.x;
      const y = (1 - t) ** 2 * start.y + 2 * (1 - t) * t * cy + t ** 2 * end.y;
      await human.move({ x: Math.round(x), y: Math.round(y) });
      if (i < segments) {
        await sleep(15 + Math.floor(Math.random() * 25));
      }
    }
    pointer = { x: Math.round(end.x), y: Math.round(end.y) };
  } catch {
    // 轨迹失败时直接点击，不影响主流程
  }
}

/** 按 8~12 字符分块输入，块间停 50~150ms，避免整段一次性注入 */
async function typeInChunks(input, text) {
  let index = 0;
  while (index < text.length) {
    const span = TYPE_CHUNK_MIN + Math.floor(Math.random() * (TYPE_CHUNK_MAX - TYPE_CHUNK_MIN + 1));
    await human.type(input, text.slice(index, index + span));
    index += span;
    if (index < text.length) {
      await sleep(TYPE_GAP_MIN_MS + Math.floor(Math.random() * (TYPE_GAP_MAX_MS - TYPE_GAP_MIN_MS + 1)));
    }
  }
}

humanTool("human_click", pointerShape, async (args) => {
  const p = requirePage();
  const target = scopedTarget(p, args);
  // frame 内的坐标语义与主文档不同，只有主文档目标才做轨迹
  if (args.frame === undefined) {
    await approachByCurve(p, target);
  }
  await human.click(target);
  return { content: [{ type: "text", text: `✅ 拟人点击 ${describeTarget(args)}` }] };
});

humanTool("human_double_click", pointerShape, async (args) => {
  const p = requirePage();
  const target = scopedTarget(p, args);
  if (args.frame === undefined) {
    await approachByCurve(p, target);
  }
  await human.doubleClick(target);
  return { content: [{ type: "text", text: `✅ 拟人双击 ${describeTarget(args)}` }] };
});

humanTool("human_right_click", pointerShape, async (args) => {
  const target = scopedTarget(requirePage(), args);
  await human.rightClick(target);
  return { content: [{ type: "text", text: `✅ 拟人右键 ${describeTarget(args)}` }] };
});

// hover 只接受 Locator|string，坐标请用 human_move
humanTool("human_hover", { selector: z.string(), frame: frameShape }, async ({ selector, frame }) => {
  await human.hover(frameLocator(requirePage(), frame, selector));
  return { content: [{ type: "text", text: `✅ 拟人悬停 ${describeTarget({ selector, frame })}` }] };
});

humanTool("human_move", { x: z.number(), y: z.number() }, async ({ x, y }) => {
  await requirePage();
  await human.move({ x, y });
  pointer = { x, y };
  return { content: [{ type: "text", text: `✅ 拟人移动到 (${x},${y})` }] };
});

humanTool("human_drag", {
  from: z.object({ selector: z.string().optional(), x: z.number().optional(), y: z.number().optional(), frame: frameShape }),
  to: z.object({ selector: z.string().optional(), x: z.number().optional(), y: z.number().optional(), frame: frameShape })
}, async ({ from, to }) => {
  const p = requirePage();
  await human.drag(scopedTarget(p, from), scopedTarget(p, to));
  return { content: [{ type: "text", text: "✅ 拟人拖拽完成" }] };
});

/* ------------------------------ 拟人输入操作 ------------------------------ */

// 坐标输入：先点击聚焦，再用 ':focus' 定位刚获得焦点的元素；
// frame 内直接用 Locator 作为输入目标，避免 ':focus' 落到主文档
humanTool("human_type", {
  ...pointerShape,
  text: z.string(),
  usePaste: z.boolean().default(false)
}, async ({ text, usePaste, ...rest }) => {
  const p = requirePage();
  const target = scopedTarget(p, rest);
  await human.click(target);
  const input = rest.frame === undefined ? ":focus" : target;
  try {
    if (usePaste) {
      await human.paste(input, text);
    } else {
      await typeInChunks(input, text);
    }
  } catch {
    await p.keyboard.type(text, { delay: 60 });
  }
  return { content: [{ type: "text", text: `✅ 拟人输入：${text}` }] };
});

humanTool("human_paste", { selector: z.string(), text: z.string(), frame: frameShape }, async ({ selector, text, frame }) => {
  await human.paste(frameLocator(requirePage(), frame, selector), text);
  return { content: [{ type: "text", text: `✅ 已粘贴到 ${selector}` }] };
});

humanTool("human_clear", { selector: z.string(), frame: frameShape }, async ({ selector, frame }) => {
  await human.clear(frameLocator(requirePage(), frame, selector));
  return { content: [{ type: "text", text: `✅ 已清空 ${selector}` }] };
});

// 键盘：Enter / Tab / Escape / Control+A / Shift+Tab 等
humanTool("human_press", { key: z.string() }, async ({ key }) => {
  await requirePage();
  const result = await human.press(key);
  return { content: [{ type: "text", text: `✅ 已按键 ${result?.dispatched || key}` }] };
});

/* ------------------------------ 表单控件 ------------------------------ */

humanTool("human_check", { selector: z.string(), frame: frameShape }, async ({ selector, frame }) => {
  await human.check(frameLocator(requirePage(), frame, selector));
  return { content: [{ type: "text", text: `✅ 已勾选 ${selector}` }] };
});

humanTool("human_uncheck", { selector: z.string(), frame: frameShape }, async ({ selector, frame }) => {
  await human.uncheck(frameLocator(requirePage(), frame, selector));
  return { content: [{ type: "text", text: `✅ 已取消勾选 ${selector}` }] };
});

humanTool("human_select_option", {
  selector: z.string(),
  values: z.union([z.string(), z.array(z.string())]),
  frame: frameShape
}, async ({ selector, values, frame }) => {
  const picked = await human.selectOption(frameLocator(requirePage(), frame, selector), values);
  return { content: [{ type: "text", text: `✅ 已选择 ${JSON.stringify(picked)}` }] };
});

humanTool("human_upload", {
  selector: z.string(),
  files: z.array(z.string()).describe("本地文件绝对路径列表"),
  frame: frameShape
}, async ({ selector, files, frame }) => {
  await human.upload(frameLocator(requirePage(), frame, selector), files);
  return { content: [{ type: "text", text: `✅ 已选择 ${files.length} 个文件` }] };
});

// 选中文本：复制/剪切、触发划词菜单、或让"选中才可用"的按钮生效
humanTool("human_select_text", {
  selector: z.string(),
  text: z.string().optional().describe("只选中这个子串；不传则选中元素全部文本"),
  frame: frameShape
}, async ({ selector, text, frame }) => {
  await human.selectText(frameLocator(requirePage(), frame, selector), text ? { text } : undefined);
  return {
    content: [{
      type: "text",
      text: `✅ 已选中 ${text ? `「${text}」` : "元素全部文本"}（${selector}）`
    }]
  };
});

/* ------------------------------ 滚动 / 阅读 / 节奏 ------------------------------ */

humanTool("human_scroll", {
  direction: z.enum(["up", "down"]),
  pixels: z.number().default(400),
  selector: z.string().optional().describe("滚动到该元素可见；配合 frame 可滚动 iframe 内的元素"),
  frame: frameShape
}, async ({ direction, pixels, selector, frame }) => {
  if (frame !== undefined && !selector) {
    throw new Error("滚动指定 frame 时必须提供 selector（frame 内滚动只支持滚到元素可见）");
  }
  const p = requirePage();
  const by = direction === "down" ? Math.abs(pixels) : -Math.abs(pixels);
  const result = selector
    ? await human.scroll(frameLocator(p, frame, selector))
    : await human.scroll({ by });
  return {
    content: [{
      type: "text",
      text: `✅ 滚动完成：${result.from} → ${result.to}（${result.distance}px，${Math.round(result.durationMs)}ms）`
    }]
  };
});

// 拟人阅读：按词数模拟阅读停留时间，避免动作过快
humanTool("human_read", {
  selector: z.string().default("body"),
  frame: frameShape,
  wordsPerMinute: z.number().optional()
}, async ({ selector, frame, wordsPerMinute }) => {
  const result = await human.read(frameLocator(requirePage(), frame, selector));
  return {
    content: [{
      type: "text",
      text: `✅ 阅读完毕：${result.words} 词，停留 ${Math.round(result.durationMs)}ms`
    }]
  };
});

humanTool("human_sleep", { ms: z.number() }, async ({ ms }) => {
  await requirePage();
  await human.sleep(ms);
  return { content: [{ type: "text", text: `✅ 已等待 ${ms}ms` }] };
});

/* ------------------------------ 多标签页 ------------------------------ */

server.tool("list_tabs", {}, async () => {
  requirePage();
  // 只列本会话的页，用户自己的标签页不暴露、不可误操作
  const pages = tabs.list();
  const list = await Promise.all(pages.map(async (p, i) => ({
    index: i,
    url: p.url(),
    title: await p.title().catch(() => ""),
    active: p === tabs.getCurrent()
  })));
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ count: list.length, maxTabs: MAX_TABS, idleCloseMs: IDLE_CLOSE_MS, tabs: list }, null, 2)
    }]
  };
});

server.tool("new_tab", { url: z.string() }, async ({ url }) => {
  requirePage();
  // 同一 URL 已有会话页时直接切换，避免 agent 重复打开相同页面
  const existing = tabs.list().find((p) => p.url() === url);
  if (existing) {
    page = existing;
    tabs.setCurrent(page);
    human = await createStealthHuman(page);
    return {
      content: [{ type: "text", text: `♻️ 已有相同地址的标签页，已直接切换: ${url}；${describeRoute(url)}` }]
    };
  }
  page = await createBackgroundPage(url);
  human = await createStealthHuman(page);
  const where = tabGroupMode ? `标签组「${TAB_GROUP_TITLE}」` : "用户浏览器窗口（未分组）";
  const extra = lastEvicted ? `；已达上限 ${MAX_TABS}，已自动关闭 ${lastEvicted} 个最久未使用的页` : "";
  return {
    content: [{
      type: "text",
      text: `✅ 已在${where}后台打开标签页（未抢焦点）: ${url}；${describeRoute(url)}${extra}`
    }]
  };
});

server.tool("switch_tab", { index: z.number() }, async ({ index }) => {
  requirePage();
  // 索引域限定在本会话的页内，绝不切到用户自己的标签页
  const pages = tabs.list();
  if (index < 0 || index >= pages.length) {
    throw new Error(`标签页索引越界：共 ${pages.length} 个`);
  }
  page = pages[index];
  tabs.setCurrent(page);
  attachDialogHandler(page);
  human = await createStealthHuman(page);
  return { content: [{ type: "text", text: `✅ 已切换到标签页 ${index}: ${page.url()}` }] };
});

server.tool("close_tab", {
  index: z.number().optional().describe("要关闭的标签页索引（见 list_tabs）；不传则关闭除当前页外的全部"),
  all: z.boolean().default(false).describe("关闭全部会话标签页")
}, async ({ index, all }) => {
  requirePage();
  if (all) {
    const closed = await tabs.closeAll();
    page = null;
    human = null;
    return {
      content: [{ type: "text", text: `✅ 已关闭 ${closed} 个会话标签页；继续操作请调用 open_browser` }]
    };
  }
  if (index === undefined) {
    const closed = await tabs.closeAll({ keepCurrent: true });
    return { content: [{ type: "text", text: `✅ 已关闭 ${closed} 个会话标签页，保留当前页` }] };
  }
  const pages = tabs.list();
  if (index < 0 || index >= pages.length) {
    throw new Error(`标签页索引越界：共 ${pages.length} 个`);
  }
  const target = pages[index];
  const closingCurrent = target === tabs.getCurrent();
  await tabs.close(target);
  if (closingCurrent) {
    const rest = tabs.list();
    page = rest[0] || null;
    if (page) {
      tabs.setCurrent(page);
      human = await createStealthHuman(page);
    } else {
      human = null;
    }
  }
  return {
    content: [{
      type: "text",
      text: `✅ 已关闭标签页 ${index}；当前会话剩余 ${tabs.size()} 个`
    }]
  };
});

/* ------------------------------ JS 弹窗 ------------------------------ */

server.tool("dialog_settings", {
  policy: z.enum(["accept", "dismiss"]).optional().describe("自动处理策略，不传则只读当前设置")
}, async ({ policy }) => {
  if (policy) {
    dialogPolicy = policy;
  }
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ policy: dialogPolicy, lastDialog }, null, 2)
    }]
  };
});

/* ------------------------------ 下载 ------------------------------ */

server.tool("download_file", {
  url: z.string(),
  savePath: z.string(),
  referer: z.string().optional(),
  transport: z.enum(["browser", "api"]).default("browser")
    .describe("browser=页面内 fetch（默认，浏览器 TLS/Cookie 指纹）；api=Playwright APIRequestContext（可绕过 CORS，但指纹不同）")
}, async ({ url, savePath, referer, transport }) => {
  const p = requirePage();
  let buf;
  let status;
  if (transport === "browser") {
    // 走页面 fetch：TLS/JA3、HTTP/2、Header 顺序与真实 Chrome 一致，Kimi 也是这条路。
    // 浏览器禁止手写 Referer/Cookie 头，自动携带当前页面的来源与 Cookie。
    const base64 = await p.evaluate(async ({ url }) => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 32768) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
      }
      return btoa(bin);
    }, { url });
    buf = Buffer.from(base64, "base64");
    status = 200;
  } else {
    const resp = await p.context().request.get(url, {
      headers: { Referer: referer || p.url() },
      timeout: 60000
    });
    if (!resp.ok()) {
      throw new Error(`下载失败：HTTP ${resp.status()} ${resp.statusText()}`);
    }
    buf = await resp.body();
    status = resp.status();
  }
  await fs.mkdir(path.dirname(savePath), { recursive: true });
  await fs.writeFile(savePath, buf);
  return {
    content: [{
      type: "text",
      text: `✅ 已保存 ${savePath}（${(buf.length / 1024 / 1024).toFixed(2)} MB，HTTP ${status}）`
    }]
  };
});

/* ------------------------------ 网络抓包 ------------------------------ */

// 抓包器与页一一绑定：换页时释放旧监听，避免旧页请求混进结果
function ensureCapture(p) {
  if (capture && capturePage === p) {
    return capture;
  }
  capture?.dispose();
  capture = createNetworkCapture(p);
  capturePage = p;
  return capture;
}

server.tool("capture_network", {
  action: z.enum(["start", "stop", "dump", "clear"]).describe("start 开始录制并清空缓冲；stop 停止录制但保留数据；dump 取结果；clear 清空缓冲"),
  filter: z.string().optional().describe("URL 正则：start 时限定录制范围，dump 时限定输出"),
  captureBody: z.boolean().optional().describe("start 时开启响应体采集，默认关闭"),
  includeHeaders: z.boolean().optional().describe("dump 时输出请求头与响应头"),
  includeCookies: z.boolean().optional().describe("dump 时按 URL 补齐 Cookie（含 HttpOnly，仅前 20 条请求）"),
  includeBody: z.boolean().optional().describe("dump 时输出响应体片段，需 start 时已开启 captureBody"),
  limit: z.number().optional().describe("dump 返回条数上限，默认 50"),
  maxChars: z.number().optional().describe("入参与响应体截断长度，默认 2000")
}, async (args) => {
  const cap = ensureCapture(requirePage());
  if (args.action === "start") {
    cap.start({ filter: args.filter, wantBody: args.captureBody });
    const scope = args.filter ? `（URL 匹配 /${args.filter}/i）` : "";
    return {
      content: [{
        type: "text",
        text: `✅ 开始录制网络请求${scope}，缓冲已清空。请刷新页面或执行查询操作，然后调用 action="dump"。`
      }]
    };
  }
  if (args.action === "stop") {
    cap.stop();
    return {
      content: [{
        type: "text",
        text: `✅ 已停止录制，缓冲保留 ${cap.size} 条，仍可 dump`
      }]
    };
  }
  if (args.action === "clear") {
    cap.clear();
    return { content: [{ type: "text", text: "✅ 缓冲已清空" }] };
  }
  const result = cap.dump({
    filter: args.filter,
    limit: args.limit,
    includeHeaders: args.includeHeaders,
    includeBody: args.includeBody,
    maxChars: args.maxChars
  });
  if (args.includeCookies) {
    for (const row of result.requests.slice(0, 20)) {
      const cookies = await page.context().cookies(row.url).catch(() => []);
      if (cookies.length) {
        row.cookies = cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          httpOnly: c.httpOnly
        }));
      }
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

/* ------------------------------ 程序化调用接口 ------------------------------ */

// 直接调用接口。默认走页面内 fetch：TLS/JA3、HTTP/2、Header 顺序、Cookie 都是真实 Chrome，
// 与 Kimi 的 evaluate 路径一致，不会像 Node APIRequestContext 那样留下服务端指纹。
// transport:"api" 仅在需要绕过 CORS 时使用（指纹不同，风控敏感站点请勿使用）。
server.tool("http_request", {
  url: z.string().optional().describe("目标地址；提供 captureIndex 时可省略"),
  method: z.string().optional().describe("HTTP 方法；提供 captureIndex 时默认沿用记录值"),
  headers: z.record(z.string(), z.string()).optional().describe("追加或覆盖请求头"),
  body: z.string().optional().describe("请求体原始字符串；提供 captureIndex 时默认沿用记录值"),
  cookies: z.union([
    z.string(),
    z.array(z.object({ name: z.string(), value: z.string() }))
  ]).optional().describe("仅 transport=api 生效：显式 Cookie；browser 模式由浏览器自动携带"),
  captureIndex: z.number().optional().describe("重放 capture_network dump 里的 index，自动沿用其 url/method/body/headers"),
  referer: z.string().optional().describe("仅 transport=api 生效；browser 模式自动使用当前页来源"),
  transport: z.enum(["browser", "api"]).default("browser")
    .describe("browser=页面内 fetch（默认，真实 Chrome 指纹）；api=Playwright APIRequestContext（可绕过 CORS）"),
  timeoutMs: z.number().default(30000),
  maxChars: z.number().default(20000)
}, async ({ url, method, headers, body, cookies, captureIndex, referer, transport, timeoutMs, maxChars }) => {
  const p = requirePage();
  const captured = captureIndex === undefined ? null : capture?.get(captureIndex);
  if (captureIndex !== undefined && !captured) {
    throw new Error(`抓包记录 ${captureIndex} 不存在：先 capture_network start、刷新页面、再 dump 取 index`);
  }
  const targetUrl = url || captured?.url;
  if (!targetUrl) {
    throw new Error("请提供 url，或用 captureIndex 指定抓包记录");
  }
  const finalMethod = (method || captured?.method || "GET").toUpperCase();
  const finalHeaders = {
    ...replayHeaders(captured?.headers),
    Referer: referer || p.url(),
    ...(headers || {})
  };
  const cookieHeader = formatCookies(cookies);
  if (cookieHeader) {
    finalHeaders.Cookie = cookieHeader;
  }
  const payload = body ?? captured?.postData ?? undefined;
  const hasContentType = Object.keys(finalHeaders).some((n) => n.toLowerCase() === "content-type");
  if (payload && !hasContentType) {
    finalHeaders["Content-Type"] = "application/json";
  }

  if (transport === "browser") {
    const browserHeaders = { ...finalHeaders };
    // fetch 禁止手写这些头；浏览器会自动携带真实值，手写反而抛错或形成指纹差异
    for (const key of Object.keys(browserHeaders)) {
      if (["cookie", "referer", "origin", "user-agent", "host"].includes(key.toLowerCase())) {
        delete browserHeaders[key];
      }
    }
    let result;
    try {
      result = await p.evaluate(async ({ url, method, headers, body, timeoutMs }) => {
        const res = await fetch(url, {
          method,
          headers,
          body,
          credentials: "include",
          signal: AbortSignal.timeout(timeoutMs)
        });
        const text = await res.text();
        return {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          body: text
        };
      }, { url: targetUrl, method: finalMethod, headers: browserHeaders, body: payload, timeoutMs });
    } catch (err) {
      throw new Error(`浏览器内 fetch 失败（通常是 CORS）：${err.message}。如确认有权限且仅用于已授权接口，可改用 transport:"api"。`);
    }
    const summary = JSON.stringify({ status: result.status, statusText: result.statusText, headers: result.headers, transport: "browser" }, null, 2);
    const text = result.body.length > maxChars ? `${result.body.slice(0, maxChars)}\n…（已截断，共 ${result.body.length} 字符）` : result.body;
    const cookieNote = cookieHeader ? "\n注意：transport=browser 忽略显式 cookies，已由浏览器自动携带。" : "";
    return { content: [{ type: "text", text: `${summary}\n\n${text}${cookieNote}` }] };
  }

  const resp = await p.context().request.fetch(targetUrl, {
    method: finalMethod,
    headers: finalHeaders,
    data: payload,
    timeout: timeoutMs,
    failOnStatusCode: false,
    maxRedirects: 5
  });
  const text = await readResponse(resp, maxChars);
  const summary = JSON.stringify({ status: resp.status(), statusText: resp.statusText(), headers: resp.headers(), transport: "api" }, null, 2);
  return { content: [{ type: "text", text: `${summary}\n\n${text}` }] };
});

/**
 * 进程退出兜底：客户端断开（stdin EOF）或被信号终止时，先归还本会话标签再退出。
 * 强杀（taskkill /F）拦不住，这类残留交给下次 open_browser 的 sweepOrphanTabs 清理。
 */
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await Promise.race([detachOrClose(), sleep(4000)]);
  } catch {
    // 退出路径不再抛错，避免掩盖真实退出原因
  }
  process.exit(0);
}

process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function bootstrap() {
  await server.connect(new StdioServerTransport());
}

bootstrap().catch(console.error);
