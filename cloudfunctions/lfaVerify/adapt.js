'use strict';
/**
 * 任务 E：课题适配 + 拟引用主张核验
 * ============================================================================
 * 与前面几步的分工：
 *   - 「核验身份」：OpenAlex / Crossref / 千问联网检索 → 题录对不对（第二阶段）
 *   - 「帮我找文献」：Crossref / OpenAlex 真实检索 → 候选从哪来（第三阶段）
 *   - 「课题适配与主张核验」（本文件）：课题要求 vs 文献【实际做了什么】的逐项对照
 *
 * 诚实边界（本文件的三条铁律）：
 *   1. 【只使用实际取得的材料】题录、来源摘要、用户粘贴的原文节选。
 *      系统【从未】抓取过全文，因此任何结论都不能以「全文写了…」为依据。
 *   2. 【摘录必须可定位】模型给出的每条摘录，都要回到用户提供的源文本里定位；
 *      定位不到的，一律标「未能在提供的材料中定位」并判为【证据不足】，
 *      绝不拿一句找不到出处的摘录去支持某个主张。
 *   3. 【只有摘要就不为全文背书】材料只有摘要时，整体标注「基于摘要初筛」，
 *      并在每一处展示里带上这个限定。
 *
 * 机器校验（不靠 prompt 自觉）：
 *   - 摘录定位（locateIn）         —— 决定这条证据能不能用
 *   - 用途取值白名单               —— 含「可借鉴方法但不能作为目标场景效果的直接证据」
 *   - 百分数剔除                   —— 匹配度 / 可信度百分比无从验证
 *   - 下一轮检索式不得含链接 / DOI  —— 那是文献条目，不是检索式
 *   - 「近年发表」不进匹配点        —— 发表时间不等于更可信
 */

var T = require('./lib/text.js');
var http = require('./lib/http.js');
var qwen = require('./sources/qwen.js');

/* 材料长度门槛（机械判定，不由模型自述）
 * 摘要沿用「帮我找文献」的口径：不足 120 字视为残摘要，不足以支撑内容判断。 */
var MIN_ABSTRACT_LEN = 120;
var MIN_EXCERPT_LEN = 60;   // 节选至少 60 字才当作「读了原文的一部分」

var DIMENSIONS = [
  { key: 'object', label: '研究对象 / 场景' },
  { key: 'task', label: '做了什么任务' },
  { key: 'condition', label: '条件 / 范围 / 数据' },
  { key: 'result', label: '主要结果 / 结论' }
];

/** 用途白名单：模型给别的取值就丢，绝不出现在界面上 */
var USAGE = {
  direct: {
    text: '可作为本课题目标场景的直接证据',
    tone: 'ok',
    hint: '对象、任务、条件都对得上时才可以选这项'
  },
  method_only: {
    text: '可借鉴方法，但不能作为目标场景效果的直接证据',
    tone: 'purple',
    hint: '研究对象或场景不同 ≠ 没用：方法、实验设计可以参考，但效果数字不能照搬'
  },
  background: {
    text: '只宜作研究背景 / 综述引用',
    tone: 'gray',
    hint: '只在主题层面相关，不承担本课题的关键论点'
  },
  insufficient: {
    text: '材料不足，无法判断用途',
    tone: 'gray',
    hint: '先补齐摘要或原文节选再判断'
  }
};

var CLAIM_VERDICT = {
  supported: { text: '材料支持该说法', tone: 'ok' },
  partial: { text: '材料部分支持（有条件）', tone: 'warn' },
  not_supported: { text: '材料不支持该说法', tone: 'orange' },
  insufficient: { text: '证据不足', tone: 'gray' }
};

var DIM_VERDICT = {
  match: { text: '一致', tone: 'ok' },
  partial: { text: '部分一致', tone: 'warn' },
  mismatch: { text: '不一致', tone: 'orange' },
  unknown: { text: '材料未提供，无法判断', tone: 'gray' }
};

var EVIDENCE_LEVEL = {
  excerpt: {
    text: '已提供原文节选',
    scope: '仅限你粘贴的这部分原文，未读全文'
  },
  abstract: {
    text: '基于摘要初筛',
    scope: '只有来源摘要，未读全文，不能为全文内容背书'
  },
  citation: {
    text: '只有题录',
    scope: '连摘要都没有，只能按题名 / 出处做最基础的判断'
  }
};

/** 「因为年份新所以更好」这类表述（不能作为匹配点） */
var RECENCY_PRAISE = /(年份较近|年份新|较新|最新发表|最新研究|近年|最近发表|出版年份较近|发表时间新|较新发表)/;

/* ==========================================================================
 *  材料准备
 * ========================================================================== */

/**
 * 从文献条目里取出【本次实际可用】的材料。
 * 只有两类：用户粘贴的原文节选、来源返回的摘要。题录不算「读过内容」的依据。
 */
function buildMaterials(ref) {
  var ev = (ref && ref.evidence) || {};
  var out = [];
  var excerpt = T.trim(ev.excerpt);
  if (excerpt) {
    /* 节选区如果装的是「从来源补全的摘要」（excerptOrigin='abstract'），
     * 必须仍按摘要计：否则会把「读过摘要」说成「读过原文节选」，属于虚报阅读范围。 */
    var fromAbstract = ev.excerptOrigin === 'abstract';
    out.push({
      id: 'm1',
      kind: fromAbstract ? 'abstract' : 'excerpt',
      label: fromAbstract ? '来源返回的摘要（补全到材料区，仍是摘要）' : '用户粘贴的原文节选',
      text: excerpt, chars: excerpt.length
    });
  }
  var abstract = T.trim(ev.abstract);
  if (abstract && !(out.length && out[0].text === abstract)) {
    out.push({ id: 'm2', kind: 'abstract', label: '来源返回的摘要', text: abstract, chars: abstract.length });
  }
  return out;
}

/**
 * 阅读范围与证据等级（系统机械判定，不是模型自述）。
 * 只有题录 → 直接判 no_material，不做任何 AI 分析。
 */
function evidenceLevelOf(materials) {
  var hasExcerpt = false, hasAbstract = false;
  for (var i = 0; i < materials.length; i++) {
    var m = materials[i] || {};
    var len = m.chars || (m.text || '').length;
    if (m.kind === 'excerpt' && len >= MIN_EXCERPT_LEN) hasExcerpt = true;
    if (m.kind === 'abstract' && len >= MIN_ABSTRACT_LEN) hasAbstract = true;
  }
  var level = hasExcerpt ? 'excerpt' : (hasAbstract ? 'abstract' : 'citation');
  return {
    level: level,
    text: EVIDENCE_LEVEL[level].text,
    scope: EVIDENCE_LEVEL[level].scope,
    hasExcerpt: hasExcerpt,
    hasAbstract: hasAbstract
  };
}

/** 交给模型的材料（截断到可控长度，避免超时；截断会如实标注） */
var EXCERPT_FOR_MODEL = 1200;
var ABSTRACT_FOR_MODEL = 600;

function materialsForModel(materials) {
  return materials.map(function (m) {
    var text = m.text;
    var cap = m.kind === 'excerpt' ? EXCERPT_FOR_MODEL : ABSTRACT_FOR_MODEL;
    var truncated = text.length > cap;
    return {
      id: m.id, kind: m.kind, label: m.label,
      text: truncated ? text.slice(0, cap) : text,
      truncated: truncated, chars: m.chars
    };
  });
}

/* ==========================================================================
 *  摘录定位：这条证据到底能不能用
 * ========================================================================== */

/** 定位用的归一化：去空白、去标点，只留字 */
function squish(s) {
  return String(s || '').toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、“”‘’（）()【】\[\]《》<>!?？！.,;:'"\-—_·]/g, '');
}

/**
 * 在材料里定位一条摘录。
 * 三级匹配：① 原文直接子串 ② 归一化后子串 ③ 按标点切片段，命中率 ≥70% 算部分定位。
 * @returns {null|{materialId:string, kind:string, label:string, exact:boolean, ratio:number}}
 */
function locateIn(materials, quote) {
  var q = T.trim(quote);
  if (!q) return null;
  for (var i = 0; i < materials.length; i++) {
    var m = materials[i] || {};
    var t = m.text || '';
    if (!t) continue;

    if (t.indexOf(q) >= 0) {
      return { materialId: m.id, kind: m.kind, label: m.label, exact: true, ratio: 1 };
    }
    var nq = squish(q), nt = squish(t);
    if (nq && nt.indexOf(nq) >= 0) {
      return { materialId: m.id, kind: m.kind, label: m.label, exact: false, ratio: 1 };
    }
    var parts = q.split(/[，。；：！？、\n\r]/).filter(function (p) { return T.trim(p).length >= 4; });
    if (parts.length) {
      var hit = 0;
      for (var k = 0; k < parts.length; k++) {
        var np = squish(parts[k]);
        if (np && nt.indexOf(np) >= 0) hit++;
      }
      var ratio = hit / parts.length;
      if (ratio >= 0.7) {
        return { materialId: m.id, kind: m.kind, label: m.label, exact: false, ratio: ratio };
      }
    }
  }
  return null;
}

/** 定位结论 → 展示文案（定位失败一律说清「没找到出处」，不粉饰） */
function locateText(loc) {
  if (!loc) return '未能在你提供的材料里定位到这段摘录（证据不足）';
  if (loc.exact) return '已在「' + loc.label + '」中定位到（原文一致）';
  if (loc.ratio >= 1) return '已在「' + loc.label + '」中定位到（忽略标点与空格后一致）';
  return '在「' + loc.label + '」中部分定位到（命中 ' + Math.round(loc.ratio * 100) + '% 片段，请人工核对）';
}

/* ==========================================================================
 *  输出归一化（机器校验）
 * ========================================================================== */

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

/** 剥掉百分数后只剩这些词 → 整句没有信息量，直接丢弃（否则界面上会出现孤零零的「匹配度」） */
var SCORE_WORD_ONLY = /^(匹配度|可信度|置信度|相似度|相关度|得分|评分|支持度|契合度|度)$/;

function strList(v, max, charMax, opt) {
  opt = opt || {};
  var arr = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
  var out = [];
  var dropped = [];
  for (var i = 0; i < arr.length && out.length < max; i++) {
    var r = stripPercent(T.trim(arr[i]));
    if (r.hit && opt.onPercent) opt.onPercent(arr[i]);
    var s = r.text.slice(0, charMax);
    if (!s) continue;
    /* 本来就是一句「匹配度 87%」：删掉数字后没内容可言，整条丢弃 */
    if (r.hit && (SCORE_WORD_ONLY.test(s) || s.length < 4)) {
      if (opt.onPercent) opt.onPercent(arr[i]);
      dropped.push({ text: String(arr[i] || '').slice(0, 40), reason: '整句只是一个匹配度 / 可信度百分数，已丢弃' });
      continue;
    }
    /* 「近年 / 最新发表」不是优势，不许进匹配点 */
    if (opt.noRecency && RECENCY_PRAISE.test(s)) {
      if (opt.onRecency) opt.onRecency(s);
      continue;
    }
    if (out.indexOf(s) < 0) out.push(s);
  }
  if (arr.length > max) {
    for (var k = max; k < arr.length; k++) dropped.push({ text: String(arr[k] || '').slice(0, 40), reason: '超出条数上限' });
  }
  return { list: out, dropped: dropped };
}

/**
 * 模型输出 → 适配结论（含逐条摘录定位）。
 * @param {object} j   模型 JSON
 * @param {object} ctx {materials, level, claims, dropped}
 */
function normFit(j, ctx) {
  j = j || {};
  ctx = ctx || {};
  var materials = ctx.materials || [];
  var dropped = ctx.dropped || [];
  var stats = { quotes: 0, located: 0, unlocated: 0, percentRemoved: 0, recencyRemoved: 0 };

  /** 一条摘录 → 带定位结论的证据项 */
  function normQuote(raw, charMax) {
    var text = T.trim(typeof raw === 'string' ? raw : (raw && raw.text));
    if (!text) return null;
    var r = stripPercent(text);
    if (r.hit) stats.percentRemoved++;
    text = r.text.slice(0, charMax);
    if (!text) return null;
    var loc = locateIn(materials, text);
    stats.quotes++;
    if (loc) stats.located++; else stats.unlocated++;
    return {
      text: text,
      locator: T.trim(typeof raw === 'string' ? '' : (raw && raw.locator)).slice(0, 40) || '',
      located: !!loc,
      locateText: locateText(loc),
      materialId: loc ? loc.materialId : '',
      materialLabel: loc ? loc.label : '',
      materialKind: loc ? loc.kind : '',
      ratio: loc ? loc.ratio : 0
    };
  }

  /* ---- ① 四个维度逐项对照 ---- */
  var dims = [];
  var rawDims = Array.isArray(j.dimensions) ? j.dimensions : [];
  var dimById = {};
  for (var d = 0; d < rawDims.length; d++) {
    var rd = rawDims[d] || {};
    var key = T.trim(rd.key);
    if (!dimById[key]) dimById[key] = rd;
  }
  for (var i = 0; i < DIMENSIONS.length; i++) {
    var def = DIMENSIONS[i];
    var rd2 = dimById[def.key] || {};
    var verdict = T.trim(rd2.verdict);
    if (['match', 'partial', 'mismatch', 'unknown'].indexOf(verdict) < 0) verdict = 'unknown';

    var quotes = [];
    var rawQ = Array.isArray(rd2.quotes) ? rd2.quotes : [];
    for (var q = 0; q < rawQ.length && quotes.length < 2; q++) {
      var nq = normQuote(rawQ[q], 80);
      if (nq) quotes.push(nq);
    }

    /* 判定为「一致 / 部分一致」却拿不出一条可定位的摘录 → 降为 unknown。
     * 没有证据支撑的结论不能展示成结论。 */
    var locatedCount = quotes.filter(function (x) { return x.located; }).length;
    var downgraded = false;
    if ((verdict === 'match' || verdict === 'partial') && !locatedCount) {
      verdict = 'unknown';
      downgraded = true;
    }

    dims.push({
      key: def.key,
      label: def.label,
      topicText: stripPercent(T.trim(rd2.topicText)).text.slice(0, 60) || '（模型未给出）',
      actualText: stripPercent(T.trim(rd2.actualText)).text.slice(0, 80) || '材料未提供',
      verdict: verdict,
      verdictText: DIM_VERDICT[verdict].text,
      tone: DIM_VERDICT[verdict].tone,
      quotes: quotes,
      hasQuotes: quotes.length > 0,
      note: stripPercent(T.trim(rd2.note)).text.slice(0, 60),
      downgraded: downgraded,
      downgradeText: downgraded ? '模型原本给了判定，但没能给出可在你材料中定位到的摘录，已降为「无法判断」' : ''
    });
  }

  /* ---- ② 匹配点 / 差异 ---- */
  var matches = strList(j.matches, 3, 40, {
    noRecency: true,
    onPercent: function () { stats.percentRemoved++; },
    onRecency: function (s) { stats.recencyRemoved++; dropped.push({ text: s, reason: '「近年 / 最新发表」不是优势，不能作为匹配点' }); }
  });
  var gaps = strList(j.gaps, 3, 40, {
    onPercent: function () { stats.percentRemoved++; }
  });
  for (var g = 0; g < matches.dropped.length; g++) dropped.push(matches.dropped[g]);

  /* ---- ③ 用途建议（白名单） ---- */
  var usage = null;
  var ru = j.usage || {};
  var uv = T.trim(typeof ru === 'string' ? ru : ru.value);
  if (!USAGE[uv]) {
    dropped.push({ text: '用途取值 ' + (uv || '（空）'), reason: '不在允许用途白名单内，已丢弃' });
    uv = 'insufficient';
  }
  usage = {
    value: uv,
    text: USAGE[uv].text,
    tone: USAGE[uv].tone,
    hint: USAGE[uv].hint,
    why: stripPercent(T.trim(typeof ru === 'string' ? '' : ru.why)).text.slice(0, 60),
    caveat: stripPercent(T.trim(j.caveat)).text.slice(0, 60),
    /* 这是模型的建议，不是最终结论——用户可以改，改完另存一层 */
    byAi: true
  };

  /* ---- ④ 拟引用主张核验 ---- */
  var claims = [];
  var rawClaims = Array.isArray(j.claims) ? j.claims : [];
  var knownIds = {};
  for (var c0 = 0; c0 < (ctx.claims || []).length; c0++) knownIds[ctx.claims[c0].id] = ctx.claims[c0];
  for (var c = 0; c < rawClaims.length && claims.length < 3; c++) {
    var rc = rawClaims[c] || {};
    var cid = T.trim(rc.claimId);
    /* 模型自己编的主张 id 一律丢：只核用户真的写下的说法 */
    if (!knownIds[cid]) {
      dropped.push({ text: '主张 ' + (cid || '（空）'), reason: '编号不是用户填写的主张，已丢弃' });
      continue;
    }
    var cv = T.trim(rc.verdict);
    if (!CLAIM_VERDICT[cv]) cv = 'insufficient';

    var cq = [];
    var rcq = Array.isArray(rc.quotes) ? rc.quotes : [];
    for (var c2 = 0; c2 < rcq.length && cq.length < 2; c2++) {
      var item = normQuote(rcq[c2], 120);
      if (item) cq.push(item);
    }
    var locatedQ = cq.filter(function (x) { return x.located; });
    var claimDowngraded = false;
    var claimOriginal = cv;
    /* 支持 / 部分支持必须有至少一条能定位的摘录；定位不到就是证据不足 */
    if ((cv === 'supported' || cv === 'partial') && !locatedQ.length) {
      cv = 'insufficient';
      claimDowngraded = true;
    }
    claims.push({
      claimId: cid,
      claimText: knownIds[cid].text,
      verdict: cv,
      verdictText: CLAIM_VERDICT[cv].text,
      tone: CLAIM_VERDICT[cv].tone,
      quotes: cq,
      hasQuotes: cq.length > 0,
      locatedCount: locatedQ.length,
      note: stripPercent(T.trim(rc.note)).text.slice(0, 60),
      downgraded: claimDowngraded,
      downgradeText: claimDowngraded
        ? '模型原本判「' + (CLAIM_VERDICT[claimOriginal] ? CLAIM_VERDICT[claimOriginal].text : claimOriginal) +
          '」，但摘录未能在你提供的材料中定位，已降为「证据不足」'
        : ''
    });
  }
  /* 用户写了主张但模型一条都没核 → 如实标注，不许留白 */
  var unchecked = [];
  for (var cid2 in knownIds) {
    var found = false;
    for (var f = 0; f < claims.length; f++) if (claims[f].claimId === cid2) found = true;
    if (!found) unchecked.push(knownIds[cid2]);
  }

  /* ---- ⑤ 下一轮检索建议（只给词，不给文献） ---- */
  var nextQueries = [];
  var rawQ2 = Array.isArray(j.nextQueries) ? j.nextQueries : [];
  for (var n = 0; n < rawQ2.length && nextQueries.length < 3; n++) {
    var rq = rawQ2[n] || {};
    var qt = stripPercent(T.trim(typeof rq === 'string' ? rq : rq.text)).text;
    if (!qt) continue;
    /* 检索式里出现链接 / DOI → 那是模型偷渡的「文献条目」，不是检索词 */
    if (/https?:\/\//i.test(qt) || /10\.\d{4,9}\//.test(qt)) {
      dropped.push({ text: qt.slice(0, 60), reason: '检索建议里含链接 / DOI（疑似具体文献而不是检索词），已丢弃' });
      continue;
    }
    if (qt.length > 120) qt = qt.slice(0, 120);
    var lang = T.trim(typeof rq === 'string' ? '' : rq.lang).toLowerCase();
    if (lang !== 'zh' && lang !== 'en') lang = T.hasCjk(qt) ? 'zh' : 'en';
    nextQueries.push({
      text: qt,
      why: stripPercent(T.trim(typeof rq === 'string' ? '' : rq.why)).text.slice(0, 40),
      lang: lang
    });
  }

  return {
    dimensions: dims,
    matches: matches.list,
    gaps: gaps.list,
    usage: usage,
    claims: claims,
    uncheckedClaims: unchecked,
    nextQueries: nextQueries,
    dropped: dropped,
    note: stripPercent(T.trim(j.note)).text.slice(0, 80),
    stats: stats
  };
}

/* ==========================================================================
 *  主流程
 * ========================================================================== */

/* 与前端 store.formatTime() 同一个时区口径（本地时间），
 * 否则导出文本里会出现「导出 11:58 / 分析 03:58」这种自相矛盾的时间。 */
function nowText() { return http.fmtTime(new Date()); }

/**
 * 课题适配 + 主张核验
 * @param {object} topic 课题
 * @param {object} ref 文献条目
 * @param {object} opt {timeout, claims}
 * @returns {Promise<object>}
 */
async function analyzeFit(topic, ref, opt) {
  opt = opt || {};
  var materials = buildMaterials(ref);
  var level = evidenceLevelOf(materials);

  var out = {
    ok: false,
    status: 'failed',
    at: nowText(),
    ms: 0,
    model: '',
    searched: false,
    failureKind: null,
    failureDetail: '',
    /* 运行时真实用到的服务（如实回报，不把开发助手的能力算进来） */
    runtime: {
      analysisProvider: qwen.PROVIDER,
      analysisModel: qwen.config().modelAnalyze,
      analysisConfigured: qwen.available(),
      retrievalServices: ['Crossref', 'OpenAlex'],
      fulltextFetched: false,
      fulltextNote: '本系统从未抓取或下载过任何全文，全部结论只基于题录、来源摘要与你粘贴的节选。'
    },
    evidenceLevel: level.level,
    evidenceLevelText: level.text,
    readingScope: level.scope,
    materialsUsed: materials.map(function (m) {
      return { id: m.id, kind: m.kind, label: m.label, chars: m.chars };
    }),
    dimensions: [], matches: [], gaps: [], usage: null,
    claims: [], uncheckedClaims: [], nextQueries: [],
    dropped: [], stats: { quotes: 0, located: 0, unlocated: 0, percentRemoved: 0, recencyRemoved: 0 },
    note: ''
  };

  /* ① 没有任何材料：连摘要都没有，不做 AI 分析（做了就是编） */
  if (!materials.length || level.level === 'citation') {
    out.status = 'no_material';
    out.ok = false;
    out.note = '这条文献目前【没有任何可用材料】（既没有摘要，也没有你粘贴的原文节选），' +
      '因此没有做任何 AI 分析——在只有题录的情况下做「内容判断」就是编造。' +
      '请先到「补充证据 / 修正字段」粘贴摘要或原文节选。';
    return out;
  }

  /* ② 运行时分析服务未配置：明确告知，不假装完成 */
  if (!qwen.available()) {
    out.status = 'config_failed';
    out.ok = false;
    out.failureKind = 'config';
    out.failureDetail = '云函数环境变量 QWEN_API_KEY 未配置，运行时分析服务不可用。' +
      '本次【没有】执行任何 AI 分析，下面也没有任何 AI 结论。';
    out.note = '运行时分析服务未配置：本次未执行 AI 分析。材料已备好（' +
      materials.map(function (m) { return m.label + ' ' + m.chars + ' 字'; }).join('、') +
      '），配置并重新部署云函数后可再次发起。';
    return out;
  }

  /* ③ 组装要核验的主张（只核用户真的写下的） */
  var claims = [];
  if (Array.isArray(opt.claims) && opt.claims.length) {
    for (var i = 0; i < opt.claims.length && claims.length < 3; i++) {
      var ct = T.trim(opt.claims[i] && opt.claims[i].text);
      if (ct) claims.push({ id: T.trim(opt.claims[i].id) || ('c' + (claims.length + 1)), text: ct.slice(0, 200) });
    }
  } else if (T.trim(topic && topic.claim)) {
    claims.push({ id: 'c1', text: T.trim(topic.claim).slice(0, 200) });
  }

  var feed = materialsForModel(materials);
  var ctxClaims = claims;

  var r = await qwen.fitRaw(topic, ref, feed, {
    timeout: opt.timeout,
    maxTokens: opt.maxTokens || 1200
  });

  out.model = r.model || '';
  out.ms = r.ms || 0;
  out.searched = !!r.searched;
  out.at = r.requestedAt || nowText();

  if (!r.ok || !r.json) {
    out.status = 'failed';
    out.failureKind = r.failureKind || 'parse';
    out.failureDetail = r.failureDetail || '模型未产出可解析的分析结果';
    out.note = '本次分析没有完成（' + (r.failureKind || '输出不可用') + '），' +
      '因此没有任何 AI 结论。这不是「这篇文献不符合课题」，只是这次没跑成，可稍后重试。';
    return out;
  }

  var dropped = [];
  var fit = normFit(r.json, { materials: materials, claims: ctxClaims, dropped: dropped });

  out.dimensions = fit.dimensions;
  out.matches = fit.matches;
  out.gaps = fit.gaps;
  out.usage = fit.usage;
  out.claims = fit.claims;
  out.uncheckedClaims = fit.uncheckedClaims;
  out.nextQueries = fit.nextQueries;
  out.dropped = dropped;
  out.stats = fit.stats;
  out.note = fit.note;
  out.ok = true;
  out.status = 'ok';

  logAdaptRound(topic, ref, out);
  return out;
}

/** 日志：把「模型给了什么、哪些被定位 / 被丢弃」打进云函数日志 */
function logAdaptRound(topic, ref, out) {
  try {
    console.log('[lfaVerify][adapt] 模型=' + out.model + '（未开联网检索）｜课题=' +
      T.trim(topic && topic.name).slice(0, 40) + '｜文献=' + T.trim(ref && ref.title).slice(0, 40));
    console.log('[lfaVerify][adapt] 证据等级=' + out.evidenceLevelText + '｜阅读范围=' + out.readingScope);
    var st = out.stats || {};
    console.log('[lfaVerify][adapt] 摘录 ' + st.quotes + ' 条：定位成功 ' + st.located +
      ' / 定位失败 ' + st.unlocated + '｜剔除百分数 ' + st.percentRemoved + '｜剔除「近年」表述 ' + st.recencyRemoved);
    for (var i = 0; i < (out.dimensions || []).length; i++) {
      var d = out.dimensions[i];
      console.log('    · ' + d.label + '：' + d.verdictText +
        (d.downgraded ? '（原判定无摘录支撑，已降级）' : '') +
        '｜课题=' + d.topicText + '｜文献实际=' + d.actualText);
    }
    console.log('[lfaVerify][adapt] 用途建议=' + (out.usage ? out.usage.value + '（' + out.usage.text + '）' : '无'));
    for (var c = 0; c < (out.claims || []).length; c++) {
      var cl = out.claims[c];
      console.log('    · 主张 ' + cl.claimId + '：' + cl.verdictText + '｜可定位摘录 ' + cl.locatedCount + ' 条');
      for (var q = 0; q < cl.quotes.length; q++) {
        console.log('        「' + cl.quotes[q].text.slice(0, 40) + '」→ ' + cl.quotes[q].locateText +
          (cl.quotes[q].locator ? '｜定位标记=' + cl.quotes[q].locator : ''));
      }
    }
    for (var n = 0; n < (out.nextQueries || []).length; n++) {
      console.log('    · 下一轮检索 [' + out.nextQueries[n].lang + '] ' + out.nextQueries[n].text);
    }
    for (var k = 0; k < (out.dropped || []).length; k++) {
      console.log('    · 丢弃 | ' + out.dropped[k].text + ' | 原因=' + out.dropped[k].reason);
    }
  } catch (e) {
    console.log('[lfaVerify][adapt] 日志输出异常：' + ((e && e.message) || e));
  }
}

module.exports = {
  USAGE: USAGE,
  CLAIM_VERDICT: CLAIM_VERDICT,
  DIM_VERDICT: DIM_VERDICT,
  EVIDENCE_LEVEL: EVIDENCE_LEVEL,
  DIMENSIONS: DIMENSIONS,
  MIN_ABSTRACT_LEN: MIN_ABSTRACT_LEN,
  MIN_EXCERPT_LEN: MIN_EXCERPT_LEN,
  buildMaterials: buildMaterials,
  evidenceLevelOf: evidenceLevelOf,
  locateIn: locateIn,
  locateText: locateText,
  squish: squish,
  normFit: normFit,
  analyzeFit: analyzeFit
};
