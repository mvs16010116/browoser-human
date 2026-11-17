/**
 * 端到端验证 iframe 支持：起两个不同源的本地服务，主文档嵌跨域 iframe，
 * 用真实 Playwright 打开后验证 listFrames / resolveFrame 与拟人动作在 frame 内生效。
 * 浏览器不可用时整组跳过，避免无 Chromium 的环境误报失败。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { createHuman } from "@humanjs/playwright";
import { listFrames, resolveFrame } from "../frame-support.js";

const MAIN_PAGE = `<!doctype html><title>main</title>
<iframe name="panel" src="http://localhost:PORT/frame"></iframe>`;
const FRAME_PAGE = `<!doctype html><title>panel</title>
<button id="go" onclick="document.getElementById('out').textContent='clicked'">go</button>
<input id="kw"><div id="out">idle</div>`;

let browser = null;
let page = null;
const servers = [];

function listen(host, html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, host, () => {
      servers.push(server);
      resolve(server.address().port);
    });
  });
}

before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = null;
    return;
  }
  const framePort = await listen("127.0.0.1", FRAME_PAGE);
  // 主机名不同即为不同源，等价于线上跨域 iframe
  const mainHtml = MAIN_PAGE.replace("PORT", framePort);
  const mainPort = await listen("localhost", mainHtml);
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${mainPort}/`, { waitUntil: "load" });
  await page.frameLocator("iframe").locator("#go").waitFor();
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (browser) {
    await browser.close();
  }
});

test("listFrames 能列出主文档与跨域 iframe", async (t) => {
  if (!browser) return t.skip("本机无可用 Chromium");
  const frames = listFrames(page);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].index, 0);
  assert.equal(frames[1].name, "panel");
  assert.match(frames[1].url, /localhost:\d+\/frame/);
});

test("按 URL 片段能解析到跨域 iframe", async (t) => {
  if (!browser) return t.skip("本机无可用 Chromium");
  const frame = resolveFrame(page, "/frame");
  assert.equal(frame.name(), "panel");
  assert.equal(await frame.locator("#out").innerText(), "idle");
});

test("拟人点击在跨域 iframe 内真实生效", async (t) => {
  if (!browser) return t.skip("本机无可用 Chromium");
  const frame = resolveFrame(page, "panel");
  const human = await createHuman(page, { personality: "careful", seed: 12345 });
  await human.click(frame.locator("#go"));
  assert.equal(await frame.locator("#out").innerText(), "clicked");
});

test("拟人输入在跨域 iframe 内真实生效", async (t) => {
  if (!browser) return t.skip("本机无可用 Chromium");
  const frame = resolveFrame(page, "panel");
  const human = await createHuman(page, { personality: "careful", seed: 12345 });
  const input = frame.locator("#kw");
  await human.click(input);
  await human.type(input, "abc");
  assert.equal(await input.inputValue(), "abc");
});
