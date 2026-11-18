import test from "node:test";
import assert from "node:assert/strict";
import { matchStrictSite, parseStrictSites, routeFor } from "../site-policy.js";

test("parseStrictSites 去空、去协议、转小写、去重", () => {
  const sites = parseStrictSites(" Taobao.com , https://X.com/path, ,taobao.com ");
  assert.deepEqual(sites, ["taobao.com", "x.com"]);
});

test("parseStrictSites 对空值与空串返回空表", () => {
  assert.deepEqual(parseStrictSites(undefined), []);
  assert.deepEqual(parseStrictSites("   "), []);
  assert.deepEqual(parseStrictSites(",,,"), []);
});

test("matchStrictSite 命中同级域名与子域", () => {
  const sites = ["taobao.com"];
  assert.equal(matchStrictSite("https://taobao.com/", sites), "taobao.com");
  assert.equal(matchStrictSite("https://s.taobao.com/search?q=1", sites), "taobao.com");
});

test("matchStrictSite 不误伤相似域名与父域", () => {
  const sites = ["taobao.com"];
  assert.equal(matchStrictSite("https://nottaobao.com/", sites), null);
  assert.equal(matchStrictSite("https://taobao.com.evil.cn/", sites), null);
  assert.equal(matchStrictSite("https://com/", sites), null);
});

test("matchStrictSite 大小写与非法 URL", () => {
  assert.equal(matchStrictSite("HTTPS://S.TAOBAO.COM/x", ["taobao.com"]), "taobao.com");
  assert.equal(matchStrictSite("about:blank", ["taobao.com"]), null);
  assert.equal(matchStrictSite("", ["taobao.com"]), null);
});

test("routeFor 命中策略表走 kimi 通道", () => {
  const route = routeFor("https://s.taobao.com/x", ["taobao.com"]);
  assert.equal(route.channel, "kimi");
  assert.equal(route.strict, true);
  assert.equal(route.matched, "taobao.com");
  assert.match(route.reason, /taobao\.com/);
});

test("routeFor 未命中走 cdp 通道", () => {
  const route = routeFor("https://example.com", ["taobao.com"]);
  assert.equal(route.channel, "cdp");
  assert.equal(route.strict, false);
  assert.equal(route.matched, null);
});

test("routeFor 空表时全部走 cdp", () => {
  assert.equal(routeFor("https://taobao.com", []).channel, "cdp");
});
