// 网络抓包：监听 Playwright Page 的 request / response，先进缓冲再按需过滤导出。
// 只在内存里保存，不落盘，避免 Cookie / Authorization 等敏感信息被持久化。
const MAX_RECORDS = 500;
const BODY_SLICE = 4000;

export function createNetworkCapture(page) {
  const records = new Map();
  let order = [];
  let recording = false;
  let captureBody = false;
  let urlFilter = null;
  let dropped = 0;

  function onRequest(request) {
    if (!recording) {
      return;
    }
    if (urlFilter && !urlFilter.test(request.url())) {
      return;
    }
    if (order.length >= MAX_RECORDS) {
      dropped += 1;
      return;
    }
    records.set(request, {
      method: request.method(),
      url: request.url(),
      type: request.resourceType(),
      postData: request.postData() || null,
      headers: request.headers(),
      status: null,
      responseHeaders: null,
      body: null
    });
    order.push(request);
  }

  async function onResponse(response) {
    const record = records.get(response.request());
    if (!record) {
      return;
    }
    record.status = response.status();
    record.responseHeaders = response.headers();
    if (captureBody && record.body === null) {
      try {
        record.body = (await response.text()).slice(0, BODY_SLICE);
      } catch {
        // 响应体在页面跳转后可能取不到，保留 null 即可
      }
    }
  }

  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    start({ filter, wantBody } = {}) {
      order = [];
      records.clear();
      urlFilter = filter ? new RegExp(filter, "i") : null;
      captureBody = Boolean(wantBody);
      dropped = 0;
      recording = true;
    },
    stop() {
      recording = false;
    },
    clear() {
      order = [];
      records.clear();
    },
    get recording() {
      return recording;
    },
    get size() {
      return order.length;
    },
    dump({ filter, limit, includeHeaders, includeBody, maxChars } = {}) {
      const re = filter ? new RegExp(filter, "i") : null;
      const cap = maxChars || 2000;
      const rows = [];
      for (let index = 0; index < order.length; index += 1) {
        const record = records.get(order[index]);
        if (!record || (re && !re.test(record.url))) {
          continue;
        }
        const row = {
          index,
          method: record.method,
          url: record.url,
          type: record.type,
          status: record.status
        };
        if (record.postData) {
          row.postData = record.postData.slice(0, cap);
        }
        if (includeHeaders) {
          row.requestHeaders = record.headers;
          row.responseHeaders = record.responseHeaders;
        }
        if (includeBody && record.body) {
          row.body = record.body.slice(0, cap);
        }
        rows.push(row);
        if (rows.length >= (limit || 50)) {
          break;
        }
      }
      return { recording, captured: order.length, dropped, returned: rows.length, requests: rows };
    },
    /** 取指定序号的可重放信息；序号即 dump 每行的 index，越界或已清空时返回 null */
    get(index) {
      const record = records.get(order[index]);
      if (!record) {
        return null;
      }
      return {
        method: record.method,
        url: record.url,
        postData: record.postData,
        headers: record.headers
      };
    },
    dispose() {
      page.off("request", onRequest);
      page.off("response", onResponse);
    }
  };
}
