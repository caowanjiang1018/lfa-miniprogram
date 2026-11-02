/**
 * 课题适配结论 → 视图模型（纯展示层）
 * ============================================================================
 * 与 utils/identity.js 同样的规矩：本文件【不发起任何请求】，只把结果转成页面能渲染的结构。
 * 单独成文件是为了能离线测试——上一轮的教训是：展示层一处空指针就让整个核验卡页
 * 一条记录都渲染不出来。这里对输入的任何形态都保证不抛异常。
 *
 * 展示上的两条硬规矩：
 *   1. 【AI 推断】与【原文摘录】必须分开呈现，不能混在一句话里，
 *      否则读者分不清哪句是文献里真有的、哪句是模型的判断。
 *   2. 摘录必须带定位结论；定位不到的明确写「未能定位（证据不足）」。
 */

var USAGE_OPTIONS = [
  {
    value: 'direct',
    text: '可作为本课题目标场景的直接证据',
    tone: 'ok',
    desc: '对象、任务、条件都对得上时才可以选这项'
  },
  {
    value: 'method_only',
    text: '可借鉴方法，但不能作为目标场景效果的直接证据',
    tone: 'purple',
    desc: '研究对象 / 场景不同 ≠ 没用：方法、实验设计可以参考，但效果数字不能照搬'
  },
  {
    value: 'background',
    text: '只宜作研究背景 / 综述引用',
    tone: 'gray',
    desc: '只在主题层面相关，不承担本课题的关键论点'
  },
  {
    value: 'insufficient',
    text: '材料不足，无法判断用途',
    tone: 'gray',
    desc: '先补齐摘要或原文节选再判断'
  }
];

var STATUS = {
  ok: { text: '已完成适配分析', tone: 'gray', icon: '✓' },
  config_failed: { text: '运行时分析服务未配置，未执行 AI 分析', tone: 'orange', icon: '!' },
  no_material: { text: '没有可用材料，未做分析', tone: 'gray', icon: '—' },
  failed: { text: '分析未完成', tone: 'orange', icon: '!' },
  cloud_unavailable: { text: '云函数不可用，未执行分析', tone: 'orange', icon: '!' },
  none: { text: '尚未做适配分析', tone: 'gray', icon: '·' }
};

function s(v) { return String(v == null ? '' : v); }

function usageOption(value) {
  for (var i = 0; i < USAGE_OPTIONS.length; i++) {
    if (USAGE_OPTIONS[i].value === value) return USAGE_OPTIONS[i];
  }
  return null;
}

/**
 * @param {object} adapt ref.adapt（运行时分析服务的原始结论，可能为 null）
 * @param {object} usage ref.usageDecision（当前生效用途，可能为 null）
 * @param {object} confirm ref.adaptConfirm（人工确认，可能为 null）
 * @param {object} topic 当前课题
 */
function buildAdaptView(adapt, usage, confirm, topic) {
  adapt = adapt || null;
  var status = adapt ? s(adapt.status) : 'none';
  var st = STATUS[status] || STATUS.none;
  var ok = !!(adapt && adapt.ok);

  /* ---- ① 四个维度：AI 推断与原文摘录分开放 ---- */
  var dims = [];
  var rawDims = (adapt && adapt.dimensions) || [];
  for (var i = 0; i < rawDims.length; i++) {
    var d = rawDims[i] || {};
    var quotes = [];
    var rq = Array.isArray(d.quotes) ? d.quotes : [];
    for (var q = 0; q < rq.length; q++) {
      var x = rq[q] || {};
      quotes.push({
        text: s(x.text),
        locator: s(x.locator) || '（未提供页码 / 章节）',
        located: !!x.located,
        locateText: s(x.locateText) || '未能在你提供的材料里定位到这段摘录（证据不足）',
        materialLabel: s(x.materialLabel),
        hasLocator: !!s(x.locator)
      });
    }
    dims.push({
      key: s(d.key),
      label: s(d.label) || '维度',
      topicText: s(d.topicText),
      actualText: s(d.actualText),
      verdict: s(d.verdict),
      verdictText: s(d.verdictText) || '未提供',
      tone: s(d.tone) || 'gray',
      /* AI 推断（模型给出的一句话判断） */
      aiText: s(d.actualText),
      note: s(d.note),
      hasNote: !!s(d.note),
      /* 原文摘录（必须能在用户材料里定位） */
      quotes: quotes,
      hasQuotes: quotes.length > 0,
      locatedCount: quotes.filter(function (y) { return y.located; }).length,
      downgraded: !!d.downgraded,
      downgradeText: s(d.downgradeText)
    });
  }

  /* ---- ② 拟引用主张核验 ---- */
  var claims = [];
  var rawClaims = (adapt && adapt.claims) || [];
  for (var c = 0; c < rawClaims.length; c++) {
    var cl = rawClaims[c] || {};
    var qs = [];
    var rcq = Array.isArray(cl.quotes) ? cl.quotes : [];
    for (var k = 0; k < rcq.length; k++) {
      var y = rcq[k] || {};
      qs.push({
        text: s(y.text),
        locator: s(y.locator) || '（未提供页码 / 章节）',
        located: !!y.located,
        locateText: s(y.locateText) || '未能在你提供的材料里定位到这段摘录（证据不足）',
        materialLabel: s(y.materialLabel),
        materialKindText: s(y.materialKind) === 'excerpt'
          ? '你粘贴的原文节选' : (s(y.materialKind) === 'abstract' ? '来源摘要' : '')
      });
    }
    claims.push({
      claimId: s(cl.claimId),
      claimText: s(cl.claimText),
      verdict: s(cl.verdict),
      verdictText: s(cl.verdictText) || '未提供',
      tone: s(cl.tone) || 'gray',
      quotes: qs,
      hasQuotes: qs.length > 0,
      locatedCount: typeof cl.locatedCount === 'number'
        ? cl.locatedCount : qs.filter(function (z) { return z.located; }).length,
      /* 没有一条能定位的摘录 → 一律显示「证据不足」的可见状态 */
      noLocatedQuote: qs.length > 0 && !qs.some(function (z) { return z.located; }),
      note: s(cl.note),
      hasNote: !!s(cl.note),
      downgraded: !!cl.downgraded,
      downgradeText: s(cl.downgradeText)
    });
  }

  var unchecked = [];
  var ru = (adapt && adapt.uncheckedClaims) || [];
  for (var u = 0; u < ru.length; u++) {
    unchecked.push({ claimId: s(ru[u] && ru[u].id), claimText: s(ru[u] && ru[u].text) });
  }

  /* ---- ③ 下一轮检索建议（只给词，不给文献） ---- */
  var nextQueries = [];
  var rn = (adapt && adapt.nextQueries) || [];
  for (var n = 0; n < rn.length; n++) {
    nextQueries.push({
      idx: n,
      text: s(rn[n] && rn[n].text),
      why: s(rn[n] && rn[n].why),
      lang: s(rn[n] && rn[n].lang) || 'zh',
      langText: s(rn[n] && rn[n].lang) === 'en' ? '英文' : '中文'
    });
  }

  /* ---- ④ 被机器校验丢弃的内容（透明展示） ---- */
  var dropped = [];
  var rd = (adapt && adapt.dropped) || [];
  for (var m = 0; m < rd.length; m++) {
    dropped.push({ text: s(rd[m] && rd[m].text), reason: s(rd[m] && rd[m].reason) });
  }

  /* ---- ⑤ 用途：自动建议 vs 人工修订，分开保存 ---- */
  var usageView = null;
  if (usage && usage.value) {
    var op = usageOption(usage.value);
    usageView = {
      value: s(usage.value),
      text: s(usage.text) || (op ? op.text : s(usage.value)),
      tone: (op ? op.tone : 'gray'),
      source: s(usage.source) || 'ai',
      sourceText: s(usage.sourceText) || (s(usage.source) === 'human' ? '你的修改' : '分析服务建议'),
      isHuman: s(usage.source) === 'human',
      reason: s(usage.reason),
      why: s(usage.why),
      caveat: s(usage.caveat),
      at: s(usage.at),
      model: s(usage.model)
    };
  }

  var stats = (adapt && adapt.stats) || {};
  var materials = (adapt && adapt.materialsUsed) || [];
  var materialsText = materials.map(function (x) {
    return s(x.label) + ' ' + (x.chars || 0) + ' 字';
  }).join('、');

  var stale = false;
  if (adapt && topic && typeof adapt.topicRevision === 'number') {
    stale = adapt.topicRevision !== topic.revision;
  }

  return {
    hasResult: !!adapt,
    ok: ok,
    status: status,
    statusText: st.text,
    statusTone: st.tone,
    statusIcon: st.icon,
    /* 未完成时的可见原因（不许静默失败） */
    failureText: adapt ? (s(adapt.failureDetail) || s(adapt.note)) : '',
    note: adapt ? s(adapt.note) : '',

    evidenceLevel: adapt ? s(adapt.evidenceLevel) : '',
    evidenceLevelText: adapt ? s(adapt.evidenceLevelText) : '',
    readingScope: adapt ? s(adapt.readingScope) : '',
    materialsText: materialsText,
    hasMaterials: materials.length > 0,
    /* 只有摘要时必须显式看到这句限定 */
    abstractOnly: adapt ? s(adapt.evidenceLevel) === 'abstract' : false,

    model: adapt ? s(adapt.model) : '',
    at: adapt ? s(adapt.at || adapt.savedAt) : '',
    ms: adapt ? (adapt.ms || 0) : 0,

    dimensions: dims,
    hasDimensions: dims.length > 0,
    matches: (adapt && adapt.matches) || [],
    gaps: (adapt && adapt.gaps) || [],
    hasMatches: !!((adapt && adapt.matches) || []).length,
    hasGaps: !!((adapt && adapt.gaps) || []).length,

    claims: claims,
    hasClaims: claims.length > 0,
    uncheckedClaims: unchecked,
    hasUnchecked: unchecked.length > 0,

    nextQueries: nextQueries,
    hasNextQueries: nextQueries.length > 0,
    dropped: dropped,
    hasDropped: dropped.length > 0,

    usage: usageView,
    usageOptions: USAGE_OPTIONS,
    /* 人工确认之前，永远是「未确认」 */
    confirmed: !!confirm,
    confirmText: confirm ? ('已确认（' + s(confirm.at) + '）') : '未确认',
    confirmNote: confirm ? s(confirm.note) : '',
    stale: stale,
    staleText: stale
      ? ('这份结论基于课题第 ' + s(adapt.topicRevision) + ' 版，当前已是第 ' + s(topic && topic.revision) + ' 版，需重新分析')
      : '',
    statsText: (stats.quotes || stats.located || stats.unlocated)
      ? ('摘录 ' + (stats.quotes || 0) + ' 条：定位成功 ' + (stats.located || 0) +
        ' · 未能定位 ' + (stats.unlocated || 0) +
        ((stats.percentRemoved || stats.recencyRemoved)
          ? '；剔除百分数 ' + (stats.percentRemoved || 0) + ' 处、剔除「近年」表述 ' + (stats.recencyRemoved || 0) + ' 处'
          : ''))
      : ''
  };
}

module.exports = {
  USAGE_OPTIONS: USAGE_OPTIONS,
  STATUS: STATUS,
  usageOption: usageOption,
  buildAdaptView: buildAdaptView
};
