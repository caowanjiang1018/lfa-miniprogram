'use strict';
/**
 * 云函数 lfaVerify —— 文献身份与题录核验
 * ============================================================================
 * 架构约定：OpenAlex / Crossref / 通义千问 的全部 HTTP 请求【只在本云函数内发起】。
 * 小程序前端只调用本云函数，不直接访问任何外部接口，前端也不保存任何接口地址与密钥。
 *
 *   - ② OpenAlex（优先）→ Crossref（回源）
 *       每个源内部固定两段式检索：
 *         第一段【宽松】只用 search= / query.bibliographic= 传题名（不加字段限定）；
 *         第一段没有合格候选时，才补第二段【精确字段】
 *         （OpenAlex: filter=title.search+author.search+publication_year；
 *          Crossref: query.title+query.author+出版年 filter）。
 *       两段产出的候选都会再做一次「信息校验匹配」（题名/作者/年份/出处），
 *       不合格的不列为候选。
 *   - ③ 未命中 → 任务B 通义千问【联网检索兜底】

 * 串行流程（顺序不可颠倒）：
 *   ① 任务A 通义千问【预处理提取】  原始不规范文本 → 结构化字段
 *   ② OpenAlex（优先）→ Crossref（回源）用结构化字段去查
 *   ③ 命中 → 直接返回学术库结论，【不】再调千问
 *      未命中 / 判定为中文文献 → 任务B 通义千问【联网检索兜底】
 *
 * 诚实边界（任何改动都必须守住）：
 *   1. 「未收录」「网络异常」「无 DOI」是三种不同结论，都【不等于文献不存在】。
 *   2. 缺失字段只标【信息缺失】，绝不自动补造作者/年份/期刊。
 *   3. 无 DOI 检索只产出候选，【绝不】自动采信第一条。
 *   4. 中文题名不消耗两个境外源，直接检索 AMiner；AMiner 也没有才进联网检索兜底。
 *   5. 失败时如实返回错误原因，绝不返回预置样例或假成功。
 *   6. 千问联网检索的结果【永远】是「需人工甄别」，绝不据此判定已核实。
 *
 * event 结构：
 *   { action: 'verify', ref: {raw, doi,title,authors,year,venue},
 *     aiExtract: true, aiSearch: true }
 *   { action: 'extract', raw: '...' }   仅执行任务 A
 *   { action: 'ping' }
 */

var http = require('./lib/http.js');
var T = require('./lib/text.js');
var compare = require('./lib/compare.js');
var openalex = require('./sources/openalex.js');
var crossref = require('./sources/crossref.js');
var aminer = require('./sources/aminer.js');
var qwen = require('./sources/qwen.js');
var discover = require('./discover.js');
var adapt = require('./adapt.js');

var ENGINE_VERSION = 'lfa-verify-engine-4.0.0';

/* ---------------- 节流参数 ----------------
 * 实测：Crossref 429 非常容易触发（2s 间隔也会）；
 *      OpenAlex 检索接口有「同 IP 共享免费日配额」，配额耗尽直接 429。
 *      因此：两个源之间留间隔，多条文献之间也留间隔。 */
/* 单次 HTTP 请求的默认超时（会被下方各段预算再次收敛） */
var TIMEOUT_MS = 12000;         // 单源超时（OpenAlex / Crossref）
/* 云函数整体耗时预算。
 * 微信云函数【默认执行超时只有 3 秒】，超时会被平台直接杀掉并返回
 * errCode -504003（FUNCTIONS_TIME_LIMIT_EXCEEDED），前端拿不到任何结论。
 * 因此这里主动做「时间预算」：宁可少查一个源并如实说明，也不要被平台硬超时。
 * 控制台把 lfaVerify 的执行超时调到 60 秒后，这里会自动跟着拿到更大的额度。 */
var TIME_BUDGET_MS = 52000;     // 期望预算；实际会被「平台剩余执行时间」钳制（见 platformRemainingMs）

/* ---------------- 分段超时预算：AMiner 与千问各自独立，不再互相挤占 ----------------
 * 需求：AMiner 要等更久、千问联网检索也要等更久。
 * 现实约束：这两段在【同一次云函数调用】里是串行的，共享同一份墙钟，
 *          单次调用的硬上限取 context.time_limit_in_ms（控制台最大 60 秒），
 *          所以「AMiner 60s + 千问 60s」在一次调用内做不到（否则必定被平台硬杀）。
 * 做法：给每一段各自的下限/上限，并强制前一段不许吃光后一段的额度。
 *      想再放宽，只改下面这几个数即可，编排逻辑不用动。 */
var AMINER_REQ_TIMEOUT_MS = 22000;   // AMiner 单次 HTTP 请求超时（原先被挤到 8~12s，慢请求直接判失败）
var AMINER_SEGMENT_MS = 32000;       // AMiner 这一段（含内部多次子请求）的总墙钟上限
/* 千问联网检索段：无论如何要给它保留的时间。
 * 实测慢是真的慢（冷门中文条目 13.7s 以上），留得少就等于「明明能查到却没查」。
 * 千问没配置或本次禁用时，这份保留会立刻释放给 AMiner 段。 */
var QWEN_RESERVE_MS = 26000;
var MIN_NEED_MS = 700;          // 剩余时间不足以完成一次请求时，不再发起新请求
var GAP_BETWEEN_SOURCES = 400;  // 同一条文献，两个源之间的间隔
/* 同一个源内部「宽松 → 精确」两段之间的间隔。
 * 取 300 而不是 400：它发生在【同一条文献的同一个源】上，
 * 真正要防的限流是「两源之间的连续请求」，那部分由 GAP_BETWEEN_SOURCES 兜住。
 * 但也不能为 0——实测 Crossref 在极短间隔下 429 概率明显上升。 */
var GAP_BETWEEN_STAGES = 300;
var PLATFORM_RESERVE_MS = 400;  // 给平台调度与结果序列化预留的时间

/* 两段式检索的阶段标识（会写进结果 method / tried.method，前端据此显示中文名） */
var STAGE_LOOSE = 'loose-title-search';
var STAGE_PRECISE = 'precise-field-search';
/* 单段检索：用于【接口不支持字段限定】的数据源（AMiner 搜索接口只有 title 参数）。
 * 这类源再发一次「精确字段检索」是同一个请求，纯属浪费时间预算，
 * 所以只跑一次，并如实标注为「题名检索（该来源不支持字段限定）」。 */
var STAGE_SINGLE = 'title-only-search';
var STAGE_LABEL = {};
STAGE_LABEL[STAGE_LOOSE] = '宽松检索（仅题名）';
STAGE_LABEL[STAGE_PRECISE] = '精确字段检索（题名+作者+年份）';
STAGE_LABEL[STAGE_SINGLE] = '题名检索（该来源不支持作者 / 年份字段限定）';
/* 候选题录的保留门槛。
 * 背景：Crossref / OpenAlex 对「完全不相关」的题名也会返回一批记录（实测用一个
 * 全生造的题名去查，照样返回若干条毫不相关的条目）。若不过滤，用户会看到一堆噪音，
 * 系统还会因为「有候选」误以为本源已命中，从而不再走通义千问联网兜底。
 * 门槛按下述两条之一判定（满足任一即保留）：
 *   ① 题名相似度 ≥ 0.2（真实同一篇的题名 Jaccard 一般 ≥0.5，0.2 已是宽松下限）；
 *   ② 作者姓氏吻合且出版年份相同（题名写法差异大时，靠作者 + 年份也能锁定）。
 * 只用「综合分」卡是不行的：年份相同就贡献 0.15，足以让毫不相关的条目过线。 */
var MIN_CANDIDATE_TITLE_SIM = 0.2;
var MIN_CANDIDATE_AUTHOR_SIM = 0.5;
/* 通义千问两个任务的单步超时上限。
 * 实测（本机）：任务A 提取 qwen-flash 0.7~1.2s；
 *              任务B 联网检索 qwen-flash 2.7s / qwen-plus 4.0s / qwen-max 11.6s。
 * 实测（云端真实调用，2026-10-31）：
 *   - 任务A qwen-flash 约 0.9~1.3s；
 *   - 任务B qwen-plus：查不到的条目 3.8~5.4s，但【真能查到的冷门中文条目要 13.7s】
 *     （例如钱学森《工程控制论》1958 科学出版社）。
 *   - 原先给 B 留 9s，导致这类「明明能查到」的条目被超时截断、只能如实报未完成。
 *     现放宽到 26s（云端实测慢是因为模型要真的联网翻，给少了等于自己砍掉命中率）。 */
var EXTRACT_TIMEOUT_MS = 6000;
var AI_SEARCH_TIMEOUT_MS = 26000;
var AI_SEARCH_NEED_MS = 2500;   // 剩余时间少于此值就不再发起联网检索（发了也必然超时）
/* 时间紧张时【不】降级到 qwen-flash：实测同一条冷门中文专著，
 * flash 只要 3.7s 但给出的链接明显是拼出来的（如 worldcat.org/title/1023456789、
 * sciencereads.com/book/1234567890），plus 约 9.5s 且链接多为真实可查来源。
 * 既然千问结论本就只作线索、必须人工打开核实，那宁可超时后如实报「未完成」，
 * 也不要为了快去用一个更爱编链接的模型。 */

/* 平台侧剩余执行时间（毫秒）。微信云函数默认执行超时只有 3 秒，
 * 在「云开发控制台 → 云函数 → lfaVerify → 配置」调大后这里会自动读到更大的值，
 * 无需改代码即可让双源降级与题名检索获得充足时间。 */
var CURRENT_CONTEXT = null;
var lastBudgetMs = 0;   // 仅用于结果里回填，便于排查「是不是被平台超时卡住」
var FN_START = 0;       // 本次调用进入 main 的时刻
var TIME_LIMIT_MS = 0;  // 平台配置的函数执行超时（context.time_limit_in_ms）

function platformRemainingMs() {
  /* 首选：用平台给的执行上限减去已用时间。
   * 实测 context.getRemainingTimeInMillis() 在该运行时内部会抛
   * TypeError（client.ms_elapsed is not a function），因此不作为首选。 */
  if (TIME_LIMIT_MS > 0 && FN_START > 0) {
    return Math.max(0, TIME_LIMIT_MS - (Date.now() - FN_START));
  }
  var c = CURRENT_CONTEXT;
  if (!c) return Infinity;
  var v = null;
  if (c.remaining_time_in_millis != null) v = c.remaining_time_in_millis;
  else if (c.remainingTimeInMillis != null) v = c.remainingTimeInMillis;
  else if (typeof c.getRemainingTimeInMillis === 'function') {
    try { v = c.getRemainingTimeInMillis(); } catch (e) { v = null; }
  }
  return (typeof v === 'number' && v > 0) ? v : Infinity;
}
var MAX_CANDIDATES = 8;         // 候选最多【展示】条数
/* 向各源接口实际【请求】的条数。
 * 为什么比展示条数大：网页检索可以翻页、换排序，API 一次只拿得到一页。
 * 实测：同一题名在 OpenAlex / AMiner 的返回结果里，正确那篇常常排在第 9~20 位，
 * 只取 8 条就会「网页搜得到、小程序搜不到」。
 * 因此这里按各源的单次上限取满（AMiner 官方上限 20），本地排完序再截断展示。
 * 注意 AMiner 的 size 参数会被 max(1, min(20, limit)) 夹住，不会超限。 */
var FETCH_LIMIT = 20;
var RAW_LIMIT = 9000;           // 原始返回留存上限（超出截断并标注）

var BOUNDARY_NOTICE = '能力边界：自动核验覆盖 OpenAlex、Crossref 与 AMiner 三个公开元数据库。' +
  '检索顺序：题名为英文时依次 OpenAlex → Crossref → AMiner；题名为中文时直接检索 AMiner' +
  '（AMiner 需在云端配置环境变量 AMINER_TOKEN，未配置时该源不会参与检索）。' +
  '中文学位论文、书籍、无 DOI 文献、部分预印本仍大概率无法自动核验，' +
  '不代表文献虚假，统一进入人工核验流程，由你自行补充证据核对。' +
  '三个源都未命中时由通义千问联网检索兜底，但模型给出的链接与结论仍是线索，不等于已核实。';

/* ---------------- 5 类核验状态 ----------------
 * 文字 + 颜色双标识，不只用颜色区分 */
var STATUS = {
  verified: {
    key: 'verified', text: '题录已核验无误', tone: 'ok', color: '绿色',
    desc: '全部核心字段匹配一致'
  },
  /* 「题名一致 + 只有一处字段不一致」：按用户规则视为核验通过，
   * 但这【不等于】冲突消失——冲突字段原样列出，必须人工确认后才能算定稿。
   * 色调仍是「通过」，文案必须带「待人工确认」，不允许只显示绿色了事。 */
  verified_one_conflict: {
    key: 'verified_one_conflict', text: '题录已核验（1 项字段冲突待人工确认）', tone: 'ok', color: '绿色',
    desc: '题名一致且仅 1 个字段不一致，判定为核验通过，该字段仍需你确认'
  },
  conflict: {
    key: 'conflict', text: '题录字段冲突', tone: 'orange', color: '橙色',
    desc: '核心字段存在不一致'
  },
  multi_candidate: {
    key: 'multi_candidate', text: '多条匹配项，请人工甄别', tone: 'yellow', color: '黄色',
    desc: '返回多条候选记录，无法唯一锁定'
  },
  network_error: {
    key: 'network_error', text: '网络异常，核验中断', tone: 'gray', color: '灰色',
    desc: '接口超时 / 限流 / 网络报错'
  },
  not_indexed: {
    key: 'not_indexed', text: '公开元数据库未收录，可人工补充证据', tone: 'gray', color: '灰色',
    desc: '两个源均无检索结果'
  },
  /* ---- 通义千问联网检索兜底（任务 B）的两种结论 ----
   * 注意：即使千问回答 exists="yes"，也【只】标为「检索到线索，请人工甄别」，
   * 绝不升级为「题录已核验无误」——实测中模型会把同期刊同期的另一篇文章当成命中。 */
  ai_found: {
    key: 'ai_found', text: '千问联网检索到线索，请人工甄别', tone: 'yellow', color: '黄色',
    desc: '学术库未命中，改由通义千问联网检索，结果需你自行打开链接确认'
  },
  ai_not_found: {
    key: 'ai_not_found', text: '联网检索未找到，可人工补充证据', tone: 'gray', color: '灰色',
    desc: '学术库未命中，且通义千问联网检索也未找到对应记录'
  },
  /* 守卫态（不属于核验结论）：输入信息不足以做任何比对 */
  insufficient_input: {
    key: 'insufficient_input', text: '信息缺失，无法核验', tone: 'gray', color: '灰色',
    desc: '未填写任何可比对的题名 / 作者 / 年份 / 出处'
  }
};

function nowText() { return http.fmtTime(new Date()); }

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function nameOf(c) { return c.name; }

/* ==========================================================================
 *  输入预处理
 * ========================================================================== */

function takeInput(ref) {
  ref = ref || {};
  return {
    doi: T.normalizeDoi(ref.doi),
    title: T.trim(ref.title),
    authors: T.trim(ref.authors),
    year: T.trim(ref.year),
    venue: T.trim(ref.venue)
  };
}

/** 是否有任何一个可比对字段 */
function hasComparable(input) {
  return !!(input.title || input.authors || input.year || input.venue);
}

/**
 * 中文预判：题名/作者/出处任一含中日韩字符 → 直接进人工核验分支，
 * 不重复消耗两个境外数据源（需求 七.5）
 */
function chineseSignals(input) {
  var hits = [];
  if (T.hasCjk(input.title)) hits.push('题名含中文');
  if (T.hasCjk(input.authors)) hits.push('作者含中文');
  if (T.hasCjk(input.venue)) hits.push('出处含中文');
  return hits;
}

/* ==========================================================================
 *  结果组装
 * ========================================================================== */

function packResult(o) {
  var st = STATUS[o.statusKey] || STATUS.network_error;
  return {
    ok: o.ok !== false,
    statusKey: st.key,
    statusText: st.text,
    statusDesc: st.desc,
    colorHint: st.color,
    tone: st.tone,
    label: o.label || st.text,
    reason: o.reason || '',
    provider: o.provider || null,
    sourceUrl: o.sourceUrl || '',
    landingUrl: o.landingUrl || '',
    apiUrl: o.apiUrl || '',
    fetchedAt: o.fetchedAt || nowText(),
    httpStatus: o.httpStatus || 0,
    method: o.method || '',
    query: o.query || '',
    /* 两段式检索里真正生效的那一段：'loose-title-search' / 'precise-field-search' */
    searchStrategy: o.searchStrategy || '',
    record: o.record || null,
    rawPayload: o.rawPayload || null,
    checks: o.checks || [],
    candidates: o.candidates || [],
    failure: o.failure || null,
    tried: o.tried || [],
    input: o.input,
    budgetMs: lastBudgetMs,
    /* 通义千问两个任务的留痕：任务 A 提取结果、任务 B 联网检索结论。
     * 与 OpenAlex / Crossref 的结果共用同一套外壳字段，前端无需改解析逻辑。 */
    aiExtract: o.aiExtract || null,
    aiSearch: o.aiSearch || null,
    /* 「题名一致 + 仅 1 项不一致」时：仍把冲突字段原样带出，交给人工确认 */
    conflictFields: o.conflictFields || [],
    needsHumanConfirm: !!o.needsHumanConfirm,
    engineVersion: ENGINE_VERSION,
    boundaryNotice: BOUNDARY_NOTICE
  };
}

/** 只保留必要字段返回前端，去掉体积庞大的 raw 引用 */
function slimRecord(rec) {
  if (!rec) return null;
  return {
    doi: rec.doi, title: rec.title, authors: rec.authorText,
    container: rec.container, publisher: rec.publisher, type: rec.type,
    yearIssued: rec.yearIssued, yearPrint: rec.yearPrint, yearOnline: rec.yearOnline,
    volume: rec.volume, issue: rec.issue, page: rec.page,
    /* 来源接口真的返回了摘要才有内容（Crossref 的 JATS / OpenAlex 的倒排索引还原），
     * 没有就是空字符串——核验成功后可一键补全到文献条目，用于课题适配的材料区。
     * abstractFrom：若命中源没给摘要、改由另一个源补取，这里记真实提供摘要的那个源。 */
    abstract: T.trim(rec.abstract),
    abstractFrom: T.trim(rec.abstractFrom),
    flags: rec.flags || null
  };
}

/** 原始返回留存：超出上限则截断并如实标注 */
function packRawPayload(provider, apiUrl, requestedAt, httpStatus, raw) {
  if (raw == null) return null;
  var full = '';
  var truncated = false;
  try {
    full = JSON.stringify(raw);
  } catch (e) {
    return {
      provider: provider ? provider.name : '', apiUrl: apiUrl, requestedAt: requestedAt,
      httpStatus: httpStatus, truncated: false, note: '原始返回无法序列化为 JSON', json: ''
    };
  }
  if (full.length > RAW_LIMIT) {
    full = full.slice(0, RAW_LIMIT);
    truncated = true;
  }
  return {
    provider: provider ? provider.name : '',
    apiUrl: apiUrl,
    requestedAt: requestedAt,
    httpStatus: httpStatus,
    truncated: truncated,
    note: truncated ? ('原始返回过长，已截断保留前 ' + RAW_LIMIT + ' 字符（完整内容以来源链接为准）') : '完整原始返回',
    json: full
  };
}

/** 单次尝试的日志条目（不含大体积原始内容） */
function logEntry(src, method, stageLabel) {
  return {
    providerId: src && src.provider ? src.provider.id : '',
    providerName: src && src.provider ? src.provider.name : '',
    method: method,
    /* 本次实际发出去的检索词 / 字段组合，便于在云端日志与前端留痕里核对 */
    query: src ? (src.query || '') : '',
    traces: src ? (src.traces || null) : null,
    stageLabel: stageLabel || STAGE_LABEL[method] || '',
    apiUrl: src ? (src.apiUrl || '') : '',
    requestedAt: src ? (src.requestedAt || nowText()) : nowText(),
    httpStatus: src ? (src.httpStatus || 0) : 0,
    ms: src && typeof src.ms === 'number' ? src.ms : 0,
    ok: !!(src && src.ok),
    failureKind: src ? (src.failureKind || null) : 'network',
    failureDetail: src ? (src.failureDetail || '') : '',
    bodySnippet: src ? (src.bodySnippet || '') : ''
  };
}

var FAILURE_LABEL = {
  timeout: '请求超时',
  network: '网络请求失败',
  ratelimit: '接口限流 / 配额耗尽',
  http_error: '接口返回异常状态码',
  parse: '返回内容无法解析',
  not_found: '该来源未收录',
  cloud_unavailable: '云函数不可用',
  budget_exhausted: '云函数执行时间预算耗尽（未发起请求）',
  config: '未配置（云函数环境变量缺失）',
  /* AMiner 专用：Token 无效 / 过期。接口把鉴权失败包在 HTTP 500 里返回
   * （code=40308 "Get Authorization Error"），因此必须按响应体判定，
   * 文案里直接给出「去控制台重新生成 Token 并更新 AMINER_TOKEN」的指引。 */
  auth_failed: 'AMiner Token 鉴权失败（无效或已过期）',
  unsupported: '该来源不支持这种查询方式',
  /* 「按检索顺序主动跳过」与「该来源未收录」是两回事：
   * 前者是我们没去查（比如中文题名不请求境外源），后者是查了确实没有。
   * 混用会让留痕里出现「（未请求境外数据源）：该来源未收录」这种自相矛盾的话。 */
  skipped: '按检索顺序未请求（能力边界 / 语言判断）',
  input: '输入为空'
};

/* ==========================================================================
 *  精确记录（DOI 命中）→ 逐字段比对
 * ========================================================================== */

function buildExact(input, src, method, tried) {
  var rec = src.record;
  var providerName = src.provider.name;
  var checks = compare.compareFields(input, rec, providerName);
  var s = compare.summarize(checks);

  var statusKey, label, reason;

  /* ---- 「题名一致 + 只有一处不一致」的宽容规则 ----
   * 规则来自用户的明确要求：题名必须一致，且不一致项恰好 1 项时，
   * 视为核验通过（不再整条判为冲突），但冲突字段【原样列出】并标记需人工确认。
   * 两处及以上不一致、或题名本身不一致 → 维持「题录字段冲突」，不套用宽容规则。
   * 被撤稿的记录不套用宽容规则：撤稿是来源给出的确定事实，不能因为只差一个字段就放行。 */
  var titleCheck = null;
  for (var ci = 0; ci < checks.length; ci++) if (checks[ci].key === 'title') titleCheck = checks[ci];
  var titleMatched = !!(titleCheck && titleCheck.verdict === 'match');
  var conflictChecks = s.mismatch.concat(s.yearAmbiguous).concat(s.weak);
  var retracted = !!(rec && rec.flags && rec.flags.isRetracted);

  /* 冲突字段明细：双方取值都给出，便于人工确认时直接对照 */
  function conflictDetailOf(list) {
    return list.map(function (c) {
      return {
        key: c.key, name: c.name, verdict: c.verdict,
        input: c.input || '', record: c.record || '', note: c.note || ''
      };
    });
  }

  if (titleMatched && conflictChecks.length === 1 && !retracted) {
    var only = conflictChecks[0];
    statusKey = 'verified_one_conflict';
    label = '题录已核验（1 项字段冲突待人工确认）';
    reason = '「' + providerName + '」存在该 DOI 记录，题名完全一致，' +
      '只有「' + only.name + '」这一项与你填写的内容不一致' +
      '（你填：' + (only.input || '（空）') + '；来源记录：' + (only.record || '（空）') + '）。' +
      '按你设定的规则（题名一致且仅 1 处不一致）本次【判定为核验通过】，' +
      '但这【不等于】该差异已消解——请回原文或期刊官网核对这一项，并在核验卡里点「我已核对该差异」完成人工确认。' +
      '注意：这只能说明【题录信息】基本对得上，不代表内容结论已被核实。';
  } else if (s.mismatch.length) {
    statusKey = 'conflict';
    label = '题录字段冲突（' + s.mismatch.length + ' 项明显不一致）';
    reason = '已在「' + providerName + '」查到这条 DOI 的记录，但你填写的内容与它有 ' +
      s.mismatch.length + ' 项不一致：' + s.mismatch.map(nameOf).join('、') +
      '。可能是题录录错了，也可能你手上的根本是另一篇。请逐项核对后再决定是否引用。';
  } else if (s.yearAmbiguous.length) {
    statusKey = 'conflict';
    label = '题录字段冲突（年份取值需人工复核）';
    reason = '已查到记录，题名/作者/出处均无冲突，但年份对不上：' +
      '你填写的是「' + input.year + '」，来源记录的实际取值为「' +
      s.yearAmbiguous[0].record + '」。' +
      '该来源存在多个不同年份取值（在线预发表 vs 印刷卷期，常跨年），全部取值已列在下方可供复核，' +
      '请你按正式卷期页确认后自行判断，系统不替你下结论。';
  } else if (s.weak.length) {
    statusKey = 'conflict';
    label = '题录字段冲突（' + s.weak.length + ' 项需人工核对）';
    reason = '已查到记录且没有明显冲突，但有 ' + s.weak.length +
      ' 项只是「部分相近」或需要你复核：' + s.weak.map(nameOf).join('、') +
      '。详见下方逐字段比对，请回原文核对后再确认。';
  } else if (!s.match.length) {
    statusKey = 'insufficient_input';
    label = '信息缺失，无法核验';
    reason = '已取到来源记录，但你没有填写任何可比对的题名 / 作者 / 年份 / 出处，' +
      '因此无法给出题录一致性结论。这不代表文献有问题，请补全字段后再核验。';
  } else {
    statusKey = 'verified';
    label = '题录已核验无误';
    reason = '「' + providerName + '」存在该 DOI 记录，且所有可比对的核心字段与你填写的内容一致。' +
      '注意：这只能说明【题录信息】对得上，不代表内容结论已被核实。';
  }

  if (s.missing.length && statusKey !== 'insufficient_input') {
    var missNames = s.missing.map(nameOf).join('、');
    reason += '另有 ' + s.missing.length + ' 个字段因「你没填」或「来源记录没有」而未参与比对（' +
      missNames + '），这些既不构成一致也不构成冲突，系统【不会】自动补全。';
  }

  // 撤稿标记：这是来源给出的真实状态，必须呈现
  if (rec && rec.flags && rec.flags.isRetracted) {
    reason += '［重要］来源标记该文献【已被撤稿】，请务必先核实撤稿原因再决定是否引用。';
  }

  return packResult({
    ok: true,
    statusKey: statusKey,
    label: label,
    reason: reason,
    provider: src.provider,
    sourceUrl: rec.url || (rec.doi ? 'https://doi.org/' + rec.doi : ''),
    landingUrl: rec.landing || '',
    apiUrl: src.apiUrl,
    fetchedAt: src.requestedAt,
    httpStatus: src.httpStatus,
    method: method,
    record: slimRecord(rec),
    rawPayload: packRawPayload(src.provider, src.apiUrl, src.requestedAt, src.httpStatus, src.raw),
    checks: checks,
    /* 宽容规则下也要把冲突项带出来：判定通过 ≠ 差异消失 */
    conflictFields: conflictDetailOf(conflictChecks),
    needsHumanConfirm: statusKey === 'verified_one_conflict',
    tried: tried,
    input: input
  });
}

/* ==========================================================================
 *  候选列表（无 DOI / DOI 未命中后检索）
 * ========================================================================== */

/**
 * 「这条记录够不够格当候选」的统一判定。
 * 两段式检索的【第一段要不要补第二段】、以及最终候选列表，用的是【同一套】标准，
 * 不会出现「宽松阶段说没有合格候选、最后却又列出候选」这种自相矛盾的情况。
 */
function isQualified(input, rec) {
  var ts = input.title ? T.titleSim(input.title, rec.title) : 0;
  if (ts >= MIN_CANDIDATE_TITLE_SIM) return true;
  var yBool = 0;
  if (input.year && (input.year === rec.yearIssued || input.year === rec.yearPrint || input.year === rec.yearOnline)) {
    yBool = 1;
  }
  if (!yBool) return false;
  var au = input.authors ? T.authorSim(input.authors, rec.authorItems) : { score: 0 };
  return au.score >= MIN_CANDIDATE_AUTHOR_SIM;
}

/** 某个源的返回结果里，有多少条够格当候选 */
function countQualified(input, src) {
  var recs = src && src.records ? src.records : [];
  var n = 0;
  for (var i = 0; i < recs.length; i++) {
    if (isQualified(input, recs[i])) n++;
  }
  return n;
}

/**
 * 候选列表（无 DOI / DOI 未命中后检索）。
 *
 * @param {object} stage 本次真正生效的检索阶段信息
 *   { method: 'loose-title-search' | 'precise-field-search', trail: ['宽松检索：返回 5 条…'] }
 *   trail 用来在结论里说明「宽松没合格、又补了一次精确」，不让用户以为漏查了。
 */
function buildCandidates(input, src, tried, extraReason, stage) {
    var recs = src.records || [];
    var providerName = src.provider.name;
    var list = [];
    var weakSeen = 0;   // 因「太不像」被剔除的记录数（如实告诉用户，不悄悄丢掉）
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i];
      var ts = input.title ? T.titleSim(input.title, rec.title) : 0;
      var au = input.authors ? T.authorSim(input.authors, rec.authorItems) : { score: 0 };
      var yBool = 0;
      if (input.year && (input.year === rec.yearIssued || input.year === rec.yearPrint || input.year === rec.yearOnline)) {
        yBool = 1;
      }
      var vs = (input.venue && rec.container) ? T.titleSim(input.venue, rec.container) : 0;
      var score = ts * 0.55 + au.score * 0.2 + yBool * 0.15 + vs * 0.1;
      /* 是否够格当候选：题名有点像，或「作者 + 年份」都对得上 */
      if (!isQualified(input, rec)) { weakSeen++; continue; }
      list.push({
        index: i,
      doi: rec.doi,
      title: rec.title || '（该记录无题名字段）',
      authors: rec.authorText || '（该记录无作者字段）',
      container: rec.container || '（该记录无期刊字段）',
      publisher: rec.publisher,
      yearIssued: rec.yearIssued, yearPrint: rec.yearPrint, yearOnline: rec.yearOnline,
      url: rec.url,
      /* 候选项带上来源返回的【真实】摘要与来源 id：
       * 用户在候选列表里选定一条后，这条摘要可直接作为补全材料，
       * 不用再为「拿不到摘要」发愁。来源没给就是空字符串，不生成。 */
      abstract: T.trim(rec.abstract).slice(0, 800),
      abstractFrom: T.trim(rec.abstractFrom) || (T.trim(rec.abstract) ? providerName : ''),
      sourceId: (src.provider && src.provider.id) || '',
      /* AMiner 的记录只有内部 id（论文信息接口只接受 id），
       * 选定后要靠它做精确核验，所以必须随候选带回前端。 */
      aminerId: rec.aminerId || '',
      sim: {
        title: round2(ts), authors: round2(au.score), year: yBool,
        venue: round2(vs), overall: round2(score)
      }
    });
  }
  list.sort(function (a, b) { return b.sim.overall - a.sim.overall; });
  for (var r = 0; r < list.length; r++) list[r].rank = r + 1;
  if (list.length > MAX_CANDIDATES) list = list.slice(0, MAX_CANDIDATES);

  /* 相似度门槛：见 MIN_CANDIDATE_TITLE_SIM 处的说明。
   * 被剔除的记录数要如实写出来——不能悄悄把接口返回的东西丢掉。 */
  var statusKey, label, reason;
  if (!list.length) {
    statusKey = 'not_indexed';
    label = '公开元数据库未收录，可人工补充证据';
    reason = '已按题名等字段在「' + providerName + '」检索，' +
      (weakSeen
        ? '接口返回了 ' + weakSeen + ' 条记录，但题名相似度都低于 ' +
          Math.round(MIN_CANDIDATE_TITLE_SIM * 100) + '%、作者与年份也对不上，' +
          '没有一条像同一篇，因此判定为【本来源未收录】，不列为候选。'
        : '没有找到任何候选记录。') +
      '这【不等于】该文献不存在，只是本来源没有收录。请通过人工补证（期刊官网、知网、万方、学校图书馆数据库）核对。';
  } else {
    statusKey = 'multi_candidate';
    label = '多条匹配项，请人工甄别（' + list.length + ' 条）';
    reason = '没有 DOI，已按题名等字段在「' + providerName + '」检索到 ' + list.length + ' 条候选。' +
      (weakSeen ? '（另有 ' + weakSeen + ' 条题名与作者年份都对不上，已剔除，不计入候选。）' : '') +
      '实测表明：即使标题完全一样，排在第一的也可能是另一篇（如同名评论文章），' +
      '因此【不会自动替你认定任何一条】。请比对手上的原文后点选对应条目；' +
      '若都不对，说明本来源可能没收录，请人工补证。';
  }
  if (extraReason) reason = extraReason + ' ' + reason;
  /* 两段式的尝试过程要如实讲清楚：先宽松后精确，各自返回了几条、筛掉了几条。 */
  if (stage && stage.trail && stage.trail.length) {
    reason += '\n本次检索过程：' + stage.trail.join('；') + '。';
  }

  return packResult({
    ok: true,
    statusKey: statusKey,
    label: label,
    reason: reason,
    provider: src.provider,
    sourceUrl: '',
    apiUrl: src.apiUrl,
    fetchedAt: src.requestedAt,
    httpStatus: src.httpStatus,
    method: (stage && stage.method) || 'bibliographic-search',
    query: src.query || '',
    searchStrategy: (stage && stage.method) || '',
    record: null,
    rawPayload: packRawPayload(src.provider, src.apiUrl, src.requestedAt, src.httpStatus, src.raw),
    candidates: list,
    tried: tried,
    input: input
  });
}

/* ==========================================================================
 *  网络异常（如实报错，不伪造）
 * ========================================================================== */

function buildNetworkError(input, tried) {
  var lines = [];
  for (var i = 0; i < tried.length; i++) {
    var t = tried[i];
    lines.push('· ' + (t.providerName || '未知来源') + '：' +
      (FAILURE_LABEL[t.failureKind] || '异常') +
      (t.httpStatus ? '（HTTP ' + t.httpStatus + '）' : '') +
      (t.failureDetail ? '｜' + t.failureDetail : '') +
      '｜请求时间 ' + t.requestedAt);
  }
  /* AMiner Token 鉴权失败时，「网络异常」这个说法会误导用户去查网络，
   * 实际上要改的是 Token。这里把这条提示提到最前面。 */
  var authNote = '';
  for (var k = 0; k < tried.length; k++) {
    if (tried[k] && tried[k].failureKind === 'auth_failed') {
      authNote = '【AMiner Token 鉴权失败】' + (tried[k].failureDetail || '') + '\n\n';
      break;
    }
  }
  var reason = authNote + '本次自动核验因网络 / 接口侧原因中断，【未得出任何题录结论】。' +
    '这与该文献是否存在无关，请稍后重试或进行人工补证。\n已尝试的数据源：\n' +
    (lines.join('\n') || '（无）');

  return packResult({
    ok: false,
    statusKey: 'network_error',
    label: '网络异常，核验中断',
    reason: reason,
    provider: null,
    method: (tried[0] && tried[0].method) || 'doi-exact',
    record: null,
    failure: {
      kind: (tried[0] && tried[0].failureKind) || 'network',
      detail: (tried[0] && tried[0].failureDetail) || ''
    },
    tried: tried,
    input: input
  });
}

function buildNotIndexed(input, tried, hint) {
  var names = tried.map(function (t) { return t.providerName; }).filter(Boolean).join('、') || '（无）';
  /* 来源数量随实际尝试情况变化（现在可能有 AMiner），不再写死「两个」 */
  var reason = '已尝试的数据源都没有检索到这条文献的记录（已尝试：' + names + '）。' +
    '这【不等于】该文献不存在——' + (hint || '可能只是未被这些数据库收录') + '。请通过人工补证核对。';

  return packResult({
    ok: true,
    statusKey: 'not_indexed',
    label: '公开元数据库未收录，可人工补充证据',
    reason: reason,
    provider: null,
    method: (tried[0] && tried[0].method) || 'skip',
    record: null,
    tried: tried,
    input: input
  });
}

/* ==========================================================================
 *  主流程
 * ========================================================================== */

/* ==========================================================================
 *  通义千问两个任务的留痕 / 结果组装
 * ========================================================================== */

/** 任务 A 的留痕：记录模型、耗时、提取到的字段，以及「哪些字段是它补的」 */
function packAiExtract(ex, rawText) {
  var f = ex.fields || null;
  return {
    ok: !!ex.ok,
    configured: true,
    model: ex.model || '',
    requestedAt: ex.requestedAt || '',
    httpStatus: ex.httpStatus || 0,
    ms: ex.ms || 0,
    failureKind: ex.failureKind || null,
    failureDetail: ex.failureDetail || '',
    fields: f ? {
      title: f.title, titleOrig: f.titleOrig,
      authors: f.authors, authorsText: f.authorsText,
      year: f.year, venue: f.venue, doi: f.doi,
      volume: f.volume, issue: f.issue, pages: f.pages, isbn: f.isbn,
      lang: f.lang, confidence: f.confidence
    } : null,
    rawTextSnippet: String(rawText || '').slice(0, 300),
    note: ex.ok
      ? '已用通义千问清洗原始文本：你【已填写】的字段保持原值不动，' +
        '【空缺】的字段由提取结果补齐；检索 OpenAlex / Crossref 时优先使用清洗后的英文题名。'
      : '通义千问结构化提取未成功（' + (FAILURE_LABEL[ex.failureKind] || ex.failureKind || '异常') +
        '），本次直接使用你填写的字段去检索，未做任何补全。'
  };
}

/**
 * 用任务 A 的结果补齐空缺字段。
 * 关键：只补【空】的，绝不覆盖用户自己填的值；
 * 检索用的 searchInput 则优先采用清洗 / 英译后的题名，以提高学术库命中率。
 */
function applyExtract(userInput, searchInput, f) {
  if (!userInput.doi && f.doi) userInput.doi = f.doi;
  if (!userInput.title && f.title) userInput.title = f.title;
  if (!userInput.authors && f.authorsText) userInput.authors = f.authorsText;
  if (!userInput.year && f.year) userInput.year = f.year;
  if (!userInput.venue && f.venue) userInput.venue = f.venue;

  searchInput.doi = userInput.doi;
  searchInput.title = f.title || userInput.title;
  searchInput.authors = f.authorsText || userInput.authors;
  searchInput.year = f.year || userInput.year;
  searchInput.venue = f.venue || userInput.venue;
}

var AI_LINK_KIND = {
  openalex: 'OpenAlex', crossref: 'Crossref', publisher: '出版社 / 期刊官网',
  official: '期刊 / 出版方官网', repository: '仓储 / 机构库',
  cnki: '知网', wanfang: '万方', scholar: '学术检索平台', other: '其他来源'
};

/* 任务 B 的三种结果状态文案（与 sources/qwen.js 保持一致） */
var OUTCOME_TEXT = qwen.OUTCOME_TEXT;

/* 链接可访问性探测结果的用户可读文案（与 sources/qwen.js 的 PROBE_TEXT 保持一致） */
var PROBE_TEXT = {
  ok: '已实测可访问',
  not_found: '实测 404，链接无效（已丢弃）',
  unverified: '未能确认（站点拦截或临时故障）',
  timeout: '未能确认（超时）',
  network: '未能确认（网络不通）',
  skipped: '未做可访问性探测（时间不足）'
};

function probeTextOf(l) {
  var p = l && l.probe;
  if (!p) return '未探测';
  var s = PROBE_TEXT[p.kind] || '未探测';
  if (p.status) s += '（HTTP ' + p.status + '）';
  return s;
}

/**
 * 任务 B（联网检索兜底）的结果组装。
 * 结构与其他数据源完全一致（statusKey / statusText / tone / checks / candidates / tried / rawPayload），
 * 因此前端解析逻辑无需改动。
 */
function buildAiSearchResult(input, ai, tried, prefixReason) {
  var v = ai.verdict || {};
  /* ------------------------------------------------------------------
   * 结果解耦（2026-11-01 改）：「查到什么」与「链接能不能打开」互不依赖
   *   recordMeta     —— 本次搜索摘要里的题录，拿到可信摘要就输出
   *   candidateLinks —— 沿用四层机器校验 + 真机可达性探测的候选链接
   * 因此 statusKey 【只看有没有拿到可信题录】，不再由链接探测结果决定。
   * 旧实现的缺陷：链接全被判无效时，明明搜到的题名/作者/年份/DOI/摘要被一起丢掉，
   * 页面只能显示「未检索到」——那是无中生有的损失。
   * ------------------------------------------------------------------ */
  var links = v.candidateLinks || [];
  var rm = v.recordMeta || {};
  var hasRecord = !!(rm && rm.credible);
  var outcome = v.outcome || (hasRecord ? (links.length ? 'record_and_link' : 'record_only') : 'no_clue');
  var exists = v.exists || 'uncertain';
  /* linkStatus 只描述「链接」本身，不参与是否存在文献的判定 */
  var linkStatus = links.length ? 'ok' : 'url_not_found';
  var found = hasRecord;

  var statusKey = found ? 'ai_found' : 'ai_not_found';
  var label, reason;

  if (found) {
    label = (rm.exists === 'yes') ? '千问联网检索到记录，请人工甄别' : '千问检索到间接线索，请人工甄别';
    if (!links.length) label += '（本次没有可稳定访问的原文链接）';

    reason = 'OpenAlex / Crossref / AMiner 都没有命中，已改由通义千问联网检索。模型回答：' +
      (rm.existsText || '未给出判定') + '。' +
      (rm.declaredSummary ? '模型给出的依据：' + rm.declaredSummary + ' ' : '');

    if (rm.partialRecovery) {
      reason += '【说明】本次模型的回答被长度截断，下面这段题录是从截断输出里抢救出来的部分字段，' +
        '可能不完整，请自行核对后再用。';
    }

    if (links.length) {
      reason += '【重要】这是大模型的联网检索结果，【不等于】权威数据库核验：' +
        '实测中模型曾把同一期刊同一期里的另一篇文章当成命中，' +
        '给出的链接也有不少是拼出来的。' +
        '本次链接已做过两道机器校验（① 必须能说清来自哪个站点且是详情页形态；' +
        '② 真去访问一次，服务器明确返回 404/410 的直接丢弃），' +
        '但「打不开」和「内容已核实」完全是两回事——' +
        '请逐条打开自行确认题名、作者、年份、卷期是否与你手上的完全一致，' +
        '确认后再在「人工确认」里给出你的结论——本系统不会据此判定「已核实」。';
      var unverified = links.filter(function (l) { return l.probeState !== 'ok'; }).length;
      if (unverified) {
        reason += '（其中 ' + unverified + ' 条本次未能确认连通性——站点拦截 / 超时 / 网络故障都可能，' +
          '保留在下面但标注「暂无法验证连通性」，不要当成已验证链接。）';
      }
    } else {
      reason += '【本次检索未找到可稳定访问的原文链接】这【不影响】上面的题录结论：' +
        '本次搜索确实查到了这条文献的题录信息并已完整展示在核验卡上，只是没能留下一个可通过校验的详情页链接' +
        '（说不清来源的、被机器判定为拼凑的、明确 404/410 的都已被丢弃），' +
        '因此这里标记 url_not_found，而不是把这条文献判成「未检索到」。' +
        '请按下面的题名 / 作者 / 年份 / DOI 自行去知网、万方、学校图书馆数据库核对。';
    }
  } else {
    label = '联网检索未找到，可人工补充证据';
    reason = 'OpenAlex / Crossref / AMiner 都没有命中，通义千问联网检索后也【没有形成可用题录】' +
      (rm.reason ? '（' + rm.reason + '）' : '') + '。' +
      (v.summary ? '模型说明：' + v.summary + ' ' : '') +
      '这【不等于】该文献虚假——中文文献、学位论文、书籍、预印本本来就很少被境外数据库收录，' +
      '联网检索本身也有覆盖盲区。请用期刊官网、知网、万方或学校图书馆数据库人工核对，' +
      '并把证据填进「人工补证」。';
  }

  if (rm.confidence != null) {
    reason += '（模型自评把握度 ' + rm.confidence + '，仅作参考，不作为结论依据。）';
  }

  var cands = [];
  for (var i = 0; i < links.length; i++) {
    cands.push({
      index: i,
      doi: v.doi || '',
      title: v.title || (links[i].note || links[i].url),
      authors: v.authorsText || '',
      /* container 优先显示「这个链接来自哪个来源」，让用户一眼知道点的是什么站 */
      container: links[i].source || v.venue || AI_LINK_KIND[links[i].kind] || '其他来源',
      source: links[i].source || '',
      /* 真实访问过一次的结论（可访问 / 未能确认），让卡片上就能看出链接靠不靠谱 */
      probeText: links[i].probe ? probeTextOf(links[i]) : '未探测',
      publisher: '',
      yearIssued: v.year || '', yearPrint: '', yearOnline: '',
      url: links[i].url,
      /* sim 置空：大模型给的链接没有可比对的相似度分数，
       * 与其编一个数字不如留空，避免用户误以为排第一就是最像的。 */
      sim: null
    });
  }

  return packResult({
    ok: true,
    statusKey: statusKey,
    label: label,
    reason: (prefixReason ? prefixReason + ' ' : '') + reason,
    provider: qwen.PROVIDER,
    sourceUrl: links.length ? links[0].url
      : ((rm.doi || v.doi) ? ('https://doi.org/' + (rm.doi || v.doi)) : ''),
    apiUrl: ai.apiUrl,
    fetchedAt: ai.requestedAt,
    httpStatus: ai.httpStatus,
    method: 'ai-web-search',
    record: null,
    rawPayload: packRawPayload(qwen.PROVIDER, ai.apiUrl, ai.requestedAt, ai.httpStatus, ai.raw),
    candidates: cands,
    tried: tried,
    input: input,
    aiSearch: {
      exists: exists,
      existsText: exists === 'yes' ? '检索到明确对应记录'
        : (exists === 'no' ? '未检索到' : '只有间接线索，无法确认'),
      summary: v.summary || '',
      confidence: (v.confidence == null ? null : v.confidence),
      model: ai.model || '',
      /* 若因剩余时间不足而降级到更快的模型，如实标注出来 */
      modelFallback: ai.modelFallback || '',
      requestedAt: ai.requestedAt || '',
      ms: ai.ms || 0,
      /* 是否真的触发了联网搜索（来自 usage.plugins.search），是「不是凭记忆作答」的证据 */
      searched: !!ai.searched,
      searchCount: ai.searchCount || 0,
      usage: ai.usage || null,
      doi: v.doi || '', year: v.year || '', venue: v.venue || '',
      title: v.title || '', authors: v.authors || [],
      /* ---- ① recordMeta：本次搜索摘要里提取到的题录（【不】依赖链接探测结果） ---- */
      recordMeta: {
        credible: hasRecord,
        /* 不可信时说明原因：例如「没触发联网检索」「模型判没找到」「摘要里没有可核对字段」 */
        reason: rm.reason || '',
        /* 模型输出被截断后抢救出来的部分字段（如实标注，不假装完整） */
        partialRecovery: !!rm.partialRecovery,
        exists: rm.exists || '',
        existsText: rm.existsText || '',
        title: rm.title || '',
        authors: rm.authors || [],
        authorsText: rm.authorsText || '',
        year: rm.year || '',
        doi: rm.doi || '',
        venue: rm.venue || '',
        abstract: rm.abstract || '',
        hasAbstract: !!rm.abstract,
        abstractTruncated: !!rm.abstractTruncated,
        sourceName: rm.sourceName || '',
        declaredSummary: rm.declaredSummary || '',
        confidence: (rm.confidence == null ? null : rm.confidence),
        /* 本次没拿到的字段，如实列出——缺失就是缺失，系统不补造 */
        fieldsAbsent: rm.fieldsAbsent || [],
        fieldsAbsentText: (rm.fieldsAbsent || []).join('、'),
        hasFieldsAbsent: (rm.fieldsAbsent || []).length > 0
      },
      hasRecordMeta: hasRecord,

      /* ---- ② candidateLinks：沿用四层机器校验 + 真机可达性探测 ---- */
      candidateLinks: links.map(function (l) {
        var st = l.probeState || (l.probe && l.probe.kind === 'ok' ? 'ok' : 'unverified');
        return {
          url: l.url, source: l.source || '', kind: l.kind, note: l.note || '',
          probeText: probeTextOf(l),
          probeStatus: (l.probe && l.probe.status) || 0,
          reachable: st === 'ok',
          /* ok = 主展示区可放心用；unverified = 保留展示但标「暂无法验证连通性」 */
          probeState: st,
          probeStateText: (st === 'ok') ? '已实测可访问' : '暂无法验证连通性'
        };
      }),
      hasLinks: links.length > 0,

      /* ---- ③ 折叠区：本次搜索返回的原始候选链接（【没有】做可达性探测） ---- */
      rawCandidateLinks: (v.rawCandidateLinks || []).map(function (s) {
        return {
          name: s.name || '', url: s.url || '',
          inMain: !!s.inMain, dropReason: s.dropReason || ''
        };
      }),
      hasRawCandidateLinks: (v.rawCandidateLinks || []).length > 0,

      /* 三种结果状态：record_and_link / record_only / no_clue */
      outcome: outcome,
      outcomeText: OUTCOME_TEXT[outcome] || outcome,

      /* 是否真的逐条访问过这些链接（没有就是没验过，不谎称验过） */
      probed: !!v.probed,
      probeSkippedReason: v.probeSkippedReason || '',
      /* 链路自身是否曾被输出截断抢救过 */
      truncatedRecovery: !!ai.truncatedRecovery,
      /* 链接治理结果：ok = 有通过校验的链接；url_not_found = 一条都没有。
       * 【注意】它只描述链接，不再决定「有没有查到这条文献」。 */
      linkStatus: linkStatus,
      linkStatusText: linkStatus === 'ok'
        ? ('有 ' + links.length + ' 条通过校验的来源链接')
        : '本次检索未找到可稳定访问的原文链接（文献题录见上方，不代表未检索到）',
      /* 模型声明「本次检索命中」的来源清单（不是平台证据，只是模型自述，供人工对照） */
      sources: v.sources || [],
      /* 每条输出链接的校验明细：保留 / 丢弃 + 原因，方便排查「为什么那条链接不见了」 */
      linkAudit: v.linkAudit || []
    }
  });
}

/**
 * 核验一条文献（串行三步）。
 *   ① 任务A 千问提取清洗 → ② OpenAlex / Crossref → ③ 未命中或中文 → 任务B 千问联网检索
 *
 * @param {object} ref {raw, doi, title, authors, year, venue}
 * @param {object} opt {timeout, allowSearch, aiExtract, aiSearch, timeBudgetMs}
 */
async function verifyOne(ref, opt) {
  opt = opt || {};
  var refObj = ref || {};
  var input = takeInput(refObj);                 // 比对基线：用户自己填的
  var rawText = T.trim(refObj.raw);              // 用户粘贴的原文（任务 A 的输入）
  var tried = [];
  var timeout = opt.timeout || TIMEOUT_MS;
  var budget = opt.timeBudgetMs || TIME_BUDGET_MS;
  /* 自适应：以「平台剩余执行时间 - 预留」为准，取两者较小值。
   * 这样即使把云函数超时调到 20 秒，也不会因为预算写死而浪费；
   * 反之在默认 3 秒环境下也不会被平台硬超时杀掉。 */
  var platRemain = platformRemainingMs();
  if (platRemain !== Infinity) {
    budget = Math.max(0, Math.min(budget, platRemain - PLATFORM_RESERVE_MS));
  }
  var deadline = Date.now() + budget;
  lastBudgetMs = budget;

  /* ---- 时间预算：防止被云函数平台执行超时硬杀 ---- */
  function remainMs() { return deadline - Date.now(); }
  function canTry(min) { return remainMs() >= (min || MIN_NEED_MS); }
  /** 单次请求超时 = min(段级上限, 该段 deadline 的剩余时间 - 余量) */
  function reqTimeout(dl, cap) {
    var left = (dl || deadline) - Date.now() - 150;
    return Math.max(600, Math.min(cap || timeout, left));
  }
  function stepTimeout(cap) { return Math.max(600, Math.min(cap, reqTimeout())); }
  /**
   * 任务 B 的超时：不受「单源超时 TIMEOUT_MS」钳制（联网检索本身就慢），
   * 而是按剩余时间动态收敛，并给结果组装留 1.2s 余量。
   * 返回 0 表示剩余时间已经不够，调用方应如实跳过而不是硬发请求。
   */
  function aiSearchTimeout() {
    var v = Math.min(AI_SEARCH_TIMEOUT_MS, remainMs() - 1200);
    return v >= 1500 ? v : 0;
  }

  var aiExtractInfo = null;
  var searchInput = {
    doi: input.doi, title: input.title,
    authors: input.authors, year: input.year, venue: input.venue
  };

  /* 中文信号必须在「任务A 补字段之前」判定，
   * 否则提取出的英文译名会把中文文献伪装成英文文献，白白消耗两个境外源。 */
  var cjkHits = chineseSignals(input);
  var userFilledTitle = !!input.title;
  var rawIsZh = !!T.hasCjk(rawText);

  /* 返回 null 表示「因时间预算不足而未发起请求」，调用方必须如实处理，
   * 绝不能当成「该源没有收录」来用。 */
  function budgetEntry(method) {
    return {
      providerId: 'none',
      providerName: '（因云函数时间预算不足未发起）',
      method: method, apiUrl: '', requestedAt: nowText(), httpStatus: 0,
      ok: false, ms: 0,
      failureKind: 'budget_exhausted',
      failureDetail: '本函数累计已用 ' + (budget - remainMs()) + 'ms，剩余 ' + remainMs() +
        'ms，不足以再完成一次请求，因此未发起。' +
        '可在云开发控制台把 lfaVerify 的「执行超时时间」调大到 20 秒。',
      bodySnippet: ''
    };
  }

  /**
   * 分段预算：AMiner 这一段有自己的 wall-clock 额度，且不许吃掉给千问留的那份。
   * 返回 { deadline, reqTimeoutMs }，直接透传给 trySource / searchOneSource。
   * 千问不可用（未配置 / 本次禁用）时，QWEN_RESERVE_MS 立即释放给 AMiner。
   */
  var needQwenLater = (opt.aiSearch !== false) && qwen.available();
  function aminerSegmentOpt() {
    var now = Date.now();
    var cap = deadline;
    if (needQwenLater) cap = Math.min(cap, deadline - QWEN_RESERVE_MS);
    var dl = Math.min(now + AMINER_SEGMENT_MS, cap);
    /* 兜底：连一次请求的时间都挤不出来时，至少给一次完整请求的时间 */
    if (dl - now < MIN_NEED_MS) dl = Math.min(now + AMINER_REQ_TIMEOUT_MS + 500, deadline);
    return { deadline: dl, reqTimeoutMs: AMINER_REQ_TIMEOUT_MS };
  }

  function trySource(source, method, arg, opt2) {
    var o = opt2 || {};
    var dl = o.deadline || deadline;
    if ((dl - Date.now()) < MIN_NEED_MS) {
      tried.push(budgetEntry(method));
      return Promise.resolve(null);
    }
    var t0 = Date.now();
    /* deadline 下传给数据源：像 AMiner 这种「一次检索内部要发多个请求」的源，
     * 靠它把每个子请求的超时收敛到剩余预算内，避免整体被平台硬超时杀掉。 */
    return source(arg, {
      timeout: reqTimeout(dl, o.reqTimeoutMs),
      limit: FETCH_LIMIT, deadline: dl
    }).then(function (r) {
      r.ms = Date.now() - t0;
      tried.push(logEntry(r, method));
      return r;
    });
  }

  function isNotFound(r) { return !r.ok && r.failureKind === 'not_found'; }

  /**
   * 摘要补取（只为「补全文献信息」服务，不改变任何核验结论）。
   * 命中源没有返回摘要时，若时间预算允许，再用另一个源按同一个 DOI 查一次，
   * 只取摘要字段——题录比对用的仍是【命中的那个源】的记录，绝不混用。
   * 两个源都没有摘要就是没有，如实留空，不生成、不推测。
   */
  async function topUpAbstract(src) {
    var rec = src && src.record;
    if (!rec || T.trim(rec.abstract)) return src;
    var doi = rec.doi || input.doi;
    if (!doi) return src;
    var other = (src.provider && src.provider.id === 'openalex') ? crossref : openalex;
    if (!canTry()) { tried.push(budgetEntry('abstract-topup')); return src; }
    var r = await trySource(other.byDoi, 'abstract-topup', doi);
    if (r && r.ok && r.record && T.trim(r.record.abstract)) {
      rec.abstract = T.trim(r.record.abstract);
      rec.abstractFrom = (other.PROVIDER && other.PROVIDER.name) || '';
    }
    return src;
  }

  /** 统一出口：把任务 A 的留痕挂到结果上 */
  function finish(res) {
    if (aiExtractInfo) res.aiExtract = aiExtractInfo;
    if (rawText) res.inputRawSnippet = rawText.slice(0, 300);
    return res;
  }

  /**
   * 任务 B：千问联网检索兜底。
   * 只在【学术库没命中】或【判定为中文文献】时才调用；
   * 调用失败时保留学术库的原结论并如实附加说明，绝不把「没查」说成「不存在」。
   */
  async function runAiSearch(baseStatusKey, baseHint, prefixReason) {
    function baseResult() {
      return (baseStatusKey === 'network_error')
        ? buildNetworkError(input, tried)
        : buildNotIndexed(input, tried, baseHint);
    }
    function withNote(res, note) {
      res.reason = (prefixReason ? prefixReason + ' ' : '') + res.reason + '\n' + note;
      return res;
    }

    if (opt.aiSearch === false) {
      return withNote(baseResult(), '（本次未启用通义千问联网检索兜底。）');
    }
    if (!qwen.available()) {
      return withNote(baseResult(),
        '另外，通义千问联网检索兜底【未执行】：云函数环境变量 QWEN_API_KEY 未配置。' +
        '在「云开发控制台 → 云函数 → lfaVerify → 配置 → 环境变量」添加该变量后会自动启用。');
    }
    if (!canTry(AI_SEARCH_NEED_MS)) {
      tried.push(budgetEntry('ai-web-search'));
      return withNote(baseResult(),
        '另外，通义千问联网检索兜底【未执行】：云函数剩余执行时间只剩 ' + remainMs() +
        'ms，不足以完成一次联网检索（至少需 ' + AI_SEARCH_NEED_MS + 'ms）。' +
        '可在云开发控制台把 lfaVerify 的执行超时调大到 20 秒。');
    }

    var aiTimeout = aiSearchTimeout();
    if (!aiTimeout) {
      tried.push(budgetEntry('ai-web-search'));
      return withNote(baseResult(),
        '另外，通义千问联网检索兜底【未执行】：云函数剩余执行时间只剩 ' + remainMs() +
        'ms，不足以完成一次联网检索（这类检索实测最长要 13 秒以上）。' +
        '可在云开发控制台把 lfaVerify 的执行超时调大到 20 秒。');
    }
    /* 留出一部分时间给「链接可达性真实探测」：
     * 云端执行上限 30s，这里取其剩余的一部分，且封顶 6s（探测是并列发起的）。
     * 没时间就如实标记「未探测」，绝不谎称链接有效。 */
    var probeMs = Math.max(0, Math.min(6000, remainMs() - 2500));
    var ai = await qwen.searchVerify(input, { timeout: aiTimeout, probeBudgetMs: probeMs });
    tried.push(logEntry(ai, 'ai-web-search'));
    /* ai.verdict 存在但 ai.ok=false ⇒ 模型输出被截断、题录是抢救出来的部分内容，
     * 这种情况仍然要进结果组装（少展示一部分，好过全丢）。 */
    if (!ai.ok && !ai.verdict) {
      return withNote(baseResult(),
        '另外，通义千问联网检索【未能完成】：' +
        (FAILURE_LABEL[ai.failureKind] || ai.failureKind || '异常') +
        (ai.httpStatus ? '（HTTP ' + ai.httpStatus + '）' : '') +
        (ai.failureDetail ? '｜' + ai.failureDetail : '') +
        '。这与该文献是否存在无关。');
    }
    return buildAiSearchResult(input, ai, tried, prefixReason);
  }

  /** 是否需要进入任务 B（兜底检索） */
  function needsAiFallback(res) {
    if (opt.aiSearch === false) return false;
    if (!qwen.available()) return false;
    /* 学术库明确报错 → 算「检索失败」，可以兜底 */
    if (res.statusKey === 'network_error') return true;
    /* 学术库未收录：若已经给出候选题录，就没必要再让模型搜一遍 */
    if (res.statusKey === 'not_indexed') {
      return !(res.candidates && res.candidates.length);
    }
    return false;
  }

  // ---- 守卫：既没有可比对字段，也没有原文可供提取 ----
  if (!input.doi && !hasComparable(input) && !rawText) {
    return finish(packResult({
      ok: true, statusKey: 'insufficient_input',
      label: '信息缺失，无法核验',
      reason: '这条既没有 DOI，也没有填写题名 / 作者 / 年份 / 出处中的任何一项，' +
        '连可提取的原文都没有，无法与任何外部来源比对。请补全题名（至少）。',
      method: 'skip', tried: tried, input: input
    }));
  }

  /* ===== ① 任务 A：通义千问预处理提取（前置步骤） ===== */
  if (rawText && opt.aiExtract !== false) {
    if (!qwen.available()) {
      aiExtractInfo = {
        ok: false, configured: false, model: '', requestedAt: '', httpStatus: 0, ms: 0,
        failureKind: 'config',
        failureDetail: '云函数环境变量 QWEN_API_KEY 未配置',
        fields: null, rawTextSnippet: rawText.slice(0, 300),
        note: '未做千问结构化提取：环境变量 QWEN_API_KEY 未配置，本次直接使用你填写的字段去检索。'
      };
    } else if (!canTry()) {
      tried.push(budgetEntry('ai-extract'));
      aiExtractInfo = {
        ok: false, configured: true, model: '', requestedAt: '', httpStatus: 0, ms: 0,
        failureKind: 'budget_exhausted',
        failureDetail: '云函数剩余时间不足',
        fields: null, rawTextSnippet: rawText.slice(0, 300),
        note: '未做千问结构化提取：云函数剩余执行时间不足。'
      };
    } else {
      var ex = await qwen.extract(rawText, { timeout: stepTimeout(EXTRACT_TIMEOUT_MS) });
      tried.push(logEntry(ex, 'ai-extract'));
      aiExtractInfo = packAiExtract(ex, rawText);
      if (ex.ok && ex.fields) applyExtract(input, searchInput, ex.fields);
    }
  }

  // ---- 提取后仍然没有任何可比对字段 ----
  if (!input.doi && !hasComparable(input)) {
    return finish(packResult({
      ok: true, statusKey: 'insufficient_input',
      label: '信息缺失，无法核验',
      reason: '没有 DOI，也没有题名 / 作者 / 年份 / 出处中的任何一项' +
        (aiExtractInfo ? '，通义千问也没能从原文里提取出可用字段' : '') +
        '，无法与任何外部来源比对。请补全题名（至少）后重试。',
      method: 'skip', tried: tried, input: input
    }));
  }

  /* ===== 用户在 AMiner 候选里选定了一条 → 按论文 id 精确核验 =====
   * AMiner 的论文信息接口只接受内部 id，这才是它唯一真正的精确查询能力。
   * 走这条路拿到的是完整题录（含摘要），可以做逐字段比对，
   * 也只有这条路能让中文文献走到「核验成功 + 补全题录与材料」。
   * 必须放在语言分支【之前】：否则中文题名会先被「直接检索 AMiner」接走，
   * 用户明明已经指定了具体条目，却拿不到精确比对的结论。 */
  var aminerId = T.trim(refObj.aminerId);
  if (aminerId && aminer.available()) {
    var amById = await trySource(aminer.byId, 'aminer-id-exact', aminerId, aminerSegmentOpt());
    if (amById === null) {
      return finish(await runAiSearch('network_error', '', ''));
    }
    if (amById.ok) {
      await topUpAbstract(amById);
      return finish(buildExact(input, amById, 'aminer-id-exact', tried));
    }
    if (amById.failureKind === 'auth_failed') {
      /* Token 过期是配置问题，不能说成「未收录」 */
      return finish(await runAiSearch('network_error', '',
        '按 AMiner 论文 id 精确核验未执行：' + amById.failureDetail));
    }
    /* 没查到（not_found / 网络问题）：不在这里下结论，继续走 DOI / 题名链路 */
  }

  /* ===== 中文题名：不消耗两个境外源，直接用 AMiner 检索；AMiner 也没有才上千问 =====
   *
   * 判定只看【题名】是否含中日韩字符（需求原话：题名是中文就直接用 AMiner）。
   * 作者 / 出处写成中文、题名是英文的情况仍走英文链路
   * （OpenAlex → Crossref → AMiner），避免把外文文献误判成中文文献。
   * 只有「题名没填、粘贴原文是中文」时才按中文处理。 */
  var titleIsZh = !!T.hasCjk(input.title);
  var isZh = !input.doi && (titleIsZh || (rawIsZh && !userFilledTitle));
  if (isZh) {
    var zhHint = cjkHits.length ? cjkHits.join('、') : '原文为中文';
    tried.push({
      providerId: 'none', providerName: '（未请求境外数据源）', method: 'skip',
      apiUrl: '', requestedAt: nowText(), httpStatus: 0, ms: 0, ok: false,
      failureKind: 'skipped',
      failureDetail: '检测到' + zhHint + '，按检索顺序未请求 OpenAlex / Crossref，' +
        '改用 AMiner（中文刊 / 中文会议论文覆盖更好）',
      bodySnippet: ''
    });

    var zhPrefix = '检测到' + zhHint + '，按检索顺序【没有】请求 OpenAlex / Crossref，' +
      '改用 AMiner 检索。';

    if (!aminer.available()) {
      aminerSkipEntry('环境变量 AMINER_TOKEN 未配置，中文题名本应走 AMiner，但本次未能请求。' +
        '请到 AMiner 开放平台控制台生成 Token，再到「云开发控制台 → 云函数 lfaVerify →' +
        ' 配置 → 环境变量」添加 AMINER_TOKEN。');
      return finish(await runAiSearch('not_indexed',
        '中文文献大概率不在 OpenAlex / Crossref 覆盖范围内，且 AMiner 未配置 Token',
        zhPrefix + '但 AMiner 的 Token（环境变量 AMINER_TOKEN）未配置，本次未请求 AMiner。'));
    }

    var zhRes = await searchOneSource(aminer, zhPrefix, aminerSegmentOpt());
    if (zhRes.res && zhRes.res.candidates && zhRes.res.candidates.length) {
      /* AMiner 查到了候选：交人工比对，不必再让模型联网搜一遍 */
      return finish(zhRes.res);
    }
    /* Token 鉴权失败是【配置问题】，既不能说成「未收录」，也不能说成网络异常，
     * 直接把「Token 无效或已过期 + 去哪重新生成」的原话带给用户。 */
    var zhFail = lastAminerFailure();
    if (zhFail && zhFail.failureKind === 'auth_failed') {
      return finish(await runAiSearch('network_error', '',
        zhPrefix + '但 AMiner 请求失败：' + zhFail.failureDetail));
    }
    if (zhRes.budgetOut || (!zhRes.res && !zhRes.fail)) {
      /* 时间预算不足 / 拿不到任何结论：如实报异常，不谎报未收录 */
      return finish(await runAiSearch('network_error', '', zhPrefix + '但 AMiner 未能返回结果。'));
    }

    /* AMiner 明确没查到 → 千问联网兜底 */
    return finish(await runAiSearch('not_indexed',
      'AMiner 未检索到该中文题名（中文学位论文、图书、内部报告等仍可能不在其覆盖范围内）',
      zhPrefix + '但 AMiner 没有检索到对应记录。'));
  }

  var doSearch = opt.allowSearch !== false;

  /* ===== ② OpenAlex 优先 → Crossref 回源（命中则直接返回，不再调千问） =====

   * 每个源内部固定两段式检索，顺序不可颠倒：
   *   ① 宽松：只用 search= / query.bibliographic= 传题名文本，不加任何字段限定
   *           （等价官网搜索框），拿到候选后做「信息校验匹配」；
   *   ② 精确：仅当①【没有合格候选】时补充一次 —— 题名字段限定 + 作者 + 年份组合，
   *           用来缩小候选范围、降低同名/近似题名造成的混淆。
   * 旧的兜底：某些测试替身 / 历史版本还只实现了 search()，这种情况下退回单段检索，
   * 行为与改造前一致。 */

  /* 数据源模块导出的是 PROVIDER（大写），单次请求结果里是 provider（小写），
   * 两种形态都要取得到名字，不能在这里炸掉整条核验链。 */
  function providerNameOf(src) {
    return (src && src.provider && src.provider.name) ||
      (src && src.PROVIDER && src.PROVIDER.name) || '未知来源';
  }

  /** 把本次真实发出去的 query 打进云端日志，方便回过头核对「到底拿什么词去查的」 */
  function logQuery(src, stageLabel, resp) {
    if (!resp) return;
    console.log('[lfaVerify][query] ' + providerNameOf(src) + ' | ' + stageLabel +
      ' | query=' + (resp.query || '(空)') +
      ' | HTTP ' + resp.httpStatus +
      ' | 返回 ' + (resp.returned == null ? '?' : resp.returned) + ' 条' +
      ' | ' + (resp.apiUrl || ''));
  }

  function cntOf(src) { return src.returned == null ? '?' : src.returned; }
  function whyOf(src) {
    return (FAILURE_LABEL[src.failureKind] || src.failureKind || '异常') +
      (src.httpStatus ? '（HTTP ' + src.httpStatus + '）' : '');
  }

  /**
   * 单个数据源的两段式检索，顺序固定：① 宽松 →（无合格候选时）② 精确字段。
   * @returns {{res: object}|{budgetOut: true}|{fail: true}}
   *          res 一定非 null（可能 candidates 为空 = 本来源未收录）
   */
  async function searchOneSource(src, prefixReason, srcOpt) {
    var trail = [];
    /* 兼容旧的「只有 search()」的数据源：退回单段检索，行为与改造前一致 */
    var looseFn = (typeof src.searchLoose === 'function') ? src.searchLoose
      : (typeof src.search === 'function' ? src.search : null);

    function pack(s, method) {
      return buildCandidates(input, s, tried, prefixReason, { method: method, trail: trail });
    }

    /* ===== 单段检索：接口不支持字段限定的数据源（AMiner）=====
     * 它的搜索接口只有 title 参数，「宽松 / 精确」发出去是【同一个请求】，
     * 差别只在本地按作者 / 年份重新排序。再发一次纯属浪费时间预算——
     * 云端实测三次串行请求叠加会把整条链路拖过平台 60s 硬超时。
     * 只跑一次，并取精确那一段（它一次取的条数更多，还能把更像的排到前面）。 */
    if (src.singleStageSearch === true && typeof src.searchPrecise === 'function') {
      var one = await trySource(src.searchPrecise, STAGE_SINGLE, searchInput, srcOpt);
      if (one === null) return { budgetOut: true };
      if (one.ok) {
        logQuery(src, STAGE_LABEL[STAGE_SINGLE], one);
        var n0 = countQualified(input, one);
        trail.push('题名检索（该来源的检索接口只支持题名，作者 / 年份在本地收敛）：接口返回 ' +
          cntOf(one) + ' 条，' +
          (n0 ? '其中 ' + n0 + ' 条通过信息校验匹配' : '没有一条通过信息校验匹配'));
        return { res: pack(one, STAGE_SINGLE) };
      }
      trail.push('题名检索（该来源只支持按题名检索）：失败（' + whyOf(one) + '）');
      return { fail: true };
    }

    /* ===== ① 宽松检索：只用 search= / query.bibliographic= 传题名，不加字段限定 ===== */
    var loose = await trySource(looseFn, STAGE_LOOSE, searchInput);
    if (loose === null) return { budgetOut: true };   // 时间预算不足，本源根本没查

    if (loose.ok) {
      logQuery(src, STAGE_LABEL[STAGE_LOOSE], loose);
      var n1 = countQualified(input, loose);
      trail.push('① 宽松检索（仅题名，不加字段限定）：接口返回 ' + cntOf(loose) + ' 条，' +
        (n1 ? '其中 ' + n1 + ' 条通过信息校验匹配' : '没有一条通过信息校验匹配'));
      if (n1) return { res: pack(loose, STAGE_LOOSE) };
    } else {
      trail.push('① 宽松检索（仅题名）：失败（' + whyOf(loose) + '）');
    }

    /* ===== ② 精确字段检索：题名字段限定 + 作者 + 年份 ===== */
    var preciseFn = (typeof src.searchPrecise === 'function') ? src.searchPrecise : null;
    if (!preciseFn) {
      /* 该数据源没有精确检索能力，如实保留宽松的结果 */
      return loose.ok ? { res: pack(loose, STAGE_LOOSE) } : { fail: true };
    }
    await sleep(GAP_BETWEEN_STAGES);
    var precise = await trySource(preciseFn, STAGE_PRECISE, searchInput);
    if (precise === null) {
      if (loose.ok) {
        trail.push('② 精确字段检索（题名+作者+年份）：因云函数时间预算不足未发起');
        return { res: pack(loose, STAGE_LOOSE) };
      }
      return { budgetOut: true };
    }

    if (precise.ok) {
      logQuery(src, STAGE_LABEL[STAGE_PRECISE], precise);
      var n2 = countQualified(input, precise);
      trail.push('② 精确字段检索（题名+作者+年份）：接口返回 ' + cntOf(precise) + ' 条，' +
        (n2 ? '其中 ' + n2 + ' 条通过信息校验匹配' : '没有一条通过信息校验匹配'));
      /* 精确阶段无论有没有合格候选，都由它来给出最终结论：
       * 有则列入候选；没有则「本来源未收录」的表述也更准确（查得更严还没查到）。 */
      return { res: pack(precise, STAGE_PRECISE) };
    }
    trail.push('② 精确字段检索（题名+作者+年份）：失败（' + whyOf(precise) + '）');
    return loose.ok ? { res: pack(loose, STAGE_LOOSE) } : { fail: true };
  }

  /**
   * AMiner 不可用（Token 未配置 / 鉴权失败）时的一条留痕。
   * 宁可多写一条日志，也不能让「这次压根没请求」在页面上看不见。
   */
  function aminerSkipEntry(detail) {
    tried.push({
      providerId: aminer.PROVIDER.id, providerName: aminer.PROVIDER.name, method: 'skip',
      apiUrl: '', requestedAt: nowText(), httpStatus: 0, ms: 0, ok: false,
      failureKind: 'config', failureDetail: detail, bodySnippet: ''
    });
  }

  /** 取最近一次 AMiner 的失败留痕（用于把「Token 过期」原话带给用户） */
  function lastAminerFailure() {
    for (var i = tried.length - 1; i >= 0; i--) {
      var t = tried[i];
      if (t && t.providerId === aminer.PROVIDER.id && !t.ok) return t;
    }
    return null;
  }

  async function runSearch(prefixReason) {
    /* 「有候选才返回」——某个源查到了就说它查到了；
     * 只是【明确未收录】的话要继续往下问下一个源，不能挡住后面的检索。
     * lastRes 保留最后一个「未收录」结论，供后续确实无源可用时如实返回。 */
    var lastRes = null;

    var oa = await searchOneSource(openalex, prefixReason);
    if (oa.res) {
      if (oa.res.candidates && oa.res.candidates.length) return oa.res;
      lastRes = oa.res;
    } else if (oa.budgetOut) {
      /* OpenAlex 因时间预算没查成：如实报网络异常，不要谎报「未收录」 */
      return buildNetworkError(input, tried);
    }
    await sleep(GAP_BETWEEN_SOURCES);
    var cr = await searchOneSource(crossref, prefixReason);
    if (cr.res) {
      if (cr.res.candidates && cr.res.candidates.length) return cr.res;
      lastRes = cr.res;
    } else if (cr.budgetOut) {
      return buildNetworkError(input, tried);
    }

    /* ===== ③ AMiner：英文题名在前两个境外源都没命中时才上，
     *       它对中文刊 / 中文会议论文的覆盖优于 OpenAlex 与 Crossref ===== */
    await sleep(GAP_BETWEEN_SOURCES);
    if (!aminer.available()) {
      aminerSkipEntry('环境变量 AMINER_TOKEN 未配置，本次未请求 AMiner。' +
        '如需中文文献覆盖，请到 AMiner 开放平台控制台生成 Token 后，' +
        '在「云开发控制台 → 云函数 lfaVerify → 配置 → 环境变量」添加 AMINER_TOKEN。');
      return lastRes || buildNetworkError(input, tried);
    }
    var am = await searchOneSource(aminer, prefixReason, aminerSegmentOpt());
    if (am.res) return am.res;
    /* AMiner Token 鉴权失败是【配置问题】：即使前面两个源给了「未收录」，
     * 也要把「Token 无效或已过期、去哪重新生成」说清楚，
     * 不能让用户以为系统跑得好好的、只是这篇没收录。 */
    var amFail = lastAminerFailure();
    if (amFail && amFail.failureKind === 'auth_failed') {
      return finish(await runAiSearch('network_error', '',
        '英文题名走完 OpenAlex / Crossref 后本应回退 AMiner，但 AMiner 请求失败：' +
        amFail.failureDetail));
    }
    /* AMiner 没查出结论（预算不足 / 彻底失败）时，前面那个源的结论仍然有效 */
    return lastRes || buildNetworkError(input, tried);
  }

  if (input.doi) {
    var oa = await trySource(openalex.byDoi, 'doi-exact', input.doi);
    if (oa !== null && oa.ok) {
      await topUpAbstract(oa);
      return finish(buildExact(input, oa, 'doi-exact', tried));
    }
    if (oa === null) {
      return finish(await runAiSearch('network_error', '', ''));
    }
    await sleep(GAP_BETWEEN_SOURCES);
    var cr = await trySource(crossref.byDoi, 'doi-exact', input.doi);
    if (cr !== null && cr.ok) {
      await topUpAbstract(cr);
      return finish(buildExact(input, cr, 'doi-exact', tried));
    }
    if (cr === null) {
      return finish(await runAiSearch('network_error', '', ''));
    }
    if (isNotFound(oa) && isNotFound(cr)) {
      /* 两个源都【明确】返回 404 = 确实未收录（有确定答案，不是网络异常） */
      if (!doSearch || !canTry()) {
        return finish(await runAiSearch('not_indexed', '两个源都明确返回未收录', ''));
      }
      /* 题名检索是锦上添花：帮用户发现「DOI 是不是抄错了」。 */
      var prefix = '你填写的 DOI「' + input.doi + '」在两个公开元数据源都返回「未收录」' +
        '（这【不等于】文献不存在，可能是未被收录，也可能是 DOI 抄错）。';
      var sr = await runSearch(prefix);
      if (sr.candidates && sr.candidates.length) {
        /* 已按题名找到候选，交人工比对即可，不必再让模型联网搜一遍 */
        var nr = packResult({
          ok: true, statusKey: 'not_indexed',
          label: STATUS.not_indexed.text,
          reason: sr.reason,
          provider: sr.provider, apiUrl: sr.apiUrl, fetchedAt: sr.fetchedAt,
          httpStatus: sr.httpStatus, method: sr.method, query: sr.query,
          searchStrategy: sr.searchStrategy,
          record: null, rawPayload: sr.rawPayload,
          candidates: sr.candidates, tried: sr.tried, input: input
        });
        return finish(nr);
      }
      return finish(await runAiSearch('not_indexed', '两个源都明确返回未收录', prefix));
    }
    /* 至少一个源是超时 / 限流 / 网络错误：不能声称未收录 */
    return finish(await runAiSearch('network_error', '', ''));
  }

  if (!doSearch) {
    return finish(await runAiSearch('not_indexed', '该条目没有 DOI，且本次未开启题名检索', ''));
  }

  var searched = await runSearch('');
  if (needsAiFallback(searched)) {
    return finish(await runAiSearch(searched.statusKey, '', ''));
  }
  return finish(searched);
}

function round2(n) { return Math.round(n * 100) / 100; }

/* ==========================================================================
 *  两段式核验：独立的千问联网检索段（action = 'ai-verify'）
 *  ------------------------------------------------------------------
 *  为什么要拆出来单独一次调用：
 *    单次云函数调用的执行上限就是 context.time_limit_in_ms（控制台最大 60 秒）。
 *    AMiner 与千问联网检索在同一条核验链里是串行的，共享这同一份墙钟，
 *    于是「AMiner 等够 + 千问也等够」在【一次调用】里做不到——
 *    前面给足就必然挤掉后面，后面只能剩几秒、必定超时。
 *    拆成两次调用后，每一段各自独占接近平台上限的时间预算，互不挤占。
 *
 *  部署事实：通义千问跑在单独的云函数 lfa_qwen 上（QWEN_API_KEY 配置在那里），
 *  本函数只带 AMINER_TOKEN。所以这一段的正确执行者是 lfa_qwen——
 *  它有自己的 Key 与自己的 60 秒预算，正好等于「千问段独占 60 秒」。
 *
 *  本段不碰 OpenAlex / Crossref / AMiner，只做一件事：千问联网检索 + 链接真实探测，
 *  因此这一整段的执行时间都能给千问（实测冷门中文条目要 13.7 秒以上）。
 * ========================================================================== */

async function runAiSearchOnly(ref, opt) {
  opt = opt || {};
  var input = takeInput(ref || {});
  var priorTried = Array.isArray(opt.priorTried) ? opt.priorTried.slice(0, 40) : [];
  var tried = [];

  var budget = opt.timeBudgetMs || TIME_BUDGET_MS;
  var platRemain = platformRemainingMs();
  if (platRemain !== Infinity) {
    budget = Math.max(0, Math.min(budget, platRemain - PLATFORM_RESERVE_MS));
  }
  var deadline = Date.now() + budget;
  function remainMs() { return deadline - Date.now(); }

  function failOf(label, reason) {
    return packResult({
      ok: false, statusKey: 'network_error', label: label, reason: reason,
      method: 'ai-web-search', tried: priorTried.concat(tried), input: input
    });
  }
  function budgetNote(method) {
    tried.push({
      providerId: 'none', providerName: '（因云函数时间预算不足未发起）', method: method,
      apiUrl: '', requestedAt: nowText(), httpStatus: 0, ok: false, ms: 0,
      failureKind: 'budget_exhausted',
      failureDetail: '本段剩余执行时间只剩 ' + remainMs() + 'ms，不足以完成一次联网检索，因此未发起。',
      bodySnippet: ''
    });
  }

  if (!qwen.available()) {
    return failOf('千问联网检索未执行（本云函数没有配置 Key）',
      '本次没有做千问联网检索：本云函数的环境变量里没有 QWEN_API_KEY。' +
      '千问能力跑在单独的云函数 lfa_qwen 上（QWEN_API_KEY 配置在那里），' +
      '这一段应当由它来调用。这与该文献是否存在无关。');
  }

  var prefix = priorTried.length
    ? '本段是两段式调用的第二段：前一段（OpenAlex / Crossref / AMiner 三个学术源）没有给出可比对结果，' +
      '本段单独用通义千问做联网检索；两段各自有一次完整的执行时间预算。'
    : '';

  if (remainMs() < AI_SEARCH_NEED_MS) {
    budgetNote('ai-web-search');
    return failOf('千问联网检索未执行（时间预算不足）',
      (prefix ? prefix + ' ' : '') +
      '本段剩余执行时间只剩 ' + remainMs() + 'ms，不足以完成一次联网检索' +
      '（至少需 ' + AI_SEARCH_NEED_MS + 'ms）。可重试一次。');
  }
  var aiTimeout = Math.min(AI_SEARCH_TIMEOUT_MS, remainMs() - 1200);
  if (aiTimeout < 1500) {
    budgetNote('ai-web-search');
    return failOf('千问联网检索未执行（时间预算不足）',
      (prefix ? prefix + ' ' : '') +
      '本段剩余执行时间只剩 ' + remainMs() + 'ms，不足以完成一次联网检索' +
      '（实测最长要 13 秒以上）。可重试一次。');
  }
  /* 链接可达性真实探测：它是并列发起的，给它单独一份、封顶 6s 的预算 */
  var probeMs = Math.max(0, Math.min(6000, remainMs() - aiTimeout - 1500));

  var ai = await qwen.searchVerify(input, { timeout: aiTimeout, probeBudgetMs: probeMs });
  tried.push(logEntry(ai, 'ai-web-search'));
  /* ai.verdict 在但 ai.ok=false ⇒ 模型输出被截断、题录是从截断输出里抢救出来的，
   * 这种情况仍然要进结果组装（少展示一部分，好过全丢）。 */
  if (!ai.ok && !ai.verdict) {
    return failOf('千问联网检索未能完成',
      (prefix ? prefix + ' ' : '') +
      '通义千问联网检索【未能完成】：' +
      (FAILURE_LABEL[ai.failureKind] || ai.failureKind || '异常') +
      (ai.httpStatus ? '（HTTP ' + ai.httpStatus + '）' : '') +
      (ai.failureDetail ? '｜' + ai.failureDetail : '') +
      '。这与该文献是否存在无关，可稍后重试。');
  }
  return buildAiSearchResult(input, ai, priorTried.concat(tried), prefix);
}

/**
 * 判定「再单独跑一次千问联网检索是否值得」。
 * 前端据此决定要不要发起第二段调用（action = 'ai-verify'）。
 * 只有【学术源没给出可用结果】且【本段确实没跑过千问】时才值得续跑，
 * 避免把一次明明已经成功的核验再拖一次调用。
 */
function aiFallbackHint(ev, res) {
  function no(reason) { return { available: false, reason: reason }; }
  function yes(reason) { return { available: true, reason: reason }; }

  if (!res) return no('没有可判断的结果');
  if (res.candidates && res.candidates.length) return no('学术源已给出可比对候选，不必再跑千问');
  if (res.statusKey === 'verified' || res.statusKey === 'verified_one_conflict') return no('已核验成功');
  if (res.statusKey === 'ai_found' || res.statusKey === 'ai_not_found') return no('本次已完成千问联网检索');

  /* 本函数没有 QWEN_API_KEY —— 这【不代表】千问不可用：
   * 部署上就是分家的（Key 在另一个云函数里），千问段由它独跑。
   * 若这里直接判 false，前端就永远不会发起第二段，等于把兜底悄悄关掉。 */
  if (!qwen.available()) {
    var peerFn = T.trim(process.env.AI_PEER_FN) || 'lfa_qwen';
    return {
      available: true, viaPeerFn: true, peerFn: peerFn,
      reason: '本云函数没有配置 QWEN_API_KEY，千问段由另一个云函数「' + peerFn +
        '」单独执行——它有自己的 Key，也独占一整段执行时间预算（不会被学术库请求挤掉）。'
    };
  }
  /* 第一段被显式禁用了千问（前端两段式调用），学术源又没命中 → 值得续跑 */
  if (ev && ev.aiSearch === false) {
    return yes('OpenAlex / Crossref / AMiner 均未给出可用结果，' +
      '可继续用千问联网检索（单独一次调用，独占一次完整的执行时间预算）。');
  }
  /* 千问因时间预算被挤掉的情形：这次没能跑完，值得单独重跑 */
  if (res.statusKey === 'network_error' && /【未执行】|【未能完成】/.test(res.reason || '')) {
    return yes('千问联网检索本次没有跑完（执行时间被前一段挤占），' +
      '可单独重跑一次，让它独占一整段时间预算。');
  }
  return no('当前结论不需要再跑千问');
}

/* ==========================================================================
 *  总闸：任何一步挂死都不能让前端一片空白
 *  ------------------------------------------------------------------
 *  云函数被平台硬超时杀掉时返回的是 errCode -504003，前端拿不到任何结论，
 *  用户看到的就是「点了没反应」。这条链路里有多个外部请求，
 *  即使每个请求都有自己的超时（见 lib/http.js 的墙钟守卫），
 *  也难保某个环节（DNS、TLS、源站黑洞、模型长文本）把整条链拖过平台上限。
 *  所以在入口再挂一道墙钟：到点就【带着已经拿到的留痕】如实返回
 *  「本次未能在平台超时前完成」，绝不说成「文献不存在」。
 * ========================================================================== */
var HARD_RESERVE_MS = 6000;   // 给「组装结论 + 返回」留的时间

function withDeadline(promise, ms, fallback) {
  if (!ms || ms <= 0) return promise;
  return new Promise(function (resolve) {
    var done = false;
    function finish(v) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    }
    var timer = setTimeout(function () { finish(fallback('')); }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    promise.then(
      function (v) { finish(v); },
      function (e) { finish(fallback(String((e && e.message) || e))); }
    );
  });
}

/** 距平台硬超时还剩多少可用时间（已扣掉返回所需的预留） */
function hardBudgetMs() {
  if (TIME_LIMIT_MS > 0 && FN_START > 0) {
    return Math.max(3000, TIME_LIMIT_MS - (Date.now() - FN_START) - HARD_RESERVE_MS);
  }
  return 0;
}

function timeoutResult(ref, actionLabel, errText) {
  return packResult({
    ok: false, statusKey: 'network_error',
    label: '核验未完成（云函数执行时间到上限）',
    reason: actionLabel + '本次未能在云函数执行时间上限前跑完' +
      (errText ? '（' + errText + '）' : '') +
      '。这【与文献是否存在无关】，也不是「查过了没查到」——是这次检索没能跑完。' +
      '请重试一次；若反复出现，可在云开发控制台把 lfaVerify 的执行超时调大，' +
      '或减少一次核验的条目数。',
    method: 'timeout', tried: [], input: takeInput(ref)
  });
}

/* ==========================================================================
 *  云函数入口
 * ========================================================================== */

exports.main = async function (event, context) {
  var ev = event || {};
  var action = ev.action || 'verify';
  CURRENT_CONTEXT = context || null;
  FN_START = Date.now();
  TIME_LIMIT_MS = (context && typeof context.time_limit_in_ms === 'number' &&
    context.time_limit_in_ms > 0) ? context.time_limit_in_ms : 0;

  if (action === 'ping') {
    var remaining = platformRemainingMs();
    var qcfg = qwen.config();
    return {
      ok: true,
      engineVersion: ENGINE_VERSION,
      sources: [openalex.PROVIDER.id, crossref.PROVIDER.id, aminer.PROVIDER.id, qwen.PROVIDER.id],
      /* 运行时真实的检索顺序（题名语言决定走哪条链）：
       *   英文题名 → OpenAlex → Crossref → AMiner → 千问联网兜底
       *   中文题名 → AMiner（不请求两个境外源） → 千问联网兜底 */
      searchOrder: {
        latinTitle: ['openalex', 'crossref', 'aminer', 'dashscope'],
        cjkTitle: ['aminer', 'dashscope'],
        note: '题名含中日韩字符即按中文题名处理；作者 / 出处写成中文而题名为英文时仍走英文链路。'
      },
      contextKeys: context ? Object.keys(context) : [],
      platformTimeoutMs: TIME_LIMIT_MS || null,
      platformRemainingMs: remaining === Infinity ? null : remaining,
      defaultBudgetMs: TIME_BUDGET_MS,
      /* 千问配置自检：只回报「有没有配置」与模型名，绝不回传密钥本身 */
      qwen: {
        configured: !!qcfg.key,
        keySource: qcfg.key ? '云函数环境变量' : '',
        modelExtract: qcfg.modelExtract,
        modelSearch: qcfg.modelSearch,
        base: qcfg.base
      },
      /* AMiner：唯一需要 Token 的检索源。
       * 只回报「有没有配置」与 Token 末 4 位（便于核对读到的到底是哪一个），
       * 绝不回传完整 Token。鉴权失败（code 40308）会在检索结果里明确提示 Token 过期。 */
      aminer: {
        configured: aminer.available(),
        tokenTail: aminer.config().tokenTail,
        endpoints: ['GET /api/paper/search', 'POST /api/paper/info'],
        note: aminer.available()
          ? 'AMiner 已配置：英文题名在前两个境外源未命中时启用；中文题名直接检索 AMiner。' +
            '仅使用论文搜索（GET）与论文信息（POST）两个接口。'
          : '【AMiner 未配置】环境变量 AMINER_TOKEN 缺失，该源不参与检索。' +
            '请到 AMiner 开放平台控制台生成 Token 后，在「云开发控制台 → 云函数 lfaVerify →' +
            ' 配置 → 环境变量」添加 AMINER_TOKEN。'
      },
      /* 「帮我找文献」链路：真实检索服务 + 分析模型（如实回报，不夸大覆盖范围） */
      discover: {
        services: discover.COVERAGE.services.map(function (s) { return s.id; }),
        modelPlan: qcfg.modelPlan,
        modelAnalyze: qcfg.modelAnalyze,
        notCovered: discover.COVERAGE.notCovered,
        maxRecommend: discover.MAX_RECOMMEND
      },
      /* 第四阶段「课题适配与主张核验」：
       * 运行时真正在跑的分析服务只有一个（通义千问，经云函数中转），
       * 【不包括】开发阶段帮我写代码的助手——它的联网检索不是本小程序的能力。 */
      adapt: {
        analysisConfigured: !!qcfg.key,
        analysisModel: qcfg.modelAnalyze,
        analysisProvider: qwen.PROVIDER,
        fulltextFetched: false,
        usageOptions: Object.keys(adapt.USAGE),
        note: qcfg.key
          ? '运行时分析服务：' + qcfg.modelAnalyze + '（经云函数中转，密钥只在云端环境变量）。' +
            '只依据题录、来源摘要与你粘贴的原文节选，不抓全文。'
          : '【运行时分析服务未配置】环境变量 QWEN_API_KEY 缺失，课题适配与主张核验不会执行 AI 分析，' +
            '页面会明确提示「未执行 AI 分析」，不会假装已经分析完成。'
      },
      at: nowText()
    };
  }

  /* 任务 A 单独调用：只做结构化提取，不查任何学术库。
   * 与核验流程里的任务 A 共用同一套 prompt，保证行为一致。 */
  if (action === 'extract') {
    var raw = T.trim(ev.raw);
    if (!raw) {
      return { ok: false, error: '缺少参数 raw（要解析的参考文献原文）', engineVersion: ENGINE_VERSION };
    }
    try {
      var ex = await qwen.extract(raw, { timeout: Math.min(EXTRACT_TIMEOUT_MS, TIME_BUDGET_MS) });
      return {
        ok: !!ex.ok,
        engineVersion: ENGINE_VERSION,
        provider: qwen.PROVIDER,
        model: ex.model,
        requestedAt: ex.requestedAt,
        httpStatus: ex.httpStatus,
        ms: ex.ms,
        failureKind: ex.failureKind,
        failureDetail: ex.failureDetail,
        fields: ex.fields ? {
          title: ex.fields.title, titleOrig: ex.fields.titleOrig,
          authors: ex.fields.authors, authorsText: ex.fields.authorsText,
          year: ex.fields.year, venue: ex.fields.venue, doi: ex.fields.doi,
          volume: ex.fields.volume, issue: ex.fields.issue,
          pages: ex.fields.pages, isbn: ex.fields.isbn,
          lang: ex.fields.lang, confidence: ex.fields.confidence
        } : null,
        rawOutput: ex.content || '',
        rawPayload: packRawPayload(qwen.PROVIDER, ex.apiUrl, ex.requestedAt, ex.httpStatus, ex.raw)
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), engineVersion: ENGINE_VERSION };
    }
  }

  /* ==========================================================================
   *  ai-verify：两段式调用的第二段，只做千问联网检索 + 链接真实探测。
   *  由 lfa_qwen（配了 QWEN_API_KEY 的那个云函数）来跑：
   *  它独占这一整段的执行时间预算，不会被前面的学术库请求挤占。
   * ======================================================================== */
  if (action === 'ai-verify') {
    if (!ev.ref || typeof ev.ref !== 'object') {
      return packResult({
        ok: false, statusKey: 'network_error',
        label: '网络异常，核验中断',
        reason: '千问联网检索段没有收到文献题录参数（ref），无法发起检索。',
        method: 'ai-web-search', tried: [],
        input: { doi: '', title: '', authors: '', year: '', venue: '' }
      });
    }
    try {
      return await withDeadline(
        runAiSearchOnly(ev.ref, {
          timeBudgetMs: ev.timeBudgetMs,
          priorTried: Array.isArray(ev.priorTried) ? ev.priorTried : []
        }),
        hardBudgetMs(),
        function (errText) { return timeoutResult(ev.ref, '千问联网检索', errText); }
      );
    } catch (e) {
      return packResult({
        ok: false, statusKey: 'network_error',
        label: '网络异常，核验中断',
        reason: '千问联网检索发生未预期错误：' + String((e && e.message) || e) +
          '。这与该文献是否存在无关，请重试或改用「人工补证」。',
        method: 'error', tried: [], input: takeInput(ev.ref)
      });
    }
  }

  if (action === 'verify') {
    if (!ev.ref || typeof ev.ref !== 'object') {
      return packResult({
        ok: false, statusKey: 'network_error',
        label: '网络异常，核验中断',
        reason: '云函数没有收到文献题录参数（ref），无法发起核验。',
        method: 'none', tried: [], input: { doi: '', title: '', authors: '', year: '', venue: '' }
      });
    }
    try {
      var vres = await withDeadline(
        verifyOne(ev.ref, {
          allowSearch: ev.allowSearch,
          timeBudgetMs: ev.timeBudgetMs,
          aiExtract: ev.aiExtract,
          aiSearch: ev.aiSearch
        }),
        hardBudgetMs(),
        function (errText) { return timeoutResult(ev.ref, '核验', errText); }
      );
      /* 告诉调用方「值不值得再跑一次千问段」，让前端决定要不要发起第二段 */
      vres.aiFallback = aiFallbackHint(ev, vres);
      return vres;
    } catch (e) {
      return packResult({
        ok: false, statusKey: 'network_error',
        label: '网络异常，核验中断',
        reason: '核验过程发生未预期错误：' + String((e && e.message) || e) +
          '。这与该文献是否存在无关，请重试或人工补证。',
        method: 'error', tried: [], input: takeInput(ev.ref)
      });
    }
  }

  /* ==========================================================================
   *  「帮我找文献」（检索推荐）三个 action
   *  拆成三次独立调用而不是一次跑完，是因为单次云函数执行时间有限：
   *    ① 生成检索式（模型，不开联网）≈ 2~5s
   *   + ② 真实检索 Crossref / OpenAlex ≈ 3~8s
   *   + ③ 关系分析（模型）≈ 5~10s
   *  合在一起必然超时；拆开后每一步都能在预算内跑完，也方便你中途改检索式。
   * ======================================================================== */

  /** 按平台剩余时间收敛的预算，避免被云函数执行超时硬杀 */
  function budgetFor(cap) {
    var rem = platformRemainingMs();
    if (rem === Infinity) return cap;
    return Math.max(1200, Math.min(cap, rem - PLATFORM_RESERVE_MS - 500));
  }

  if (action === 'discover-plan') {
    var dt = ev.topic || {};
    if (!T.trim(dt.name) && !T.trim(dt.problem) && !T.trim(dt.target) && !T.trim(ev.hints)) {
      return {
        ok: false, status: 'failed', error: '缺少课题信息（topic）或补充要求（hints），无法生成检索式。',
        coverage: discover.COVERAGE, engineVersion: ENGINE_VERSION
      };
    }
    try {
      var pr = await discover.planTopic(dt, T.trim(ev.hints), { timeout: budgetFor(9000) });
      pr.engineVersion = ENGINE_VERSION;
      return pr;
    } catch (e) {
      return {
        ok: false, status: 'failed', error: String((e && e.message) || e),
        coverage: discover.COVERAGE, engineVersion: ENGINE_VERSION
      };
    }
  }

  if (action === 'discover-search') {
    var qs = Array.isArray(ev.queries) ? ev.queries : [];
    var texts = qs.map(function (x) {
      return typeof x === 'string' ? T.trim(x) : T.trim(x && x.text);
    }).filter(Boolean);
    if (!texts.length) {
      return {
        ok: false, status: 'failed', error: '没有提供任何检索式（queries），未发起检索。',
        coverage: discover.COVERAGE, engineVersion: ENGINE_VERSION
      };
    }
    try {
      var sr = await withDeadline(
        discover.runSearch(texts, {
          yearFrom: T.trim(ev.yearFrom), yearTo: T.trim(ev.yearTo)
        }, {
          /* 三源都要跑，AMiner 单源就可能需要十几秒，13s 的旧预算必然把它挤掉 */
          timeBudgetMs: budgetFor(42000),
          timeout: 7000,          // OpenAlex / Crossref 的单次请求上限
          maxQueries: ev.maxQueries || 2
        }),
        hardBudgetMs(),
        function (errText) {
          return {
            ok: false, status: 'failed',
            error: '检索未能在云函数执行时间上限前跑完' + (errText ? '（' + errText + '）' : '') +
              '。这与「有没有相关文献」无关，请重试或减少检索式条数。',
            coverage: discover.COVERAGE, engineVersion: ENGINE_VERSION
          };
        }
      );
      sr.engineVersion = ENGINE_VERSION;
      return sr;
    } catch (e) {
      return {
        ok: false, status: 'failed', error: String((e && e.message) || e),
        coverage: discover.COVERAGE, engineVersion: ENGINE_VERSION
      };
    }
  }

  if (action === 'discover-analyze') {
    var cands = Array.isArray(ev.candidates) ? ev.candidates : [];
    if (!cands.length) {
      return {
        ok: false, status: 'empty', error: '没有候选记录，不做任何分析，也不给出任何文献条目。',
        coverage: discover.COVERAGE, engineVersion: ENGINE_VERSION
      };
    }
    try {
      var ar = await discover.analyzeTopic(ev.topic || {}, cands, { timeout: budgetFor(18000) });
      ar.engineVersion = ENGINE_VERSION;
      return ar;
    } catch (e) {
      return {
        ok: false, status: 'failed', error: String((e && e.message) || e),
        coverage: discover.COVERAGE, engineVersion: ENGINE_VERSION
      };
    }
  }

  /* ==========================================================================
   *  第四阶段：课题适配与主张核验（action: adapt）
   *  输入：课题要求 + 一条文献 + 【用户提供的材料】（摘要 / 原文节选）
   *  说明：这里只做「课题要求 vs 文献实际做了什么」的对照与主张核验，
   *        不抓全文、不推荐替代文献；材料不足或未配置分析服务时如实返回对应状态。
   * ======================================================================== */
  if (action === 'adapt') {
    var at = ev.topic || {};
    var ar2 = ev.ref || {};
    if (!T.trim(ar2.title) && !T.trim(ar2.doi)) {
      return {
        ok: false, status: 'failed',
        error: '缺少文献题录（ref.title / ref.doi），无法做课题适配。',
        engineVersion: ENGINE_VERSION
      };
    }
    try {
      var fr = await adapt.analyzeFit(at, ar2, {
        timeout: budgetFor(18000),
        claims: Array.isArray(ev.claims) ? ev.claims : null
      });
      fr.engineVersion = ENGINE_VERSION;
      return fr;
    } catch (e) {
      return {
        ok: false, status: 'failed',
        error: String((e && e.message) || e),
        engineVersion: ENGINE_VERSION,
        /* 如实说明：这是程序内部错误，不代表文献不符合课题 */
        note: '适配分析过程发生未预期错误，本次没有产出任何结论。' +
          '这与该文献是否符合课题无关，请重试或人工核对。'
      };
    }
  }

  return { ok: false, error: '未知 action: ' + action };
};

/* 供 Node 端离线测试使用 */
module.exports.verifyOne = verifyOne;
module.exports.buildAiSearchResult = buildAiSearchResult;
module.exports.STATUS = STATUS;
module.exports.OUTCOME_TEXT = OUTCOME_TEXT;
module.exports.discover = discover;
