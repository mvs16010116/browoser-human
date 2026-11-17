import test from "node:test";
import assert from "node:assert/strict";
import { createTabManager, DEFAULT_MAX_TABS, DEFAULT_IDLE_CLOSE_MS } from "../tab-manager.js";

/** 可控的假页对象：close() 会触发 close 事件，userClose() 模拟用户手动关闭 */
function fakePage() {
  let closed = false;
  const listeners = {};
  return {
    isClosed: () => closed,
    close: async () => {
      closed = true;
      listeners.close?.();
    },
    on: (event, handler) => {
      listeners[event] = handler;
    },
    userClose: () => {
      closed = true;
      listeners.close?.();
    }
  };
}

test("add 纳入管理并设为当前页", () => {
  const tabs = createTabManager();
  const p = fakePage();
  tabs.add(p);
  assert.equal(tabs.size(), 1);
  assert.equal(tabs.getCurrent(), p);
});

test("用户手动关闭的页不再计入", () => {
  const tabs = createTabManager();
  const p = fakePage();
  tabs.add(p);
  p.userClose();
  assert.equal(tabs.size(), 0);
  assert.equal(tabs.getCurrent(), null);
});

test("超过上限时关闭最旧页并保留当前页", async () => {
  const tabs = createTabManager({ maxTabs: 3 });
  const pages = [fakePage(), fakePage(), fakePage(), fakePage()];
  pages.forEach((p) => tabs.add(p));
  const closed = await tabs.enforceLimit();
  assert.equal(closed.length, 1);
  assert.equal(closed[0], pages[0]);
  assert.equal(tabs.size(), 3);
  assert.equal(tabs.getCurrent(), pages[3]);
});

test("enforceLimit 在当前页最旧时也不会关掉当前页", async () => {
  const tabs = createTabManager({ maxTabs: 2 });
  const first = fakePage();
  const second = fakePage();
  const third = fakePage();
  tabs.add(first);
  tabs.add(second);
  tabs.add(third);
  tabs.setCurrent(first);
  const closed = await tabs.enforceLimit();
  assert.equal(closed.length, 1);
  assert.equal(closed[0], second);
  assert.equal(tabs.getCurrent(), first);
});

test("未超上限时不关闭任何页", async () => {
  const tabs = createTabManager({ maxTabs: 5 });
  tabs.add(fakePage());
  tabs.add(fakePage());
  const closed = await tabs.enforceLimit();
  assert.deepEqual(closed, []);
  assert.equal(tabs.size(), 2);
});

test("closeAll 默认关闭全部并清空当前页", async () => {
  const tabs = createTabManager();
  tabs.add(fakePage());
  tabs.add(fakePage());
  const count = await tabs.closeAll();
  assert.equal(count, 2);
  assert.equal(tabs.size(), 0);
  assert.equal(tabs.getCurrent(), null);
});

test("closeAll 传入 keepCurrent 时保留当前页", async () => {
  const tabs = createTabManager();
  const first = fakePage();
  const second = fakePage();
  tabs.add(first);
  tabs.add(second);
  const count = await tabs.closeAll({ keepCurrent: true });
  assert.equal(count, 1);
  assert.equal(tabs.getCurrent(), second);
  assert.equal(tabs.size(), 1);
});

test("关闭当前页后 current 置空，由调用方决定切换", async () => {
  const tabs = createTabManager();
  const only = fakePage();
  tabs.add(only);
  await tabs.close(only);
  assert.equal(tabs.getCurrent(), null);
  assert.equal(tabs.size(), 0);
});

test("list 只返回未被关闭的页", async () => {
  const tabs = createTabManager();
  const first = fakePage();
  const second = fakePage();
  tabs.add(first);
  tabs.add(second);
  await first.close();
  assert.deepEqual(tabs.list(), [second]);
});

test("空闲未达阈值时不回收", () => {
  let clock = 0;
  const tabs = createTabManager({ idleCloseMs: 1000, now: () => clock });
  tabs.touch();
  clock = 999;
  assert.equal(tabs.shouldReclaim(), false);
  clock = 1000;
  assert.equal(tabs.shouldReclaim(), true);
});

test("idleCloseMs <= 0 时永不回收", () => {
  let clock = 0;
  const tabs = createTabManager({ idleCloseMs: 0, now: () => clock });
  clock = 99999999;
  assert.equal(tabs.shouldReclaim(), false);
});

test("touch 刷新活动时间，阻止回收", () => {
  let clock = 0;
  const tabs = createTabManager({ idleCloseMs: 1000, now: () => clock });
  clock = 900;
  tabs.touch();
  clock = 1500;
  assert.equal(tabs.shouldReclaim(), false);
});

test("markReclaimed 记录回收次数并重置活动时间", () => {
  let clock = 0;
  const tabs = createTabManager({ idleCloseMs: 1000, now: () => clock });
  clock = 5000;
  tabs.markReclaimed(3);
  assert.deepEqual(tabs.reclaimInfo(), { at: 5000, count: 3 });
  assert.equal(tabs.shouldReclaim(), false);
});

test("默认上限与空闲阈值符合预期", () => {
  assert.equal(DEFAULT_MAX_TABS, 5);
  assert.equal(DEFAULT_IDLE_CLOSE_MS, 20 * 60 * 1000);
});

test("close 传入空值不报错", async () => {
  const tabs = createTabManager();
  assert.equal(await tabs.close(null), false);
});
