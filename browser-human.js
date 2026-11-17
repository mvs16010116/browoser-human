import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium } from "playwright";
import { z } from "zod";
import { createHuman } from "@humanjs/playwright";
import { createNetworkCapture } from "./network-capture.js";
import { listFrames, resolveFrame } from "./frame-support.js";
import { formatCookies, readResponse, replayHeaders } from "./http-client.js";
import { createTabManager, DEFAULT_MAX_TABS, DEFAULT_IDLE_CLOSE_MS } from "./tab-manager.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 唯一工作方式：附着用户的 Chrome，复用真实登录态；禁止另起任何浏览器实例
const CDP_ENDPOINT = process.env.MCP_CHROME_CDP || "http://127.0.0.1:9222";
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

// 探测本机 Chrome 是否已开启调试端口；未开启时由 open_browser 决定启动或提示重启
async function isCdpUp() {
  try {
    const res = await fetch(`${CDP_ENDPOINT}/json/version`, {
      signal: AbortSignal.timeout(1500)
    });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

server.tool("open_browser", {}, async () => {
  if (browser && page && !page.isClosed()) {
    return { content: [{ type: "text", text: "浏览器已经打开" }] };
  }
  if (browser) {
    await detachOrClose();
  }

  // 只允许附着用户 Chrome，任何情况下都不启动替代浏览器
  let launchedByUs = false;
  if (!(await isCdpUp())) {
    if (await isBrowserRunning()) {
      // 已在运行的 Chrome 无法事后开启调试端口，只能整体重启一次（标签页可恢复）
      return {
        content: [{
          type: "text",
          text: `❌ Chrome 正在运行但未开启调试端口，无法复用登录态。\n请调用 restart_chrome_with_debugging 重启 Chrome（会恢复上次标签页），或手动完全退出 Chrome 后再调用 open_browser。本工具不会启动替代浏览器。`
        }]
      };
    }
    launchedByUs = await launchUserChrome();
    if (!launchedByUs) {
      return {
        content: [{
          type: "text",
          text: `❌ 无法在 ${CDP_ENDPOINT} 上拉起用户 Chrome（exe：${CHROME_PATH}，profile 联接：${DEBUG_PROFILE}）。请确认 Chrome 已安装、profile 可读。本工具不会启动替代浏览器。`
        }]
      };
    }
  }

  browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  // 默认上下文即用户真实 profile，Cookie / localStorage / IndexedDB 全部直接复用
  const ctx = browser.contexts()[0];
  // human.paste 依赖剪贴板权限，真实 profile 未授权时静默失败
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

  // 上一次进程被强杀时扩展分组里会留下孤儿页，先清掉再开新页
  const swept = await sweepOrphanTabs();

  // 在独立窗口后台开页：不与用户标签混在一起，也不把用户当前标签切走
  page = await createBackgroundPage();
  human = await createHuman(page, { personality: "careful", seed: 12345 });
  startIdleReaper();

  const cookieCount = (await ctx.cookies().catch(() => [])).length;
  const tip = launchedByUs
    ? `Chrome 未运行，已用真实 profile 启动并附着（${DEBUG_PROFILE}），Cookie ${cookieCount} 条`
    : `已附着到本机 Chrome（${CDP_ENDPOINT}），复用真实 profile，Cookie ${cookieCount} 条`;
  const cleaned = swept ? `；已清理上次残留标签 ${swept} 个` : "";
  const limit = `标签上限 ${MAX_TABS} 个（超出自动关闭最久未使用的页），任务结束请调用 close_browser 释放标签页`;
  return { content: [{ type: "text", text: `✅ ${tip}${cleaned}；${limit}` }] };
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
server.tool("restart_chrome_with_debugging", {}, async () => {
  if (await isCdpUp()) {
    return { content: [{ type: "text", text: `✅ 调试端口已就绪：${CDP_ENDPOINT}` }] };
  }
  if (browser) {
    await detachOrClose();
  }
  let closed = !(await isBrowserRunning());
  if (!closed) {
    closed = await closeChromeGracefully();
  }
  if (!closed) {
    return {
      content: [{
        type: "text",
        text: "❌ Chrome 未能在超时内退出（可能弹出了关闭多标签页的确认框）。请在任务栏手动退出 Chrome 后重试。"
      }]
    };
  }
  const ok = await launchUserChrome();
  return {
    content: [{
      type: "text",
      text: ok
        ? `✅ 已用真实 profile 重启 Chrome 并开启调试端口（${DEBUG_PROFILE}），已尝试恢复上次标签页`
        : `❌ 重启后调试端口仍未就绪。请检查 ${DEBUG_PROFILE} 是否为可创建的联接路径、以及 ${CDP_ENDPOINT} 是否被占用。`
    }]
  };
});

/* ------------------------------ 导航与观测 ------------------------------ */

server.tool("goto", { url: z.string() }, async ({ url }) => {
  await requirePage().goto(url, { timeout: 30000, waitUntil: "domcontentloaded" });
  return { content: [{ type: "text", text: `✅ 已打开: ${url}` }] };
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
    frames: listFrames(p)
  };
  return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
});

// Playwright 1.49+ 用 ariaSnapshot，page.accessibility() 已移除
server.tool("get_accessibility_tree", { frame: frameShape }, async ({ frame }) => {
  const snapshot = await scopeOf(requirePage(), frame).locator("body").ariaSnapshot();
  return { content: [{ type: "text", text: snapshot || "（页面无可访问性内容）" }] };
});

// 页面可见文本，比无障碍树更简洁，适合 AI 快速理解页面
server.tool("page_text", { frame: frameShape, maxChars: z.number().default(20000) }, async ({ frame, maxChars }) => {
  const text = await scopeOf(requirePage(), frame).locator("body").innerText();
  return {
    content: [{
      type: "text",
      text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断）` : text
    }]
  };
});

server.tool("screenshot", { fullPage: z.boolean().default(false) }, async ({ fullPage }) => {
  const buf = await requirePage().screenshot({ fullPage });
  return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
});

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

server.tool("human_click", pointerShape, async (args) => {
  const target = scopedTarget(requirePage(), args);
  await human.click(target);
  return { content: [{ type: "text", text: `✅ 拟人点击 ${describeTarget(args)}` }] };
});

server.tool("human_double_click", pointerShape, async (args) => {
  const target = scopedTarget(requirePage(), args);
  await human.doubleClick(target);
  return { content: [{ type: "text", text: `✅ 拟人双击 ${describeTarget(args)}` }] };
});

server.tool("human_right_click", pointerShape, async (args) => {
  const target = scopedTarget(requirePage(), args);
  await human.rightClick(target);
  return { content: [{ type: "text", text: `✅ 拟人右键 ${describeTarget(args)}` }] };
});

// hover 只接受 Locator|string，坐标请用 human_move
server.tool("human_hover", { selector: z.string(), frame: frameShape }, async ({ selector, frame }) => {
  await human.hover(frameLocator(requirePage(), frame, selector));
  return { content: [{ type: "text", text: `✅ 拟人悬停 ${describeTarget({ selector, frame })}` }] };
});

server.tool("human_move", { x: z.number(), y: z.number() }, async ({ x, y }) => {
  await requirePage();
  await human.move({ x, y });
  return { content: [{ type: "text", text: `✅ 拟人移动到 (${x},${y})` }] };
});

server.tool("human_drag", {
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
server.tool("human_type", {
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
      await human.type(input, text);
    }
  } catch {
    await p.keyboard.type(text, { delay: 60 });
  }
  return { content: [{ type: "text", text: `✅ 拟人输入：${text}` }] };
});

server.tool("human_paste", { selector: z.string(), text: z.string(), frame: frameShape }, async ({ selector, text, frame }) => {
  await human.paste(frameLocator(requirePage(), frame, selector), text);
  return { content: [{ type: "text", text: `✅ 已粘贴到 ${selector}` }] };
});

server.tool("human_clear", { selector: z.string(), frame: frameShape }, async ({ selector, frame }) => {
  await human.clear(frameLocator(requirePage(), frame, selector));
  return { content: [{ type: "text", text: `✅ 已清空 ${selector}` }] };
});

// 键盘：Enter / Tab / Escape / Control+A / Shift+Tab 等
server.tool("human_press", { key: z.string() }, async ({ key }) => {
  await requirePage();
  const result = await human.press(key);
  return { content: [{ type: "text", text: `✅ 已按键 ${result?.dispatched || key}` }] };
});

/* ------------------------------ 表单控件 ------------------------------ */

server.tool("human_check", { selector: z.string(), frame: frameShape }, async ({ selector, frame }) => {
  await human.check(frameLocator(requirePage(), frame, selector));
  return { content: [{ type: "text", text: `✅ 已勾选 ${selector}` }] };
});

server.tool("human_uncheck", { selector: z.string(), frame: frameShape }, async ({ selector, frame }) => {
  await human.uncheck(frameLocator(requirePage(), frame, selector));
  return { content: [{ type: "text", text: `✅ 已取消勾选 ${selector}` }] };
});

server.tool("human_select_option", {
  selector: z.string(),
  values: z.union([z.string(), z.array(z.string())]),
  frame: frameShape
}, async ({ selector, values, frame }) => {
  const picked = await human.selectOption(frameLocator(requirePage(), frame, selector), values);
  return { content: [{ type: "text", text: `✅ 已选择 ${JSON.stringify(picked)}` }] };
});

server.tool("human_upload", {
  selector: z.string(),
  files: z.array(z.string()).describe("本地文件绝对路径列表"),
  frame: frameShape
}, async ({ selector, files, frame }) => {
  await human.upload(frameLocator(requirePage(), frame, selector), files);
  return { content: [{ type: "text", text: `✅ 已选择 ${files.length} 个文件` }] };
});

// 选中文本：复制/剪切、触发划词菜单、或让"选中才可用"的按钮生效
server.tool("human_select_text", {
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

server.tool("human_scroll", {
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
server.tool("human_read", {
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

server.tool("human_sleep", { ms: z.number() }, async ({ ms }) => {
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
    human = await createHuman(page, { personality: "careful", seed: 12345 });
    return { content: [{ type: "text", text: `♻️ 已有相同地址的标签页，已直接切换: ${url}` }] };
  }
  page = await createBackgroundPage(url);
  human = await createHuman(page, { personality: "careful", seed: 12345 });
  const where = tabGroupMode ? `标签组「${TAB_GROUP_TITLE}」` : "用户浏览器窗口（未分组）";
  const extra = lastEvicted ? `；已达上限 ${MAX_TABS}，已自动关闭 ${lastEvicted} 个最久未使用的页` : "";
  return {
    content: [{ type: "text", text: `✅ 已在${where}后台打开标签页（未抢焦点）: ${url}${extra}` }]
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
  human = await createHuman(page, { personality: "careful", seed: 12345 });
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
      human = await createHuman(page, { personality: "careful", seed: 12345 });
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
  referer: z.string().optional()
}, async ({ url, savePath, referer }) => {
  const p = requirePage();
  const resp = await p.context().request.get(url, {
    headers: { Referer: referer || p.url() },
    timeout: 60000
  });
  if (!resp.ok()) {
    throw new Error(`下载失败：HTTP ${resp.status()} ${resp.statusText()}`);
  }
  const buf = await resp.body();
  await fs.mkdir(path.dirname(savePath), { recursive: true });
  await fs.writeFile(savePath, buf);
  return {
    content: [{
      type: "text",
      text: `✅ 已保存 ${savePath}（${(buf.length / 1024 / 1024).toFixed(2)} MB，HTTP ${resp.status()}）`
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

// 直接调用接口：走 Playwright 的 APIRequestContext，与浏览器共享 Cookie 存储（含 HttpOnly），
// 不受 CORS 限制；captureIndex 可一键沿用刚抓到的 url / method / body / headers
server.tool("http_request", {
  url: z.string().optional().describe("目标地址；提供 captureIndex 时可省略"),
  method: z.string().optional().describe("HTTP 方法；提供 captureIndex 时默认沿用记录值"),
  headers: z.record(z.string(), z.string()).optional().describe("追加或覆盖请求头"),
  body: z.string().optional().describe("请求体原始字符串；提供 captureIndex 时默认沿用记录值"),
  cookies: z.union([
    z.string(),
    z.array(z.object({ name: z.string(), value: z.string() }))
  ]).optional().describe("Cookie：字符串原样作为 Cookie 头，或 [{name,value}]（可直接用 capture_network includeCookies 的输出）；不传则自动使用浏览器 Cookie 存储"),
  captureIndex: z.number().optional().describe("重放 capture_network dump 里的 index，自动沿用其 url/method/body/headers"),
  referer: z.string().optional().describe("默认取当前页地址，模拟真实来源"),
  timeoutMs: z.number().default(30000),
  maxChars: z.number().default(20000)
}, async ({ url, method, headers, body, cookies, captureIndex, referer, timeoutMs, maxChars }) => {
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
  // 显式 Cookie 优先；不传时 APIRequestContext 自动用浏览器 Cookie 存储（含 HttpOnly）
  const cookieHeader = formatCookies(cookies);
  if (cookieHeader) {
    finalHeaders.Cookie = cookieHeader;
  }
  const payload = body ?? captured?.postData ?? undefined;
  const hasContentType = Object.keys(finalHeaders).some((n) => n.toLowerCase() === "content-type");
  if (payload && !hasContentType) {
    finalHeaders["Content-Type"] = "application/json";
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
  const summary = JSON.stringify({ status: resp.status(), statusText: resp.statusText(), headers: resp.headers() }, null, 2);
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
