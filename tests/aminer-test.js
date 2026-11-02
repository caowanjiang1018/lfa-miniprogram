'use strict';
/**
 * AMiner 数据源接入测试
 * ------------------------------------------------------------
 * 覆盖需求点：
 *   1. 检索顺序：英文题名 OpenAlex → Crossref → AMiner；中文题名直接 AMiner
 *   2. 三个源都没命中才走千问联网兜底
 *   3. 「帮我找文献」也用三个源推荐（中文检索式时 AMiner 优先）
 *   4. Token 鉴权失败必须被捕获并明确提示「Token 过期 / 去哪重新生成」
 *      —— 关键：AMiner 把鉴权失败包在 HTTP 500 里（code 40308），
 *         只按状态码判断会把它误当成「源站故障」，用户就永远修不对。
 *   5. Token 未配置时不假装检索过（留痕 + 明确提示）
 *   6. 链接红线：绝不用论文 id 拼接详情页网址
 *
 * 全部请求由注入的 transport 返回，不发外网请求。
 * 运行：node tests/aminer-test.js
 */

var path = require('path');
var CF = path.resolve(__dirname, '../cloudfunctions/lfaVerify');

var http = require(path.join(CF, 'lib/http.js'));
var aminer = require(path.join(CF, 'sources/aminer.js'));
var discover = require(path.join(CF, 'discover.js'));
var fn = require(path.join(CF, 'index.js'));

var pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  << ' + detail : '')); }
}
function head(t) { console.log('\n===== ' + t + ' ====='); }

/* ---------------- 可控的 transport ---------------- */
var calls = [];
var mode = 'ok';         // ok | auth_fail | not_found | network
var aminerHits = [];
var infoAuthors = null;  // 覆盖详情接口返回的作者（默认给英文姓名）
/* 「连接黑洞」剧本：只对 /paper/search 生效，逐次消费 'hang'（挂死）/ 'ok'（正常返回）。
 * 用于模拟 AMiner 偶发 DNS / 建连挂死时的重试行为。 */
var hangPlan = null;
var hangStep = 0;

function setToken(v) {
  if (v === null) { try { delete process.env.AMINER_TOKEN; } catch (e) { process.env.AMINER_TOKEN = ''; } }
  else process.env.AMINER_TOKEN = v;
}

function install() {
  calls = [];
  hangStep = 0;
  http.setTransport(function (url, opt) {
    calls.push({ url: url, method: (opt && opt.method) || 'GET', body: (opt && opt.body) || '' });

    /* ---- AMiner ---- */
    if (/datacenter\.aminer\.cn/.test(url)) {
      /* 连接黑洞剧本：只对搜索接口生效 */
      if (hangPlan && /\/paper\/search/.test(url)) {
        var act = hangPlan[Math.min(hangStep, hangPlan.length - 1)];
        hangStep++;
        if (act === 'hang') {
          return Promise.resolve({
            ok: false, status: 0, raw: '', requestedAtText: '2026-11-01 10:00:00', ms: 8000,
            failureKind: 'timeout',
            failureDetail: '请求超时（超过 8000ms 未收到响应，已主动放弃本次请求）'
          });
        }
      }
      if (mode === 'auth_fail') {
        return Promise.resolve({
          ok: false, status: 500,
          raw: JSON.stringify({ code: 40308, success: false, msg: 'Get Authorization Error', data: null, log_id: 'x1' }),
          requestedAtText: '2026-11-01 10:00:00', ms: 30
        });
      }
      if (mode === 'network') {
        return Promise.resolve({
          ok: false, status: 0, raw: '', requestedAtText: '2026-11-01 10:00:00', ms: 30,
          failureKind: 'network', failureDetail: '网络不可达'
        });
      }
      var isInfo = /\/paper\/info/.test(url);
      if (isInfo) {
        var ids = [];
        try { ids = JSON.parse(opt.body).ids || []; } catch (e) { ids = []; }
        var data = ids.map(function (id) {
          return {
            id: id,
            title: '基于实测的老旧小区围护结构改造供暖节能效果分析',
            title_zh: '基于实测的老旧小区围护结构改造供暖节能效果分析',
            authors: infoAuthors || [{ name: 'Zhang San', name_zh: '张三' }, { name: 'Li Si', name_zh: '李四' }],
            abstract: 'This study measured heating energy use in three old residential buildings in Beijing before and after envelope retrofit, and reported a mean reduction of 18.3 percent across two heating seasons, while extreme cold conditions were not covered.',
            abstract_zh: '本文对北京市某老旧小区 3 栋住宅楼围护结构改造前后的冬季供暖能耗进行了实测，结果表明改造后单位面积供暖能耗平均下降 18.3%，但样本未覆盖极端低温工况。',
            doi: '10.1000/zh1',
            year: 2021,
            venue: { raw: '建筑科学', name: '建筑科学' },
            n_citation: 12,
            url: 'https://kns.cnki.net/kcms2/article/abstract?v=zh1',
            volume: '37', issue: '4', page_start: '12', page_end: '20',
            lang: 'zh', type: 'journal-article'
          };
        });
        return Promise.resolve({
          ok: true, status: 200, raw: JSON.stringify({ code: 200, success: true, msg: '', data: data }),
          requestedAtText: '2026-11-01 10:00:01', ms: 40
        });
      }
      if (mode === 'not_found') {
        return Promise.resolve({
          ok: true, status: 200, raw: JSON.stringify({ code: 200, success: true, msg: '', data: [] }),
          requestedAtText: '2026-11-01 10:00:00', ms: 20
        });
      }
      var items = aminerHits.map(function (h) {
        return {
          id: h.id, title: h.title, title_zh: h.title,
          doi: h.doi, year: h.year, venue_name: h.venue,
          first_author: h.author, n_citation_bucket: '11-50'
        };
      });
      return Promise.resolve({
        ok: true, status: 200, raw: JSON.stringify({ code: 200, success: true, msg: '', data: items }),
        requestedAtText: '2026-11-01 10:00:00', ms: 20
      });
    }

    /* ---- OpenAlex / Crossref：默认都未收录（用来验证 AMiner 是否真的被启用） ---- */
    if (/api\.openalex\.org/.test(url)) {
      return Promise.resolve({
        ok: true, status: 200, raw: JSON.stringify({ results: [] }),
        requestedAtText: '2026-11-01 10:00:00', ms: 10
      });
    }
    if (/api\.crossref\.org/.test(url)) {
      return Promise.resolve({
        ok: true, status: 200,
        raw: JSON.stringify({ message: { 'total-results': 0, items: [] } }),
        requestedAtText: '2026-11-01 10:00:00', ms: 10
      });
    }
    return Promise.resolve({
      ok: false, status: 404, raw: 'not found', requestedAtText: '2026-11-01 10:00:00', ms: 5,
      failureKind: 'not_found', failureDetail: '未收录'
    });
  });
}

function aminerCalls() {
  return calls.filter(function (c) { return /datacenter\.aminer\.cn/.test(c.url); });
}
function oaCalls() {
  return calls.filter(function (c) { return /api\.openalex\.org/.test(c.url); });
}
function crCalls() {
  return calls.filter(function (c) { return /api\.crossref\.org/.test(c.url); });
}

function call(payload) { return Promise.resolve(fn.main(payload, { time_limit_in_ms: 60000 })); }

/* ==========================================================================
 *  1) Token 未配置：不请求、留痕、给明确指引
 * ========================================================================== */
head('1) Token 未配置：不假装检索过');
setToken(null);
install();
aminerHits = [];

call({
  action: 'verify',
  ref: { title: '基于实测的老旧小区围护结构改造供暖节能效果分析', authors: '张三', year: '2021', venue: '建筑科学' }
}).then(function (r1) {
  var mc = aminerCalls();
  check('A1 未配置 Token 时不发任何 AMiner 请求', mc.length === 0, '实际 ' + mc.length + ' 次');
  var skip = (r1.tried || []).filter(function (t) { return t.providerId === 'aminer'; });
  check('A2 留痕里写明 AMiner 未配置', skip.length > 0 && /AMINER_TOKEN/.test(skip[0].failureDetail || ''),
    skip.length ? skip[0].failureDetail : '没有 AMiner 留痕');
  check('A3 提示里给出去哪配置', /云开发控制台/.test(JSON.stringify(r1.tried || [])));
  check('A4 中文题名未请求两个境外源', oaCalls().length === 0 && crCalls().length === 0,
    'OA=' + oaCalls().length + ' CR=' + crCalls().length);
  check('A5 未配置时不谎报核验通过', r1.statusKey !== 'verified' && r1.statusKey !== 'verified_one_conflict',
    r1.statusKey);

  /* ==========================================================================
   *  2) Token 鉴权失败（HTTP 500 + code 40308）
   * ========================================================================== */
  head('2) Token 鉴权失败：HTTP 500 里包着 code 40308');
  setToken('bad-token-1234');
  mode = 'auth_fail';
  install();

  return call({
    action: 'verify',
    ref: { title: '基于实测的老旧小区围护结构改造供暖节能效果分析', authors: '张三', year: '2021' }
  });
}).then(function (r2) {
  var am = (r2.tried || []).filter(function (t) { return t.providerId === 'aminer'; });
  check('B1 AMiner 确实发起了请求', aminerCalls().length > 0 && am.length > 0);
  check('B2 鉴权失败被判为 auth_failed（不是 http_error）',
    am.length > 0 && am[0].failureKind === 'auth_failed',
    am.length ? am[0].failureKind : '无留痕');
  var txt = JSON.stringify(r2);
  check('B3 提示写明 Token 无效或已过期', /无效或已过期/.test(txt));
  check('B4 提示写明去控制台重新生成 Token', /重新生成 Token/.test(txt));
  check('B5 提示写明更新环境变量 AMINER_TOKEN', /AMINER_TOKEN/.test(txt));
  check('B6 不把鉴权失败说成「未收录」', !/未收录.*AMiner|AMiner.*未收录/.test(r2.reason || ''),
    (r2.reason || '').slice(0, 80));
  check('B7 不假装核验通过', r2.statusKey !== 'verified', r2.statusKey);

  /* ---- 英文题名链路的鉴权失败也要提示 ---- */
  head('2b) 英文题名：三个源都查完，AMiner 鉴权失败照样提示');
  mode = 'auth_fail';
  install();
  return call({
    action: 'verify',
    ref: { title: 'Winter heating retrofit in old communities', authors: 'Zhang San', year: '2020' }
  });
}).then(function (r2b) {
  check('B8 英文题名依次请求了 OpenAlex + Crossref + AMiner',
    oaCalls().length > 0 && crCalls().length > 0 && aminerCalls().length > 0,
    'OA=' + oaCalls().length + ' CR=' + crCalls().length + ' AM=' + aminerCalls().length);
  var txt = JSON.stringify(r2b);
  check('B9 英文链路上鉴权失败同样明确提示', /auth_failed|鉴权失败/.test(txt));

  /* ==========================================================================
   *  3) 英文题名：OA / CR 未命中 → AMiner 命中
   * ========================================================================== */
  head('3) 英文题名：前两个源未收录时由 AMiner 接手');
  setToken('good-token-5678');
  mode = 'ok';
  aminerHits = [{
    id: 'am1',
    title: 'Winter heating retrofit in old communities',
    doi: '10.1000/zh1', year: 2020, venue: 'Building Science', author: 'Zhang San'
  }];
  install();

  return call({
    action: 'verify',
    ref: { title: 'Winter heating retrofit in old communities', authors: 'Zhang San', year: '2020' }
  });
}).then(function (r3) {
  check('C1 三个源都被请求过', oaCalls().length > 0 && crCalls().length > 0 && aminerCalls().length > 0);
  var am = (r3.tried || []).filter(function (t) { return t.providerId === 'aminer'; });
  check('C2 AMiner 成功返回', am.length > 0 && am[0].ok === true,
    am.length ? String(am[0].failureDetail) : '无留痕');
  check('C3 拿到候选题录', (r3.candidates || []).length > 0, '候选 ' + (r3.candidates || []).length + ' 条');
  var c0 = (r3.candidates || [])[0] || {};
  check('C4 候选题名来自 AMiner 真实返回', /Winter heating retrofit/.test(c0.title || ''), c0.title);
  check('C5 调用了论文信息接口补详情',
    aminerCalls().filter(function (c) { return /\/paper\/info/.test(c.url); }).length > 0);
  check('C6 详情接口用 POST + ids', (function () {
    var info = aminerCalls().filter(function (c) { return /\/paper\/info/.test(c.url); });
    if (!info.length) return false;
    var b = info[0].body || '';
    return info[0].method === 'POST' && /"ids"/.test(b);
  })(), JSON.stringify(aminerCalls().map(function (c) { return c.method + ' ' + c.url.slice(-20); })));

  /* ==========================================================================
   *  4) 中文题名：直接 AMiner，不消耗两个境外源
   * ========================================================================== */
  head('4) 中文题名：直接 AMiner，不请求 OpenAlex / Crossref');
  mode = 'ok';
  aminerHits = [{
    id: 'am2',
    title: '基于实测的老旧小区围护结构改造供暖节能效果分析',
    doi: '10.1000/zh1', year: 2021, venue: '建筑科学', author: '张三'
  }];
  install();

  return call({
    action: 'verify',
    ref: { title: '基于实测的老旧小区围护结构改造供暖节能效果分析', authors: '张三', year: '2021', venue: '建筑科学' }
  });
}).then(function (r4) {
  check('D1 未请求 OpenAlex / Crossref', oaCalls().length === 0 && crCalls().length === 0,
    'OA=' + oaCalls().length + ' CR=' + crCalls().length);
  check('D2 只请求了 AMiner', aminerCalls().length > 0);
  var txt = JSON.stringify(r4.tried || []);
  check('D3 留痕写明「按检索顺序未请求 OpenAlex / Crossref」', /未请求 OpenAlex/.test(txt));
  check('D4 中文题名也能拿到候选', (r4.candidates || []).length > 0,
    '候选 ' + (r4.candidates || []).length + ' 条');
  var c0 = (r4.candidates || [])[0] || {};
  check('D5 候选带上了来源返回的摘要', !!c0.abstract, String(c0.abstract).slice(0, 40));
  check('D6 摘要来自 AMiner 论文信息接口', /18\.3|围护结构/.test(String(c0.abstract || '')),
    String(c0.abstract).slice(0, 60));

  /* ---- 链接红线：不许用 id 拼详情页 ---- */
  head('5) 链接红线：不用论文 id 拼详情页');
  var all = JSON.stringify(r4);
  check('E1 不出现拼接的 aminer 详情页网址', !/aminer\.(cn|org)\/(pub|paper)\//.test(all));
  check('E2 链接只用来源给的 url 或 DOI',
    !/https?:\/\/(www\.)?aminer\.cn\/pub\//.test(all));

  /* ==========================================================================
   *  6) 中文题名 AMiner 也没查到 → 千问兜底（未配置时如实说明）
   * ========================================================================== */
  head('6) 中文题名 AMiner 未命中：如实报未收录，不谎称不存在');
  mode = 'not_found';
  install();
  return call({
    action: 'verify',
    ref: { title: '某篇不存在的中文文献题目测试用', authors: '测试作者', year: '2021' }
  });
}).then(function (r6) {
  check('F1 状态为未收录 / 未找到类结论',
    ['not_indexed', 'ai_not_found', 'ai_found'].indexOf(r6.statusKey) >= 0, r6.statusKey);
  check('F2 明确说「不等于文献不存在」', /不等于/.test(r6.reason || ''), (r6.reason || '').slice(0, 60));
  check('F3 如实说明 AMiner 没检索到', /AMiner/.test(r6.reason || ''));

  /* ==========================================================================
   *  7) byDoi 不支持：如实返回 unsupported，不拿 DOI 去撞 title 参数
   * ========================================================================== */
  head('7) 按 DOI 查询：AMiner 两个接口都不支持，如实交代');
  return aminer.byDoi('10.1000/abc', { timeout: 5000 });
}).then(function (r7) {
  check('G1 byDoi 判为 unsupported', r7.failureKind === 'unsupported', r7.failureKind);
  check('G2 说明原因（论文信息接口只接受 ids）', /ids/.test(r7.failureDetail || ''), r7.failureDetail);

  /* ==========================================================================
   *  8) 帮我找文献：三个源都参与推荐
   * ========================================================================== */
  head('8) 帮我找文献：AMiner 参与推荐');
  mode = 'ok';
  aminerHits = [{
    id: 'am3',
    title: '老旧小区供暖改造节能效果实测研究',
    doi: '10.1000/zh2', year: 2021, venue: '建筑科学', author: '张三'
  }];
  install();

  return discover.runSearch(['老旧小区 供暖 改造 节能'], {}, { timeBudgetMs: 20000, timeout: 8000 });
}).then(function (s1) {
  check('H1 中文检索式时 AMiner 先跑',
    aminerCalls().length > 0 && oaCalls().length > 0 &&
    calls[0] && /datacenter\.aminer\.cn/.test(calls[0].url),
    '首个请求 = ' + (calls[0] ? calls[0].url.slice(0, 40) : '无'));
  check('H2 AMiner 的候选进了清单',
    (s1.candidates || []).some(function (c) { return c.sourceId === 'aminer'; }),
    (s1.candidates || []).map(function (c) { return c.sourceId; }).join(','));
  check('H3 候选带来源返回的摘要',
    (s1.candidates || []).some(function (c) { return c.sourceId === 'aminer' && c.hasAbstract; }));
  check('H4 services 列出三个源', s1.services.length === 3 &&
    s1.services.filter(function (x) { return x.id === 'aminer' && x.configured; }).length === 1);
  check('H5 orderNote 写明本次实际顺序', /AMiner/.test(s1.orderNote || ''), s1.orderNote);

  /* ---- 英文检索式：顺序应为 OpenAlex → Crossref → AMiner ---- */
  head('8b) 英文检索式：AMiner 作为补充排在最后');
  install();
  return discover.runSearch(['heating retrofit energy'], {}, { timeBudgetMs: 20000, timeout: 8000 });
}).then(function (s2) {
  var seq = calls.map(function (c) {
    return /datacenter\.aminer/.test(c.url) ? 'aminer'
      : (/api\.openalex/.test(c.url) ? 'openalex' : (/api\.crossref/.test(c.url) ? 'crossref' : '?'));
  });
  check('H6 英文检索式顺序为 OpenAlex → Crossref → AMiner',
    seq.indexOf('openalex') >= 0 && seq.indexOf('crossref') > seq.indexOf('openalex') &&
    seq.indexOf('aminer') > seq.indexOf('crossref'), seq.join(' → '));

  /* ==========================================================================
   *  9) 推荐时 Token 鉴权失败：单独提示，不让用户以为没有相关文献
   * ========================================================================== */
  head('9) 推荐时 Token 鉴权失败：独立提示');
  mode = 'auth_fail';
  install();
  return discover.runSearch(['老旧小区 供暖 改造'], {}, { timeBudgetMs: 20000, timeout: 8000 });
}).then(function (s3) {
  check('I1 authNotice 明确提示 Token 过期', /无效或已过期/.test(s3.authNotice || ''), s3.authNotice || '(空)');
  check('I2 说明本次不含 AMiner 结果', /没有.*AMiner 的结果|不含/.test(s3.authNotice || ''), s3.authNotice || '(空)');
  check('I3 不把鉴权失败说成没有相关文献', !/没有相关文献/.test(s3.failureDetail || '') || !!s3.authNotice,
    s3.failureDetail);
  var lg = (s3.log || []).filter(function (x) { return x.providerId === 'aminer'; });
  check('I4 日志里标记 auth_failed', lg.length > 0 && lg[0].failureKind === 'auth_failed',
    lg.length ? lg[0].failureKind : '无');

  /* ==========================================================================
   *  10) ping 如实回报
   * ========================================================================== */
  head('10) ping 如实回报检索顺序与 AMiner 配置');
  setToken('good-token-5678');
  return Promise.resolve(fn.main({ action: 'ping' }, { time_limit_in_ms: 60000 }));
}).then(function (p) {
  check('J1 sources 包含 aminer', (p.sources || []).indexOf('aminer') >= 0, (p.sources || []).join(','));
  check('J2 英文链路顺序正确',
    (p.searchOrder.latinTitle || []).join(',') === 'openalex,crossref,aminer,dashscope',
    (p.searchOrder.latinTitle || []).join(','));
  check('J3 中文链路顺序正确',
    (p.searchOrder.cjkTitle || []).join(',') === 'aminer,dashscope',
    (p.searchOrder.cjkTitle || []).join(','));
  check('J4 配置时只回传 Token 末 4 位', p.aminer.configured === true && p.aminer.tokenTail === '5678',
    JSON.stringify(p.aminer));
  check('J5 不回传完整 Token', JSON.stringify(p).indexOf('good-token-5678') < 0);
  check('J6 列明只用两个接口', (p.aminer.endpoints || []).length === 2, JSON.stringify(p.aminer.endpoints));

  setToken(null);
  return Promise.resolve(fn.main({ action: 'ping' }, { time_limit_in_ms: 60000 }));
}).then(function (p2) {
  check('J7 未配置时如实标注', p2.aminer.configured === false && /未配置/.test(p2.aminer.note || ''));

  /* ==========================================================================
   *  11) 按 AMiner 论文 id 精确核验：中文文献也能「核验成功 + 补全摘要」
   * ========================================================================== */
  head('11) 按论文 id 精确核验（中文文献核验成功并拿到可补全的摘要）');
  setToken('good-token-5678');
  mode = 'ok';
  infoAuthors = [{ name: '张三', name_zh: '张三' }, { name: '李四', name_zh: '李四' }];
  install();

  return call({
    action: 'verify',
    ref: {
      aminerId: 'am9',
      title: '基于实测的老旧小区围护结构改造供暖节能效果分析',
      authors: '张三; 李四', year: '2021', venue: '建筑科学'
    }
  });
}).then(function (r8) {
  check('K1 中文文献核验成功（verified）', r8.statusKey === 'verified',
    r8.statusKey + '｜' + (r8.reason || '').slice(0, 90));
  check('K2 记录来自 AMiner', r8.provider && r8.provider.id === 'aminer',
    r8.provider ? r8.provider.id : '无');
  check('K3 拿到来源返回的摘要（可用于补全）', !!((r8.record || {}).abstract),
    String((r8.record || {}).abstract).slice(0, 40));
  check('K4 摘要标明真实出处', (r8.record || {}).abstractFrom === 'AMiner',
    String((r8.record || {}).abstractFrom));
  check('K5 记录带完整题录（作者 / 年份 / 出处）',
    !!(r8.record && r8.record.authors && r8.record.yearIssued && r8.record.container),
    JSON.stringify({
      a: (r8.record || {}).authors, y: (r8.record || {}).yearIssued, c: (r8.record || {}).container
    }));
  check('K6 逐字段比对有结果', (r8.checks || []).length > 0, '检查项 ' + (r8.checks || []).length);
  check('K7 用了论文信息接口（POST）',
    aminerCalls().some(function (c) { return /\/paper\/info/.test(c.url) && c.method === 'POST'; }));

  /* ==========================================================================
   *  12) 按 id 核验时 Token 过期：明确提示，不谎报未收录
   * ========================================================================== */
  head('12) 按 id 核验时 Token 过期：明确提示');
  mode = 'auth_fail';
  install();
  return call({
    action: 'verify',
    ref: { aminerId: 'am9', title: '基于实测的老旧小区围护结构改造供暖节能效果分析', year: '2021' }
  });
}).then(function (r9) {
  var txt = JSON.stringify(r9);
  check('L1 提示 Token 无效或已过期', /无效或已过期/.test(txt));
  check('L2 提示去更新 AMINER_TOKEN', /AMINER_TOKEN/.test(txt));
  check('L3 不谎报核验通过', r9.statusKey !== 'verified', r9.statusKey);
  infoAuthors = null;

  /* ==========================================================================
   *  13) 单段检索 + 时间预算收敛
   *  AMiner 的搜索接口只有 title 参数，「宽松 / 精确」发出去是同一个请求。
   *  云端实测：两次一样的请求 + 补详情，三次串行叠加会拖过平台硬超时，
   *  因此必须【只跑一次】，并且每个子请求按 deadline 收敛、可选步骤预算不足就不发。
   * ========================================================================== */
  head('13) 单段检索：AMiner 不重复发两次相同请求');
  setToken('good-token-5678');
  mode = 'ok';
  install();
  aminerHits = [
    { id: 'am1', title: 'Winter heating retrofit in old residential communities', doi: '10.1000/w1', year: 2020, venue: 'Energy and Buildings', author: 'Zhang San' }
  ];
  return call({
    action: 'verify',
    ref: { title: 'Winter heating retrofit in old residential communities', authors: 'Zhang San', year: '2020' },
    aiSearch: false
  });
}).then(function (r10) {
  var am = (r10.tried || []).filter(function (t) { return t.providerId === 'aminer'; });
  check('M1 AMiner 只检索一次（不是宽松+精确两次）', am.length === 1, '实际 ' + am.length + ' 次');
  check('M2 标注为「只支持题名检索」的单段方法',
    am.length === 1 && am[0].method === 'title-only-search', am.length ? am[0].method : '无');
  check('M3 留痕写明该来源不支持作者 / 年份字段限定',
    /不支持|本地收敛/.test(JSON.stringify((r10.searchTrail || (r10.result && r10.result.searchTrail) || am[0].traces || '')) +
      JSON.stringify(r10)),
    '未找到相关说明');
  check('M4 仍然拿到了 AMiner 的候选', (r10.candidates || []).length > 0,
    '候选 ' + (r10.candidates || []).length + ' 条');

  /* ---------- 时间预算：可选步骤预算不足就不发 ---------- */
  head('14) 时间预算不足：跳过可选请求，且如实标注「未发起」');
  install();
  aminerHits = [];     // 搜索返回 0 条 → 本会触发「题名前段降级重试」
  var pastDeadline = Date.now() - 1;
  /* 题名要够长（> 40 字）才会触发「题名前段降级重试」这条可选路径 */
  return aminer.paperSearch(
    '基于实测数据驱动的老旧小区围护结构改造供暖节能效果分析与经济性综合评价研究——以北京市某典型住宅小区冬季供暖季为例',
    { timeout: 8000, deadline: pastDeadline });
}).then(function (rs) {
  check('M5 必做的那次检索照常发出', aminerCalls().length === 1, '实际 ' + aminerCalls().length + ' 次');
  check('M6 预算不足时【不发】降级重试',
    !!(rs.shortRetry && rs.shortRetry.skipped === 'budget_exhausted'),
    JSON.stringify(rs.shortRetry || {}));
  check('M7 如实写明「不是检索不到」',
    !!(rs.shortRetry && /不是检索不到/.test(rs.shortRetry.note || '')),
    rs.shortRetry ? rs.shortRetry.note : '');

  install();
  var recs = [aminer.toRecord({ id: 'am1', title: '某中文论文题名', year: 2021 })];
  return aminer.enrich(recs, { timeout: 8000, deadline: Date.now() - 1 });
}).then(function (e) {
  check('M8 预算不足时【不发】补详情请求', aminerCalls().length === 0,
    '实际 ' + aminerCalls().length + ' 次');
  check('M9 说明题录本身仍然有效', /题录本身|仍然有效/.test(e.note || ''), e.note || '');
      check('M10 补详情被跳过时不算成功', e.ok === false && e.filled === 0, JSON.stringify(e));

      /* ==========================================================================
       *  15) 连接黑洞快速重试（云端实测：AMiner 偶发 DNS / 建连挂死，
       *      表现是「超时/无响应」而不是「没收录」。
       *      把超时拉到 22s 干等没用，早点重发一次多数秒回。）
       * ========================================================================== */
      head('15) 连接黑洞：首次挂死立即重发，不干等');
      setToken('good-token-5678');
      mode = 'ok';
      install();
      hangPlan = ['hang', 'ok'];   // 第一次挂死，重发一次拿到结果
      aminerHits = [{ id: 'bh1', title: '基于实测的老旧小区围护结构改造供暖节能效果分析', doi: '', year: 2021, venue: '建筑科学', author: '张三' }];
      return aminer.searchLoose(
        { title: '基于实测的老旧小区围护结构改造供暖节能效果分析' },
        { timeout: 22000, deadline: Date.now() + 30000 }
      );
    }).then(function (rb1) {
      var searches = aminerCalls().filter(function (c) { return /\/paper\/search/.test(c.url); });
      check('N1 首次挂死后立刻重发一次', searches.length === 2, '实际发出 ' + searches.length + ' 次检索');
      check('N2 重发后确实拿到了结果', rb1.ok && rb1.returned === 1,
        'ok=' + rb1.ok + ' returned=' + rb1.returned);
      check('N3 如实标注「重试过」而不是假装一次成功',
        rb1.retried === 1 && /重发|重试/.test(rb1.retryNote || ''), rb1.retryNote || '（无说明）');

      /* ---------- 两次都黑洞：才算真的失败，且不能说成「未收录」 ---------- */
      head('16) 两次都黑洞：如实报连接问题，不说「没收录」');
      install();
      hangPlan = ['hang', 'hang'];
      return aminer.searchLoose(
        { title: '基于实测的老旧小区围护结构改造供暖节能效果分析' },
        { timeout: 22000, deadline: Date.now() + 30000 }
      );
    }).then(function (rb2) {
      check('N4 两次都没拿到响应才算失败', rb2.ok === false, 'ok=' + rb2.ok);
      check('N5 说清「连续两次没有响应」', /连续两次/.test(rb2.failureDetail || ''), rb2.failureDetail || '');
      check('N6 绝不谎报「未收录」', rb2.failureKind !== 'not_found', rb2.failureKind || '');
      check('N7 说明这与文献是否存在无关', /是否存在无关/.test(rb2.failureDetail || ''), rb2.failureDetail || '');
      hangPlan = null;
    }).then(function () {
  console.log('\n========== AMiner 接入测试：通过 ' + pass + ' / 失败 ' + fail + ' ==========');
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.error('运行异常：', (e && e.stack) || e);
  process.exit(1);
});
