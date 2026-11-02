'use strict';
/**
 * 「帮我找文献」——检索推荐引擎（第三阶段）
 * ============================================================================
 * 与「核验已有文献」是两条【互不干扰】的链路：
 *   核验：你手上已有一条题录 → 去公开库核对它是不是真的、字段对不对。
 *   推荐：你手上还没有文献 → 按课题去公开库检索 → 把真实检索到的记录交给你挑。
 *
 * 本模块只做三件事，且顺序固定（与页面上的步骤一一对应）：
 *   ① planTopic()   任务 C：通义千问按课题生成【关键词 / 同义词 / 检索式】
 *                    —— 严禁在这一步产出任何具体文献；
 *   ② runSearch()   真实调用 Crossref + OpenAlex 的公开检索接口，拿回候选记录；
 *   ③ analyzeTopic() 任务 D：通义千问【只依据上一步真实拿到的记录】解释与课题的关系。
 *
 * 诚实边界（任何改动都必须守住）：
 *   1. 推荐条目的题名 / 作者 / 年份 / DOI / 链接【只能来自真实检索记录】，
 *      模型不得凭记忆补齐参考文献；模型输出里不在候选里的条目一律丢弃。
 *   2. 只接 Crossref 与 OpenAlex 两个公开服务，如实说明覆盖范围，
 *      不承诺覆盖知网 / 万方 / 全部中文文献。
 *   3. 查询到记录【不等于】已核实论文质量，也不代表原文已被读过：
 *      「阅读依据」由系统按实际拿到的材料机械判定（题录 / 题录+摘要），
 *      没有摘要就绝不写摘要，从未抓取全文就绝不出现页码与原文摘录。
 *   4. 推荐清单默认最多 5 篇；数量不足如实显示，不用虚构或不相关条目凑数；
 *      只有题录、材料不足的条目进「待阅读线索」，标明匹配程度尚未确认。
 *   5. 不使用任何「匹配度 87%」「可信度 0.9」这类无法验证的百分数。
 *   6. 检索失败（接口不通 / 限流 / 超时）与「检索成功但没有合适结果」
 *      是两种不同结论，分别返回 failed / empty，绝不互相冒充。
 */

var http = require('./lib/http.js');
var T = require('./lib/text.js');
var openalex = require('./sources/openalex.js');
var crossref = require('./sources/crossref.js');
var aminer = require('./sources/aminer.js');
var qwen = require('./sources/qwen.js');

/* ---------------- 常量 ---------------- */

var MAX_RECOMMEND = 5;        // 推荐清单默认最多 5 篇（需求 4）
var MAX_LEADS = 10;           // 待阅读线索最多展示条数
var MAX_ANALYZE_CANDS = 6;    // 交给模型分析的候选上限（实测 8 条 × 400 字摘要会让 qwen-plus 超过 13s 超时）
var MAX_QUERIES_PER_SOURCE = 2;
/* 每个源、每条检索式取回的条数。
 * 取 8 条时经常出现「网页上明明有、API 取不到」——因为正确那条排在第 9 位以后，
 * 而 API 不像网页可以翻页。AMiner 的单次上限是 20，取满它。
 * 多取回来不会污染结果：后面还有去重与「词面重合」门槛把关。 */
var PER_PAGE = 20;
var GAP_BETWEEN_QUERIES = 300;
var ABSTRACT_FOR_MODEL = 240; // 送给模型的摘要字数上限（同上，实测 240 字时约 12s 可完成）
var ABSTRACT_KEEP = 800;      // 本地留存的摘要字数上限
/* 摘要「够不够当作材料」的下限。
 * 实测：部分记录虽然带 abstract 字段，但只有一两句话（几十字的残摘要），
 * 模型照着它能写出的"匹配点"其实与只看到题录没区别。
 * 这类条目按需求 4 归入「待阅读线索」，不混进推荐清单。 */
var MIN_ABSTRACT_LEN = 120;
/* 词面重合门槛。
 * 背景（实测）：OpenAlex / Crossref 的检索是【模糊匹配】，即使检索式是一串生造词，
 * 它们照样返回一批记录（2026-11-01 实测：全生造词也要回 8 条）。
 * 若不设门槛，用户会看到一批与检索式毫无关系的条目，模型还会照着这些噪音写推荐理由。
 * 因此这里做一道很松的机械门槛：候选的题名 / 出处 / 摘要里至少要出现 1 个检索词。
 * 被剔除的记录【如实计数并给出理由】，不会悄悄丢掉。 */
var MIN_TERM_HITS = 1;

/**
 * 实际覆盖范围（务必如实，不夸大）。
 * 这一整段会原样展示给用户，也会写进本机保存的检索留痕里。
 */
var COVERAGE = {
  services: [
    {
      id: 'crossref', name: 'Crossref', home: 'https://www.crossref.org',
      note: '公开元数据接口（api.crossref.org），无需注册与密钥；覆盖以有 DOI 的期刊文献为主'
    },
    {
      id: 'openalex', name: 'OpenAlex', home: 'https://openalex.org',
      note: '公开学术元数据库（api.openalex.org），无需注册与密钥；有 DOI 的期刊文献覆盖较好，中文刊、学位论文、图书覆盖不完整'
    },
    {
      id: 'aminer', name: 'AMiner', home: 'https://www.aminer.cn',
      note: 'AMiner 开放平台（datacenter.aminer.cn），需 Token（云端环境变量 AMINER_TOKEN）；' +
        '仅使用论文搜索（GET）与论文信息（POST）两个接口，中文刊与中文会议论文覆盖优于两个境外源'
    }
  ],
  notCovered: [
    '知网 / 万方 / 维普等中文数据库（未接入，不做承诺）',
    '未分配 DOI 的中文期刊论文、会议论文',
    '学位论文、图书与教材、内部报告、标准规范',
    '需要机构订阅才能访问的出版商全文'
  ],
  text: '本次检索 Crossref、OpenAlex 与 AMiner 三个公开元数据服务' +
    '（前两个无需注册，AMiner 需在云端配置 AMINER_TOKEN）。' +
    '前两者以「有 DOI 的期刊文献」覆盖最好，中文文献、学位论文、图书很可能检索不到；' +
    'AMiner 对中文刊与中文会议论文的覆盖更好，但仍不等于知网 / 万方全库。' +
    '本功能【不】覆盖知网 / 万方 / 维普，也【不】承诺覆盖全部文献；' +
    '检索不到不等于没有相关研究，请另行用学校图书馆数据库或中文库补充检索。',
  /* 检索到记录 ≠ 已核实：这句话在每个结果里都要出现 */
  notVerified: '检索到记录只说明公开库里有这条题录，【不等于】论文质量已核实，' +
    '也不代表本系统读过出版方原文；摘要、全文与结论仍需你自行打开原文确认。'
};

/* ---------------- 小工具 ---------------- */

function nowText() { return http.fmtTime(new Date()); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/** OpenAlex 的摘要是倒排索引，需要还原成文本 */
function abstractFromOpenAlex(w) {
  var idx = w && w.abstract_inverted_index;
  if (!idx || typeof idx !== 'object') return '';
  var words = Object.keys(idx);
  if (!words.length) return '';
  var slots = [];
  var max = 0;
  for (var i = 0; i < words.length; i++) {
    var pos = idx[words[i]] || [];
    for (var k = 0; k < pos.length; k++) {
      var p = pos[k];
      if (typeof p !== 'number') continue;
      slots[p] = words[i];
      if (p > max) max = p;
    }
  }
  var out = [];
  for (var j = 0; j <= max; j++) out.push(slots[j] || '');
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Crossref 的摘要多为 JATS XML，去掉标签即可 */
function abstractFromCrossref(msg) {
  var a = msg && msg.abstract;
  if (!a || typeof a !== 'string') return '';
  return String(a)
    .replace(/<jats:[^>]*>/gi, ' ')
    .replace(/<\/jats:[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 用于去重：题名归一化（小写、只留字母数字与中日韩字符） */
function titleKey(t) {
  return String(t || '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/g, '').slice(0, 120);
}

/* ---------------- 候选记录 ---------------- */

/**
 * 把来源返回的一条记录 → 本系统的候选条目。
 * 只搬运真实存在的字段；缺什么就记一条「该来源未提供 X」，
 * 绝不用模型或规则去补造。
 */
function buildCandidate(src, rec, meta) {
  /* 摘要按来源的真实结构取：
   *   OpenAlex 是倒排索引、Crossref 是 JATS XML、AMiner 由「论文信息」接口返回
   *   （适配器已把它补进 record.abstract）。来源没给就是空，不生成、不推测。 */
  var abs = (src.id === 'openalex') ? abstractFromOpenAlex(rec.raw)
    : (src.id === 'crossref') ? abstractFromCrossref(rec.raw)
      : T.trim(rec.abstract);
  var hasAbs = !!abs;
  var year = rec.yearIssued || rec.yearPrint || rec.yearOnline || '';
  var raw = rec.raw || {};

  var oa = { isOa: false, pdfUrl: '' };
  if (src.id === 'openalex') {
    var oaObj = raw.open_access || {};
    oa.isOa = !!oaObj.is_oa;
    var best = raw.best_oa_location || raw.primary_location || {};
    oa.pdfUrl = T.trim(best.pdf_url || (best.landing_page_url && oa.isOa ? best.landing_page_url : ''));
  }

  var missing = [];
  if (!rec.doi) missing.push('该来源未提供 DOI');
  if (!year) missing.push('该来源未提供年份');
  if (!rec.authorText) missing.push('该来源未提供作者');
  if (!rec.container) missing.push('该来源未提供出处');

  /* 阅读依据：系统按【实际拿到的材料】机械判定，模型无权改写 */
  var level = hasAbs ? 'citation_abstract' : 'citation';
  var evidenceText = hasAbs
    ? '题录 + 来源返回的摘要（未获取全文，未读原文）'
    : '仅有题录（题名 / 作者 / 年份 / 出处），来源未提供摘要，未获取全文';

  var lang = T.trim(raw.language || (raw.primary_location && raw.primary_location.language) ||
    rec.lang || (T.hasCjk(rec.title) ? 'zh' : ''));

  return {
    id: '',                       // 去重后统一编号
    source: src.name,
    sourceId: src.id,
    query: meta.query || '',
    apiUrl: meta.apiUrl || '',
    retrievedAt: meta.requestedAt || nowText(),
    title: T.trim(rec.title) || '（该来源未提供题名）',
    authors: T.trim(rec.authorText),
    year: year,
    venue: T.trim(rec.container),
    publisher: T.trim(rec.publisher),
    type: T.trim(rec.type),
    lang: lang,
    doi: T.trim(rec.doi),
    url: T.trim(rec.url),
    hasAbstract: hasAbs,
    abstract: hasAbs ? abs.slice(0, ABSTRACT_KEEP) : '',
    abstractLen: (hasAbs ? abs.slice(0, ABSTRACT_KEEP) : '').length,
    abstractTruncated: hasAbs && abs.length > ABSTRACT_KEEP,
    oa: oa,
    citedBy: (rec.flags && typeof rec.flags.citedByCount === 'number') ? rec.flags.citedByCount : null,
    retracted: !!(rec.flags && rec.flags.isRetracted),
    evidenceLevel: level,
    evidenceText: evidenceText,
    missing: missing,
    alsoIn: [],                   // 去重时被合并进来的其它来源
    _key: ''                      // 去重键，内部用
  };
}

/**
 * 去重 + 统一编号。
 * 同一条文献常被两个源都返回；按 DOI 优先、其次「题名 + 年份」判重。
 * 保留信息更全的那条（有摘要的优先），被合并掉的如实记一条理由。
 */
function dedupe(list) {
  /* 有摘要的排前面，去重时就会留下信息更全的那条 */
  var arr = list.slice().sort(function (a, b) {
    if (a.hasAbstract !== b.hasAbstract) return a.hasAbstract ? -1 : 1;
    return 0;
  });
  var byKey = {};
  var out = [];
  var removed = [];
  for (var i = 0; i < arr.length; i++) {
    var c = arr[i];
    c._key = c.doi ? ('doi:' + c.doi.toLowerCase()) : ('t:' + titleKey(c.title) + '|' + c.year);
    if (byKey[c._key]) {
      var keep = byKey[c._key];
      if (keep.alsoIn.indexOf(c.source) < 0) keep.alsoIn.push(c.source);
      removed.push({
        title: c.title, source: c.source,
        reason: '与已保留条目重复（同 DOI / 同题名+年份），已合并，保留信息更全的一条'
      });
      continue;
    }
    byKey[c._key] = c;
    out.push(c);
  }
  for (var k = 0; k < out.length; k++) {
    out[k].id = 'c' + (k + 1);
    delete out[k]._key;
  }
  return { list: out, removed: removed };
}

/* ---------------- 词面重合门槛（剔除与检索式毫无关系的记录） ---------------- */

var STOP_WORDS = {
  and: 1, or: 1, not: 1, the: 1, for: 1, with: 1, that: 1, this: 1, from: 1,
  into: 1, of: 1, in: 1, on: 1, to: 1, by: 1, a: 1, an: 1, is: 1, are: 1,
  be: 1, as: 1, at: 1, it: 1, using: 1, based: 1, study: 1, research: 1
};

/**
 * 从检索式里抽出「有意义的检索词」。
 * 拉丁词按非字母数字切；中文串先按空格切，过长的串再切 2 字滑窗（无分词器时的稳妥做法）。
 */
function termsOf(q) {
  var s = String(q || '').toLowerCase();
  var out = [];
  function add(t) { if (t && out.indexOf(t) < 0) out.push(t); }

  var latin = s.match(/[a-z][a-z0-9\-]{2,}/g) || [];
  for (var i = 0; i < latin.length; i++) if (!STOP_WORDS[latin[i]]) add(latin[i]);

  var runs = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (var k = 0; k < runs.length; k++) {
    var r = runs[k];
    if (r.length <= 6) { add(r); continue; }
    for (var j = 0; j + 2 <= r.length; j++) add(r.substr(j, 2));
  }
  return out;
}

/** 候选与检索式的词面重合情况 */
function relevanceOf(c, terms) {
  var text = String((c.title || '') + ' ' + (c.venue || '') + ' ' + (c.abstract || '')).toLowerCase();
  var hits = [];
  for (var i = 0; i < terms.length; i++) {
    if (terms[i] && text.indexOf(terms[i]) >= 0) hits.push(terms[i]);
  }
  return { hits: hits.length, hitTerms: hits.slice(0, 6) };
}

/**
 * 剔除与【产生它的那条检索式】毫无词面重合的记录。
 * 只在「检索式确实能抽出检索词」时生效（抽不出词的检索式不做剔除，免得误杀）。
 */
function filterIrrelevant(list) {
  var kept = [];
  var removed = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var terms = termsOf(c.query);
    if (!terms.length) { kept.push(c); continue; }
    var r = relevanceOf(c, terms);
    if (r.hits >= MIN_TERM_HITS) {
      c.termHits = r.hitTerms;
      kept.push(c);
    } else {
      removed.push({
        title: c.title, source: c.source, query: c.query,
        reason: '与检索式「' + c.query + '」没有任何词面重合（检索词：' +
          terms.slice(0, 6).join('、') + '），判定为无关记录，不列为候选'
      });
    }
  }
  return { list: kept, removed: removed };
}

/** 从真实候选集里统计筛选项：只提供【有真实数据支撑】的选项 */
function facetsOf(list) {
  var years = {}, langs = {}, types = {};
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (c.year) years[c.year] = (years[c.year] || 0) + 1;
    if (c.lang) langs[c.lang] = (langs[c.lang] || 0) + 1;
    if (c.type) types[c.type] = (types[c.type] || 0) + 1;
  }
  function toArr(map) {
    return Object.keys(map).sort().map(function (k) {
      return { value: k, count: map[k] };
    });
  }
  return { years: toArr(years), langs: toArr(langs), types: toArr(types) };
}

/* ==========================================================================
 *  ① 任务 C：检索式规划
 * ========================================================================== */

/** 模型不可用 / 没给出检索式时的机械兜底（只拼课题原文，不编造文献） */
function fallbackQueries(topic) {
  var qs = [];
  function add(text, note) {
    var t = T.trim(text);
    if (!t) return;
    qs.push({ text: t.slice(0, 120), lang: T.hasCjk(t) ? 'zh' : 'en', why: note });
  }
  add(topic.name, '课题名称');
  add([topic.problem, topic.target].filter(Boolean).join(' ').slice(0, 120), '研究问题 + 对象');
  return qs.slice(0, 2);
}

/**
 * @param {object} topic 课题
 * @param {string} hints 用户补充：「这次想找什么」
 * @param {object} opt {timeout}
 */
async function planTopic(topic, hints, opt) {
  opt = opt || {};
  topic = topic || {};
  var out = {
    ok: false, status: 'failed', plan: null, model: '', searched: false,
    at: nowText(), ms: 0, coverage: COVERAGE, failureKind: null, failureDetail: '', note: ''
  };

  if (!qwen.available()) {
    out.status = 'config_failed';
    out.failureKind = 'config';
    out.failureDetail = '云函数环境变量 QWEN_API_KEY 未配置，无法调用通义千问生成检索式。';
    out.plan = { keywords: [], synonyms: [], queries: fallbackQueries(topic), dropped: [], scopeNote: '', fallback: true };
    out.note = '未调用大模型（环境变量缺失），已用课题原文机械拼接 1~2 条检索式，你可以自行修改后检索。';
    return out;
  }

  var r = await qwen.planQueries(topic, hints, { timeout: opt.timeout });
  out.model = r.model || '';
  out.ms = r.ms || 0;
  out.searched = !!r.searched;
  out.at = r.requestedAt || nowText();

  if (!r.ok || !r.plan || !r.plan.queries.length) {
    out.status = 'fallback';
    out.failureKind = r.failureKind || 'parse';
    out.failureDetail = r.failureDetail || '模型没有给出可用检索式';
    out.plan = {
      keywords: [], synonyms: [],
      queries: fallbackQueries(topic),
      dropped: (r.plan && r.plan.dropped) || [],
      scopeNote: '', fallback: true
    };
    out.note = '大模型本次没有给出可用的检索式（' + (r.failureKind || '输出不可用') +
      '），已用课题原文机械拼接检索式。你可以直接修改下面的检索式再检索——' +
      '这里不会使用任何模型记忆里的文献。';
    return out;
  }

  out.ok = true;
  out.status = 'ok';
  out.plan = r.plan;
  out.note = '检索式由通义千问（' + out.model + '）按课题生成，【未开启联网检索】，' +
    '因此它不会把记忆里的论文混进来；真正的文献条目全部来自下一步的真实检索接口。';
  return out;
}

/* ==========================================================================
 *  ② 真实检索（Crossref + OpenAlex）
 * ========================================================================== */

/**
 * @param {Array<string>} queries 检索式（最多取前 MAX_QUERIES_PER_SOURCE 条）
 * @param {object} filters {yearFrom, yearTo}
 * @param {object} opt {timeout, timeBudgetMs, maxQueries}
 * @returns {Promise<object>} {status:'ok'|'empty'|'failed', candidates, log, ...}
 */
async function runSearch(queries, filters, opt) {
  opt = opt || {};
  filters = filters || {};
  var list = (queries || []).filter(function (q) { return T.trim(q); });
  var maxQ = opt.maxQueries || MAX_QUERIES_PER_SOURCE;
  var use = list.slice(0, maxQ);
  var skipped = list.slice(maxQ);

  var deadline = Date.now() + (opt.timeBudgetMs || 15000);
  function remain() { return deadline - Date.now(); }
  function timeout() { return Math.max(800, Math.min(opt.timeout || 8000, remain() - 200)); }
  /* AMiner 单独一份请求超时：它的响应时间跨度极大（云端实测 0.4s ~ 12.5s，
   * 偶发连接黑洞），跟着 OpenAlex / Crossref 用 8s 会把「慢但能返回」的请求全判失败。
   * deadline 仍会把它收敛到本段剩余预算内，不会被它拖过平台上限。 */
  var AMINER_TIMEOUT_MS = 22000;
  function timeoutFor(src) {
    var want = (src && src.PROVIDER && src.PROVIDER.id === 'aminer') ? AMINER_TIMEOUT_MS : (opt.timeout || 8000);
    return Math.max(800, Math.min(want, remain() - 200));
  }

  var log = [];
  var rawCands = [];
  var anyOk = false;

  /* 检索顺序（与核验链路保持同一套规则）：
   *   检索式含中文 → AMiner 先跑：两个境外源对中文检索式会返回大量无关记录，
   *     最终都要被「词面重合门槛」剔除，白白吃掉时间预算；
   *   否则 → OpenAlex → Crossref → AMiner（AMiner 作为中文覆盖的补充）。 */
  var zhQuery = false;
  for (var z = 0; z < use.length; z++) { if (T.hasCjk(use[z])) { zhQuery = true; break; } }
  var sources = zhQuery ? [aminer, openalex, crossref] : [openalex, crossref, aminer];
  for (var s = 0; s < sources.length; s++) {
    var src = sources[s];
    for (var i = 0; i < use.length; i++) {
      var q = use[i];
      if (remain() < 1200) {
        log.push({
          providerId: src.PROVIDER.id, providerName: src.PROVIDER.name, query: q,
          apiUrl: '', requestedAt: nowText(), httpStatus: 0, returned: 0, ok: false,
          failureKind: 'budget_exhausted',
          failureDetail: '云函数剩余执行时间不足，该检索式未发出（不是检索不到）', ms: 0
        });
        continue;
      }
      if (i > 0) await sleep(GAP_BETWEEN_QUERIES);
      var t0 = Date.now();
      /* deadline 下传：AMiner 一次检索内部最多三次请求（搜索 + 降级重试 + 补详情），
       * 没有它就会各自按 timeout() 等满，三次叠加直接把云函数拖过平台硬超时。 */
      var r = await src.searchTopic(q, {
        limit: PER_PAGE, timeout: timeoutFor(src), deadline: deadline,
        yearFrom: filters.yearFrom, yearTo: filters.yearTo
      });
      var entry = {
        providerId: src.PROVIDER.id, providerName: src.PROVIDER.name, query: q,
        apiUrl: r.apiUrl || '', requestedAt: r.requestedAt || nowText(),
        httpStatus: r.httpStatus || 0, returned: r.returned || 0, ok: !!r.ok,
        failureKind: r.ok ? null : (r.failureKind || 'network'),
        failureDetail: r.ok ? '' : (r.failureDetail || ''),
        /* 补摘要的实际情况要留痕：AMiner 的详情接口不给摘要时，
         * 页面必须能说清「来源没提供」，而不是让用户以为系统忘了补。 */
        enriched: r.enriched || 0,
        enrichNote: r.enrichNote || '',
        retried: r.retried || 0,
        ms: Date.now() - t0
      };
      log.push(entry);
      console.log('[lfaVerify][discover-search] ' + src.PROVIDER.name +
        ' | query=' + q + ' | HTTP ' + entry.httpStatus + ' | 返回 ' + entry.returned + ' 条 | ' + entry.apiUrl);
      if (r.ok) {
        anyOk = true;
        var recs = r.records || [];
        for (var k = 0; k < recs.length; k++) {
          rawCands.push(buildCandidate(src.PROVIDER, recs[k], {
            query: q, apiUrl: r.apiUrl, requestedAt: r.requestedAt
          }));
        }
      }
    }
  }

  var d = dedupe(rawCands);
  var ir = filterIrrelevant(d.list);
  var cands = ir.list;
  var facets = facetsOf(cands);

  /* 全部失败时，把「哪个源、什么错」汇总成一句人能看懂的话，
   * 免得页面上只显示一句空泛的「检索失败」。 */
  var failText = '';
  if (!anyOk) {
    var bits = [];
    for (var fi = 0; fi < log.length; fi++) {
      var lg = log[fi];
      var why = lg.failureKind === 'auth_failed'
        ? 'Token 鉴权失败（无效或已过期）'
        : (lg.failureKind === 'config' ? '未配置 Token（AMINER_TOKEN）'
          : (lg.httpStatus ? ('HTTP ' + lg.httpStatus) : (lg.failureDetail || '未发起')));
      bits.push(lg.providerName + '：' + why);
    }
    failText = bits.join('；') || '检索服务都没有响应';
  }

  /* AMiner Token 鉴权失败要单独拎出来讲：这是配置问题，不是「检索不到」，
   * 用户需要的是「去重新生成 Token」，而不是以为课题没相关文献。 */
  var authNotice = '';
  for (var ai2 = 0; ai2 < log.length; ai2++) {
    var al = log[ai2];
    if (al && al.failureKind === 'auth_failed') {
      authNotice = 'AMiner Token 鉴权失败：Token 无效或已过期。' +
        '请到 AMiner 开放平台控制台重新生成 Token，并在「云开发控制台 → 云函数 lfaVerify →' +
        ' 配置 → 环境变量」更新 AMINER_TOKEN。' +
        '本次推荐清单【没有】包含 AMiner 的结果，不表示没有相关文献。';
      break;
    }
  }

  var out = {
    ok: anyOk,
    status: !anyOk ? 'failed' : (cands.length ? 'ok' : 'empty'),
    failureKind: !anyOk ? 'http_error' : null,
    failureDetail: failText,
    /* 零结果的两种成因要分开讲：
     *   no_records   接口一条都没返回；
     *   no_relevant  接口返回了，但没有一条与检索式有词面重合。 */
    emptyKind: (!anyOk) ? '' : (cands.length ? '' : (d.list.length ? 'no_relevant' : 'no_records')),
    candidates: cands,
    removedDuplicates: d.removed,
    removedIrrelevant: ir.removed,
    facets: facets,
    log: log,
    executedQueries: use,
    skippedQueries: skipped,
    filters: { yearFrom: filters.yearFrom || '', yearTo: filters.yearTo || '' },
    coverage: COVERAGE,
    /* AMiner Token 鉴权失败提示（空字符串表示没有这个问题） */
    authNotice: authNotice,
    /* 检索服务清单（运行时真实调用的），前端据此展示「实际用了哪些服务」 */
    services: COVERAGE.services.map(function (x) {
      var used = false;
      var failed = '';
      for (var i = 0; i < log.length; i++) {
        if (log[i].providerId !== x.id) continue;
        if (log[i].ok) used = true;
        else if (!failed && (log[i].failureKind === 'auth_failed' || log[i].failureKind === 'config')) {
          failed = log[i].failureKind;
        }
      }
      return {
        id: x.id, name: x.name, home: x.home, note: x.note, used: used,
        /* 需要 Token 的源要如实标出「这次到底用上了没有」 */
        configured: (x.id !== 'aminer') ? true : aminer.available(),
        unavailableReason: failed || ''
      };
    }),
    at: nowText(),
    /* 排序说明：只按检索服务自身的相关度顺序合并，不额外打分 */
    orderNote: '候选按检索服务自身返回的相关度顺序合并（本次顺序：' +
      sources.map(function (x) { return x.PROVIDER.name; }).join(' → ') + '），' +
      '系统没有给出任何「匹配度」评分，也不把「发表年份更新」当作更可信。'
  };
  return out;
}

/* ==========================================================================
 *  ③ 任务 D：候选与课题的关系分析
 * ========================================================================== */

/**
 * @param {object} topic 课题
 * @param {Array} candidates 真实检索到的候选（runSearch 的产物）
 * @param {object} opt {timeout}
 */
async function analyzeTopic(topic, candidates, opt) {
  opt = opt || {};
  var cands = candidates || [];
  var out = {
    ok: false, status: 'failed', model: '', searched: false, at: nowText(), ms: 0,
    recommended: [], leads: [], others: [], dropped: [], note: '',
    analyzedCount: 0, unanalyzedCount: cands.length,
    percentRemoved: 0, failureKind: null, failureDetail: '', coverage: COVERAGE
  };

  if (!cands.length) {
    out.status = 'empty';
    out.ok = true;
    out.note = '本次没有检索到任何候选记录，因此【没有】做任何推荐，也不会给出任何文献条目。';
    return out;
  }

  if (!qwen.available()) {
    out.status = 'config_failed';
    out.failureKind = 'config';
    out.failureDetail = '云函数环境变量 QWEN_API_KEY 未配置，无法调用通义千问做关系分析。';
    out.note = '候选记录已真实检索到（' + cands.length + ' 条），但没有做关系分析：' +
      '未配置模型凭证。你可以直接按题录自行判断，或配置后重新分析。';
    return out;
  }

  /* 只把前 N 条交给模型：控制耗时与输出长度；未分析的条目如实说明，不给结论 */
  var pool = cands.slice(0, MAX_ANALYZE_CANDS);
  var feed = pool.map(function (c) {
    return {
      id: c.id, title: c.title, authors: c.authors, year: c.year,
      venue: c.venue, type: c.type, doi: c.doi,
      abstract: c.hasAbstract ? c.abstract.slice(0, ABSTRACT_FOR_MODEL) : ''
    };
  });

  var r = await qwen.analyzeCandidates(topic, feed, { timeout: opt.timeout });
  out.model = r.model || '';
  out.ms = r.ms || 0;
  out.searched = !!r.searched;
  out.at = r.requestedAt || nowText();

  if (!r.ok || !r.analysis) {
    out.status = 'failed';
    out.failureKind = r.failureKind || 'parse';
    out.failureDetail = r.failureDetail || '模型未产出可解析的分析结果';
    out.note = '候选记录已真实检索到（' + cands.length + ' 条），但关系分析没有完成（' +
      (r.failureKind || '输出不可用') + '）。你可以按题录自行判断，或稍后重试——' +
      '本系统不会因为分析失败就编造推荐理由。';
    return out;
  }

  var a = r.analysis;
  out.percentRemoved = a.percentRemoved || 0;
  out.recencyRemoved = a.recencyRemoved || 0;
  out.dropped = a.dropped || [];
  out.note = a.note || '';
  out.analyzedCount = pool.length;
  out.unanalyzedCount = Math.max(0, cands.length - pool.length);

  var byId = {};
  for (var i = 0; i < cands.length; i++) byId[cands[i].id] = cands[i];

  var withMaterial = [];
  var noMaterial = [];
  for (var k = 0; k < a.items.length; k++) {
    var it = a.items[k];
    var c = byId[it.id];
    if (!c) continue;
    var entry = {
      id: c.id,
      cand: c,
      match: it.match || [],
      gap: it.gap || [],
      todo: it.todo || [],
      uses: it.uses || [],
      usesEmpty: !!it.usesEmpty,
      why: it.why || '',
      /* 阅读依据由系统按实际材料机械给出，不是模型自述 */
      evidenceLevel: c.evidenceLevel,
      evidenceText: c.evidenceText
    };
    /* 材料是否够拿到「推荐清单」里：
     *   ① 摘要长度达到下限（残摘要不算）；或 ② 来源标注了可获取的开放获取全文。
     *   其余一律进「待阅读线索」——有题录但材料不足，匹配程度尚未确认。 */
    var materialEnough = (c.hasAbstract && (c.abstractLen || 0) >= MIN_ABSTRACT_LEN) || !!c.oa.pdfUrl;
    if (materialEnough) withMaterial.push(entry);
    else noMaterial.push(entry);
  }

  out.recommended = withMaterial.slice(0, MAX_RECOMMEND);
  out.others = withMaterial.slice(MAX_RECOMMEND);
  out.leads = noMaterial.slice(0, MAX_LEADS);

  out.ok = true;
  out.status = 'ok';
  return out;
}

module.exports = {
  COVERAGE: COVERAGE,
  MAX_RECOMMEND: MAX_RECOMMEND,
  MAX_ANALYZE_CANDS: MAX_ANALYZE_CANDS,
  MIN_TERM_HITS: MIN_TERM_HITS,
  MIN_ABSTRACT_LEN: MIN_ABSTRACT_LEN,
  planTopic: planTopic,
  runSearch: runSearch,
  analyzeTopic: analyzeTopic,
  termsOf: termsOf,
  relevanceOf: relevanceOf,
  filterIrrelevant: filterIrrelevant,
  /* 供离线测试使用 */
  abstractFromOpenAlex: abstractFromOpenAlex,
  abstractFromCrossref: abstractFromCrossref,
  buildCandidate: buildCandidate,
  dedupe: dedupe,
  facetsOf: facetsOf,
  fallbackQueries: fallbackQueries
};
