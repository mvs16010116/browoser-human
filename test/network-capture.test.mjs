// 网络抓包模块单元测试：用假的 Page（EventEmitter）驱动，不依赖真实浏览器
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createNetworkCapture } from "../network-capture.js";

/** 构造一个只具备抓包所需接口的假 Page */
function makePage() {
  return new EventEmitter();
}

/** 构造假请求对象，Playwright 里请求对象是 Map 的键，必须保持引用稳定 */
function makeRequest(url, { method = "GET", postData = null, headers = { accept: "*/*" } } = {}) {
  return {
    url: () => url,
    method: () => method,
    resourceType: () => "xhr",
    postData: () => postData,
    headers: () => headers
  };
}

function makeResponse(request, { status = 200, headers = { "content-type": "application/json" }, body = "{}" } = {}) {
  return {
    request: () => request,
    status: () => status,
    headers: () => headers,
    text: async () => body
  };
}

test("未 start 时不记录任何请求", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  page.emit("request", makeRequest("https://a.com/x"));
  assert.equal(cap.dump().captured, 0);
});

test("start 后记录请求，并带出状态码", async () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  const req = makeRequest("https://a.com/list?page=1", { method: "POST", postData: '{"q":1}' });
  page.emit("request", req);
  page.emit("response", makeResponse(req, { status: 201 }));
  await new Promise((r) => setImmediate(r));

  const out = cap.dump();
  assert.equal(out.captured, 1);
  assert.equal(out.requests[0].method, "POST");
  assert.equal(out.requests[0].status, 201);
  assert.equal(out.requests[0].postData, '{"q":1}');
});

test("start 会清空上一次的缓冲", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  page.emit("request", makeRequest("https://a.com/old"));
  assert.equal(cap.size, 1);
  cap.start();
  assert.equal(cap.size, 0);
});

test("start 的 filter 只录制匹配的 URL", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start({ filter: "order" });
  page.emit("request", makeRequest("https://a.com/order/list"));
  page.emit("request", makeRequest("https://a.com/user/info"));
  assert.equal(cap.size, 1);
  assert.match(cap.dump().requests[0].url, /order/);
});

test("dump 的 filter 只输出匹配项，limit 限制条数", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  for (let i = 0; i < 5; i += 1) {
    page.emit("request", makeRequest(`https://a.com/order/${i}`));
    page.emit("request", makeRequest(`https://a.com/user/${i}`));
  }
  assert.equal(cap.dump({ filter: "order" }).returned, 5);
  assert.equal(cap.dump({ filter: "order", limit: 2 }).returned, 2);
});

test("入参按 maxChars 截断", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  page.emit("request", makeRequest("https://a.com/x", { method: "POST", postData: "k".repeat(100) }));
  const out = cap.dump({ maxChars: 10 });
  assert.equal(out.requests[0].postData.length, 10);
});

test("默认不输出 header，includeHeaders 才输出", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  const req = makeRequest("https://a.com/x", { headers: { cookie: "sid=1" } });
  page.emit("request", req);
  page.emit("response", makeResponse(req));
  assert.equal(cap.dump().requests[0].requestHeaders, undefined);
  assert.equal(cap.dump({ includeHeaders: true }).requests[0].requestHeaders.cookie, "sid=1");
});

test("未开启 wantBody 时不采集响应体，开启后可输出", async () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  const reqA = makeRequest("https://a.com/a");
  page.emit("request", reqA);
  page.emit("response", makeResponse(reqA, { body: '{"ok":true}' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(cap.dump({ includeBody: true }).requests[0].body, undefined);

  cap.start({ wantBody: true });
  const reqB = makeRequest("https://a.com/b");
  page.emit("request", reqB);
  page.emit("response", makeResponse(reqB, { body: '{"ok":true}' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(cap.dump({ includeBody: true }).requests[0].body, '{"ok":true}');
});

test("stop 之后不再记录新请求", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  page.emit("request", makeRequest("https://a.com/1"));
  cap.stop();
  page.emit("request", makeRequest("https://a.com/2"));
  assert.equal(cap.dump().captured, 1);
});

test("超过 500 条上限时拒绝新记录，并如实报告丢弃数", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  for (let i = 0; i < 505; i += 1) {
    page.emit("request", makeRequest(`https://a.com/${i}`));
  }
  const out = cap.dump({ limit: 1 });
  assert.equal(out.captured, 500);
  assert.equal(out.dropped, 5);
});

test("dispose 后不再占用 Page 上的监听", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  assert.equal(page.listenerCount("request"), 1);
  cap.dispose();
  assert.equal(page.listenerCount("request"), 0);
  assert.equal(page.listenerCount("response"), 0);
});

test("dump 每行带 index，get 能取到可重放信息", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  page.emit("request", makeRequest("https://a.com/list", { method: "POST", postData: '{"q":1}', headers: { "x-token": "t" } }));

  const out = cap.dump();
  assert.equal(out.requests[0].index, 0);
  const replay = cap.get(out.requests[0].index);
  assert.equal(replay.method, "POST");
  assert.equal(replay.url, "https://a.com/list");
  assert.equal(replay.postData, '{"q":1}');
  assert.equal(replay.headers["x-token"], "t");
});

test("get 的索引与 dump 过滤后的 index 一致，越界返回 null", () => {
  const page = makePage();
  const cap = createNetworkCapture(page);
  cap.start();
  page.emit("request", makeRequest("https://a.com/skip"));
  page.emit("request", makeRequest("https://a.com/api/query", { method: "POST", postData: "{}" }));

  const out = cap.dump({ filter: "/api/" });
  assert.equal(out.requests.length, 1);
  assert.equal(out.requests[0].index, 1);
  assert.equal(cap.get(1).url, "https://a.com/api/query");
  assert.equal(cap.get(9), null);
});
