'use strict';
/**
 * Crossref 数据源适配器（降级回源）
 * ------------------------------------------------------------
 * 真实接口事实（2026-10-31 实测，非文档推测）：
 *   - 公开、无需注册与 API Key；mailto 仅为礼貌池标识，不是凭证
 *   - DOI 精确查询：GET https://api.crossref.org/works/<DOI>
 *   - 检索分两段（顺序固定，见 searchLoose / searchPrecise）：
 *       ① 宽松：GET /works?query.bibliographic=<题名>&rows=N&mailto=
 *              —— 不加任何字段限定，等价于 Crossref 官网的默认搜索框
 *       ② 精确：GET /works?query.title=<题名>&query.author=<作者>
 *                        &filter=from-pub-date:<年>-01-01,until-pub-date:<年>-12-31>&rows=N
 *              —— 仅在①没有合格候选时才补一次，用作者 + 年份限定消歧
 *   - /works/<DOI> 【不支持 select 参数】，传了返回 400 validation-failure
 *   - 未收录：HTTP 404，响应体是纯文本 "Resource not found."（也不是 JSON）
 *   - 429 限流真实存在且频繁，即使 2 秒间隔也会触发，必须退避
 *   - 提供 published-online / published-print / issued 三类日期，
 *     这正是「在线预发表年份 vs 期刊卷期出版年份」的区分依据
 */

var http = require('../lib/http.js');
var T = require('../lib/text.js');

var BASE = 'https://api.crossref.org';
var MAILTO = 'lfa-mini@example.com';
var UA = 'LFA-verify/2.0 (mailto:' + MAILTO + ')';

var PROVIDER = {
  id: 'crossref',
  name: 'Crossref',
  home: 'https://www.crossref.org',
  note: '公开元数据接口，无需注册与密钥；覆盖以有 DOI 的英文期刊文献为主，中文刊与无 DOI 文献覆盖不完整'
};

function headers() {
  return { 'User-Agent': UA, 'Accept': 'application/json' };
}

function shortBody(b) {
  if (b == null) return '';
  var s = typeof b === 'string' ? b : JSON.stringify(b);
  return String(s).replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * 摘要原文（Crossref 侧）。
 * 只做「去 XML 标签 + 压空白」这类纯格式处理，不做任何改写、补全或翻译；
 * 来源没给 abstract 字段就返回空字符串——空就是空，后面一律照实显示为「来源未提供摘要」。
 */
function abstractOf(v) {
  if (!v) return '';
  /* 先还原实体再去标签：否则被二次转义的 &lt;jats:p&gt; 会在还原后变成真标签 */
  var s = String(v)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  s = T.stripTags(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 4000 ? s.slice(0, 4000) : s;
}

function yearFrom(dateParts) {
  if (!dateParts || !dateParts[0]) return '';
  var y = String(dateParts[0][0]);
  return /^\d{4}$/.test(y) ? y : '';
}

function fullDate(dateParts) {
  if (!dateParts || !dateParts[0]) return '';
  var p = dateParts[0];
  if (!/^\d{4}$/.test(String(p[0]))) return '';
  if (p[1] == null) return String(p[0]);
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  if (p[2] == null) return p[0] + '-' + pad(p[1]);
  return p[0] + '-' + pad(p[1]) + '-' + pad(p[2]);
}

/** 在线 / 印刷 / 出版年 三类日期分别保留（实测它们常常跨年不同） */
function collectYearSources(msg) {
  var src = [];
  function add(kind, dp) {
    var y = yearFrom(dp);
    if (!y) return;
    src.push({ kind: kind, year: y, full: fullDate(dp) });
  }
  add('在线预发表(published-online)', msg['published-online'] && msg['published-online']['date-parts']);
  add('印刷/卷期(published-print)', msg['published-print'] && msg['published-print']['date-parts']);
  add('出版年(issued)', msg.issued && msg.issued['date-parts']);
  return src;
}

function flattenRecord(msg) {
  var recTitle = (msg.title || []).join(' ');
  if (msg.subtitle) recTitle = T.trim(recTitle + ' ' + (msg.subtitle || []).join(' '));

  var auths = msg.author || [];
  var authorText = auths.map(function (a) {
    var g = T.trim(a.given), f = T.trim(a.family);
    if (f && g) return g + ' ' + f;
    return f || g || T.trim(a.name) || '';
  }).filter(Boolean).join('; ');

  return {
    raw: msg,
    doi: T.trim(msg.DOI),
    title: T.trim(recTitle),
    /* Crossref 的 abstract 是出版商提交的 JATS XML（<jats:p>…</jats:p>），
     * 只在真的有这个字段时才有值；没有就是空字符串，绝不补写。 */
    abstract: abstractOf(msg.abstract),
    container: T.trim((msg['container-title'] || []).join(' ')) || T.trim((msg['short-container-title'] || []).join(' ')),
    type: T.trim(msg.type),
    publisher: T.trim(msg.publisher),
    authorItems: auths,
    authorText: authorText,
    yearSources: collectYearSources(msg),
    yearIssued: yearFrom(msg.issued && msg.issued['date-parts']),
    yearPrint: yearFrom(msg['published-print'] && msg['published-print']['date-parts']),
    yearOnline: yearFrom(msg['published-online'] && msg['published-online']['date-parts']),
    volume: T.trim(msg.volume),
    issue: T.trim(msg.issue),
    page: T.trim(msg.page),
    url: T.trim(msg.URL) || (msg.DOI ? 'https://doi.org/' + msg.DOI : ''),
    landing: T.trim(msg.URL),
    flags: { isRetracted: false, citedByCount: null, openAlexId: '' }
  };
}

/** 按 DOI 精确查询 */
function byDoi(doi, opt) {
  opt = opt || {};
  var clean = T.normalizeDoi(doi);
  var url = BASE + '/works/' + encodeURI(clean) + '?mailto=' + encodeURIComponent(MAILTO);
  return http.fetchJson(url, { timeout: opt.timeout, headers: headers() }).then(function (r) {
    var base = {
      provider: PROVIDER, apiUrl: url, requestedAt: r.requestedAtText,
      httpStatus: r.status, ms: r.ms
    };
    if (!r.ok) {
      base.ok = false;
      base.failureKind = r.failureKind;
      base.failureDetail = r.failureDetail;
      base.bodySnippet = shortBody(r.raw);
      return base;
    }
    var msg = r.body && r.body.message;
    if (!msg) {
      base.ok = false;
      base.failureKind = 'parse';
      base.failureDetail = '返回 JSON 中没有 message 字段';
      base.bodySnippet = shortBody(r.raw);
      return base;
    }
    base.ok = true;
    base.raw = msg;
    base.record = flattenRecord(msg);
    return base;
  });
}

/* ==========================================================================
 *  两段式检索（顺序固定：① 宽松 → ② 精确字段）
 * ========================================================================== */

/** 题名文本清洗（去掉辅助标点，保留原词序） */
function cleanTitleWords(title) {
  var s = T.trim(title);
  if (!s) return '';
  s = s.replace(/[\[\]\(\){}<>《》「」【】"'`]/g, ' ');
  s = s.replace(/[\/\\|]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 250);
}

/** 取第一作者（姓在前 / 名在前都能用，Crossref 的 query.author 做模糊匹配） */
function firstAuthor(ref) {
  var s = T.trim(ref && ref.authors);
  if (!s) return '';
  var parts = s.split(/[;；,，]/).map(function (x) { return T.trim(x); }).filter(Boolean);
  return (parts[0] || '').slice(0, 80);
}

function year4(ref) {
  var m = String(T.trim(ref && ref.year) || '').match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}

function finishSearch(url, q, r) {
  var base = {
    provider: PROVIDER, apiUrl: url, requestedAt: r.requestedAtText,
    httpStatus: r.status, ms: r.ms, query: q
  };
  if (!r.ok) {
    base.ok = false;
    /* Crossref 检索接口「零命中」也返回 200（items 为空数组），
     * 因此这里不存在 404 分支；404 只出现在按 DOI 查询时。 */
    base.failureKind = r.failureKind === 'not_found' ? 'http_error' : r.failureKind;
    base.failureDetail = r.failureDetail;
    base.bodySnippet = shortBody(r.raw);
    base.returned = 0;
    return base;
  }
  var items = (r.body && r.body.message && r.body.message.items) || [];
  base.ok = true;
  base.raw = r.body;
  base.items = items;
  base.records = items.map(flattenRecord);
  base.returned = items.length;
  return base;
}

function emptyResult(why) {
  return {
    provider: PROVIDER, ok: false, apiUrl: '', requestedAt: http.fmtTime(new Date()),
    httpStatus: 0, failureKind: 'parse', failureDetail: why, query: '', returned: 0
  };
}

/**
 * ① 宽松检索：只用 query.bibliographic= 传题名，不加字段限定。
 *    这是 Crossref 最接近「官网搜索框」的入口，召回优先。
 */
function searchLoose(ref, opt) {
  opt = opt || {};
  ref = ref || {};
  var q = cleanTitleWords(ref.title);
  if (!q) return Promise.resolve(emptyResult('没有可用于宽松检索的题名'));

  var url = BASE + '/works?rows=' + (opt.limit || 5) +
    '&mailto=' + encodeURIComponent(MAILTO) +
    '&query.bibliographic=' + encodeURIComponent(q);

  return http.fetchJson(url, { timeout: opt.timeout, headers: headers() }).then(function (r) {
    return finishSearch(url, q, r);
  });
}

/**
 * ② 精确字段检索（宽松没有合格候选时才补充一次）
 *    query.title（标题字段）+ query.author（作者）+ 出版年区间 filter（年份）
 */
function searchPrecise(ref, opt) {
  opt = opt || {};
  ref = ref || {};
  var t = cleanTitleWords(ref.title);
  if (!t) return Promise.resolve(emptyResult('没有可用于精确检索的题名'));

  var au = firstAuthor(ref);
  var yr = year4(ref);
  var params = ['query.title=' + encodeURIComponent(t)];
  var parts = ['title=' + t];
  if (au) {
    params.push('query.author=' + encodeURIComponent(au));
    parts.push('author=' + au);
  }
  if (yr) {
    params.push('filter=' + encodeURIComponent(
      'from-pub-date:' + yr + '-01-01,until-pub-date:' + yr + '-12-31'));
    parts.push('year=' + yr);
  }

  var url = BASE + '/works?rows=' + (opt.limit || 5) +
    '&mailto=' + encodeURIComponent(MAILTO) + '&' + params.join('&');

  return http.fetchJson(url, { timeout: opt.timeout, headers: headers() }).then(function (r) {
    return finishSearch(url, parts.join(' + '), r);
  });
}

/**
 * 主题检索（「帮我找文献」用）。
 * 与核验用的两段式检索【分开】：这里传的是检索式文本，不做题名比对。
 *
 * @param {string} q 检索式文本
 * @param {object} opt {limit, yearFrom, yearTo, timeout}
 */
function searchTopic(q, opt) {
  opt = opt || {};
  var text = T.trim(q);
  if (!text) return Promise.resolve(emptyResult('检索式为空'));

  var url = BASE + '/works?rows=' + (opt.limit || 8) +
    '&mailto=' + encodeURIComponent(MAILTO) +
    '&query.bibliographic=' + encodeURIComponent(text);

  /* 年份区间走 Crossref 的 from-pub-date / until-pub-date filter（实测可用） */
  var f = [];
  if (opt.yearFrom) f.push('from-pub-date:' + opt.yearFrom + '-01-01');
  if (opt.yearTo) f.push('until-pub-date:' + opt.yearTo + '-12-31');
  if (f.length) url += '&filter=' + encodeURIComponent(f.join(','));

  return http.fetchJson(url, { timeout: opt.timeout, headers: headers() }).then(function (r) {
    return finishSearch(url, text, r);
  });
}

module.exports = {
  PROVIDER: PROVIDER,
  byDoi: byDoi,
  searchLoose: searchLoose,
  searchPrecise: searchPrecise,
  searchTopic: searchTopic,
  cleanTitleWords: cleanTitleWords,
  flattenRecord: flattenRecord
};
