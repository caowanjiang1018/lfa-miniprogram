'use strict';
/**
 * 阶段 A 补充：多源降级路径专项测试
 * ------------------------------------------------------------
 * 目标：证明「OpenAlex 优先、失败降级 Crossref」不是纸面设计，而是真的会执行、真的会换源。
 *
 * 方法（不编造数据来源）：
 *   - Crossref 一律走【真实 HTTPS 请求】，返回的是真数据；
 *   - OpenAlex 用注入的传输层模拟「限流 / 超时 / 未收录」三种失败，
 *     （软件测试需要人为制造失败，这是唯一被允许的人造部分，且已在此注明）。
 *
 * 断言重点：
 *   1. 降级后结论确实来自 Crossref；
 *   2. 日志里两个源都留下了痕迹（先失败后成功）；
 *   3. 两个源都失败时是「网络异常」，绝不能谎报「未收录」；
 *   4. 两源都明确 404 才是「未收录」。
 */
var path = require('path');
var https = require('https');
var urlLib = require('url');

var CF = path.join(__dirname, '../cloudfunctions/lfaVerify');
var http = require(path.join(CF, 'lib/http.js'));
var engine = require(path.join(CF, 'index.js'));

var pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg); }
}

/** Crossref 真实请求 */
function realCrossref(urlStr, opt) {
  var timeout = (opt && opt.timeout) || 15000;
  var started = Date.now();
  var requestedAt = new Date();
  return new Promise(function (resolve) {
    var u = urlLib.parse(urlStr);
    var req = https.request({
      hostname: u.hostname, port: u.port || undefined,
      path: u.path || '/', method: 'GET', headers: opt.headers || {}
    }, function (res) {
      var chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () {
        resolve({
          ok: res.statusCode === 200, status: res.statusCode,
          raw: Buffer.concat(chunks).toString('utf8'), body: null,
          requestedAt: requestedAt, requestedAtText: http.fmtTime(requestedAt),
          ms: Date.now() - started, failureKind: null, failureDetail: ''
        });
      });
    });
    req.setTimeout(timeout, function () {
      req.destroy();
      resolve({
        ok: false, status: 0, raw: '', body: null,
        requestedAt: requestedAt, requestedAtText: http.fmtTime(requestedAt),
        ms: Date.now() - started,
        failureKind: 'timeout', failureDetail: '请求超时（模拟）'
      });
    });
    req.on('error', function (e) {
      resolve({
        ok: false, status: 0, raw: '', body: null,
        requestedAt: requestedAt, requestedAtText: http.fmtTime(requestedAt),
        ms: Date.now() - started,
        failureKind: 'network', failureDetail: String(e && e.message || e)
      });
    });
    req.end();
  });
}

/** 造一个 OpenAlex 的失败响应（软件测试专用，非真实数据） */
function fakeOpenAlex(kind) {
  if (kind === 'ratelimit') {
    return {
      ok: false, status: 429, raw: '', body: null,
      requestedAt: new Date(), requestedAtText: http.fmtTime(new Date()),
      ms: 120, failureKind: 'ratelimit', failureDetail: 'HTTP 429：被限流或配额耗尽（测试注入）'
    };
  }
  if (kind === 'timeout') {
    return {
      ok: false, status: 0, raw: '', body: null,
      requestedAt: new Date(), requestedAtText: http.fmtTime(new Date()),
      ms: 3000, failureKind: 'timeout', failureDetail: '请求超时（测试注入）'
    };
  }
  // not_found
  return {
    ok: false, status: 404, raw: '', body: null,
    requestedAt: new Date(), requestedAtText: http.fmtTime(new Date()),
    ms: 900, failureKind: 'not_found', failureDetail: 'HTTP 404：该来源没有收录此条目（测试注入）'
  };
}

function makeTransport(oaKind) {
  return function (urlStr, opt) {
    if (urlStr.indexOf('openalex.org') >= 0) {
      return Promise.resolve(fakeOpenAlex(oaKind));
    }
    if (urlStr.indexOf('crossref.org') >= 0) {
      return realCrossref(urlStr, opt);
    }
    return Promise.resolve({
      ok: false, status: 0, raw: '', body: null,
      requestedAt: new Date(), requestedAtText: http.fmtTime(new Date()),
      ms: 0, failureKind: 'network', failureDetail: '未知域名：' + urlStr
    });
  };
}

var REF = {
  doi: '10.1038/nature14539',
  title: 'Deep learning',
  authors: 'LeCun Y',
  year: '2015',
  venue: 'Nature'
};

async function main() {
  console.log('==================================');
  console.log('多源降级专项测试（OpenAlex 失败 → Crossref 接力）');
  console.log('==================================');

  /* ---- 1. OpenAlex 限流 → 降级 Crossref ---- */
  console.log('\n===== [1] OpenAlex 429 限流 → 应降级到 Crossref 并命中 =====');
  http.setTransport(makeTransport('ratelimit'));
  var r1 = await engine.verifyOne(REF, { allowSearch: false });
  console.log('  → ' + r1.statusText + '（' + r1.statusKey + '）');
  ok(r1.statusKey === 'verified', '降级后仍给出「题录已核验无误」');
  ok(r1.provider && r1.provider.id === 'crossref', '结论来源确实是 Crossref（实际=' +
    (r1.provider && r1.provider.id) + '）');
  /* 第五阶段起：命中源没给摘要时，会再按同一 DOI 到另一个源补取摘要（abstract-topup），
   * 这也是一条真实的请求留痕，所以这里按「两个核验源 + 可能的补摘要请求」来断言。 */
  var coreTried = (r1.tried || []).filter(function (t) {
    return t.method !== 'abstract-topup';
  });
  ok(coreTried.length === 2, '日志记录了两个核验源（实际 ' + coreTried.length + ' 条）');
  ok(r1.tried[0].failureKind === 'ratelimit', '第 1 个源记录为限流');
  ok(r1.tried[1].ok === true && r1.tried[1].httpStatus === 200, '第 2 个源 Crossref 真实命中 HTTP 200');
  ok(/Deep learning/i.test(r1.record && r1.record.title || ''), 'Crossref 返回的题名正确：' +
    (r1.record && r1.record.title || '').slice(0, 40));

  /* ---- 2. OpenAlex 超时 → 降级 Crossref ---- */
  console.log('\n===== [2] OpenAlex 超时 → 应降级到 Crossref 并命中 =====');
  http.setTransport(makeTransport('timeout'));
  var r2 = await engine.verifyOne(REF, { allowSearch: false });
  console.log('  → ' + r2.statusText + '（' + r2.statusKey + '）');
  ok(r2.statusKey === 'verified', '超时降级后仍给出「题录已核验无误」');
  ok(r2.provider && r2.provider.id === 'crossref', '结论来源是 Crossref');
  ok(r2.tried[0].failureKind === 'timeout', '第 1 个源记录为超时');

  /* ---- 3. 两源都失败（非 404）→ 网络异常，不是未收录 ---- */
  console.log('\n===== [3] 两源都超时/限流 → 必须是「网络异常」，不能谎报未收录 =====');
  http.setTransport(function (urlStr, opt) {
    return Promise.resolve(fakeOpenAlex(urlStr.indexOf('openalex') >= 0 ? 'timeout' : 'ratelimit'));
  });
  var r3 = await engine.verifyOne(REF, { allowSearch: false });
  console.log('  → ' + r3.statusText + '（' + r3.statusKey + '）');
  ok(r3.statusKey === 'network_error', '归类为网络异常（不是 not_indexed）');
  ok(r3.statusKey !== 'verified', '绝不会谎报为已核验');

  /* ---- 4. 两源都明确 404 → 未收录 ---- */
  console.log('\n===== [4] 两源都明确 404 → 才是「公开元数据库未收录」 =====');
  http.setTransport(function () { return Promise.resolve(fakeOpenAlex('not_found')); });
  var r4 = await engine.verifyOne(REF, { allowSearch: false });
  console.log('  → ' + r4.statusText + '（' + r4.statusKey + '）');
  ok(r4.statusKey === 'not_indexed', '两源都 404 → 未收录（有确定答案）');
  ok(/不等于/.test(r4.reason), '文案明确说明「不等于文献不存在」');

  http.setTransport(null);

  console.log('\n==================================');
  console.log('降级测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==================================');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
