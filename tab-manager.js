/**
 * 会话标签页管理器：约束本会话标签页的数量与生命周期，避免 agent 反复开页造成标签泛滥。
 * 只做纯逻辑，页对象由调用方注入，关闭动作也通过 page.close() 完成，便于单测。
 */

export const DEFAULT_MAX_TABS = 5;
export const DEFAULT_IDLE_CLOSE_MS = 20 * 60 * 1000;

/**
 * @param {object} options
 * @param {number} options.maxTabs 会话标签页上限，超出后按最久未使用顺序回收
 * @param {number} options.idleCloseMs 空闲多久后允许整批回收，<=0 表示不启用
 * @param {() => number} options.now 时间源，便于测试
 */
export function createTabManager({
  maxTabs = DEFAULT_MAX_TABS,
  idleCloseMs = DEFAULT_IDLE_CLOSE_MS,
  now = Date.now
} = {}) {
  const pages = new Set();
  let current = null;
  let lastActivity = now();
  let lastReclaim = null;

  const alive = () => [...pages].filter((p) => !p.isClosed());

  /** 标记有活动，空闲回收据此判断 */
  function touch() {
    lastActivity = now();
  }

  /** 纳入管理并设为当前页；用户手动关闭该页时自动从集合移除 */
  function add(p) {
    pages.add(p);
    current = p;
    touch();
    p.on?.("close", () => pages.delete(p));
    return p;
  }

  function remove(p) {
    pages.delete(p);
    if (current === p) {
      current = null;
    }
  }

  function setCurrent(p) {
    current = p;
    touch();
  }

  function getCurrent() {
    return current && !current.isClosed() ? current : null;
  }

  function list() {
    return alive();
  }

  /**
   * 关闭单个页。关闭的是当前页时把当前页置空，由调用方决定是否切换。
   * 返回是否执行了关闭。
   */
  async function close(p) {
    if (!p) {
      return false;
    }
    try {
      await p.close();
    } catch {
      // 页已失效时忽略
    }
    pages.delete(p);
    if (current === p) {
      current = null;
    }
    return true;
  }

  /** 超过上限时按最久未使用顺序关闭，当前页始终保留；返回被关闭的页 */
  async function enforceLimit() {
    const closed = [];
    let items = alive();
    while (items.length > maxTabs) {
      const victim = items.find((p) => p !== current) || items[0];
      await close(victim);
      closed.push(victim);
      items = alive();
    }
    return closed;
  }

  /** keepCurrent 为 true 时保留当前页，其余全部关闭；返回关闭数量 */
  async function closeAll({ keepCurrent = false } = {}) {
    let count = 0;
    for (const p of alive()) {
      if (keepCurrent && p === current) {
        continue;
      }
      await close(p);
      count += 1;
    }
    return count;
  }

  function idleFor() {
    return now() - lastActivity;
  }

  function shouldReclaim() {
    return idleCloseMs > 0 && idleFor() >= idleCloseMs;
  }

  /** 记录一次自动回收，同时把活动时间重置，避免定时器空转 */
  function markReclaimed(count) {
    lastReclaim = { at: now(), count };
    touch();
  }

  function reclaimInfo() {
    return lastReclaim;
  }

  function size() {
    return alive().length;
  }

  return {
    maxTabs,
    idleCloseMs,
    touch,
    add,
    remove,
    setCurrent,
    getCurrent,
    list,
    close,
    enforceLimit,
    closeAll,
    idleFor,
    shouldReclaim,
    markReclaimed,
    reclaimInfo,
    size
  };
}
