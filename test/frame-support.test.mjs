// frame 定位模块单元测试：用假的 Page/Frame 驱动，不依赖真实浏览器
import { test } from "node:test";
import assert from "node:assert/strict";
import { listFrames, resolveFrame } from "../frame-support.js";

function makeFrame({ name = "", url = "about:blank" } = {}) {
  return { name: () => name, url: () => url };
}

function makePage(frames) {
  return { frames: () => frames, mainFrame: () => frames[0] };
}

test("listFrames 返回索引、name 与 url", () => {
  const main = makeFrame({ url: "https://a.com/main" });
  const child = makeFrame({ name: "pay", url: "https://pay.b.com/form" });
  const page = makePage([main, child]);

  assert.deepEqual(listFrames(page), [
    { index: 0, name: "", url: "https://a.com/main" },
    { index: 1, name: "pay", url: "https://pay.b.com/form" }
  ]);
});

test("不传引用时返回主文档", () => {
  const main = makeFrame({ url: "https://a.com/main" });
  const page = makePage([main, makeFrame({ url: "https://b.com" })]);
  assert.equal(resolveFrame(page), main);
});

test("按数字索引取 frame", () => {
  const main = makeFrame();
  const child = makeFrame({ url: "https://b.com" });
  const page = makePage([main, child]);
  assert.equal(resolveFrame(page, 1), child);
});

test("索引越界时报错并说明总数", () => {
  const page = makePage([makeFrame()]);
  assert.throws(() => resolveFrame(page, 3), /索引越界.*共 1 个/);
});

test("按 name 精确匹配优先于 URL 匹配", () => {
  const byName = makeFrame({ name: "pay", url: "https://x.com" });
  const byUrl = makeFrame({ name: "other", url: "https://pay.y.com" });
  const page = makePage([makeFrame(), byUrl, byName]);
  assert.equal(resolveFrame(page, "pay"), byName);
});

test("按 URL 片段匹配（跨域 iframe 也能命中）", () => {
  const child = makeFrame({ url: "https://pay.other-site.com/form" });
  const page = makePage([makeFrame({ url: "https://a.com" }), child]);
  assert.equal(resolveFrame(page, "other-site"), child);
});

test("找不到时报错并列出可用 frame", () => {
  const page = makePage([makeFrame({ url: "https://a.com" }), makeFrame({ url: "https://b.com" })]);
  assert.throws(() => resolveFrame(page, "nope"), /未找到 frame「nope」.*0:https:\/\/a\.com/);
});
