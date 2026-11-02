'use strict';
/**
 * 云函数专用 HTTP 层
 * ------------------------------------------------------------
 * 只使用 Node 内置 https/http 模块，不引入任何第三方依赖，
 * 因此该云函数无需 npm install，上传即可运行。
 *
 * 失败分类（与「文献是否存在」严格区分）：
 *   timeout  —— 请求超时，说明网络不通或源站慢，与文献无关
 *   network  —— DNS/TCP/TLS 失败，与文献无关
 *   ratelimit—— 429/403，源站限流或配额耗尽，与文献无关
 *   not_found—— 404，仅说明【该源没有收录这条】，不等于文献不存在
 *   http_error—— 5xx 或其它异常状态码
 *   parse    —— 返回体不是合法 JSON（实测 OpenAlex 的 404 返回的是 HTML）
 */

var https = require('https');
var http = require('http');
var urlLib = require('url');

var DEFAULT_TIMEOUT = 12000;

/* 传输层可注入：仅用于 Node 端测试（录制回放 / 模拟断网），
 * 云函数线上运行时始终为 null，走真实的 https 请求。 */
var injected = null;

function setTransport(fn) { injected = fn || null; }

function requestRaw(urlStr, opt) {
  opt = opt || {};
  var timeout = opt.timeout || DEFAULT_TIMEOUT;
  if (injected) return injected(urlStr, opt);
  var headers = opt.headers || {};
  var started = Date.now();
  var requestedAt = new Date();

  return new Promise(function (resolve) {
    var u;
    try {
      u = urlLib.parse(urlStr);
    } catch (e) {
      resolve(fail('network', 'URL 解析失败', started, requestedAt));
      return;
    }
    if (!u || !u.hostname) {
      resolve(fail('network', 'URL 无效: ' + urlStr, started, requestedAt));
      return;
    }

    var settled = false;
    var req = null;
    function done(v) {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      resolve(v);
    }
    /* 墙钟硬守卫（关键，线上真实踩过）：
     * req.setTimeout 本质是【socket 空闲超时】，只有 socket 分配之后才开始计时，
     * DNS 解析 / TCP 建连 / TLS 握手这几个阶段卡住时它【根本不会触发】。
     * 实测现象：偶发的出网连接黑洞，请求既不返回也不超时，云函数一直挂着，
     * 最后被平台 60 秒硬超时杀掉（errCode -504003），前端一个字都拿不到——
     * 用户看到的是「一片空白」，而不是「这个源暂时不可用」。
     * 所以额外挂一个真正按墙钟走的定时器，到点主动放弃并如实报 timeout。 */
    var guard = setTimeout(function () {
      try { if (req) req.destroy(); } catch (e) { /* ignore */ }
      done(fail('timeout',
        '请求超时（超过 ' + timeout + 'ms 未收到响应，已主动放弃本次请求）', started, requestedAt));
    }, Math.max(1000, timeout + 300));
    /* unref：别让这个守卫自己把云函数的事件循环吊住不放 */
    if (guard && typeof guard.unref === 'function') guard.unref();

    var lib = (u.protocol === 'http:') ? http : https;
    req = lib.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.path || '/',
      method: opt.method || 'GET',
      headers: headers
    }, function (res) {
      var chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        done({
          ok: res.statusCode === 200,
          status: res.statusCode,
          raw: raw,
          body: null,
          requestedAt: requestedAt,
          requestedAtText: fmtTime(requestedAt),
          ms: Date.now() - started,
          failureKind: null,
          failureDetail: ''
        });
      });
    });

    req.setTimeout(timeout, function () {
      try { req.destroy(); } catch (e) { /* ignore */ }
      done(fail('timeout', '请求超时（超过 ' + timeout + 'ms 未响应）', started, requestedAt));
    });

    req.on('error', function (e) {
      done(fail('network', String((e && e.message) || e), started, requestedAt));
    });

    if (opt.body != null) req.write(opt.body);
    req.end();
  });
}

function fail(kind, detail, started, requestedAt) {
  return {
    ok: false,
    status: 0,
    raw: '',
    body: null,
    requestedAt: requestedAt,
    requestedAtText: fmtTime(requestedAt),
    ms: Date.now() - started,
    failureKind: kind,
    failureDetail: detail
  };
}

/* 云函数运行环境是 UTC，直接取本地时间会比用户手机慢 8 小时，
 * 导出记录里就会出现「导出 12:01 / 分析 04:01」这种自相矛盾的时间。
 * 这里统一按 UTC+8（中国标准时间）输出；如需其它时区可用环境变量覆盖。 */
var TZ_OFFSET_MIN = (function () {
  var v = process.env.LFA_TZ_OFFSET_MIN;
  var n = parseInt(v, 10);
  return isNaN(n) ? 480 : n;
})();

function fmtTime(d) {
  function p(n) { return n < 10 ? '0' + n : String(n); }
  var t = new Date((d ? d.getTime() : Date.now()) + TZ_OFFSET_MIN * 60000);
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) +
    ' ' + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds());
}

/** 非 200 时按状态码细分失败类型（GET / POST 共用） */
function classifyFailure(r) {
  /* 传输层已经判定过的失败（timeout / network）必须优先保留。
   * 否则 status=0 的超时会被下面的 else 分支误判成 http_error，
   * 前端「超时自动重试」就永远不会触发（它靠 kind==='timeout' 判断）。 */
  if (r.failureKind === 'timeout' || r.failureKind === 'network') return r;
  /* 注入的传输层给出的自定义失败类型也要原样透出（例如离线回放缺录制样本），
   * 不能都被抹成 http_error，否则排查方向会被带偏。 */
  if (r.status === 0 && r.failureKind) return r;
  if (r.status === 404) {
    r.failureKind = 'not_found';
    r.failureDetail = 'HTTP 404：该来源没有收录此条目';
  } else if (r.status === 429 || r.status === 403) {
    r.failureKind = 'ratelimit';
    r.failureDetail = 'HTTP ' + r.status + '：被限流或配额耗尽';
  } else if (r.status >= 500) {
    r.failureKind = 'http_error';
    r.failureDetail = 'HTTP ' + r.status + '：源站服务端错误';
  } else {
    r.failureKind = 'http_error';
    r.failureDetail = 'HTTP ' + r.status;
  }
  return r;
}

/** 取 JSON；按状态码细分失败类型 */
function fetchJson(urlStr, opt) {
  return requestRaw(urlStr, opt).then(function (r) {
    if (r.ok) {
      try {
        r.body = JSON.parse(r.raw);
        return r;
      } catch (e) {
        r.ok = false;
        r.failureKind = 'parse';
        r.failureDetail = '返回体不是合法 JSON。前 120 字：' + r.raw.slice(0, 120).replace(/\s+/g, ' ');
        return r;
      }
    }
    return classifyFailure(r);
  });
}

/**
 * POST 一个 JSON 对象并取回 JSON（用于通义千问 DashScope 原生接口）。
 * 与 fetchJson 共用同一套失败分类，保证上层判断逻辑一致。
 */
function postJson(urlStr, bodyObj, opt) {
  opt = opt || {};
  var body = (typeof bodyObj === 'string') ? bodyObj : JSON.stringify(bodyObj);
  var headers = opt.headers || {};
  headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
  return requestRaw(urlStr, {
    timeout: opt.timeout,
    headers: headers,
    method: 'POST',
    body: body
  }).then(function (r) {
    if (r.ok) {
      try {
        r.body = JSON.parse(r.raw);
        return r;
      } catch (e) {
        r.ok = false;
        r.failureKind = 'parse';
        r.failureDetail = '返回体不是合法 JSON。前 120 字：' + r.raw.slice(0, 120).replace(/\s+/g, ' ');
        return r;
      }
    }
    return classifyFailure(r);
  });
}

/**
 * 探测一个 URL 是否真的能打开（用于校验大模型给出的链接）。
 * ------------------------------------------------------------
 * 为什么需要它（2026-10-31 实测）：即便在 prompt 里三令五申「只能给本次检索
 * 命中的原始链接」，模型照样给出了 http://www.sciencep.com/book/4050 —— 看着像
 * 出版社书目详情页，实测 302 → https，落地是 HTTP 404「页面没有找到」。
 * 光靠模型自觉挡不住，只能真去访问一次。
 *
 * 做法：GET（很多站点不给 HEAD）+ 最多跟随 3 次重定向；
 *      拿到响应头就断开连接，不下载正文（省时间也省流量）。
 * 判定（宁可放过，不可错杀）：
 *      ok          —— 最终 2xx（若跟随了重定向会写明最终地址）
 *      not_found   —— 404 / 410，明确「这个地址没有这个页面」→ 可判定链接无效
 *      unverified  —— 403 / 401 / 429 / 5xx 等：站点拦爬虫或临时故障，
 *                      【不能】据此说链接是假的，如实标「未能确认」
 *      timeout / network —— 网络侧问题，同上，标「未能确认」
 *
 * 安全边界：只走 http/https，并拒绝内网 / 本机地址，避免被诱导去访问内部资源。
 */
var MAX_REDIRECTS = 3;

function isPrivateHost(host) {
  var h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;   // 云元数据服务
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function probeReachable(urlStr, opt) {
  opt = opt || {};
  /* 先【严格】校验证书，失败才降级重试：见 probeStep 注释里的原因与安全边界 */
  return probeStep(String(urlStr || '').trim(), {
    timeout: opt.timeout || 6000,
    rejectUnauthorized: true,
    depth: 0, hops: []
  });
}

var CERT_ERR = /certificate|cert|self[- ]signed|unable to verify|tls/i;

/**
 * @param {object} o {timeout, rejectUnauthorized, depth, hops}
 * 关于证书：有些站点（实测 www.sciencep.com）没有正确下发中间证书，Node 会直接报
 * 「unable to verify the first certificate」，浏览器却能正常打开。
 * 这里只在【第一次严格校验失败】时降级重试一次，并把 tlsLenient 标出来如实记录：
 * 降级后【只读取状态码】，不涉及任何凭据，也不把站点内容当成可信输入。
 */
function probeStep(urlStr, o) {
  var started = Date.now();
  var u;
  try { u = urlLib.parse(urlStr); } catch (e) { u = null; }
  if (!u || !u.hostname || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
    return Promise.resolve({ ok: false, kind: 'network', status: 0, finalUrl: urlStr, hops: o.hops, detail: '不是 http(s) 链接' });
  }
  if (isPrivateHost(u.hostname)) {
    return Promise.resolve({ ok: false, kind: 'network', status: 0, finalUrl: urlStr, hops: o.hops, detail: '拒绝访问内网地址' });
  }

  return new Promise(function (resolve) {
    var lib = (u.protocol === 'http:') ? http : https;
    var req = lib.request({
      hostname: u.hostname, port: u.port || undefined, path: u.path || '/', method: 'GET',
      rejectUnauthorized: o.rejectUnauthorized,
      headers: {
        /* 不少站点对没有 UA 的请求直接 403 / 拒绝连接 */
        'User-Agent': 'Mozilla/5.0 (compatible; LFA-verify/3.0; link-check)',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
      }
    }, function (res) {
      /* 拿到响应头就断开：这个探测只关心状态码，不需要正文 */
      res.resume();
      try { res.destroy(); } catch (e) { /* ignore */ }
      var st = res.statusCode;
      var nextHops = o.hops.concat([urlStr]);
      if (st >= 300 && st < 400 && res.headers && res.headers.location) {
        if (o.depth >= MAX_REDIRECTS) {
          return resolve({ ok: true, kind: 'ok', status: st, finalUrl: urlStr, hops: nextHops, detail: '重定向层数过多，未继续跟随' });
        }
        var nx;
        try { nx = new URL(res.headers.location, urlStr).toString(); } catch (e) { nx = res.headers.location; }
        return resolve(probeStep(nx, {
          timeout: o.timeout, rejectUnauthorized: o.rejectUnauthorized,
          depth: o.depth + 1, hops: nextHops
        }));
      }
      if (st >= 200 && st < 300) {
        return resolve({
          ok: true, kind: 'ok', status: st, finalUrl: urlStr, hops: nextHops,
          tlsLenient: !o.rejectUnauthorized, ms: Date.now() - started, detail: ''
        });
      }
      if (st === 404 || st === 410) {
        return resolve({
          ok: false, kind: 'not_found', status: st, finalUrl: urlStr, hops: nextHops,
          tlsLenient: !o.rejectUnauthorized, ms: Date.now() - started,
          detail: '服务器明确返回 ' + st + '：这个地址没有这个页面'
        });
      }
      return resolve({
        ok: false, kind: 'unverified', status: st, finalUrl: urlStr, hops: nextHops,
        tlsLenient: !o.rejectUnauthorized, ms: Date.now() - started,
        detail: 'HTTP ' + st + '（站点拦爬虫 / 需登录 / 临时故障，未能确认）'
      });
    });

    req.setTimeout(o.timeout, function () {
      try { req.destroy(); } catch (e) { /* ignore */ }
      resolve({ ok: false, kind: 'timeout', status: 0, finalUrl: urlStr, hops: o.hops, ms: Date.now() - started, detail: '超过 ' + o.timeout + 'ms 未响应，未能确认' });
    });
    /* 同上：墙钟硬守卫，防 DNS / 建连阶段挂死（socket 空闲超时覆盖不到那一段） */
    var pGuard = setTimeout(function () {
      try { req.destroy(); } catch (e) { /* ignore */ }
      resolve({
        ok: false, kind: 'timeout', status: 0, finalUrl: urlStr, hops: o.hops,
        ms: Date.now() - started,
        detail: '超过 ' + o.timeout + 'ms 未建立可用连接，已主动放弃，未能确认'
      });
    }, Math.max(1000, (o.timeout || 6000) + 300));
    if (pGuard && typeof pGuard.unref === 'function') pGuard.unref();

    req.on('error', function (e) {
      var msg = String((e && e.message) || e);
      /* 证书问题 → 放宽一次重试（已在本函数注释里说明为什么） */
      if (o.rejectUnauthorized && CERT_ERR.test(msg)) {
        return resolve(probeStep(urlStr, {
          timeout: o.timeout, rejectUnauthorized: false,
          depth: o.depth, hops: o.hops
        }));
      }
      /* 域名解析失败要说清楚：既可能是书名/网址写错，也可能是本机 DNS 或网络受限，
       * 两种都不能当作「链接无效」的铁证，所以仍然归到 unverified（保留 + 标注）。 */
      if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/i.test(msg)) {
        msg = '域名无法解析（可能是地址写错，也可能是本机 DNS / 网络受限）：' + msg;
      }
      resolve({ ok: false, kind: 'network', status: 0, finalUrl: urlStr, hops: o.hops, ms: Date.now() - started, detail: msg });
    });
    req.end();
  });
}

module.exports = {
  requestRaw: requestRaw,
  fetchJson: fetchJson,
  postJson: postJson,
  probeReachable: probeReachable,
  setTransport: setTransport,
  DEFAULT_TIMEOUT: DEFAULT_TIMEOUT,
  fmtTime: fmtTime
};
