/**
 * 核验结果 → 视图模型（纯展示层）
 * ============================================================================
 * 第二阶段改造后，本文件【不含任何网络请求与字段比对逻辑】：
 *   - HTTP 请求：全部在云函数 cloudfunctions/lfaVerify 内（见 utils/verify-service.js）
 *   - 字段比对：在云函数 lib/compare.js 内
 * 本文件只负责把云函数返回的结论转成页面能直接渲染的结构。
 *
 * 展示规则：状态用【文字 + 颜色】双标识，不只用颜色区分。
 */

/** 逐字段判定的文字标记（与云函数 lib/compare.js 的 verdict 取值对应） */
var VERDICT_MARK = {
  match: { mark: '✓ 一致', tone: 'ok' },
  mismatch: { mark: '✗ 冲突', tone: 'orange' },
  weak: { mark: '？ 需人工核对', tone: 'yellow' },
  year_ambiguous: { mark: 'ⓘ 在线/卷期年份不同，请复核', tone: 'yellow' },
  input_missing: { mark: '— 你未填写，未比对', tone: 'gray' },
  record_missing: { mark: '— 来源无此字段，未比对', tone: 'gray' }
};

/** 核验状态的图标符号，用于和颜色一起做双重标识 */
var STATUS_ICON = {
  verified: '✓',
  /* 题名一致但 1 项字段不一致：判定为通过（勾），但文案必须写明「待人工确认」 */
  verified_one_conflict: '✓',
  conflict: '✗',
  multi_candidate: '☰',
  network_error: '!',
  not_indexed: '?',
  insufficient_input: '—',
  ai_found: '🔍',
  ai_not_found: '⊘'
};

/** 尚未核验时的默认展示 */
var PENDING_TEXT = '尚未自动核验（待核验）';

/**
 * 把云函数返回的核验结论转成视图结构。
 * @param {object} idn ref.identity
 */
function buildIdentityView(idn) {
  if (!idn || !idn.statusKey) return null;

  var checks = (idn.checks || []).map(function (c) {
    var m = VERDICT_MARK[c.verdict] || VERDICT_MARK.weak;
    return {
      name: c.name,
      verdict: c.verdict,
      mark: m.mark,
      tone: m.tone,
      input: c.input,
      record: c.record,
      note: c.note,
      hasInput: !!c.input,
      hasRecord: !!c.record,
      yearDetail: c.yearDetail || []
    };
  });

  var candidates = (idn.candidates || []).map(function (c, i) {
    var y = [];
    if (c.yearOnline) y.push('在线 ' + c.yearOnline);
    if (c.yearPrint) y.push('卷期 ' + c.yearPrint);
    if (c.yearIssued) y.push('出版 ' + c.yearIssued);
    return {
      idx: i,
      rank: c.rank || (i + 1),
      doi: c.doi,
      title: c.title,
      authors: c.authors,
      container: c.container,
      publisher: c.publisher,
      url: c.url,
      overall: c.sim ? c.sim.overall : 0,
      titleScore: c.sim ? c.sim.title : 0,
      authorScore: c.sim ? c.sim.authors : 0,
      yearScore: c.sim ? c.sim.year : 0,
      venueScore: c.sim ? c.sim.venue : 0,
      /* 千问联网检索给出的链接没有相似度评分（sim 为 null）。
       * 与其显示 0 让人误以为「最不像」，不如整行不显示。 */
      hasSim: !!c.sim,
      yearText: y.join(' · ') || '（记录无年份）',
      /* AMiner 记录只有内部论文 id（它的论文信息接口只接受 id）；
       * 没有 DOI 时这是唯一能做精确核验的钥匙，必须带到页面上。 */
      aminerId: c.aminerId || '',
      sourceId: c.sourceId || '',
      /* 来源返回的真实摘要：选定核验通过后可直接补全，不生成、不推测 */
      abstract: c.abstract || '',
      abstractFrom: c.abstractFrom || ''
    };
  });

  var tried = (idn.tried || []).map(function (t) {
    return {
      providerName: t.providerName || '未知来源',
      method: t.stageLabel || methodLabel(t.method),
      apiUrl: t.apiUrl || '',
      /* 本次实际发出去的检索词 / 字段组合（两段式检索：宽松 / 精确） */
      query: t.query || '',
      requestedAt: t.requestedAt || '',
      httpStatus: t.httpStatus || 0,
      ok: !!t.ok,
      failureText: t.failureKind ? (FAILURE_LABEL[t.failureKind] || t.failureKind) : '',
      failureDetail: t.failureDetail || ''
    };
  });

  /* 通义千问任务 A（结构化提取）留痕 */
  var aiExtract = idn.aiExtract ? {
    ok: !!idn.aiExtract.ok,
    model: idn.aiExtract.model || '',
    requestedAt: idn.aiExtract.requestedAt || '',
    ms: idn.aiExtract.ms || 0,
    failureText: idn.aiExtract.failureKind
      ? (FAILURE_LABEL[idn.aiExtract.failureKind] || idn.aiExtract.failureKind) : '',
    note: idn.aiExtract.note || '',
    title: (idn.aiExtract.fields && idn.aiExtract.fields.title) || '',
    titleOrig: (idn.aiExtract.fields && idn.aiExtract.fields.titleOrig) || '',
    authors: ((idn.aiExtract.fields && idn.aiExtract.fields.authors) || []).join('; '),
    year: (idn.aiExtract.fields && idn.aiExtract.fields.year) || '',
    venue: (idn.aiExtract.fields && idn.aiExtract.fields.venue) || '',
    doi: (idn.aiExtract.fields && idn.aiExtract.fields.doi) || '',
    lang: (idn.aiExtract.fields && idn.aiExtract.fields.lang) || '',
    confidence: (idn.aiExtract.fields && idn.aiExtract.fields.confidence != null)
      ? idn.aiExtract.fields.confidence : null,
    rawTextSnippet: idn.aiExtract.rawTextSnippet || ''
  } : null;

  /* 通义千问任务 B（联网检索兜底）结论。
   *
   * 2026-11-01 起结果拆成两块【互不依赖】的部分：
   *   recordMeta     —— 本次搜索摘要里提取到的题录（拿到可信摘要就展示，不看链接脸色）
   *   candidateLinks —— 走四层机器校验 + 真机可达性探测的链接，可能为空
   * 「搜到了题录但没留下可用链接」是一种正常且常见的结果，不能显示成「未检索到」。 */
  /* 只有走过千问联网检索的结果才带 aiSearch；OpenAlex / Crossref 直接命中的条目这一项是 null。
   * 这里必须先取到局部变量再判空——直接读 identity 里的 aiSearch 字段会在没有兜底结果时抛异常，
   * 而本函数是核验卡列表的必经路径，一抛异常整页卡片就会全部渲染不出来。 */
  var as = idn.aiSearch || null;
  var rc = (as && as.recordMeta) || null;
  var aiLinks = (as && (as.candidateLinks || as.links)) || [];
  var rawLinks = (as && as.rawCandidateLinks) || [];
  /* 老数据兼容：本地已存的旧结果没有 recordMeta，用当时的顶层字段补一个 */
  if (!rc) {
    rc = {
      credible: !!(as && (as.title || as.doi)),
      partialRecovery: false,
      exists: (as && as.exists) || '',
      existsText: existsTextOf(as && as.exists),
      title: (as && as.title) || '', authors: (as && as.authors) || [],
      authorsText: ((as && as.authors) || []).join('; '),
      year: (as && as.year) || '', doi: (as && as.doi) || '',
      venue: (as && as.venue) || '', abstract: '', hasAbstract: false,
      abstractTruncated: false, sourceName: '',
      declaredSummary: (as && as.summary) || '',
      confidence: (as ? (as.confidence == null ? null : as.confidence) : null),
      fieldsAbsent: [], fieldsAbsentText: '', hasFieldsAbsent: false,
      reason: ''
    };
  }
  var outcome = (as && as.outcome) ||
    (rc.credible ? (aiLinks.length ? 'record_and_link' : 'record_only') : 'no_clue');

  var aiSearch = as ? {
    exists: as.exists || 'uncertain',
    existsText: existsTextOf(as.exists),
    summary: as.summary || '',
    confidence: (as.confidence == null ? null : as.confidence),
    model: as.model || '',
    requestedAt: as.requestedAt || '',
    ms: as.ms || 0,
    searched: !!as.searched,
    searchCount: as.searchCount || 0,
    doi: rc.doi || '', year: rc.year || '', venue: rc.venue || '',
    title: rc.title || '', authors: rc.authorsText || '',

    /* ---- ① recordMeta：题录（与链接完全解耦） ---- */
    recordMeta: rc,
    hasRecordMeta: !!rc.credible,
    hasAbstract: !!rc.hasAbstract,
    /* 没摘要就是没摘要，链路不补写、不生成摘要 */
    sourceName: rc.sourceName || '',
    partialRecovery: !!rc.partialRecovery,

    /* ---- ② candidateLinks：主展示区链接 ---- */
    candidateLinks: aiLinks.map(function (l, i) {
      var st = l.probeState || (l.reachable ? 'ok' : 'unverified');
      return {
        idx: i, url: l.url, kind: linkKindLabel(l.kind), source: l.source || '', note: l.note || '',
        /* 真实访问过一次的结论：已实测可访问 / 未能确认… */
        probeText: l.probeText || '未探测',
        probeStatus: l.probeStatus || 0,
        reachable: st === 'ok',
        probeState: st,
        probeStateText: (st === 'ok') ? '已实测可访问' : '暂无法验证连通性'
      };
    }),
    hasLinks: aiLinks.length > 0,
    /* 有多少条保留下来但没能确认连通性（403/429/超时/5xx 等） */
    unverifiedCount: aiLinks.filter(function (l) {
      return (l.probeState || (l.reachable ? 'ok' : 'unverified')) !== 'ok';
    }).length,

    /* ---- ③ 折叠区：本次搜索的原始候选链接（未做连通性核验） ---- */
    rawCandidateLinks: rawLinks.map(function (s, i) {
      return { idx: i, name: s.name || '', url: s.url || '', inMain: !!s.inMain, dropReason: s.dropReason || '' };
    }),
    hasRawCandidateLinks: rawLinks.length > 0,

    probed: !!as.probed,
    probeSkippedReason: as.probeSkippedReason || '',
    truncatedRecovery: !!as.truncatedRecovery,
    /* 三种结果状态：查到文献信息+有链接 / 查到文献信息无链接 / 完全无线索 */
    outcome: outcome,
    outcomeText: OUTCOME_TEXT[outcome] || outcome,
    /* 链接治理结论：ok / url_not_found（只描述链接，不决定「有没有查到」） */
    linkStatus: as.linkStatus || 'url_not_found',
    linkStatusText: as.linkStatusText ||
      ((as.linkStatus === 'ok') ? '有通过校验的来源链接' : '本次检索未找到可稳定访问的原文链接'),
    /* 只有「完全没有任何检索线索」才判未检索到 */
    noClue: outcome === 'no_clue',
    recordOnly: outcome === 'record_only',
    /* 模型声明「本次检索命中」的来源（注意：这是模型自述，不是平台的检索证据） */
    sources: (as.sources || []).map(function (s, i) {
      return { idx: i, name: s.name || '', url: s.url || '' };
    }),
    /* 每条链接的机器校验明细，便于排查「那条链接为什么没了」 */
    linkAudit: (as.linkAudit || []).map(function (a, i) {
      return { idx: i, url: a.url || '', source: a.source || '', kept: !!a.kept, reason: a.reason || '' };
    })
  } : null;

  return {
    statusKey: idn.statusKey,
    statusText: idn.statusText || PENDING_TEXT,
    statusDesc: idn.statusDesc || '',
    icon: STATUS_ICON[idn.statusKey] || '·',
    tone: idn.tone || 'gray',
    colorHint: idn.colorHint || '灰色',
    label: idn.label || idn.statusText || PENDING_TEXT,
    reason: idn.reason || '',
    providerName: idn.provider ? idn.provider.name : '',
    providerNote: idn.provider ? idn.provider.note : '',
    sourceUrl: idn.sourceUrl || '',
    apiUrl: idn.apiUrl || '',
    fetchedAt: idn.fetchedAt || '',
    httpStatus: idn.httpStatus || 0,
    method: methodLabel(idn.method),
    query: idn.query || '',
    /* 顶部 Ethaniel：本次真正生效的是哪一段检索 */
    searchStrategy: idn.searchStrategy || '',
    searchStrategyText: STRATEGY_LABEL[idn.searchStrategy] || '',
    record: idn.record || null,
    checks: checks,
    candidates: candidates,
    tried: tried,
    hasCandidates: candidates.length > 0,
    hasChecks: checks.length > 0,
    hasRaw: !!(idn.rawPayload && idn.rawPayload.json),
    rawNote: idn.rawPayload ? idn.rawPayload.note : '',
    retracted: !!(idn.record && idn.record.flags && idn.record.flags.isRetracted),
    /* 「题名一致 + 仅 1 项不一致」：判定为核验通过，但差异字段原样列出、必须人工确认 */
    conflicts: (idn.conflictFields || []).map(function (c) {
      var m = VERDICT_MARK[c.verdict] || VERDICT_MARK.weak;
      return {
        key: c.key, name: c.name, verdict: c.verdict, mark: m.mark, tone: m.tone,
        input: c.input || '', record: c.record || '', note: c.note || '',
        hasBoth: !!c.input && !!c.record
      };
    }),
    hasConflicts: (idn.conflictFields || []).length > 0,
    needsHumanConfirm: !!idn.needsHumanConfirm,
    conflictNamesText: (idn.conflictFields || []).map(function (c) { return c.name; }).join('、'),
    boundaryNotice: idn.boundaryNotice || '',
    aiExtract: aiExtract,
    aiSearch: aiSearch,
    hasAiExtract: !!aiExtract,
    hasAiSearch: !!aiSearch
  };
}

var METHOD_LABEL = {
  'doi-exact': 'DOI 精确查询',
  'bibliographic-search': '题名检索',
  /* 两段式检索：① 宽松（只用 search= / query.bibliographic= 传题名）
   *            ② 精确（题名字段限定 + 作者 + 年份），仅在①没合格候选时才补 */
  'loose-title-search': '① 宽松检索（仅题名）',
  'precise-field-search': '② 精确字段检索（题名+作者+年份）',
  /* 单段检索：该来源的检索接口只支持题名（AMiner），不支持作者 / 年份字段限定，
   * 因此只检索一次，作者 / 年份在本地做收敛排序。 */
  'title-only-search': '题名检索（该来源不支持作者 / 年份字段限定）',
  'ai-extract': '千问结构化提取',
  'ai-web-search': '千问联网检索',
  skip: '未请求外部来源',
  none: '无',
  error: '内部错误'
};

/** 结果顶部标注「本次生效的是哪一段检索」 */
var STRATEGY_LABEL = {
  'loose-title-search': '宽松检索命中',
  'precise-field-search': '精确字段检索命中',
  'title-only-search': '题名检索命中'
};

var EXISTS_TEXT = {
  yes: '检索到明确对应的记录',
  no: '未检索到',
  uncertain: '只有间接线索，无法确认'
};

/** 任务 B 的三种结果状态（与云函数 sources/qwen.js 保持一致） */
var OUTCOME_TEXT = {
  record_and_link: '查到文献信息 + 有可用链接',
  record_only: '查到文献信息 · 无可用链接',
  no_clue: '完全没有检索线索'
};

function existsTextOf(e) {
  return EXISTS_TEXT[e] || '未给出判定';
}

var LINK_KIND_LABEL = {
  openalex: 'OpenAlex',
  crossref: 'Crossref',
  publisher: '出版社 / 期刊官网',
  official: '期刊 / 出版方官网',
  repository: '仓储 / 机构库',
  cnki: '知网',
  wanfang: '万方',
  scholar: '学术检索平台',
  other: '其他来源'
};

function linkKindLabel(k) {
  return LINK_KIND_LABEL[k] || '其他来源';
}

function methodLabel(m) {
  return METHOD_LABEL[m] || String(m || '');
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
  input: '输入为空'
};

/* ==========================================================================
 *  核验成功后的「一键补全」
 * ==========================================================================
 * 只做三件事，且都来自【来源接口真实返回的内容】：
 *   ① 题录字段：来源有、你这里是空的 → 直接补；两边都有且不同 → 列为冲突，
 *      必须你自己勾选「确认用来源取值覆盖」才会写入（默认绝不动你填过的内容）
 *   ② 摘要：来源接口给了 abstract 就补，没给就是没给，绝不生成
 *   ③ 原文节选：系统【永远不生成】——没抓全文就说没抓，只能你粘贴；
 *      提供「把来源摘要放进材料区」的选项，但会标记 excerptOrigin='abstract'，
 *      课题适配仍按「基于摘要」计，不谎称读过原文节选
 */

var FILL_FIELDS = [
  { key: 'title', label: '题名' },
  { key: 'authors', label: '作者' },
  { key: 'year', label: '年份' },
  { key: 'venue', label: '出处 / 期刊' },
  { key: 'doi', label: 'DOI' },
  { key: 'url', label: '链接' }
];

var MODE_TEXT = {
  fill: '来源有、你这里是空的 → 可直接补全',
  same: '与来源一致，无需改动',
  /* 注意：这里的「不同」只是【写法差异】（如作者名序、期刊名全称 vs 简称），
   * 不等同于逐字段比对判定的核验冲突；不勾选就一个字都不改。 */
  conflict: '你填的写法与来源不同 → 需你确认后才覆盖',
  none: '来源没有这个字段，无法补全',
  manual: '只能你手工填写'
};

function norm(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

/**
 * 找出可用的补全来源（优先级：DOI 精确命中的来源记录 > 千问检索到的题录）
 * @returns {{sourceName:string, fetchedAt:string, fields:object, abstract:string}|null}
 */
function fillSourceOf(idn) {
  if (!idn) return null;
  var rec = idn.record || null;
  if (rec && (rec.title || rec.authors || rec.doi)) {
    return {
      kind: 'record',
      sourceName: (idn.provider && idn.provider.name) || '公开元数据库',
      fetchedAt: idn.fetchedAt || '',
      fields: {
        title: rec.title || '',
        authors: rec.authors || '',
        year: rec.yearIssued || rec.yearPrint || rec.yearOnline || '',
        venue: rec.container || '',
        doi: rec.doi || '',
        url: idn.sourceUrl || ''
      },
      abstract: norm(rec.abstract),
      /* 命中源没给摘要、由另一个源补取时，摘要的真正出处要如实显示 */
      abstractSource: norm(rec.abstractFrom) || ((idn.provider && idn.provider.name) || '公开元数据库')
    };
  }
  var rm = idn.aiSearch && idn.aiSearch.recordMeta;
  if (rm && rm.credible && (rm.title || rm.doi || (rm.authors && rm.authors.length))) {
    return {
      kind: 'ai',
      sourceName: rm.sourceName || ((idn.provider && idn.provider.name) || '联网检索来源'),
      abstractSource: rm.sourceName || ((idn.provider && idn.provider.name) || '联网检索来源'),
      fetchedAt: idn.fetchedAt || '',
      fields: {
        title: rm.title || '',
        authors: rm.authorsText || (rm.authors || []).join('; '),
        year: rm.year || '',
        venue: rm.venue || '',
        doi: rm.doi || '',
        url: '' /* 千问只给题录，链接区另有独立校验，不拿来覆盖用户链接 */
      },
      abstract: norm(rm.abstract)
    };
  }
  return null;
}

/**
 * 生成补全方案（只算计划，不写库）。
 * @param {object} ref 文献条目
 * @param {object} idn ref.identity（云函数原始结果）
 */
function buildFillPlan(ref, idn) {
  ref = ref || {};
  var src = fillSourceOf(idn);
  var base = {
    ok: false,
    sourceName: '',
    fetchedAt: '',
    reason: '',
    fields: [],
    abstract: { mode: 'none', text: '', sourceName: '', note: '' },
    excerpt: { mode: 'manual', note: '' },
    canFill: 0,
    canConflict: 0
  };
  if (!src) {
    base.reason = '这次核验没有拿到可用的来源题录，没有可补全的内容。';
    return base;
  }
  /* 「题录字段冲突」意味着这条记录可能根本不是你写的那篇，
   * 这时候补全等于拿另一篇的信息填进你的条目 —— 一律不做，先让用户核对是不是同一篇。 */
  if (idn && idn.statusKey === 'conflict') {
    base.reason = '这条与来源记录有多处不一致（也可能不是同一篇），' +
      '先按逐字段比对核对清楚，确认是同一篇之后再考虑补全，本系统不在这里提供补全。';
    return base;
  }
  var ev = ref.evidence || {};
  var fields = [];
  var canFill = 0, canConflict = 0;

  for (var i = 0; i < FILL_FIELDS.length; i++) {
    var f = FILL_FIELDS[i];
    var incoming = norm(src.fields[f.key]);
    var current = norm(ref[f.key]);
    var mode;
    if (!incoming) mode = 'none';
    else if (!current) { mode = 'fill'; canFill++; }
    else if (current === incoming) mode = 'same';
    else { mode = 'conflict'; canConflict++; }
    fields.push({
      key: f.key, label: f.label, mode: mode, modeText: MODE_TEXT[mode],
      current: current, incoming: incoming,
      picked: mode === 'fill'   /* 默认只勾选「补空」，冲突项默认不勾 */
    });
  }

  var curAbs = norm(ev.abstract);
  var absMode = !src.abstract ? 'none' : (!curAbs ? 'fill' : (curAbs === src.abstract ? 'same' : 'conflict'));
  var absNote = !src.abstract
    ? '来源这次没有返回摘要，无法补全。请自行粘贴摘要或原文节选（系统不会抓取全文）。'
    : (absMode === 'conflict'
      ? '你已有的摘要与来源返回的摘要不同，勾选后才会用来源摘要覆盖。'
      : '这是来源接口返回的原文摘要，未经本系统改写，也不代表读过全文。');
  if (src.abstract && src.abstractSource && src.abstractSource !== src.sourceName) {
    absNote += '（摘要由「' + src.abstractSource + '」补取，题录比对仍以「' + src.sourceName + '」的记录为准。）';
  }

  base.ok = canFill > 0 || canConflict > 0 || absMode === 'fill' || absMode === 'conflict';
  base.sourceName = src.sourceName;
  base.fetchedAt = src.fetchedAt;
  base.sourceKind = src.kind;
  base.reason = base.ok ? '' : '来源记录与你已填内容完全一致，没有需要补全的字段。';
  base.fields = fields;
  base.canFill = canFill;
  base.canConflict = canConflict;
  base.abstract = {
    mode: absMode, modeText: MODE_TEXT[absMode] || '',
    text: src.abstract, sourceName: src.abstractSource || src.sourceName, note: absNote,
    picked: absMode === 'fill'
  };
  base.excerpt = {
    mode: 'manual',
    note: '原文节选必须是你从原文里摘录的内容。本系统从未抓取或下载全文，' +
      '也不会用摘要冒充节选；你可以把来源摘要放进材料区，但它会被标注为「摘要」，' +
      '课题适配仍按「基于摘要初筛」计。'
  };
  return base;
}

/** 未核验时显示在核验按钮下方的「能力边界」一句话提示 */
function boundaryShort() {
  return '自动核验先走 OpenAlex / Crossref 学术库，每个源都是「先宽松检索、没有合格候选再补一次精确字段检索」；' +
    '未命中或判断为中文文献时，改由通义千问联网检索兜底，结果仍需你自行打开链接确认。';
}

module.exports = {
  VERDICT_MARK: VERDICT_MARK,
  STATUS_ICON: STATUS_ICON,
  PENDING_TEXT: PENDING_TEXT,
  OUTCOME_TEXT: OUTCOME_TEXT,
  buildIdentityView: buildIdentityView,
  buildFillPlan: buildFillPlan,
  fillSourceOf: fillSourceOf,
  METHOD_LABEL: METHOD_LABEL,
  methodLabel: methodLabel,
  existsTextOf: existsTextOf,
  linkKindLabel: linkKindLabel,
  boundaryShort: boundaryShort
};
