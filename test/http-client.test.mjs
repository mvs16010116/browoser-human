import test from "node:test";
import assert from "node:assert/strict";
import { formatCookies, readResponse, replayHeaders } from "../http-client.js";

test("replayHeaders 剔除运行时生成的头，保留业务头", () => {
  const kept = replayHeaders({
    Host: "x.com",
    "content-length": "12",
    Connection: "keep-alive",
    "Accept-Encoding": "gzip",
    "x-token": "t",
    "Content-Type": "application/json"
  });
  assert.deepEqual(kept, { "x-token": "t", "Content-Type": "application/json" });
});

test("replayHeaders 入参为空时返回空对象", () => {
  assert.deepEqual(replayHeaders(undefined), {});
});

test("formatCookies 字符串原样返回并去空白", () => {
  assert.equal(formatCookies("  a=1; b=2  "), "a=1; b=2");
});

test("formatCookies 数组按 name=value 拼接", () => {
  const out = formatCookies([
    { name: "sid", value: "abc" },
    { name: "uid", value: "9", domain: ".x.com", httpOnly: true }
  ]);
  assert.equal(out, "sid=abc; uid=9");
});

test("formatCookies 不传或空数组返回空字符串，交由浏览器 Cookie 存储自动携带", () => {
  assert.equal(formatCookies(undefined), "");
  assert.equal(formatCookies([]), "");
});

test("readResponse 文本响应直出并按 maxChars 截断", async () => {
  const resp = {
    body: async () => Buffer.from("0123456789"),
    headers: () => ({ "content-type": "application/json" })
  };
  const text = await readResponse(resp, 4);
  assert.ok(text.startsWith("0123"));
  assert.ok(text.includes("已截断"));
});

test("readResponse 二进制响应给 base64 前缀", async () => {
  const resp = {
    body: async () => Buffer.from([0xff, 0xfe, 0x00]),
    headers: () => ({ "content-type": "image/png" })
  };
  const text = await readResponse(resp, 1000);
  assert.ok(text.includes("二进制响应 3 字节"));
});

test("readResponse 无 content-type 时按文本处理", async () => {
  const resp = {
    body: async () => Buffer.from("hello"),
    headers: () => ({})
  };
  assert.equal(await readResponse(resp, 100), "hello");
});
