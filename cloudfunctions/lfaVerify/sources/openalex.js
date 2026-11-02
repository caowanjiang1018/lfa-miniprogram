'use strict';
/**
 * OpenAlex 数据源适配器（优先源）
 * ------------------------------------------------------------
 * 真实接口事实（2026-10-31 实测，非文档推测）：
 *   - DOI 精确查询：GET https://api.openalex.org/works/doi:<DOI>
 *       → 200 返回完整 work 对象（约 20~50KB）
 *   - 检索分两段（顺序固定，见 searchLoose / searchPrecise）：
 *       ① 宽松：GET /works?search=<题名>&per-page=N&mailto=<邮箱>
 *              —— 只用 search= 入口，不加任何字段限定，等价在官网搜索框敲题名
 *       ② 精确：GET /works?filter=title.search:<题名>,raw_author_name.search:<作者>,
 *                        publication_year:<年份>&per-page=N&mailto=<邮箱>
 *              —— 仅在①没有合格候选时才补一次，用来消歧同名文献
 *
 * 精确检索的字段名是【云端实测】确认的，不是照抄文档（2026-10-31）：
 *   - author.search:xxx  → HTTP 400 "author.search is not a valid field"
 *   - 正确写法是 raw_author_name.search:xxx → HTTP 200
 *   - title.search / publication_year 组合有效：
 *     filter=title.search:Deep residual learning...,raw_author_name.search:Kaiming He,
 *            publication_year:2016  → 200，正好返回那 1 篇
 *   - 未收录：HTTP 404，但响应体是【HTML】不是 JSON（"<title>404 Not Found</title>"）
 *       → 因此必须先按状态码判 404，再尝试解析 JSON，否则会误判成「解析失败」
 *   - 限流/配额：实测检索接口返回 429 且 body 为 JSON：
 *       {"error":"Rate limit exceeded","message":"Insufficient budget...shared by
 *        everyone on your network's IP address...$0 remaining; resets at midnight UTC"}
 *       即：同一出口 IP 共享免费日配额，配额耗尽后检索接口整体不可用。
 *       这正是本程序必须做多源降级的原因——OpenAlex 检索挂掉时由 Crossref 接手。
 *   - 响应头不暴露剩余额度，客户端无法预知，只能靠状态码 + 退避。
 *
 * 字段说明：OpenAlex 只提供单一出版日期（publication_date / publication_year），
 * 没有 Crossref 那样的「在线发表 vs 印刷卷期」双日期，因此这里只产出一年份来源，
 * 不伪造第二个。
 */

var http = require('../lib/http.js');
var T = require('../lib/text.js');

var BASE = 'https://api.openalex.org';
var MAILTO = 'lfa-mini@example.com';
var UA = 'LFA-verify/2.0 (mailto:' + MAILTO + ')';

var PROVIDER = {
  id: 'openalex',
  name: 'OpenAlex',
  home: 'https://openalex.org',
  note: '公开学术元数据库，无需注册与密钥；覆盖以有 DOI 的期刊文献为主，中文刊、学位论文、图书覆盖不完整'
};

function headers() {
  return { 'User-Agent': UA, 'Accept': 'application/json' };
}

function stripDoiPrefix(s) {
  return String(s || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
}

/**
 * OpenAlex work → 本程序内部扁平记录
 * 只搬运真实存在的字段；缺失留空字符串，不补造。
 */
/**
 * 把 OpenAlex 的 abstract_inverted_index 还原成原文顺序的摘要。
 * 纯位置还原，不增删改任何一个词；来源没给就返回空字符串。
 */
function abstractFromInverted(idx) {
  if (!idx || typeof idx !== 'object') return '';
  var words = Object.keys(idx);
  if (!words.length) return '';
  var slots = [];
  var max = -1;
  for (var i = 0; i < words.length; i++) {
    var pos = idx[words[i]] || [];
    for (var j = 0; j < pos.length; j++) {
      var p = pos[j];
      if (typeof p !== 'number') continue;
      slots[p] = words[i];
      if (p > max) max = p;
    }
  }
  if (max < 0) return '';
  var out = [];
  for (var k = 0; k <= max; k++) out.push(slots[k] || '');
  var s = out.join(' ').replace(/\s+/g, ' ').trim();
  return s.length > 4000 ? s.slice(0, 4000) : s;
}

function toRecord(w) {
  var loc = w.primary_location || {};
  var src = loc.source || {};
  var host = w.host_venue || {};

  var title = T.trim(w.display_name || w.title);

  var auths = w.authorships || [];
  var authorItems = [];
  var authorNames = [];
  for (var i = 0; i < auths.length; i++) {
    var a = auths[i] || {};
    var nm = T.trim((a.author && a.author.display_name) || a.raw_author_name);
    if (!nm) continue;
    authorNames.push(nm);
    authorItems.push({ name: nm });
  }

  var py = w.publication_year ? String(w.publication_year) : '';
  var pd = T.trim(w.publication_date);
  var yearSources = [];
  if (py) {
    yearSources.push({
      kind: '出版年(publication_year)',
      year: py,
      full: pd || py
    });
  }
  if (pd && pd.slice(0, 4) && pd.slice(0, 4) !== py) {
    // 出版日期的年份与 publication_year 不一致时，额外列出供人工复核
    yearSources.push({ kind: '出版日期(publication_date)', year: pd.slice(0, 4), full: pd });
  }

  var biblio = w.biblio || {};
  var doi = stripDoiPrefix(w.doi);

  return {
    raw: w,
    doi: doi,
    title: title,
    /* OpenAlex 的摘要是倒排索引 {词: [位置…]}，按位置还原成原文即可。
     * 来源没有这个字段就是空字符串，不做任何补写。 */
    abstract: abstractFromInverted(w.abstract_inverted_index),
    container: T.trim(src.display_name || host.display_name),
    type: T.trim(w.type),
    publisher: T.trim(src.host_organization_name || host.publisher),
    authorItems: authorItems,
    authorText: authorNames.join('; '),
    yearSources: yearSources,
    yearIssued: py,
    yearPrint: '',
    yearOnline: '',
    volume: T.trim(biblio.volume),
    issue: T.trim(biblio.issue),
    page: T.trim(biblio.first_page) ? (T.trim(biblio.first_page) + (T.trim(biblio.last_page) ? '-' + T.trim(biblio.last_page) : '')) : '',
    url: T.trim(loc.landing_page_url) || (doi ? 'https://doi.org/' + doi : '') || T.trim(w.doi),
    landing: T.trim(loc.landing_page_url),
    flags: {
      isRetracted: !!w.is_retracted,
      citedByCount: (typeof w.cited_by_count === 'number') ? w.cited_by_count : null,
      openAlexId: T.trim(w.id)
    }
  };
}

/** 按 DOI 精确查询。返回 { provider, ok, record, apiUrl, ... } */
function byDoi(doi, opt) {
  opt = opt || {};
  var clean = T.normalizeDoi(doi);
  var url = BASE + '/works/doi:' + encodeURI(clean) + '?mailto=' + encodeURIComponent(MAILTO);
  return http.fetchJson(url, { timeout: opt.timeout, headers: headers() }).then(function (r) {
    var base = {
      provider: PROVIDER,
      apiUrl: url,
      requestedAt: r.requestedAtText,
      httpStatus: r.status,
      ms: r.ms
    };
    if (!r.ok) {
      base.ok = false;
      base.failureKind = r.failureKind;
      base.failureDetail = r.failureDetail;
      base.bodySnippet = shortBody(r.raw);
      return base;
    }
    if (!r.body || typeof r.body !== 'object') {
      base.ok = false;
      base.failureKind = 'parse';
      base.failureDetail = '返回 JSON 结构异常';
      base.bodySnippet = shortBody(r.raw);
      return base;
    }
    base.ok = true;
    base.raw = r.body;
    base.record = toRecord(r.body);
    return base;
  });
}

/* ==========================================================================
 *  两段式检索（顺序固定：① 宽松 → ② 精确字段）
 * ========================================================================== */

/**
 * 抽出「可作为检索词的题名文本」。
 * 只做标点清洗：OpenAlex 的 search= / title.search 本身就对停用词与词形有容错，
 * 保留原词序可以让短语search= 拿到更准的结果。
 */
function cleanTitleWords(title) {
  var s = T.trim(title);
  if (!s) return '';
  s = s.replace(/[\[\]\(\){}<>《》「」【】"'`]/g, ' ');
  s = s.replace(/[\/\\|,:：;；]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 250);
}

/** 取第一作者作为精确检索的辅助限定（塞全部作者会显著抬高漏召回风险） */
function firstAuthor(ref) {
  var s = T.trim(ref && ref.authors);
  if (!s) return '';
  var parts = s.split(/[;；,，]/).map(function (x) { return T.trim(x); }).filter(Boolean);
  return (parts[0] || '').slice(0, 80);
}

/** 取四位年份 */
function year4(ref) {
  var m = String(T.trim(ref && ref.year) || '').match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}

/** 统一的检索结果处理（宽松 / 精确共用） */
function finishSearch(url, q, r) {
  var base = {
    provider: PROVIDER,
    apiUrl: url,
    requestedAt: r.requestedAtText,
    httpStatus: r.status,
    ms: r.ms,
    query: q
  };
  if (!r.ok) {
    base.ok = false;
    base.failureKind = r.failureKind;
    base.failureDetail = r.failureDetail;
    base.bodySnippet = shortBody(r.raw);
    base.returned = 0;
    return base;
  }
  var items = (r.body && r.body.results) || [];
  base.ok = true;
  base.raw = r.body;
  base.items = items;
  base.records = items.map(toRecord);
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
 * ① 宽松检索：只用 search= 入口，传题名文本，【不加任何字段限定】，
 *    等价于在 openalex.org 首页搜索框里敲下这条题名。
 *    这一阶段【召回优先】——宁可多带回几条，交由上层的「信息校验匹配」筛。
 */
function searchLoose(ref, opt) {
  opt = opt || {};
  ref = ref || {};
  var q = cleanTitleWords(ref.title);
  if (!q) return Promise.resolve(emptyResult('没有可用于宽松检索的题名'));

  var url = BASE + '/works?search=' + encodeURIComponent(q) +
    '&per-page=' + (opt.limit || 5) + '&mailto=' + encodeURIComponent(MAILTO);

  return http.fetchJson(url, { timeout: opt.timeout, headers: headers() }).then(function (r) {
    return finishSearch(url, q, r);
  });
}

/**
 * ② 精确字段检索（宽松没有合格候选时才补充一次）
 *    title.search（标题字段限定）+ author.search（作者）+ publication_year（年份）
 *    三者组合缩小候选范围、降低同名/近似题名造成的混淆。
 *    缺失的限定项会跳过，但题名是必须的。
 */
function searchPrecise(ref, opt) {
  opt = opt || {};
  ref = ref || {};
  var t = cleanTitleWords(ref.title);
  if (!t) return Promise.resolve(emptyResult('没有可用于精确检索的题名'));

  var au = firstAuthor(ref);
  var yr = year4(ref);

  var filters = ['title.search:' + t];
  /* 【实测确认】作者字段只能写 raw_author_name.search：
   * 写 author.search 会被 OpenAlex 直接拒（HTTP 400 "author.search is not a valid field"）。 */
  if (au) filters.push('raw_author_name.search:' + au);
  if (yr) filters.push('publication_year:' + yr);

  /* query 给人看（日志记录），filter 才是真正发出去的值 */
  var parts = ['title=' + t];
  if (au) parts.push('author=' + au);
  if (yr) parts.push('year=' + yr);

  var url = BASE + '/works?filter=' + encodeURIComponent(filters.join(',')) +
    '&per-page=' + (opt.limit || 5) + '&mailto=' + encodeURIComponent(MAILTO);

  return http.fetchJson(url, { timeout: opt.timeout, headers: headers() }).then(function (r) {
    return finishSearch(url, parts.join(' + '), r);
  });
}

/**
 * 主题检索（「帮我找文献」用）。
 * 与核验用的两段式检索【分开】：这里传的是模型生成 / 用户填写的检索式，
 * 不是某条具体文献的题名，因此只用 search= 入口，不做「与输入题名比对」那一套。
 *
 * @param {string} q 检索式文本
 * @param {object} opt {limit, yearFrom, yearTo, timeout}
 */
function searchTopic(q, opt) {
  opt = opt || {};
  var text = T.trim(q);
  if (!text) return Promise.resolve(emptyResult('检索式为空'));

  var url = BASE + '/works?search=' + encodeURIComponent(text) +
    '&per-page=' + (opt.limit || 8) + '&mailto=' + encodeURIComponent(MAILTO);

  /* 年份区间：OpenAlex 的 filter 支持 from_publication_date / to_publication_date，
   * 与 search= 同时使用是允许的（实测 200）。只有用户设了年份才加，避免多余参数。 */
  var f = [];
  if (opt.yearFrom) f.push('from_publication_date:' + opt.yearFrom + '-01-01');
  if (opt.yearTo) f.push('to_publication_date:' + opt.yearTo + '-12-31');
  if (f.length) url += '&filter=' + encodeURIComponent(f.join(','));

  return http.fetchJson(url, { timeout: opt.timeout, headers: headers() }).then(function (r) {
    return finishSearch(url, text, r);
  });
}

function shortBody(b) {
  return String(b || '').replace(/\s+/g, ' ').slice(0, 160);
}

module.exports = {
  PROVIDER: PROVIDER,
  byDoi: byDoi,
  searchLoose: searchLoose,
  searchPrecise: searchPrecise,
  searchTopic: searchTopic,
  cleanTitleWords: cleanTitleWords,
  firstAuthor: firstAuthor,
  year4: year4,
  toRecord: toRecord
};
