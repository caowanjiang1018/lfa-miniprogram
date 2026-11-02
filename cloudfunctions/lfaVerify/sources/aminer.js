'use strict';
/**
 * AMiner 开放平台数据源适配器
 * ============================================================================
 * 只使用需求指定的两个接口，不碰任何其它端点：
 *   ① 论文搜索  GET  https://datacenter.aminer.cn/gateway/open_platform/api/paper/search
 *   ② 论文信息  POST https://datacenter.aminer.cn/gateway/open_platform/api/paper/info
 *
 * 鉴权：HTTP Header  Authorization: <Token>
 *      Token 只从云函数环境变量 AMINER_TOKEN 读取（值取自 AMiner 开放平台控制台），
 *      不写入代码、不下发前端。
 *
 * 真实接口事实（2026-11-01 实测 + 官方文档核对，不是照抄文档猜测）：
 *   - 搜索接口参数：title（题名，必填）、page（页序号）、size（条数，上限 20）。
 *     免费版【没有】author / year / keyword 参数，传了会被忽略——
 *     所以「按作者 + 年份精确检索」在这里只能【本地收敛】，见 searchPrecise 的注释。
 *   - 论文信息接口：body 固定为 {"ids": ["<AMiner 论文 id>", ...]}（批量）。
 *     它【不支持】按 DOI 查询，这一点在 byDoi() 处如实交代，不伪造支持。
 *   - 返回外壳：{"code":200,"success":true,"msg":"","data":[...],"log_id":"..."}
 *   - 鉴权失败的真实形态（重要，与直觉相反，2026-11-01 实测）：
 *       不带 Token / Token 错误 / Token 过期 → HTTP 【500】而不是 401/403，
 *       响应体：{"code":40308,"success":false,"msg":"Get Authorization Error","data":null}
 *     因此本模块【不能只按 HTTP 状态码判断失败】，必须解析响应体的 code / msg：
 *     命中鉴权类错误时统一判 failureKind='auth_failed'，给出「Token 无效或已过期，
 *     请到 AMiner 控制台重新生成并更新环境变量 AMINER_TOKEN」的明确指引。
 *
 * 链接红线（与全项目一致）：【不拼接任何详情页 URL】。
 *   搜索接口只返回 doi / id / 题名等字段，没有落地页地址时，
 *   链接只用来源返回的 url / pdf 字段或 DOI；来源没给就是空字符串，
 *   绝不用论文 id 去拼一个看着像详情页的网址。
 */

var http = require('../lib/http.js');
var T = require('../lib/text.js');

var BASE = 'https://datacenter.aminer.cn/gateway/open_platform';
var URL_SEARCH = BASE + '/api/paper/search';   // GET
var URL_INFO = BASE + '/api/paper/info';       // POST

var PROVIDER = {
  id: 'aminer',
  name: 'AMiner',
  home: 'https://www.aminer.cn',
  note: 'AMiner 开放平台（datacenter.aminer.cn），需在 AMiner 控制台申请 Key 并生成 Token；' +
    '中文期刊、会议论文的覆盖优于两个境外源，但仍【不等于】知网 / 万方全库，' +
    '学位论文与图书同样可能检索不到'
};

var MAX_SIZE = 20;   // 搜索接口 size 上限（官方文档：20）

/* ==========================================================================
 *  配置与鉴权
 * ========================================================================== */

function env(name, dflt) {
  var v;
  try { v = process.env[name]; } catch (e) { v = null; }
  if (v === undefined || v === null || String(v).trim() === '') return dflt || '';
  return String(v).trim();
}

function config() {
  var token = env('AMINER_TOKEN');
  return {
    token: token,
    configured: !!token,
    /* 只留末 4 位用于日志核对「到底读到了哪个 Token」，绝不记录完整密钥 */
    tokenTail: token ? token.slice(-4) : ''
  };
}

function available() { return !!config().token; }

function headers(extra) {
  var h = {
    'Accept': 'application/json',
    'User-Agent': 'LFA-verify/4.0 (miniprogram)'
  };
  var t = config().token;
  /* 控制台生成的 Token 直接放进 Authorization；
   * 若用户填进来的是 "Bearer xxx" 形式，原样使用，不再重复加前缀。 */
  if (t) h['Authorization'] = t;
  if (extra) {
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i++) h[keys[i]] = extra[keys[i]];
  }
  return h;
}

/* ==========================================================================
 *  时间预算收敛
 *  ------------------------------------------------------------------
 *  AMiner 一次「检索」内部最多会串行发出三次请求：
 *      ① 论文搜索（必做）
 *      ② 题名前段降级重试（可选：①返回 0 条时才发）
 *      ③ 论文信息接口补详情（可选：①有结果时才发）
 *  若三次都按同一个固定超时去等（实测云端每请求可达 6~7s），叠加就是 20s+，
 *  再叠上 OpenAlex / Crossref，整条链路会被云函数平台硬超时杀掉
 *  （errCode -504003，前端什么都拿不到）。
 *  因此这里统一按【绝对截止时间 deadline】收敛每一个子请求：
 *    - 必做请求：超时 = min(调用方给的 timeout, 距 deadline 的剩余时间)
 *    - 可选请求：剩余时间不够就【不发】，并在留痕里写明「未发起，不是检索不到」
 * ========================================================================== */
var NEED_MS_RETRY = 1200;    // 发起「题名前段降级重试」至少要留这么多
var NEED_MS_ENRICH = 1200;   // 发起「补详情」至少要留这么多

function budgetTimeout(opt, dflt) {
  var t = (opt && opt.timeout) || dflt || 8000;
  if (opt && opt.deadline) t = Math.min(t, opt.deadline - Date.now() - 150);
  return t >= 700 ? t : 700;
}

function hasBudget(opt, min) {
  if (!opt || !opt.deadline) return true;   // 没给 deadline（单元测试）→ 不限制
  return (opt.deadline - Date.now()) >= (min || 1000);
}

/* ---- 鉴权失败判定：必须看响应体，不能只看状态码 ---- */

/* 40308 是实测到的「Get Authorization Error」；其余 403xx 一并按鉴权/配额问题处理，
 * 文案里会如实带上接口返回的 code 与 msg，不做无根据的猜测。 */
var AUTH_CODES = { '40308': 1, '40301': 1, '40302': 1, '40305': 1 };
var AUTH_RE = /auth|token|authorization|unauthor|凭证|鉴权|过期|expire/i;

function parseBody(r) {
  if (r && r.body && typeof r.body === 'object') return r.body;
  if (r && r.raw) {
    try { return JSON.parse(r.raw); } catch (e) { return null; }
  }
  return null;
}

/**
 * 判定一次请求的实际结果。
 * @returns {{kind:'ok'|'auth_failed'|'api_error'|'http_error'|'parse', code:string, msg:string}}
 */
function verdictOf(r) {
  var b = parseBody(r);
  var code = (b && b.code != null) ? String(b.code) : '';
  var msg = T.trim((b && b.msg) || '');

  if (b && b.success === false) {
    if (AUTH_CODES[code] || AUTH_RE.test(msg)) {
      return { kind: 'auth_failed', code: code, msg: msg || 'Get Authorization Error' };
    }
    return { kind: 'api_error', code: code, msg: msg || ('接口返回 code=' + code) };
  }
  if (!r.ok) {
    return { kind: 'http_error', code: code, msg: msg || (r.failureDetail || ('HTTP ' + r.status)) };
  }
  if (!b) return { kind: 'parse', code: '', msg: '返回体不是合法 JSON' };
  return { kind: 'ok', code: code, msg: msg };
}

function authDetail(v) {
  return 'AMiner Token 鉴权失败' + (v.code ? '（接口 code=' + v.code + '）' : '') +
    (v.msg ? '：' + v.msg : '') + '。' +
    '这通常意味着 Token 无效或已过期。请到 AMiner 开放平台控制台重新生成 Token，' +
    '再到「云开发控制台 → 云函数 lfaVerify → 配置 → 环境变量」更新 AMINER_TOKEN。' +
    'Token 修好之前，这条文献改由其它数据源 / 通义千问联网检索兜底，不会假装已核验。';
}

/* ==========================================================================
 *  结果外壳（与 openalex.js / crossref.js 保持同构，上层无需区分来源）
 * ========================================================================== */

function baseResult(url, q) {
  return {
    provider: PROVIDER,
    apiUrl: url || '',
    requestedAt: http.fmtTime(new Date()),
    httpStatus: 0,
    ms: 0,
    query: q || '',
    ok: false,
    records: [],
    returned: 0,
    failureKind: null,
    failureDetail: ''
  };
}

function notConfigured(url, q) {
  var r = baseResult(url, q);
  r.failureKind = 'config';
  r.failureDetail = '环境变量 AMINER_TOKEN 未配置，本次【没有】请求 AMiner。' +
    '请到 AMiner 开放平台控制台生成 Token，再到「云开发控制台 → 云函数 lfaVerify →' +
    ' 配置 → 环境变量」添加 AMINER_TOKEN 后自动生效。';
  return r;
}

function emptyResult(why, q) {
  var r = baseResult('', q);
  r.failureKind = 'parse';
  r.failureDetail = why;
  return r;
}

/* ==========================================================================
 *  ① 论文搜索（GET）
 * ========================================================================== */

/** 年份字段可能是 float（文档标注 year: float），统一收敛成四位字符串 */
function yearVal(v) {
  if (v == null || v === '') return '';
  var n = Number(v);
  if (!isFinite(n)) return '';
  var y = String(Math.round(n));
  return /^(19|20)\d{2}$/.test(y) ? y : '';
}

/** 搜索接口只回「被引档位」字符串（如 "11-50"），不是精确被引数，如实保留档位 */
function bucketText(v) { return T.trim(v); }

function toRecord(item) {
  item = item || {};
  var id = T.trim(item.id);
  var title = T.trim(item.title || item.title_zh);
  var year = yearVal(item.year);
  var firstAuthor = T.trim(item.first_author);
  var authorItems = [];
  if (firstAuthor) authorItems.push({ name: firstAuthor });

  return {
    raw: item,
    rawSearch: item,
    aminerId: id,
    doi: T.normalizeDoi(item.doi),
    title: title,
    titleZh: T.trim(item.title_zh),
    abstract: '',
    abstractZh: '',
    container: T.trim(item.venue_name),
    type: '',
    publisher: '',
    authorItems: authorItems,
    authorText: firstAuthor,
    yearSources: year ? [{ kind: '出版年', year: year, full: year }] : [],
    yearIssued: year,
    yearPrint: '',
    yearOnline: '',
    volume: '',
    issue: '',
    page: '',
    /* 链接红线：来源没给落地页就是空，只用 doi 兜一个 doi.org 解析地址，
     * 绝不用论文 id 拼接 https://www.aminer.cn/pub/<id> 这类「看着像」的地址。 */
    url: T.normalizeDoi(item.doi) ? ('https://doi.org/' + T.normalizeDoi(item.doi)) : '',
    landing: '',
    flags: {
      isRetracted: false,
      citedByCount: null,
      aminerId: id,
      citationBucket: bucketText(item.n_citation_bucket)
    }
  };
}

/**
 * 把「论文信息」接口返回的详情合并进搜索得到的记录。
 * 只搬运接口真的给了的字段；没给的保持原样，不推测、不补造。
 */
function mergeDetail(rec, d) {
  if (!rec || !d || typeof d !== 'object') return rec;

  var names = [];
  var arr = d.authors || d.author || d.authors_info || [];
  if (Object.prototype.toString.call(arr) === '[object Array]') {
    for (var i = 0; i < arr.length; i++) {
      var a = arr[i];
      var nm = (typeof a === 'string')
        ? T.trim(a)
        : T.trim((a && (a.name || a.name_zh || a.display_name)) || '');
      if (nm && names.indexOf(nm) < 0) names.push(nm);
    }
  }
  if (names.length) {
    rec.authorText = names.join('; ');
    rec.authorItems = names.map(function (n) { return { name: n }; });
  }

  var abs = T.trim(d.abstract);
  var absZh = T.trim(d.abstract_zh);
  if (abs) rec.abstract = abs;
  if (absZh) rec.abstractZh = absZh;
  /* 只有中文摘要时：课题适配需要材料，中文摘要同样是【来源返回的真实摘要】，
   * 但要在 abstractFrom 里标明它来自 AMiner，不许被当成"读过全文"。 */
  if (!rec.abstract && absZh) rec.abstract = absZh;

  var v = d.venue;
  var venue = '';
  if (typeof v === 'string') venue = T.trim(v);
  else if (v && typeof v === 'object') venue = T.trim(v.name || v.raw || v.display_name);
  if (venue) rec.container = venue;

  var y = yearVal(d.year || d.publication_year);
  if (y) {
    rec.yearIssued = y;
    rec.yearSources = [{ kind: '出版年', year: y, full: y }];
  }

  if (T.trim(d.volume)) rec.volume = T.trim(d.volume);
  if (T.trim(d.issue)) rec.issue = T.trim(d.issue);
  var ps = T.trim(d.page_start || d.first_page);
  var pe = T.trim(d.page_end || d.last_page);
  var pg = ps ? (ps + (pe ? '-' + pe : '')) : T.trim(d.pages || d.page);
  if (pg) rec.page = pg;

  if (T.trim(d.type)) rec.type = T.trim(d.type);
  else if (T.trim(d.doc_type)) rec.type = T.trim(d.doc_type);
  if (T.trim(d.publisher)) rec.publisher = T.trim(d.publisher);

  /* 链接：只用接口返回的字段，或 DOI；来源没给就留空 */
  var link = '';
  var urls = d.url || d.pdf || d.urls || d.link;
  if (typeof urls === 'string') link = T.trim(urls);
  else if (Object.prototype.toString.call(urls) === '[object Array]' && urls.length) {
    link = T.trim(typeof urls[0] === 'string' ? urls[0] : (urls[0] && urls[0].url));
  }
  if (link && /^https?:\/\//i.test(link)) {
    rec.url = link;
    rec.landing = link;
  } else if (rec.doi && !rec.url) {
    rec.url = 'https://doi.org/' + rec.doi;
  }

  if (typeof d.n_citation === 'number') rec.flags.citedByCount = d.n_citation;
  if (d.is_retracted === true) rec.flags.isRetracted = true;
  if (T.trim(d.lang)) rec.lang = T.trim(d.lang);

  /* raw 保留完整详情，供「原始返回留存」与前端溯源 */
  rec.raw = d;
  return rec;
}

/** 把一次 HTTP 结果翻译成对外统一的结果对象 */
function respondSearch(url, q, r) {
  var out = baseResult(url, q);
  out.apiUrl = url;
  out.requestedAt = r.requestedAtText || out.requestedAt;
  out.httpStatus = r.status;

  var v = verdictOf(r);
  if (v.kind === 'ok') {
    var data = (r.body && r.body.data) || [];
    if (Object.prototype.toString.call(data) !== '[object Array]') data = [];
    out.ok = true;
    out.raw = r.body;
    out.records = data.map(toRecord);
    out.returned = out.records.length;
    out.total = null;
    return out;
  }
  if (v.kind === 'auth_failed') {
    out.failureKind = 'auth_failed';
    out.failureDetail = authDetail(v);
  } else if (v.kind === 'api_error') {
    out.failureKind = 'http_error';
    out.failureDetail = 'AMiner 接口返回错误' + (v.code ? '（code=' + v.code + '）' : '') +
      '：' + (v.msg || '');
  } else if (v.kind === 'parse') {
    out.failureKind = 'parse';
    out.failureDetail = 'AMiner 返回体不是合法 JSON（HTTP ' + r.status + '）';
  } else {
    out.failureKind = r.failureKind || 'http_error';
    out.failureDetail = r.failureDetail || v.msg || ('HTTP ' + r.status);
    if (r.failureKind === 'not_found') {
      out.failureKind = 'not_found';
      out.failureDetail = 'AMiner 未收录该题名';
    }
  }
  out.bodySnippet = String(r.raw || '').replace(/\s+/g, ' ').slice(0, 160);
  out.returned = 0;
  return out;
}

/**
 * 单次搜索请求（含【黑洞快速重试】）。
 * 实测（2026-11-01 云端）：同一批题名里，既有 0.35s 就返回的，也有卡满 22s 最后
 * 连接黑洞彻底无响应的——慢是连接侧偶发，不是「题名搜不到」。
 * 所以与其把超时从 8s 拉到 22s 干等，不如：第一次给足但不过分（8s 内），
 * 判定为连接挂死后立刻用更短的超时重发一次；重发多数秒回。
 * 两次都黑洞才算真的失败，并且会把「连续两次超时」如实写进留痕。
 */
var FIRST_TRY_MS = 8000;      // 首次等待上限：挂死就立刻重发，别干等
var RETRY_TIMEOUT_MS = 12000; // 重试时的等待上限：这次愿意多等一会儿
var RETRY_NEED_MS = 12500;    // 剩余预算不足以跑完重试时，干脆不重试

function paperSearchOnce(q, opt) {
  opt = opt || {};
  var size = Math.max(1, Math.min(MAX_SIZE, opt.limit || 8));
  var url = URL_SEARCH + '?title=' + encodeURIComponent(q) +
    '&page=0&size=' + size;
  /* 第一次不要用满调用方给的大超时：AMiner 一旦连接挂死，等 22s 也是白等，
   * 不如早放弃、立刻重发。真慢但能返回的情况由重试那一次兜住。 */
  var t1 = budgetTimeout({ timeout: Math.min(FIRST_TRY_MS, opt.timeout || FIRST_TRY_MS), deadline: opt.deadline }, FIRST_TRY_MS);

  return http.fetchJson(url, { timeout: t1, headers: headers() }).then(function (r) {
    var hung = (r.failureKind === 'timeout' || r.failureKind === 'network');
    if (!hung || !hasBudget(opt, RETRY_NEED_MS)) return respondSearch(url, q, r);

    var left = (opt.deadline ? (opt.deadline - Date.now() - 300) : RETRY_TIMEOUT_MS);
    var t2 = Math.max(1500, Math.min(RETRY_TIMEOUT_MS, left));
    return http.fetchJson(url, { timeout: t2, headers: headers() }).then(function (r2) {
      var out = respondSearch(url, q, r2);
      if (out.ok) {
        out.retried = 1;
        out.retryNote = '首次请求在 ' + t1 + 'ms 内未得到响应（AMiner 偶发连接挂死），' +
          '立即重发一次后拿到结果（这次 ' + t2 + 'ms 超时上限内）';
        return out;
      }
      if (r2.failureKind === 'timeout' || r2.failureKind === 'network') {
        out.failureDetail = 'AMiner 连续两次请求都没有响应（第一次等 ' + t1 + 'ms、重试等 ' + t2 +
          'ms）。这是 AMiner 服务侧的连接问题，与该文献是否存在无关，请稍后重试。';
      }
      out.retried = 1;
      return out;
    });
  });
}

/**
 * 题名检索。
 * 长题名一条都搜不到时，用「题名前段」降级再试一次（最多一次）：
 * 实测中文长题名（含副标题、破折号）整体匹配命中率偏低。
 * 降级后的检索词会如实写进 query，不做隐瞒。
 */
function paperSearch(title, opt) {
  opt = opt || {};
  var cfg = config();
  if (!cfg.token) return Promise.resolve(notConfigured(URL_SEARCH, title));

  var q = T.trim(title);
  if (!q) return Promise.resolve(emptyResult('没有可用于检索的题名', ''));

  return paperSearchOnce(q, opt).then(function (first) {
    if (!first.ok) return first;
    if (first.returned) return first;
    if (opt.noShortRetry) return first;

    var shorter = shortenQuery(q);
    if (!shorter || shorter === q) return first;
    /* 降级重试是【可选】的：预算不够就不发。
     * 这里必须如实标注「未发起」，不能让上层把它当成「检索不到」。 */
    if (!hasBudget(opt, NEED_MS_RETRY)) {
      first.shortRetry = {
        query: shorter, skipped: 'budget_exhausted',
        note: '剩余时间预算不足，未发起题名前段降级检索（不是检索不到）'
      };
      return first;
    }
    return paperSearchOnce(shorter, {
      timeout: opt.timeout, deadline: opt.deadline, limit: opt.limit, noShortRetry: true
    }).then(function (second) {
        if (!second.ok) {
          /* 第二次失败不影响第一次「确实没搜到」的结论，只把降级尝试记进日志字段 */
          first.shortRetry = { query: shorter, ok: false, detail: second.failureDetail };
          return first;
        }
        if (!second.returned) {
          first.shortRetry = { query: shorter, ok: true, returned: 0 };
          return first;
        }
        second.shortRetry = { query: q, ok: true, returned: 0, note: '完整题名无结果，改用题名前段' };
        second.query = shorter + '（题名前段；完整题名「' + q + '」无结果）';
        return second;
      });
  });
}

/** 题名前段：按标点切第一段，再兜底硬截 40 字 */
function shortenQuery(q) {
  var s = String(q || '').trim();
  if (s.length <= 40) return '';
  var seg = s.split(/[：:。；;，,！!？?—－\-–—、\/]/)[0].trim();
  if (seg.length >= 8 && seg.length < s.length) return seg;
  return s.slice(0, 40).trim();
}

/* ==========================================================================
 *  ② 论文信息（POST）—— 按论文 id 批量补详情
 * ========================================================================== */

/**
 * @param {Array<string>} ids AMiner 论文 id
 * @returns {Promise<{ok, items, failureKind, failureDetail, ...}>}
 */
function paperInfo(ids, opt) {
  opt = opt || {};
  var url = URL_INFO;
  var cfg = config();
  if (!cfg.token) {
    var nc = baseResult(url, '');
    nc.failureKind = 'config';
    nc.failureDetail = notConfigured(url, '').failureDetail;
    nc.items = [];
    return Promise.resolve(nc);
  }
  var list = (ids || []).map(function (x) { return T.trim(x); }).filter(Boolean).slice(0, MAX_SIZE);
  if (!list.length) {
    var empty = baseResult(url, '');
    empty.ok = true;
    empty.items = [];
    return Promise.resolve(empty);
  }

  return http.postJson(url, { ids: list }, {
    timeout: budgetTimeout(opt, 8000),
    headers: headers({ 'Content-Type': 'application/json;charset=utf-8' })
  }).then(function (r) {
    var out = baseResult(url, list.join(','));
    out.apiUrl = url;
    out.requestedAt = r.requestedAtText || out.requestedAt;
    out.httpStatus = r.status;

    var v = verdictOf(r);
    if (v.kind === 'ok') {
      var data = (r.body && r.body.data) || [];
      if (Object.prototype.toString.call(data) !== '[object Array]') data = [];
      out.ok = true;
      out.raw = r.body;
      out.items = data;
      out.returned = data.length;
      return out;
    }
    if (v.kind === 'auth_failed') {
      out.failureKind = 'auth_failed';
      out.failureDetail = authDetail(v);
    } else if (v.kind === 'api_error') {
      out.failureKind = 'http_error';
      out.failureDetail = 'AMiner 论文信息接口返回错误' + (v.code ? '（code=' + v.code + '）' : '') +
        '：' + (v.msg || '');
    } else if (v.kind === 'parse') {
      out.failureKind = 'parse';
      out.failureDetail = 'AMiner 论文信息接口返回体不是合法 JSON（HTTP ' + r.status + '）';
    } else {
      out.failureKind = r.failureKind || 'http_error';
      out.failureDetail = r.failureDetail || v.msg || ('HTTP ' + r.status);
    }
    out.items = [];
    out.returned = 0;
    out.bodySnippet = String(r.raw || '').replace(/\s+/g, ' ').slice(0, 160);
    return out;
  });
}

/**
 * 给一批搜索结果补详情（摘要 / 完整作者 / 出处 / 卷期页）。
 * 补详情【失败不影响检索结果本身】：记录会原样返回，只是少了摘要，
 * 上层会如实显示「来源未提供摘要」，不会假装读过全文。
 */
function enrich(records, opt) {
  opt = opt || {};
  if (!records || !records.length) return Promise.resolve({ ok: true, filled: 0, note: '' });
  var cfg = config();
  if (!cfg.token) {
    return Promise.resolve({ ok: false, filled: 0, note: 'AMINER_TOKEN 未配置，未补详情' });
  }
  /* 补详情是【可选】步骤：预算不够就跳过。
   * 题录本身来自搜索接口，照样有效，只是没有摘要——页面会如实显示「来源未提供摘要」。 */
  if (!hasBudget(opt, NEED_MS_ENRICH)) {
    return Promise.resolve({
      ok: false, filled: 0,
      note: '剩余时间预算不足，未调用论文信息接口补详情；题录本身来自搜索接口，仍然有效'
    });
  }
  var ids = [];
  for (var i = 0; i < records.length; i++) {
    var id = records[i] && records[i].aminerId;
    if (id && ids.indexOf(id) < 0) ids.push(id);
  }
  if (!ids.length) return Promise.resolve({ ok: true, filled: 0, note: '没有可用于补详情的论文 id' });

  return paperInfo(ids, { timeout: opt.timeout }).then(function (r) {
    if (!r.ok || !r.items.length) {
      return { ok: !!r.ok, filled: 0, note: r.failureDetail || '论文信息接口无返回' };
    }
    var map = {};
    for (var k = 0; k < r.items.length; k++) {
      var d = r.items[k];
      var key = T.trim(d && (d.id || d._id));
      if (key) map[key] = d;
    }
    var filled = 0;
    for (var j = 0; j < records.length; j++) {
      var rec = records[j];
      var det = map[rec.aminerId];
      if (!det) continue;
      mergeDetail(rec, det);
      /* 摘要的真实出处：课题适配会因它标注「基于 AMiner 返回的摘要」 */
      if (T.trim(rec.abstract)) rec.abstractFrom = PROVIDER.name;
      filled++;
    }
    return { ok: true, filled: filled, note: '' };
  });
}

/* ==========================================================================
 *  对外接口（与 openalex.js / crossref.js 同签名，便于上层统一编排）
 * ========================================================================== */

/** 题名清洗：AMiner 直接按题名匹配，只去掉明显干扰的括号与多余空白 */
function cleanTitleWords(title) {
  var s = T.trim(title);
  if (!s) return '';
  s = s.replace(/[\[\]（）(){}<>《》「」【】"'`]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 200);
}

function firstAuthor(ref) {
  var s = T.trim(ref && ref.authors);
  if (!s) return '';
  var parts = s.split(/[;；,，]/).map(function (x) { return T.trim(x); }).filter(Boolean);
  return (parts[0] || '').slice(0, 80);
}

function surnameOf(s) {
  var t = T.trim(s);
  if (!t) return '';
  /* 中文姓名取前 2 字（复姓也够用），西文取最后一个 token 的姓氏 */
  if (/[\u4e00-\u9fa5]/.test(t)) return t.slice(0, 2);
  var parts = t.split(/\s+/);
  return T.trim(parts[parts.length - 1]).toLowerCase();
}

function year4(ref) {
  var m = String(T.trim(ref && ref.year) || '').match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}

/**
 * 本地收敛：作者 / 年份命中加分，命中过的排在前面。
 * 【如实说明】AMiner 搜索接口没有 author / year 参数，无法下推到服务端；
 * 这里的"精确"只是本地筛选。为避免误杀，若没有任何一条命中就【原样返回】，
 * 绝不把「筛完为空」当成「该库未收录」。
 */
function narrow(records, ref) {
  var yr = year4(ref);
  var au = surnameOf(firstAuthor(ref));
  if (!yr && !au) return { list: records, narrowed: false };
  var kept = [];
  var loose = [];
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var hit = 0;
    if (yr && r.yearIssued === yr) hit++;
    if (au) {
      var hay = String(r.authorText || '').toLowerCase();
      var hitAu = hay.indexOf(au) >= 0;
      if (!hitAu) {
        for (var k = 0; k < (r.authorItems || []).length; k++) {
          if (String(r.authorItems[k].name || '').toLowerCase().indexOf(au) >= 0) { hitAu = true; break; }
        }
      }
      if (hitAu) hit++;
    }
    if (hit) kept.push(r); else loose.push(r);
  }
  if (!kept.length) return { list: records, narrowed: false };
  return { list: kept.concat(loose), narrowed: true };
}

/** ① 宽松检索：只用题名 */
function searchLoose(ref, opt) {
  opt = opt || {};
  ref = ref || {};
  var q = cleanTitleWords(ref.title);
  if (!q) return Promise.resolve(emptyResult('没有可用于检索的题名', ''));
  return paperSearch(q, opt).then(function (r) {
    if (!r.ok || !r.records.length) return r;
    return enrich(r.records, { timeout: opt.timeout, deadline: opt.deadline }).then(function (e) {
      r.enrichNote = e.note || '';
      r.enriched = e.filled || 0;
      return r;
    });
  });
}

/**
 * ② 精确检索：题名检索 + 本地按作者 / 年份收敛（接口不支持下推，见 narrow 注释）
 */
function searchPrecise(ref, opt) {
  opt = opt || {};
  ref = ref || {};
  var q = cleanTitleWords(ref.title);
  if (!q) return Promise.resolve(emptyResult('没有可用于检索的题名', ''));

  var au = firstAuthor(ref);
  var yr = year4(ref);
  var want = { limit: Math.max(10, Math.min(MAX_SIZE, (opt.limit || 5) * 2)) };

  return paperSearch(q, { timeout: opt.timeout, deadline: opt.deadline, limit: want.limit }).then(function (r) {
    if (!r.ok || !r.records.length) return r;
    var n = narrow(r.records, ref);
    r.records = n.list;
    r.narrowed = n.narrowed;
    /* query 供日志与页面留痕：写清楚筛选是在本地做的 */
    var parts = ['title=' + q];
    if (au) parts.push('author=' + au + '（本地筛选）');
    if (yr) parts.push('year=' + yr + '（本地筛选）');
    r.query = parts.join(' + ');
    return enrich(r.records, { timeout: opt.timeout, deadline: opt.deadline }).then(function (e) {
      r.enrichNote = e.note || '';
      r.enriched = e.filled || 0;
      return r;
    });
  });
}

/**
 * 主题检索（「帮我找文献」用）。
 * 传进来的是检索式 / 关键词，不一定是完整题名；AMiner 的搜索接口只有 title 参数，
 * 因此这里把检索式当作题名关键词传给它——这是接口能力的真实边界，不做夸大。
 */
function searchTopic(q, opt) {
  opt = opt || {};
  var text = T.trim(q);
  if (!text) return Promise.resolve(emptyResult('检索式为空', ''));
  return paperSearch(text, opt).then(function (r) {
    if (!r.ok || !r.records.length) return r;
    return enrich(r.records, { timeout: opt.timeout, deadline: opt.deadline }).then(function (e) {
      r.enrichNote = e.note || '';
      r.enriched = e.filled || 0;
      return r;
    });
  });
}

/**
 * 按 AMiner 论文 id 取详情，组装成「精确记录」供逐字段比对使用。
 * 这是 AMiner 唯一真正的精确查询入口（论文信息接口只接受 id）：
 * 用户在候选列表里选定一条 AMiner 记录后，走这里才能拿到完整题录与摘要，
 * 进而支撑「核验成功后补全题录与材料」。
 */
function byId(id, opt) {
  opt = opt || {};
  var clean = T.trim(id);
  if (!clean) return Promise.resolve(emptyResult('没有 AMiner 论文 id', ''));

  return paperInfo([clean], opt).then(function (r) {
    if (!r.ok) {
      return {
        provider: PROVIDER, ok: false, apiUrl: r.apiUrl, requestedAt: r.requestedAt,
        httpStatus: r.httpStatus, ms: r.ms, query: clean,
        failureKind: r.failureKind, failureDetail: r.failureDetail,
        bodySnippet: r.bodySnippet || '', returned: 0, records: []
      };
    }
    var d = (r.items && r.items[0]) || null;
    if (!d) {
      return {
        provider: PROVIDER, ok: false, apiUrl: r.apiUrl, requestedAt: r.requestedAt,
        httpStatus: r.httpStatus, ms: r.ms, query: clean,
        failureKind: 'not_found',
        failureDetail: 'AMiner 论文信息接口没有返回该 id 的记录',
        returned: 0, records: []
      };
    }
    var rec = toRecord({ id: clean, title: T.trim(d.title || d.title_zh), doi: T.trim(d.doi) });
    mergeDetail(rec, d);
    if (T.trim(rec.abstract)) rec.abstractFrom = PROVIDER.name;
    return {
      provider: PROVIDER, ok: true, record: rec, raw: d,
      apiUrl: r.apiUrl, requestedAt: r.requestedAt,
      httpStatus: r.httpStatus, ms: r.ms,
      query: clean, returned: 1, records: [rec]
    };
  });
}

/**
 * 按 DOI 查询 —— AMiner 的两个接口【都不支持】按 DOI 检索：
 *   论文信息接口只接受内部论文 id（{"ids":[...]}），论文搜索接口只有 title 参数。
 * 这里如实返回 unsupported，由上层改走题名检索链（那里会用到 AMiner），
 * 而不是拿 DOI 去撞 title 参数——那只会换回一批无关记录，还会假装"查过了"。
 */
function byDoi(doi, opt) {
  var r = baseResult('', T.normalizeDoi(doi));
  r.failureKind = 'unsupported';
  r.failureDetail = 'AMiner 开放平台的论文信息接口只支持按论文 id 查询（POST {"ids":[...]}），' +
    '论文搜索接口也只接受题名，均不支持按 DOI 检索，因此本次未请求 AMiner。';
  return Promise.resolve(r);
}

module.exports = {
  PROVIDER: PROVIDER,
  config: config,
  available: available,
  /* AMiner 的搜索接口只有 title 一个检索参数，没有「作者 / 年份字段限定」这一档，
   * 所谓「精确检索」与「宽松检索」发出去的是【同一个请求】（区别只在本地收敛排序）。
   * 因此上层对 AMiner 【只跑一次题名检索】，不要重复发两次一样的请求白白吃掉时间预算。
   * 这不是偷懒——发两次除了多花一倍时间，不会多查出任何东西。 */
  singleStageSearch: true,
  byDoi: byDoi,
  byId: byId,
  searchLoose: searchLoose,
  searchPrecise: searchPrecise,
  searchTopic: searchTopic,
  paperSearch: paperSearch,
  paperInfo: paperInfo,
  enrich: enrich,
  mergeDetail: mergeDetail,
  toRecord: toRecord,
  verdictOf: verdictOf,
  authDetail: authDetail,
  cleanTitleWords: cleanTitleWords,
  firstAuthor: firstAuthor,
  year4: year4
};
