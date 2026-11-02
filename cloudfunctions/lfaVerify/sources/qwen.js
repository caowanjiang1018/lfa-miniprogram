'use strict';
/**
 * 通义千问 DashScope 数据源适配器
 * ============================================================================
 * 承担两个【互相独立】的任务，分别用两套 prompt、两次独立调用：
 *   任务 A  extract()       —— 文献预处理：不规范原文 → 结构化 JSON（清洗 / 拆解 / 标题英译）
 *   任务 B  searchVerify()  —— 兜底检索：OpenAlex + Crossref 都没命中时的联网存在性核查
 *
 * 真实接口事实（2026-10-31 在本工作区实测，非文档推测）：
 *   - 本工作区网关【只支持 DashScope 原生接口】：
 *       POST {BASE}/api/v1/services/aigc/text-generation/generation
 *     OpenAI 兼容的 /api/v1/chat/completions 返回 HTTP 404，不要用。
 *   - 鉴权：Authorization: Bearer <key>
 *   - 本机可调用的模型只有 4 个：qwen-flash(约 0.24s) / qwen-plus-latest(约 0.4s)
 *     / qwen-max(约 0.39s) / qwen-plus(约 0.64s)。
 *     qwen3.x 系列、qwen2.5-* 系列在本工作区一律被拒（403 AccessDenied 或 404），
 *     且报错信息具有误导性——不支持的模型会报 "url error, please check url！"。
 *   - 联网搜索：parameters.enable_search = true，响应里 usage.plugins.search.count
 *     表示实际检索次数。注意开启搜索后 input_tokens 会显著变大（检索上下文注入）。
 *   - 实测耗时（本机）：任务 A 提取 qwen-flash 0.7~1.2s / qwen-plus 2.8~3.2s；
 *     任务 B 联网检索 qwen-flash 2.7s / qwen-plus 4.0s / qwen-max 11.6s。
 *     因此默认：A 用 qwen-flash，B 用 qwen-plus，均可通过环境变量覆盖。
 *
 * 凭证安全：
 *   - API key【只】从云函数环境变量读取（QWEN_API_KEY 或 DASHSCOPE_API_KEY），
 *     不写入任何代码文件，也不下发给前端。
 *   - 未配置时本模块所有调用返回 failureKind='config' 的失败结果，
 *     由上层如实呈现为「未做该项核验」，绝不伪造成功。
 */

var http = require('../lib/http.js');
var T = require('../lib/text.js');
var EXTRACT_PROMPT = require('../prompts/extract-prompt.js');
var SEARCH_PROMPT = require('../prompts/search-prompt.js');
var PLAN_PROMPT = require('../prompts/plan-prompt.js');
var ANALYZE_PROMPT = require('../prompts/analyze-prompt.js');
var ADAPT_PROMPT = require('../prompts/adapt-prompt.js');

var DEFAULT_BASE = 'https://ws-cvz13wkp2idhhvc2.cn-beijing.maas.aliyuncs.com/api/v1';
var PATH_CHAT = '/services/aigc/text-generation/generation';

var PROVIDER = {
  id: 'dashscope',
  name: '通义千问（DashScope）',
  home: 'https://dashscope.aliyun.com',
  note: '阿里通义千问大模型，经云函数中转调用：任务A负责题录结构化提取，任务B负责联网检索兜底。' +
    '模型输出不等于权威数据库核验，链接与结论都需你自行打开确认。'
};

/* ---------------- 环境变量 ---------------- */

function env(name, dflt) {
  var v;
  try { v = process.env[name]; } catch (e) { v = null; }
  if (v === undefined || v === null || String(v).trim() === '') return dflt || '';
  return String(v).trim();
}

function config() {
  return {
    key: env('QWEN_API_KEY') || env('DASHSCOPE_API_KEY'),
    base: env('QWEN_BASE_URL', DEFAULT_BASE).replace(/\/+$/, ''),
    modelExtract: env('QWEN_MODEL_EXTRACT', 'qwen-flash'),
    modelSearch: env('QWEN_MODEL_SEARCH', 'qwen-plus'),
    /* 任务 C 检索式规划 / 任务 D 关系分析：
     * 两者都【不开联网检索】（enable_search=false）——检索式是语言组织工作，
     * 关系分析只允许依据真实检索到的记录，开联网会让模型把记忆里的论文混进来。 */
    modelPlan: env('QWEN_MODEL_PLAN', 'qwen-plus'),
    modelAnalyze: env('QWEN_MODEL_ANALYZE', 'qwen-plus')
  };
}

/** 是否已配置可用凭证 */
function available() {
  return !!config().key;
}

/* ---------------- JSON 解析（模型输出容错） ---------------- */

/**
 * 从模型输出里抠出 JSON 对象。
 * 模型偶尔会包 ```json 代码块或前后带一句废话，这里做容错；
 * 但【不】做语义修补——抠不出来就是解析失败，如实上报。
 */
function parseJsonLoose(s) {
  if (!s) return null;
  var text = String(s).trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  var a = text.indexOf('{');
  var b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  var slice = text.slice(a, b + 1);
  try {
    var v = JSON.parse(slice);
    return (v && typeof v === 'object') ? v : null;
  } catch (e) {
    return null;
  }
}

/* ---------------- 底层调用 ---------------- */

function shortBody(s) {
  return String(s || '').replace(/\s+/g, ' ').slice(0, 200);
}

function baseResult(model) {
  return {
    provider: PROVIDER,
    apiUrl: '',
    requestedAt: http.fmtTime(new Date()),
    httpStatus: 0,
    ms: 0,
    ok: false,
    model: model,
    failureKind: null,
    failureDetail: '',
    bodySnippet: ''
  };
}

/**
 * 调用一次 DashScope 原生文本生成接口。
 * @param {string} model
 * @param {string} systemText
 * @param {string} userText
 * @param {object} opt {timeout, maxTokens, enableSearch}
 */
function chat(model, systemText, userText, opt) {
  opt = opt || {};
  var cfg = config();
  var base = baseResult(model);
  base.apiUrl = cfg.base + PATH_CHAT;

  if (!cfg.key) {
    base.failureKind = 'config';
    base.failureDetail = '云函数环境变量 QWEN_API_KEY 未配置，无法调用通义千问。' +
      '请在「云开发控制台 → 云函数 → lfaVerify → 配置 → 环境变量」中添加该变量后重新部署。';
    return Promise.resolve(base);
  }

  var parameters = {
    result_format: 'message',
    max_tokens: opt.maxTokens || 800,
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };
  if (opt.enableSearch) parameters.enable_search = true;

  var payload = {
    model: model,
    input: {
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: userText }
      ]
    },
    parameters: parameters
  };

  var t0 = Date.now();
  return http.postJson(base.apiUrl, payload, {
    timeout: opt.timeout || 12000,
    headers: {
      'Authorization': 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  }).then(function (r) {
    base.ms = Date.now() - t0;
    base.httpStatus = r.status;
    base.requestedAt = r.requestedAtText;

    if (!r.ok) {
      base.ok = false;
      base.failureKind = r.failureKind || 'http_error';
      base.failureDetail = r.failureDetail || ('HTTP ' + r.status);
      base.bodySnippet = shortBody(r.raw);
      return base;
    }

    var content = '';
    try {
      content = r.body.output.choices[0].message.content;
    } catch (e) {
      content = '';
    }
    if (!content) {
      base.ok = false;
      base.failureKind = 'parse';
      base.failureDetail = '模型返回内容为空或结构异常';
      base.bodySnippet = shortBody(r.raw);
      return base;
    }

    base.ok = true;
    base.raw = r.body;
    base.content = content;
    base.usage = r.body.usage || null;
    /* usage.plugins.search 是「真的做过联网检索」的证据，必须留存给用户查看 */
    base.searched = !!(r.body.usage && r.body.usage.plugins && r.body.usage.plugins.search);
    base.searchCount = (r.body.usage && r.body.usage.plugins && r.body.usage.plugins.search &&
      r.body.usage.plugins.search.count) || 0;

    base.json = parseJsonLoose(content);
    if (!base.json) {
      base.ok = false;
      base.failureKind = 'parse';
      base.failureDetail = '模型返回不是合法 JSON。前 160 字：' + shortBody(content);
    }
    return base;
  });
}

/* ---------------- 字段归一化 ---------------- */

function str(v) {
  return v === undefined || v === null ? '' : T.trim(String(v));
}

/* 中文数字年份（二〇二〇 / 二零二零）也要能识别：
 * 模型偶尔会用中文数字写年份，直接丢掉会让「年份」字段平白缺失。 */
var CN_DIGIT = { '零': '0', '〇': '0', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };

function year4(v) {
  var s = str(v);
  var m = s.match(/(19|20)\d{2}/);
  if (m) return m[0];
  var t = s.replace(/[零〇一二三四五六七八九]/g, function (c) { return CN_DIGIT[c]; });
  var m2 = t.match(/(19|20)\d{2}/);
  return m2 ? m2[0] : '';
}

function normDoi(v) {
  var s = T.normalizeDoi(str(v));
  /* 只接受形如 10.xxxx/... 的 DOI，防止模型把期刊名之类当 DOI 返回 */
  return /^10\.\d{4,9}\//.test(s) ? s : '';
}

function normConf(v) {
  var n = Number(v);
  if (isNaN(n)) return null;
  if (n > 1) n = n / 100;   // 模型偶尔给 0-100
  if (n < 0) n = 0;
  if (n > 1) n = 1;
  return Math.round(n * 100) / 100;
}

function normAuthors(v) {
  var arr = [];
  if (Array.isArray(v)) {
    arr = v;
  } else if (typeof v === 'string' && v) {
    arr = v.split(/[;；,，]/);
  }
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var s = str(arr[i]);
    if (!s || s === 'unknown' || s === 'N/A') continue;
    if (out.indexOf(s) < 0) out.push(s);
  }
  return { list: out, text: out.join('; ') };
}

/** 任务 A 输出 → 内部字段（只搬运，缺的留空，不补造） */
function normFields(j) {
  j = j || {};
  var au = normAuthors(j.authors);
  var lang = str(j.lang).toLowerCase();
  if (lang !== 'zh' && lang !== 'en') lang = 'other';
  return {
    title: str(j.title_en),
    titleOrig: str(j.title_orig),
    authors: au.list,
    authorsText: au.text,
    year: year4(j.year),
    venue: str(j.venue),
    doi: normDoi(j.doi),
    volume: str(j.volume),
    issue: str(j.issue),
    pages: str(j.pages),
    isbn: str(j.isbn),
    lang: lang,
    confidence: normConf(j.confidence),
    rawJson: j
  };
}

/* ---------------- 任务 B 结果解耦：recordMeta / candidateLinks ---------------- */
/*
 * 为什么要拆成两个互不依赖的字段（2026-11-01 改）：
 *   旧实现把「模型查到了什么」和「链接能不能打开」绑成一件事判定——
 *   链接一旦全军覆没（被机器校验丢掉、或探测出 404），
 *   明明已经搜到的题名 / 作者 / 年份 / DOI / 摘要就跟着一起丢，
 *   页面上只能显示「未检索到该文献」。这是【凭空多出来的损失】：
 *   搜索有没有线索，和链接能不能连上，本来就是两件事。
 *
 *   现在：
 *     recordMeta     —— 从本次联网搜索摘要里提取的题录（标题/作者/年份/DOI/摘要/来源名）
 *                        只要拿到可信搜索摘要就输出，【完全不看链接探测结果】
 *     candidateLinks —— 沿用原有的四层机器校验 + 真机可达性探测
 *
 *   只有「本次搜索根本没有可信文献线索、拿不到有效 recordMeta」时，才判『未检索到』。
 */

/** 摘要留存上限（够人工看，又不会把本地存储撑爆） */
var ABSTRACT_KEEP = 600;

/** 三种结果状态（对应需求：查到文献信息无可用链接 / 查到文献信息加有效链接 / 完全无检索线索） */
var OUTCOME_TEXT = {
  record_and_link: '查到文献信息 + 有可用链接',
  record_only: '查到文献信息 · 无可用链接',
  no_clue: '完全没有检索线索'
};

/**
 * 探测结论 → 展示区归属。
 * 【判定规则本身没变】，只把它翻译成主展示区要不要放：
 *   ok        → 主展示区
 *   not_found → 直接丢弃（只认服务器明确回的 404 / 410）
 *   其余：403 / 401 / 429 / 5xx / 超时 / 网络失败 / 时间不足没探测
 *          → 保留在主展示区，标注「暂无法验证连通性」
 * 那可能只是站点拦爬虫或临时抽风，不能据此把真链接说成假链接。
 */
var PROBE_STATE = {
  ok: 'ok',
  not_found: 'dropped',
  unverified: 'unverified',
  timeout: 'unverified',
  network: 'unverified',
  skipped: 'unverified'
};

var PROBE_STATE_TEXT = {
  ok: '已实测可访问',
  unverified: '暂无法验证连通性'
};

function probeStateOf(l) {
  var k = (l && l.probe && l.probe.kind) || 'skipped';
  return PROBE_STATE[k] || 'unverified';
}

function probeStateTextOf(l) {
  return PROBE_STATE_TEXT[probeStateOf(l)] || '暂无法验证连通性';
}

var EXISTS_TEXT_META = {
  yes: '检索到明确对应记录',
  no: '模型检索后未找到',
  uncertain: '只有间接线索，无法确认'
};

/**
 * 截断抢救。
 * 旧教训：模型输出过长被 finish_reason=length 截断后整条 JSON 作废，
 * 于是【连搜到的题录一起丢】。这里按字段逐个抠，救回多少算多少，
 * 并如实打上 partialRecovery=true——用户看得到这是不完整的结果，不会被当成完整核验。
 */
function recoverField(content, key) {
  var c = String(content || '');
  var m = c.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
  if (!m) return '';
  try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
}

/** 只在 JSON 解析失败（多半是被截断）时才使用的兜底题录 */
function recoverRecordMeta(content, ctx) {
  if (!ctx || ctx.searched === false) return null;   // 没真联网，抢救出来的也不能信
  var title = str(recoverField(content, 'title'));
  var year = year4(recoverField(content, 'year'));
  var doi = normDoi(recoverField(content, 'doi'));
  var venue = str(recoverField(content, 'venue'));
  var abstract = str(recoverField(content, 'abstract')).slice(0, ABSTRACT_KEEP);
  var sourceName = str(recoverField(content, 'sourceName'));
  var summary = str(recoverField(content, 'summary'));
  if (!title && !doi && !year && !venue && !abstract) return null;
  return {
    partialRecovery: true,
    /* 抢救出来的内容确实来自本次联网检索的返回（已通过 searched 校验），
     * 只是不完整；credible=true 让上层不至于把它判成「完全没线索」。 */
    credible: true,
    reason: '模型本次输出被长度截断，下面是抢救出来的部分题录，可能不完整。',
    exists: 'uncertain',
    existsText: EXISTS_TEXT_META.uncertain,
    title: title, authors: [], authorsText: '', year: year, doi: doi, venue: venue,
    abstract: abstract, sourceName: sourceName, declaredSummary: summary,
    confidence: null,
    fieldsAbsent: ['authors']
  };
}

/**
 * 任务 B 的题录部分（recordMeta）。
 *
 * 可信性判定采用【宁缺毋滥】：只有下面三条同时成立才认
 *   ① 确实触发了联网检索（usage.plugins.search > 0）——否则模型是凭记忆在答；
 *   ② 模型没有判定「没找到」；
 *   ③ 至少拿到了题名 / DOI / 作者之一，能让人去核对。
 * 不满足就如实给出原因，由上层决定展示「未检索到」还是别的状态。
 */
function normRecordMeta(j, ctx) {
  j = j || {};
  ctx = ctx || {};
  var au = normAuthors(j.authors);
  var title = str(j.title);
  var year = year4(j.year);
  var doi = normDoi(j.doi);
  var venue = str(j.venue);
  var abstract = str(j.abstract).slice(0, ABSTRACT_KEEP);
  var sourceName = str(j.sourceName);
  var declaredSummary = str(j.summary).slice(0, 300);
  var searched = ctx.searched !== false;
  var exists = str(j.exists).toLowerCase();
  if (exists !== 'yes' && exists !== 'no' && exists !== 'uncertain') exists = 'uncertain';

  var credible = true;
  var reason = '';
  if (!searched) {
    credible = false;
    reason = '本次没有触发联网检索（返回的 usage.plugins.search 为 0），模型是按既有知识作答，' +
      '不满足「题录只能取自本次搜索摘要」的要求，因此不采用它给出的题录。';
  } else if (exists === 'no') {
    credible = false;
    reason = '模型检索后判定【没有找到】对应记录，本次没有可采用的题录线索。';
  } else if (!title && !doi && !au.text) {
    credible = false;
    reason = '本次搜索摘要里没有可核对的题名 / DOI / 作者，不形成题录。';
  }

  /* 哪些字段这次没拿到：如实列出，系统绝不补造 */
  var absent = [];
  if (!title) absent.push('题名');
  if (!au.text) absent.push('作者');
  if (!year) absent.push('年份');
  if (!doi) absent.push('DOI');
  if (!venue) absent.push('出处');
  if (!abstract) absent.push('摘要');

  return {
    credible: credible,
    reason: reason,
    partialRecovery: false,
    exists: exists,
    existsText: EXISTS_TEXT_META[exists] || '未给出判定',
    title: title,
    authors: au.list,
    authorsText: au.text,
    year: year,
    doi: doi,
    venue: venue,
    abstract: abstract,
    hasAbstract: !!abstract,
    abstractTruncated: str(j.abstract).length > ABSTRACT_KEEP,
    sourceName: sourceName,
    declaredSummary: declaredSummary,
    confidence: normConf(j.confidence),
    fieldsAbsent: absent
  };
}

/**
 * 「本次搜索原始候选链接」——模型声明本次命中的全部来源链接。
 * 这些链接【没有】做过可达性探测，统一放进核验卡的折叠区块供用户手动尝试，
 * 绝不能混进主展示区冒充「已验证链接」。
 */
function normRawCandidates(srcs, keptLinks, audit) {
  var keptKeys = {};
  for (var i = 0; i < (keptLinks || []).length; i++) keptKeys[normUrlKey(keptLinks[i].url)] = true;
  var dropByKey = {};
  for (var k = 0; k < (audit || []).length; k++) {
    if (!audit[k].kept) dropByKey[normUrlKey(audit[k].url)] = audit[k].reason;
  }
  return (srcs || []).map(function (s, idx) {
    var key = normUrlKey(s.url);
    return {
      idx: idx, name: s.name, url: s.url,
      inMain: !!keptKeys[key],
      /* 没进主展示区的原因：要么被机器校验拦下（有具体理由），要么模型压根没把它放进 links */
      dropReason: keptKeys[key] ? ''
        : (dropByKey[key] || '模型没有把它作为链接提交，因此没有进入链接校验流程')
    };
  });
}

function outcomeOf(recordMeta, candidateLinks) {
  if (recordMeta && recordMeta.credible) {
    return (candidateLinks && candidateLinks.length) ? 'record_and_link' : 'record_only';
  }
  return 'no_clue';
}

/** 任务 B 里 links[].kind 的允许取值（前端据此显示来源类型） */
var LINK_KINDS = ['openalex', 'crossref', 'publisher', 'repository', 'cnki', 'wanfang', 'scholar', 'official', 'other'];

/** 归一化 URL：去掉末尾斜杠、fragment、锚点，便于与原始来源做比对 */
function normUrlKey(u) {
  var s = String(u || '').trim();
  s = s.replace(/[#].*$/, '');
  s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

function hostOf(u) {
  var m = String(u || '').match(/^https?:\/\/([^\/\s?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/** 路径部分（去掉 query），用于判断是不是首页 / 检索页 */
function pathOf(u) {
  var m = String(u || '').match(/^https?:\/\/[^\/\s?#]+([^?#]*)/i);
  return m ? m[1] : '';
}

/**
 * 任务 B 输出的「本次实际命中的来源」。
 * 注意：本网关的 DashScope 原生接口【不会】回传它内部检索到的页面清单
 * （实测原始返回只有 output.choices[].message.content 与 usage.plugins.search.count），
 * 因此这个清单是【模型自己声明】的来源，不是平台给的证据。
 * 它的用途是给下面的链接做交叉校验：模型自己也交代不清来源的链接，一律丢弃。
 */
function normSources(v) {
  var out = [];
  var hosts = {};
  var raw = Array.isArray(v) ? v : [];
  for (var i = 0; i < raw.length && out.length < 8; i++) {
    var it = raw[i] || {};
    var url = str(it.url);
    if (!/^https?:\/\/\S+/i.test(url)) continue;
    var name = str(it.name) || hostOf(url);
    if (!name) continue;
    out.push({ name: name, url: url });
    var h = hostOf(url);
    if (h) hosts[h] = true;
  }
  return { list: out, hosts: hosts };
}

/**
 * 任务 B 输出 → 内部结论。结果【拆成两个互不依赖的部分】：
 *   recordMeta     —— 本次搜索摘要里的题录（不看链接脸色）
 *   candidateLinks —— 走四层校验 + 真机探测的候选链接
 *
 * 链接治理（2026-10-31 实测加上的强校验，本次改造【未改动判定规则】）：
 *   实测模型给过的链接里相当一部分是拼出来的：worldcat.org/title/1023456789、
 *   sciencereads.com/book/1234567890、凭空生成的 CNKI 书目 ID、假的 OCLC 号。
 *   用户点开是 404 或不相干页面，等于拿到假证据。因此这里做四道过滤：
 *     ① 必须是 http(s) 链接；
 *     ② 域名必须出现在模型自己声明的 sources 里（说不清来源的链接一律丢）；
 *     ③ 不能是站点首页 / 检索结果页，必须是详情页形态；
 *     ④ 路径里不得出现 10 位以上连续数字（凭空生成的编号的典型特征）。
 *   一条都没剩下时，如实标记 linkStatus='url_not_found'，并保留完整的丢弃理由供排查；
 *   但【不再】反过来把有价值的题录一起判死——那是 recordMeta 的事，两者互不依赖。
 *
 * @param {object} j    模型输出的 JSON
 * @param {object} ctx  {searched} 是否真触发了联网检索（来自 usage.plugins.search）
 */
function normVerdict(j, ctx) {
  j = j || {};
  ctx = ctx || {};
  var ex = str(j.exists).toLowerCase();
  if (ex !== 'yes' && ex !== 'no') ex = 'uncertain';

  var srcs = normSources(j.sources);
  var declared = str(j.linkStatus).toLowerCase();
  if (declared !== 'ok' && declared !== 'url_not_found') declared = '';

  var links = [];
  var audit = [];
  var raw = Array.isArray(j.links) ? j.links : [];

  function drop(u, s, reason) {
    audit.push({ url: u, source: s, kept: false, reason: reason });
  }

  for (var i = 0; i < raw.length && links.length < 6; i++) {
    var it = raw[i] || {};
    var url = str(it.url);
    var source = str(it.source);
    var kind = str(it.kind).toLowerCase();
    if (LINK_KINDS.indexOf(kind) < 0) kind = 'other';

    /* ① 基本格式 */
    if (!/^https?:\/\/\S+/i.test(url)) { drop(url, source, '不是 http(s) 链接'); continue; }

    /* ② 必须与本次检索命中的来源同源 */
    if (srcs.list.length && !srcs.hosts[hostOf(url)]) {
      drop(url, source, '域名不在本次检索命中的来源中（疑似编造，已知来源：' +
        Object.keys(srcs.hosts).join('、') + '）');
      continue;
    }

    /* ③ 必须是详情页，不是首页 / 检索页 */
    var p = pathOf(url);
    if (!p || p === '/') { drop(url, source, '只是站点首页，不是文献详情页'); continue; }
    if (/\/(search|results|result|query|searchresult)(\/|$|\?)/i.test(p) || /[?&]q=/i.test(url)) {
      drop(url, source, '是检索结果页，不是文献详情页');
      continue;
    }

    /* ④ 疑似凭空生成的长数字编号 */
    if (/\d{10,}/.test(p)) {
      drop(url, source, '链接路径含 10 位以上连续数字，疑似凭空生成的编号');
      continue;
    }

    if (!source) source = hostOf(url);
    links.push({ url: url, source: source, kind: kind, note: str(it.note) });
    audit.push({ url: url, source: source, kept: true, reason: '' });
  }

  var au = normAuthors(j.authors);
  var linkStatus = links.length ? 'ok' : 'url_not_found';

  /* 题录与链接分开算：recordMeta 完全不看 links 的结果 */
  var recordMeta = normRecordMeta(j, ctx);
  var rawCandidateLinks = normRawCandidates(srcs.list, links, audit);

  return {
    exists: ex,
    candidateLinks: links,
    linkStatus: linkStatus,
    /* 模型自己声明的 linkStatus，仅用于日志核对（我们最终以上面的实际校验结果为准） */
    declaredLinkStatus: declared,
    sources: srcs.list,
    sourceHosts: Object.keys(srcs.hosts),
    linkAudit: audit,
    /* 折叠区用：本次搜索返回的原始候选链接，未做连通性核验 */
    rawCandidateLinks: rawCandidateLinks,
    /* 三种状态之一：record_and_link / record_only / no_clue */
    outcome: outcomeOf(recordMeta, links),
    recordMeta: recordMeta,
    doi: normDoi(j.doi),
    year: year4(j.year),
    venue: str(j.venue),
    title: str(j.title),
    authors: au.list,
    authorsText: au.text,
    summary: str(j.summary).slice(0, 300),
    confidence: normConf(j.confidence),
    rawJson: j
  };
}

/* ---------------- 任务 A：结构化提取 ---------------- */

/**
 * @param {string} rawText 用户粘贴的参考文献原文
 * @param {object} opt {timeout}
 * @returns {Promise} base 对象 + fields
 */
function extract(rawText, opt) {
  opt = opt || {};
  var text = str(rawText);
  var cfg = config();
  if (!text) {
    var b = baseResult(cfg.modelExtract);
    b.apiUrl = cfg.base + PATH_CHAT;
    b.failureKind = 'input';
    b.failureDetail = '原始文献文本为空，未调用通义千问。';
    return Promise.resolve(b);
  }
  return chat(cfg.modelExtract, EXTRACT_PROMPT.SYSTEM, EXTRACT_PROMPT.buildUser(text), {
    timeout: opt.timeout, maxTokens: opt.maxTokens || 600
  }).then(function (r) {
    r.fields = r.ok ? normFields(r.json) : null;
    return r;
  });
}

/* ---------------- 任务 B：联网检索兜底 ---------------- */

/**
 * 日志：把「发给千问什么 / 本次提取的 recordMeta / 每条链接保留或丢弃的原因 / 三种状态」
 * 全部打印到云函数日志。
 *
 * 三种状态必须能一眼分清（需求 5）：
 *   ① record_and_link 查到文献信息 + 有效链接
 *   ② record_only    查到文献信息，但没有可用链接（【不许】据此判「未检索到」）
 *   ③ no_clue        完全没有检索线索
 *
 * 注意：平台不会回传它内部检索到的页面清单，所以这里的 sources 是【模型自己声明】的。
 */
function logSearchRound(input, model, r) {
  var v = r.verdict;
  try {
    console.log('[lfaVerify][qwen-search] 请求 ' + model +
      ' | 题名=' + str(input && input.title).slice(0, 80) +
      ' | 作者=' + str(input && input.authors).slice(0, 60) +
      ' | 年份=' + str(input && input.year) +
      ' | 出处=' + str(input && input.venue).slice(0, 50) +
      ' | DOI=' + str(input && input.doi));
    if (!r.ok) {
      console.log('[lfaVerify][qwen-search] 调用失败：' +
        (r.failureKind || '') + ' ' + str(r.failureDetail).slice(0, 120));
      return;
    }
    console.log('[lfaVerify][qwen-search] 触发联网检索=' + r.searched +
      '（' + r.searchCount + ' 次）｜耗时 ' + r.ms + 'ms');
    if (!v) { console.log('[lfaVerify][qwen-search] —— 状态③ no_clue：未能产出任何结论'); return; }

    /* ---- ① 本次提取的 recordMeta ---- */
    var rm = v.recordMeta || {};
    console.log('[lfaVerify][qwen-search] recordMeta 可信=' + rm.credible +
      (rm.partialRecovery ? '（模型输出被截断，为抢救出来的部分题录）' : '') +
      '｜来源名=' + (rm.sourceName || '（未给出）'));
    if (rm.title) console.log('    · 题名：' + rm.title.slice(0, 100));
    if (rm.authorsText) console.log('    · 作者：' + rm.authorsText.slice(0, 100));
    if (rm.year) console.log('    · 年份：' + rm.year);
    if (rm.venue) console.log('    · 出处：' + rm.venue);
    if (rm.doi) console.log('    · DOI：' + rm.doi);
    console.log('    · 摘要：' + (rm.hasAbstract
      ? ('有（' + rm.abstract.length + ' 字）')
      : '【本次搜索未提供，系统不补写】'));
    if (rm.fieldsAbsent && rm.fieldsAbsent.length) {
      console.log('    · 本次未拿到的字段（不补造）：' + rm.fieldsAbsent.join('、'));
    }
    if (!rm.credible) console.log('    · 不判为可信的原因：' + rm.reason);

    /* ---- ② 每条链接的保留 / 丢弃原因 ---- */
    console.log('[lfaVerify][qwen-search] 模型声明本次命中来源 ' + v.sources.length + ' 条：');
    for (var i = 0; i < v.sources.length; i++) {
      console.log('    · [' + v.sources[i].name + '] ' + v.sources[i].url);
    }
    console.log('[lfaVerify][qwen-search] 模型输出链接 ' + v.linkAudit.length + ' 条：');
    for (var k = 0; k < v.linkAudit.length; k++) {
      var a = v.linkAudit[k];
      console.log('    · ' + (a.kept ? '保留' : '丢弃') + ' | ' + a.url +
        ' | 来源=' + (a.source || '(未给出)') +
        (a.kept ? '' : ' | 原因=' + a.reason));
    }
    console.log('[lfaVerify][qwen-search] —— 链接可访问性实测：' +
      (v.probed ? '已逐个真实访问' : ('未执行：' + (v.probeSkippedReason || '未知原因'))));
    for (var m = 0; m < v.candidateLinks.length; m++) {
      console.log('    · 保留｜' + probeStateTextOf(v.candidateLinks[m]) + ' | ' +
        probeText(v.candidateLinks[m]) + ' | ' + v.candidateLinks[m].url);
    }
    console.log('[lfaVerify][qwen-search] 最终候选链接 ' + v.candidateLinks.length +
      ' 条，linkStatus=' + v.linkStatus + '（模型自评 ' + (v.declaredLinkStatus || '未给出') + '）');
    console.log('[lfaVerify][qwen-search] 原始候选链接（未做连通性核验，进核验卡折叠区）' +
      v.rawCandidateLinks.length + ' 条');

    /* ---- ③ 三种状态分开记 ---- */
    console.log('[lfaVerify][qwen-search] ===== 本次兜底状态：' + v.outcome +
      '（' + (OUTCOME_TEXT[v.outcome] || '') + '）' +
      (v.outcome === 'record_only'
        ? '｜查到题录但无可用链接，核验卡照常展示题录，【不】判未检索到' : '') +
      (v.outcome === 'no_clue' ? '｜本次搜索没有任何可信文献线索' : '') + ' =====');
  } catch (e) {
    /* 日志失败绝不能影响主流程 */
    console.log('[lfaVerify][qwen-search] 日志输出异常：' + ((e && e.message) || e));
  }
}

/**
 * 对模型给出的链接做【真实可访问性】探测（并行，受总预算约束）。
 *
 * 为什么非做不可（2026-10-31 实测）：
 *   即便在 prompt 里写得再狠，模型照样给出了 http://www.sciencep.com/book/4050
 *   ——看着像出版社书目详情页，真去访问：302 跳 https，落地 HTTP 404「页面没有找到」。
 *   格式校验、来源自述一致性都挡不住这种「页面存在就是不打开都编得像」的链接。
 *
 * 判定边界（宁可放过，不可错杀）：
 *   只有服务器【明确】返回 404 / 410 才判定「链接无效」并丢弃；
 *   403 / 401 / 429 / 5xx / 超时 / 网络失败一律标 unverified 并保留
 *   ——那可能只是站点拦爬虫或临时抽风，不能据此说人家是假链接。
 */
function probeLinks(links, opt) {
  opt = opt || {};
  var budget = opt.probeBudgetMs || 0;

  function markAll(kind, detail) {
    for (var i = 0; i < links.length; i++) {
      links[i].probe = { kind: kind, status: 0, detail: detail, finalUrl: links[i].url, ms: 0 };
    }
    return links;
  }

  if (!links.length) {
    return Promise.resolve({ links: links, dropped: [], probed: false, skippedReason: '没有可探测的链接' });
  }
  if (budget < 1200) {
    return Promise.resolve({
      links: markAll('skipped', '云函数剩余执行时间不足，未做可访问性探测（不代表链接无效）'),
      dropped: [], probed: false, skippedReason: '时间预算不足'
    });
  }

  var per = Math.max(1200, Math.min(7000, budget));
  var deadlineHit = false;
  var guard = null;
  try {
    guard = setTimeout(function () { deadlineHit = true; }, budget);
    if (guard.unref) guard.unref();
  } catch (e) { guard = null; }

  function race(p) {
    return Promise.race([
      p,
      new Promise(function (resolve) {
        var t = setTimeout(function () {
          resolve({ ok: false, kind: 'timeout', status: 0, detail: '超出本轮探测总预算，未能确认' });
        }, budget);
        if (t.unref) t.unref();
      })
    ]);
  }

  return Promise.all(links.map(function (l) { return race(http.probeReachable(l.url, { timeout: per })); }))
    .then(function (res) {
      if (guard) clearTimeout(guard);
      var kept = [];
      var dropped = [];
      for (var i = 0; i < links.length; i++) {
        var l = links[i];
        var p = res[i] || {};
        l.probe = {
          kind: p.kind || 'network',
          status: p.status || 0,
          finalUrl: p.finalUrl || l.url,
          redirects: (p.hops && p.hops.length > 1) ? p.hops.length - 1 : 0,
          detail: p.detail || '',
          ms: p.ms || 0,
          tlsLenient: !!p.tlsLenient
        };
        if (p.kind === 'not_found') dropped.push(l);
        else kept.push(l);
      }
      return { links: kept, dropped: dropped, probed: true, deadlineHit: deadlineHit };
    });
}

/** 把探测结论翻译给用户看 */
var PROBE_TEXT = {
  ok: '已实测可访问',
  not_found: '实测 404，链接无效（已丢弃）',
  unverified: '未能确认（站点拦截或临时故障）',
  timeout: '未能确认（超时）',
  network: '未能确认（网络不通）',
  skipped: '未做可访问性探测（时间不足）'
};

function probeText(l) {
  var k = (l && l.probe && l.probe.kind) || 'skipped';
  var s = PROBE_TEXT[k] || '未探测';
  if (l && l.probe && l.probe.status) s += '（HTTP ' + l.probe.status + '）';
  return s;
}

/**
 * @param {object} input {title, authors, year, venue, doi, volume, issue, pages, raw}
 * @param {object} opt {timeout, model, probeBudgetMs}
 *   model：不传则用环境变量 QWEN_MODEL_SEARCH 配置的模型（默认 qwen-plus）。
 *          实测同一条冷门中文专著：plus 约 9.5s 且链接多为真实来源；
 *          flash 只要 3.7s 但会给出拼凑的假链接，因此【默认不降级到 flash】。
 *   probeBudgetMs：留给「链接可达性探测」的时间预算，不传则不探测。
 * @returns {Promise} base 对象 + verdict
 */
function searchVerify(input, opt) {
  opt = opt || {};
  var cfg = config();
  var model = (typeof opt.model === 'string' && opt.model) ? opt.model : cfg.modelSearch;
  /* max_tokens：配合 prompt 里「links 最多 2 条、说明 ≤16 字、摘要 ≤150 字」的硬约束。
   * 实测把上限放宽反而诱导模型输出更长、被 finish_reason=length 截断，
   * 截断后整条 JSON 作废。现在除了收紧输出，再加一层「截断抢救」：
   * 真被截断时按字段把题录抠出来，至少不让已搜到的题录一起丢掉。 */
  return chat(model, SEARCH_PROMPT.SYSTEM, SEARCH_PROMPT.buildUser(input), {
    timeout: opt.timeout, maxTokens: opt.maxTokens || 1000, enableSearch: true
  }).then(function (r) {
    if (r.ok) {
      r.verdict = normVerdict(r.json, { searched: !!r.searched });
    } else if (r.failureKind === 'parse' && r.content) {
      /* 多半是输出被截断：抢救题录，保住 recordMeta（partialRecovery=true 会如实标注） */
      var rec = recoverRecordMeta(r.content, { searched: !!r.searched });
      if (rec) {
        r.verdict = {
          exists: 'uncertain',
          candidateLinks: [],
          linkStatus: 'url_not_found',
          declaredLinkStatus: '',
          sources: [], sourceHosts: [], linkAudit: [],
          rawCandidateLinks: [],
          outcome: 'record_only',
          recordMeta: rec,
          doi: rec.doi, year: rec.year, venue: rec.venue, title: rec.title,
          authors: [], authorsText: '', summary: rec.declaredSummary,
          confidence: null, rawJson: null,
          truncated: true
        };
        r.truncatedRecovery = true;
        r.probed = false;
        r.probeSkippedReason = '模型输出被截断，未完成链接解析';
      }
    }
    if (!r.verdict) {
      /* JSON 作废且抢救不出任何题录 → 如实失败，不伪造结论 */
      if (opt.silentLog !== true) logSearchRound(input, model, r);
      return r;
    }
    /* 走到这里有两种情况：正常解析成功（r.ok=true），
     * 或输出被截断后抢救出了部分题录（r.ok=false 但 verdict 非空，r.truncatedRecovery=true）。 */
    return probeLinks(r.verdict.candidateLinks, opt).then(function (pr) {
      var v = r.verdict;
      v.candidateLinks = pr.links;
      /* 探测之后重新定 linkStatus：一条都没剩下就是 url_not_found。
       * 【注意】linkStatus 只描述链接，不再决定「有没有查到文献」——那是 recordMeta 的事。 */
      v.linkStatus = v.candidateLinks.length ? 'ok' : 'url_not_found';
      v.probed = pr.probed;
      v.probeSkippedReason = pr.skippedReason || '';
      /* 每条链接标出展示区归属：ok = 主展示；其余 = 保留但标「暂无法验证连通性」 */
      for (var n = 0; n < v.candidateLinks.length; n++) {
        v.candidateLinks[n].probeState = probeStateOf(v.candidateLinks[n]);
        v.candidateLinks[n].probeStateText = probeStateTextOf(v.candidateLinks[n]);
      }
      /* 被 404 淘汰的链接也要留下证据：用户得知道「原来有一条，为什么没了」 */
      for (var i = 0; i < pr.dropped.length; i++) {
        v.linkAudit.push({
          url: pr.dropped[i].url, source: pr.dropped[i].source,
          kept: false,
          reason: '可访问性探测：' + probeText(pr.dropped[i]) +
            (pr.dropped[i].probe && pr.dropped[i].probe.detail ? '｜' + pr.dropped[i].probe.detail : '')
        });
      }
      /* 题录一旦定下来就不受链接影响；outcome 只在最后重新算一次（顺便带上真实候选链接数） */
      if (v.recordMeta && v.recordMeta.partialRecovery && v.candidateLinks.length) {
        v.recordMeta.partialRecovery = false;
      }
      v.outcome = outcomeOf(v.recordMeta, v.candidateLinks);
      v.rawCandidateLinks = normRawCandidates(v.sources, v.candidateLinks, v.linkAudit);
      if (opt.silentLog !== true) logSearchRound(input, model, r);
      return r;
    });
  });
}

/* ---------------- 任务 C：检索式规划 ---------------- */

var MAX_PLAN_WORDS = 8;
var MAX_PLAN_QUERIES = 5;

/** 任务 D 里允许的「用途」取值（只允许这三个，模型给别的就丢） */
var USES = ['了解背景', '借鉴方法', '寻找直接相关研究'];

/** 「因为年份新所以更好」这类表述（不能作为匹配点，见 normAnalysis 里的说明） */
var RECENCY_PRAISE = /(年份较近|年份新|较新|最新发表|最新研究|近年|最近发表|出版年份较近|发表时间新)/;

/** 字符串数组归一化：去重、截长度、限条数 */
function strList(v, max, charMax) {
  var arr = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
  var out = [];
  for (var i = 0; i < arr.length && out.length < max; i++) {
    var s = str(arr[i]);
    if (!s) continue;
    if (charMax && s.length > charMax) s = s.slice(0, charMax);
    if (out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

/**
 * 去掉「可信度 / 匹配度百分数」。
 * 依据：需求明确要求「不使用未经验证的可信度或匹配度百分数」——这类数字无从验证，
 * 与其让模型编一个 87%，不如把这句话删掉；删完为空则该字段不计入。
 */
function stripPercent(s) {
  var before = String(s || '');
  var out = before
    .replace(/\d+(\.\d+)?\s*%/g, '')
    .replace(/百分之\s*[零〇一二三四五六七八九十百\d]+/g, '')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[、，,；;.\s]+|[、，,；;.\s]+$/g, '')
    .trim();
  return { text: out, hit: out !== before.trim() };
}

/**
 * 任务 C 输出 → 检索式计划。
 * 机器校验：检索式里不得出现链接 / DOI（那说明模型把「某篇文献」当成检索式输出了）。
 */
function normPlan(j) {
  j = j || {};
  var dropped = [];
  var queries = [];
  var raw = Array.isArray(j.queries) ? j.queries : [];

  for (var i = 0; i < raw.length && queries.length < MAX_PLAN_QUERIES; i++) {
    var it = raw[i] || {};
    var text = str(typeof it === 'string' ? it : it.text);
    if (!text) { dropped.push({ text: '', reason: '空检索式' }); continue; }
    /* 含链接或 DOI —— 这不是检索式，而是模型偷渡出来的文献条目 */
    if (/https?:\/\//i.test(text) || /10\.\d{4,9}\//.test(text)) {
      dropped.push({ text: text, reason: '含链接 / DOI，疑似文献条目而不是检索式（已丢弃）' });
      continue;
    }
    if (text.length > 120) text = text.slice(0, 120);
    var lang = str(it.lang).toLowerCase();
    if (lang !== 'zh' && lang !== 'en') lang = T.hasCjk(text) ? 'zh' : 'en';
    queries.push({ text: text, lang: lang, why: str(it.why).slice(0, 40) });
  }

  return {
    keywords: strList(j.keywords, MAX_PLAN_WORDS, 24),
    synonyms: strList(j.synonyms, MAX_PLAN_WORDS, 40),
    queries: queries,
    dropped: dropped,
    scopeNote: str(j.scopeNote).slice(0, 120)
  };
}

/** 任务 C 日志：把「模型给了什么检索式、哪些被丢」打进云函数日志 */
function logPlanRound(topic, model, r) {
  try {
    console.log('[lfaVerify][qwen-plan] 请求 ' + model +
      '（未开联网检索）｜课题=' + str(topic && topic.name).slice(0, 60));
    if (!r.ok) {
      console.log('[lfaVerify][qwen-plan] 调用失败：' + (r.failureKind || '') +
        ' ' + str(r.failureDetail).slice(0, 120));
      return;
    }
    var p = r.plan || {};
    console.log('[lfaVerify][qwen-plan] 关键词 ' + (p.keywords || []).length +
      ' 个：' + (p.keywords || []).join('、'));
    console.log('[lfaVerify][qwen-plan] 同义词 ' + (p.synonyms || []).length +
      ' 个：' + (p.synonyms || []).join('、'));
    var qs = p.queries || [];
    console.log('[lfaVerify][qwen-plan] 检索式 ' + qs.length + ' 条：');
    for (var i = 0; i < qs.length; i++) {
      console.log('    · [' + qs[i].lang + '] ' + qs[i].text +
        (qs[i].why ? '（' + qs[i].why + '）' : ''));
    }
    for (var k = 0; k < (p.dropped || []).length; k++) {
      console.log('    · 丢弃 | ' + p.dropped[k].text + ' | 原因=' + p.dropped[k].reason);
    }
  } catch (e) {
    console.log('[lfaVerify][qwen-plan] 日志输出异常：' + ((e && e.message) || e));
  }
}

/**
 * @param {object} topic 课题
 * @param {string} hints 用户补充的「这次想找什么」
 * @param {object} opt {timeout, model}
 */
function planQueries(topic, hints, opt) {
  opt = opt || {};
  var cfg = config();
  var model = (typeof opt.model === 'string' && opt.model) ? opt.model : cfg.modelPlan;
  return chat(model, PLAN_PROMPT.SYSTEM, PLAN_PROMPT.buildUser(topic, hints), {
    timeout: opt.timeout, maxTokens: opt.maxTokens || 700, enableSearch: false
  }).then(function (r) {
    r.plan = r.ok ? normPlan(r.json) : null;
    if (opt.silentLog !== true) logPlanRound(topic, model, r);
    return r;
  });
}

/* ---------------- 任务 D：候选与课题的关系分析 ---------------- */

/**
 * 任务 D 输出 → 分析结论。
 * 机器校验三条：
 *   ① id 必须是本次真实检索到的候选（模型自行补的条目一律丢）；
 *   ② 去掉所有百分数（可信度 / 匹配度百分比无法验证）；
 *   ③ 空理由的条目不进推荐清单。
 */
function normAnalysis(j, cands) {
  j = j || {};
  var ids = {};
  for (var c = 0; c < (cands || []).length; c++) ids[str(cands[c].id)] = cands[c];

  var items = [];
  var dropped = [];
  var percentHit = 0;
  var recencyHit = 0;
  var raw = Array.isArray(j.items) ? j.items : [];

  function cleanArr(v, max, charMax) {
    var out = [];
    var arr = Array.isArray(v) ? v : [];
    for (var i = 0; i < arr.length && out.length < max; i++) {
      var r = stripPercent(arr[i]);
      if (r.hit) percentHit++;
      var s = r.text.slice(0, charMax);
      if (s && out.indexOf(s) < 0) out.push(s);
    }
    return out;
  }

  /**
   * 「近年 / 最新发表」不是优势——需求明确要求【不把"近年"自动当作"更可信"】。
   * 实测模型会把「出版年份较近（2023）」写进匹配点，等于把发表时间当成可信度，
   * 因此这里把这类表述从【匹配点】里剔除（写在「差异 / 仍需验证」里是允许的，
   * 例如「2023 年的数据是否覆盖本课题地区」）。
   */
  function cleanMatch(v) {
    return cleanArr(v, 3, 40).filter(function (s) {
      if (RECENCY_PRAISE.test(s)) { recencyHit++; return false; }
      return true;
    });
  }

  for (var k = 0; k < raw.length && items.length < 8; k++) {
    var it = raw[k] || {};
    var id = str(it.id);
    if (!id || !ids[id]) {
      dropped.push({ id: id, reason: '编号不在本次真实检索到的候选里（疑似模型自行补的条目）' });
      continue;
    }
    var whyR = stripPercent(it.why);
    if (whyR.hit) percentHit++;
    var why = whyR.text.slice(0, 60);
    var match = cleanMatch(it.match);
    var gap = cleanArr(it.gap, 3, 40);
    var todo = cleanArr(it.todo, 3, 40);

    var uses = [];
    var us = Array.isArray(it.uses) ? it.uses : [];
    for (var u = 0; u < us.length; u++) {
      var s = str(us[u]);
      if (USES.indexOf(s) >= 0 && uses.indexOf(s) < 0) uses.push(s);
    }

    if (!match.length && !why) {
      dropped.push({ id: id, reason: '没有给出任何可核对的推荐理由（已丢弃，归入待阅读线索）' });
      continue;
    }
    items.push({
      id: id, match: match, gap: gap, todo: todo, uses: uses,
      usesEmpty: !uses.length, why: why
    });
  }

  return {
    items: items,
    dropped: dropped,
    percentRemoved: percentHit,
    /* 被剔除的「因为年份新所以更好」类表述条数（如实记录，不悄悄删） */
    recencyRemoved: recencyHit,
    note: str(j.note).slice(0, 120)
  };
}

/** 任务 D 日志：模型【收到了哪些真实候选】+【输出了哪些条目】 */
function logAnalyzeRound(model, cands, r) {
  try {
    var cs = cands || [];
    console.log('[lfaVerify][qwen-analyze] 请求 ' + model +
      '（未开联网检索）｜输入候选 ' + cs.length + ' 条');
    for (var i = 0; i < cs.length; i++) {
      console.log('    · ' + cs[i].id + ' | 摘要：' + (cs[i].abstract ? '有（' +
        String(cs[i].abstract).length + ' 字）' : '【该来源未提供】') +
        ' | ' + str(cs[i].title).slice(0, 50));
    }
    if (!r.ok) {
      console.log('[lfaVerify][qwen-analyze] 调用失败：' + (r.failureKind || '') +
        ' ' + str(r.failureDetail).slice(0, 120));
      return;
    }
    var a = r.analysis || {};
    console.log('[lfaVerify][qwen-analyze] 模型输出条目 ' + ((a.items || []).length +
      (a.dropped || []).length) + ' 条，保留 ' + (a.items || []).length + ' 条' +
      '（去掉百分数 ' + (a.percentRemoved || 0) + ' 处' +
      '，去掉「年份新=更好」表述 ' + (a.recencyRemoved || 0) + ' 处）：');
    for (var k = 0; k < (a.items || []).length; k++) {
      console.log('    · 保留 | ' + a.items[k].id + ' | 用途=' +
        ((a.items[k].uses || []).join('、') || '未给出') + ' | ' + (a.items[k].why || ''));
    }
    for (var d = 0; d < (a.dropped || []).length; d++) {
      console.log('    · 丢弃 | ' + a.dropped[d].id + ' | 原因=' + a.dropped[d].reason);
    }
  } catch (e) {
    console.log('[lfaVerify][qwen-analyze] 日志输出异常：' + ((e && e.message) || e));
  }
}

/**
 * @param {object} topic 课题
 * @param {Array} cands 真实检索到的候选（已裁剪）
 * @param {object} opt {timeout, model}
 */
function analyzeCandidates(topic, cands, opt) {
  opt = opt || {};
  var cfg = config();
  var model = (typeof opt.model === 'string' && opt.model) ? opt.model : cfg.modelAnalyze;
  return chat(model, ANALYZE_PROMPT.SYSTEM, ANALYZE_PROMPT.buildUser(topic, cands), {
    timeout: opt.timeout, maxTokens: opt.maxTokens || 1400, enableSearch: false
  }).then(function (r) {
    r.analysis = r.ok ? normAnalysis(r.json, cands) : null;
    if (opt.silentLog !== true) logAnalyzeRound(model, cands, r);
    return r;
  });
}

/* ---------------- 任务 E：课题适配 + 主张核验 ---------------- */

/**
 * 调用模型做适配分析，【只返回原始 JSON】，不做归一化。
 * 归一化（摘录定位、用途白名单、百分数剔除）全部在 adapt.js 里做，
 * 这样 qwen.js 不反向依赖 adapt.js，避免循环引用。
 *
 * @param {object} topic 课题
 * @param {object} ref 文献条目
 * @param {Array} materials 本次可用材料（已裁剪长度）
 * @param {object} opt {timeout, maxTokens, model}
 */
function fitRaw(topic, ref, materials, opt) {
  opt = opt || {};
  var cfg = config();
  var model = (typeof opt.model === 'string' && opt.model) ? opt.model : cfg.modelAnalyze;
  /* 【不开联网检索】：这一条链路只允许依据用户提供的材料说话，
   * 开联网会让模型把它在网上看到的论文混进「原文摘录」里。 */
  return chat(model, ADAPT_PROMPT.SYSTEM, ADAPT_PROMPT.buildUser(topic, ref, materials), {
    timeout: opt.timeout, maxTokens: opt.maxTokens || 1200, enableSearch: false
  }).then(function (r) {
    if (opt.silentLog !== true) {
      console.log('[lfaVerify][qwen-fit] 请求 ' + model + '（未开联网检索）｜材料 ' +
        (materials || []).length + ' 份｜' + (r.ok ? ('耗时 ' + r.ms + 'ms') : ('失败 ' + (r.failureKind || ''))));
    }
    return r;
  });
}

module.exports = {
  PROVIDER: PROVIDER,
  config: config,
  available: available,
  extract: extract,
  searchVerify: searchVerify,
  planQueries: planQueries,
  analyzeCandidates: analyzeCandidates,
  fitRaw: fitRaw,
  parseJsonLoose: parseJsonLoose,
  normFields: normFields,
  normVerdict: normVerdict,
  normRecordMeta: normRecordMeta,
  normRawCandidates: normRawCandidates,
  recoverRecordMeta: recoverRecordMeta,
  outcomeOf: outcomeOf,
  probeStateOf: probeStateOf,
  probeStateTextOf: probeStateTextOf,
  OUTCOME_TEXT: OUTCOME_TEXT,
  PROBE_STATE_TEXT: PROBE_STATE_TEXT,
  LINK_KINDS: LINK_KINDS,
  normPlan: normPlan,
  normAnalysis: normAnalysis,
  strList: strList,
  stripPercent: stripPercent,
  USES: USES,
  DEFAULT_BASE: DEFAULT_BASE,
  PATH_CHAT: PATH_CHAT
};
