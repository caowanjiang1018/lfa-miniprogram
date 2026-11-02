/**
 * 核验记录文本生成（复制 / 导出用）
 * 规则：自动初判与人工确认并列输出，人工修改不覆盖原始结果。
 */

var store = require('./store.js');

function trim(s) { return (s || '').replace(/^\s+|\s+$/g, ''); }

function line(k, v) { return (v && trim(v)) ? k + '：' + trim(v) : k + '：（未填写）'; }

function buildRefText(topic, ref, index, total) {
  var out = [];
  out.push('记录 ' + index + ' / 共 ' + total + ' 条');
  out.push('条目来源：' + (ref.origin === 'sample'
    ? '演示样例（流程演示样例，非实时核验结果）'
    : (ref.origin === 'discover'
      ? '系统检索推荐（题录来自真实检索记录，未经内容核验）'
      : '用户自行粘贴')));
  out.push(line('粘贴原文', ref.raw));
  out.push('解析后字段：');
  out.push('  题名：' + (trim(ref.title) || '（未填写）'));
  out.push('  作者：' + (trim(ref.authors) || '（未填写）'));
  out.push('  年份：' + (trim(ref.year) || '（未填写）'));
  out.push('  出处：' + (trim(ref.venue) || '（未填写）'));
  out.push('  DOI：' + (trim(ref.doi) || '（未填写）'));
  out.push('  链接：' + (trim(ref.url) || '（未填写）'));
  if (ref.fieldsEdited) out.push('  注：以上字段存在人工修正，修正内容未与外部来源核对。');
  out.push('补充材料：');
  out.push('  原始链接：' + (trim(ref.evidence.link) || '（未提供）'));
  out.push('  摘要：' + (trim(ref.evidence.abstract) || '（未提供）'));
  out.push('  原文节选：' + (trim(ref.evidence.excerpt) || '（未提供）'));
  if (trim(ref.note)) out.push('  备注：' + trim(ref.note));
  if (trim(ref.dupNote)) out.push('  重复提示：' + trim(ref.dupNote));
  out.push('导入时间：' + (ref.createdAt || '—'));

  /* 第三阶段：检索推荐进来的条目，把「系统原始推荐」与「用户决定」并列导出 */
  if (ref.recommend) {
    var rc = ref.recommend;
    out.push('系统检索推荐（原始推荐，不会被人工确认改写）：');
    out.push('  检索服务：' + (rc.source || '—') +
      (rc.sourceId ? '（' + rc.sourceId + '）' : '') +
      '｜检索式：' + (rc.query || '—') +
      '｜取得时间：' + (rc.retrievedAt || '—'));
    if (rc.apiUrl) out.push('  接口请求：' + rc.apiUrl);
    out.push('  阅读依据：' + (rc.evidenceText || '—') +
      (rc.hasAbstract ? '（摘要为接口返回的原文摘要，系统未读原文）' : '（来源未提供摘要，未读原文）'));
    if (rc.oaPdfUrl) out.push('  开放获取 PDF（未下载、未阅读）：' + rc.oaPdfUrl);
    if (rc.why) out.push('  推荐理由（模型给出，非核验结论）：' + rc.why);
    if (rc.match && rc.match.length) {
      out.push('  匹配点：');
      for (var mi2 = 0; mi2 < rc.match.length; mi2++) out.push('     - ' + rc.match[mi2]);
    }
    if (rc.gap && rc.gap.length) {
      out.push('  差异 / 局限：');
      for (var gi2 = 0; gi2 < rc.gap.length; gi2++) out.push('     - ' + rc.gap[gi2]);
    }
    if (rc.todo && rc.todo.length) {
      out.push('  仍需验证的条件：');
      for (var ti2 = 0; ti2 < rc.todo.length; ti2++) out.push('     - ' + rc.todo[ti2]);
    }
    if (rc.uses && rc.uses.length) out.push('  加入时你选择的用途：' + rc.uses.join('、'));
    if (rc.model) out.push('  分析模型：' + rc.model + '（模型只做解释，题录全部来自真实检索记录）');
    if (rc.analysisNote) out.push('  模型对这批候选的整体说明：' + rc.analysisNote);
    out.push('  基于课题第 ' + (rc.topicRevision || '?') + ' 版，保存时间 ' + (rc.savedAt || '—'));
    out.push('  说明：推荐条目只说明公开库里有这条题录，不等于论文质量已核实、也不等于原文已核对。');
  }

  var evs = (ref.evals || []);
  if (!evs.length) {
    out.push('自动初判：（尚未执行）');
  } else {
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      var tag = (topic && ev.revision !== topic.revision) ? '［基于课题第 ' + ev.revision + ' 版，课题已更新，需重新评估］' : '［基于课题第 ' + ev.revision + ' 版］';
      out.push('自动初判 ' + (i + 1) + '（' + ev.at + '，规则 ' + (ev.ruleVersion || store.RULE_VERSION) + '）' + tag);
      out.push('  1) 文献身份和题录：' + safe(ev.identity, 'label') + '｜' + safe(ev.identity, 'reason'));
      var idn = ev.identity && ev.identity.identity;
      if (!idn) {
        out.push('  判定方式：本地初判，尚未做外部来源核验');
      } else {
        out.push('  核验状态：' + (idn.statusText || '—') + '（' + (idn.colorHint || '—') +
          '）｜判定含义：' + (idn.statusDesc || '—'));
        out.push('  核验来源：' + (idn.provider ? idn.provider.name : '外部来源') +
          '｜取得时间 ' + (idn.fetchedAt || '') + '｜HTTP ' + (idn.httpStatus || 0) +
          '｜方式 ' + (idn.method || ''));
        if (idn.query) out.push('  检索关键词：' + idn.query);
        if (idn.sourceUrl) out.push('  原文链接：' + idn.sourceUrl);
        if (idn.apiUrl) out.push('  接口请求：' + idn.apiUrl);
        if (idn.record && idn.record.flags && idn.record.flags.isRetracted) {
          out.push('  ［重要］来源标记该文献【已被撤稿】');
        }

        // ② 各个数据源返回的原始元数据、来源链接、接口请求时间
        var tried = idn.tried || [];
        if (tried.length) {
          out.push('  数据访问日志（逐源记录）：');
          for (var ti = 0; ti < tried.length; ti++) {
            var tg = tried[ti];
            out.push('     · ' + tg.providerName + '｜' + tg.method +
              '｜HTTP ' + tg.httpStatus + '｜请求时间 ' + tg.requestedAt +
              (tg.failureText ? '｜' + tg.failureText + (tg.failureDetail ? '：' + tg.failureDetail : '') : ''));
            if (tg.apiUrl) out.push('       接口地址：' + tg.apiUrl);
          }
        }
        if (idn.rawPayload && idn.rawPayload.json) {
          out.push('  来源原始返回（' + (idn.rawPayload.provider || '来源') + '，' +
            idn.rawPayload.requestedAt + '，HTTP ' + idn.rawPayload.httpStatus + '）：' +
            idn.rawPayload.note);
          out.push('    ' + idn.rawPayload.json);
        }

        // ③ 系统自动比对得出的原始核验结论
        var cks = idn.checks || [];
        if (cks.length) {
          out.push('  自动比对结论（逐字段）：');
          for (var ci = 0; ci < cks.length; ci++) {
            var ck = cks[ci];
            out.push('     - ' + ck.name + '：' + verdictText(ck.verdict) +
              '｜你填写=“' + (ck.input || '（空）') + '”｜来源记录=“' + (ck.record || '（无此字段）') + '”');
            if (ck.yearDetail && ck.yearDetail.length) {
              var ys = [];
              for (var yi = 0; yi < ck.yearDetail.length; yi++) {
                ys.push(ck.yearDetail[yi].kind + ' ' + ck.yearDetail[yi].value + '（' + ck.yearDetail[yi].full + '）');
              }
              out.push('       年份取值明细：' + ys.join('；'));
            }
          }
        }
        var cands = idn.candidates || [];
        if (cands.length) {
          out.push('  候选记录 ' + cands.length + ' 条（未经自动认定，等待人工确认）：');
          for (var ai = 0; ai < cands.length; ai++) {
            var cd = cands[ai];
            /* 千问联网检索给出的链接没有相似度分数（sim 为 null），不能当成 0 打印，
             * 否则会让人误以为「排第一的是最不像的」，这里如实写「无相似度评分」。 */
            var score = (cd.sim && typeof cd.sim.overall === 'number') ? cd.sim.overall : '无相似度评分';
            out.push('     #' + (cd.rank || (ai + 1)) + ' ' + cd.title + '｜' + cd.doi + '｜综合 ' + score +
              (cd.url ? '｜链接：' + cd.url : ''));
          }
        }

        // 通义千问两个任务的留痕（任务A 提取 / 任务B 联网检索）
        if (idn.aiExtract) {
          var ae = idn.aiExtract;
          out.push('  千问预处理提取（任务A）：' + (ae.ok ? '成功' : '未成功') +
            '｜模型 ' + (ae.model || '—') + '｜耗时 ' + (ae.ms || 0) + 'ms｜' + (ae.requestedAt || ''));
          if (ae.failureKind) {
            out.push('     失败原因：' + (ae.failureKind === 'config'
              ? '云函数环境变量 QWEN_API_KEY 未配置' : (ae.failureDetail || ae.failureKind)));
          }
          if (ae.fields) {
            var af = ae.fields;
            out.push('     提取结果：英文题名=“' + (af.title || '') + '”｜原题名=“' + (af.titleOrig || '') +
              '”｜作者=' + ((af.authors || []).join('; ') || '') +
              '｜年份=' + (af.year || '') + '｜出处=' + (af.venue || '') +
              '｜DOI=' + (af.doi || '') + '｜语种=' + (af.lang || '') +
              '｜把握度=' + (af.confidence == null ? '—' : af.confidence));
          }
          if (ae.rawTextSnippet) out.push('     你粘贴的原文：' + ae.rawTextSnippet);
        }
        if (idn.aiSearch) {
          var as = idn.aiSearch;
          out.push('  千问联网检索（任务B）：模型判定=' + (as.existsText || as.exists) +
            '｜模型 ' + (as.model || '—') + '｜耗时 ' + (as.ms || 0) + 'ms｜' + (as.requestedAt || '') +
            '｜实际触发联网搜索=' + (as.searched ? '是（' + as.searchCount + ' 次）' : '否'));
          if (as.summary) out.push('     模型依据：' + as.summary);
          if (as.title) out.push('     检索到的题名：' + as.title);
          if (as.authors && as.authors.length) out.push('     作者：' + as.authors.join('; '));
          if (as.venue) out.push('     期刊 / 会议：' + as.venue);
          if (as.year) out.push('     年份：' + as.year);
          if (as.doi) out.push('     DOI：' + as.doi);
          var als = as.links || [];
          if (als.length) {
            out.push('     检索到的链接 ' + als.length + ' 条（需人工打开确认，本系统不代为核实）：');
            for (var li = 0; li < als.length; li++) {
              out.push('       [' + (li + 1) + '] ' + als[li].url +
                (als[li].note ? '（' + als[li].note + '）' : ''));
            }
          }
        }
      }

      // 人工备注（只追加，不覆盖自动结论）
      var mes = ref.manualEvidence || [];
      if (mes.length) {
        out.push('  人工备注（' + mes.length + ' 条，与系统自动结论并列保存）：');
        for (var mi = 0; mi < mes.length; mi++) {
          var me = mes[mi];
          out.push('     [' + (mi + 1) + '] ' + me.at +
          (me.sourceName ? '｜来源：' + me.sourceName : '') +
          (me.url ? '｜链接：' + me.url : '') +
          (me.title ? '｜题名：' + me.title : '') +
          (me.year ? '｜年份：' + me.year : ''));
          if (me.note) out.push('         备注：' + me.note);
        }
      }
      var lcs = ev.identity && ev.identity.localConflicts;
      if (lcs && lcs.length) {
        for (var lc = 0; lc < lcs.length; lc++) {
          out.push('     - 本地字段冲突 ' + lcs[lc].name + '：粘贴解析=“' + lcs[lc].parsed + '”，当前=“' + lcs[lc].current + '”');
        }
      }

      /* 第五阶段：单一字段冲突的判定与人工确认状态（判定通过 ≠ 差异消失） */
      var idnR = ev.identity && ev.identity.identity;
      if (idnR && idnR.needsHumanConfirm) {
        out.push('  题录差异（题名一致 + 仅 1 项不一致，系统判为核验通过，但差异需人工确认）：');
        var cfs5 = idnR.conflictFields || [];
        for (var c5 = 0; c5 < cfs5.length; c5++) {
          out.push('     - ' + cfs5[c5].name + '：你填=“' + (cfs5[c5].input || '空') +
            '”，来源=“' + (cfs5[c5].record || '空') + '”');
        }
        var acks = ref.conflictAcks || [];
        if (!acks.length) {
          out.push('     人工确认：（尚未确认）');
        } else {
          for (var a5 = 0; a5 < acks.length; a5++) {
            out.push('     人工确认 ' + (a5 + 1) + '（' + acks[a5].at + '）：' + (acks[a5].note || '（未填写）'));
          }
        }
      }

      /* 第五阶段：核验成功后的补全留痕（补了什么、值从哪来） */
      var fills = ref.fills || [];
      if (fills.length) {
        out.push('  核验后补全（' + fills.length + ' 次，内容均来自来源真实返回）：');
        for (var f5 = 0; f5 < fills.length; f5++) {
          var fl = fills[f5];
          out.push('     [' + (f5 + 1) + '] ' + fl.at + '｜来源：' + (fl.sourceName || '—'));
          var chs = fl.changed || [];
          for (var c6 = 0; c6 < chs.length; c6++) {
            out.push('          · ' + chs[c6].field + '：' + chs[c6].from + ' → ' + chs[c6].to);
          }
        }
      }

      out.push('  2) 对本课题的用途：' + safe(ev.usage, 'label') + '｜' + safe(ev.usage, 'reason'));
      if (ev.usage && ev.usage.detail && ev.usage.detail.length) {
        for (var d = 0; d < ev.usage.detail.length; d++) out.push('     - ' + ev.usage.detail[d]);
      }
      out.push('  3) 对拟引用主张的支持：' + safe(ev.claim, 'label') + '｜' + safe(ev.claim, 'reason'));
      if (ev.claim && ev.claim.detail && ev.claim.detail.length) {
        for (var dt = 0; dt < ev.claim.detail.length; dt++) out.push('     - ' + ev.claim.detail[dt]);
      }
    }
  }

  var cfs = (ref.confirms || []);
  if (!cfs.length) {
    out.push('人工确认：（尚未确认）');
  } else {
    for (var j = 0; j < cfs.length; j++) {
      var cf2 = cfs[j];
      out.push('人工确认 ' + (j + 1) + '（' + cf2.at + '，基于课题第 ' + (cf2.basedOnRevision || '?') + ' 版）');
      out.push('  决定：' + (cf2.decisionLabel || cf2.decision || '—'));
      out.push('  对拟引用主张的人工判断：' + (cf2.claimVerdict || '未选择'));
      out.push('  理由：' + (cf2.reason || '（未填写）'));
    }
  }
  /* 第四阶段：课题适配与主张核验（与人工确认并列，自动结论不被改写） */
  var adLines = adaptLines(topic, ref);
  for (var al = 0; al < adLines.length; al++) out.push(adLines[al]);

  out.push('说明：本条记录中，自动初判与人工确认并列保存，人工修改不覆盖原始自动结果。');
  out.push('');
  return out.join('\n');
}

/**
 * 课题适配与主张核验 → 导出文本
 * 规则：AI 推断与原文摘录分开写；摘录必须带定位结论；
 *      用途区分「分析服务建议」与「你的修改」；没确认过就写「未确认」。
 */
function adaptLines(topic, ref) {
  var out = [];
  var a = ref.adapt;
  if (!a) {
    out.push('课题适配与主张核验：（尚未执行）');
    return out;
  }

  /* 确认状态要写准：确认过就不能再写「未经人工确认」 */
  var statusText = a.ok
    ? (ref.adaptConfirm ? '已完成（已人工确认）' : '已完成（自动结论，未经人工确认）')
    : (a.status === 'config_failed' ? '运行时分析服务未配置，【未执行 AI 分析】'
      : (a.status === 'no_material' ? '材料不足，未做分析'
        : (a.status === 'cloud_unavailable' ? '云函数不可用，未执行分析' : '分析未完成')));

  out.push('课题适配与主张核验：' + statusText +
    '｜分析服务 ' + (a.model || '—') + '｜时间 ' + (a.at || a.savedAt || '—') +
    (a.ms ? '｜耗时 ' + a.ms + 'ms' : ''));
  out.push('  证据等级：' + (a.evidenceLevelText || '—') + '｜阅读范围：' + (a.readingScope || '—'));
  var mus = a.materialsUsed || [];
  if (mus.length) {
    var mt = [];
    for (var mi = 0; mi < mus.length; mi++) mt.push((mus[mi].label || '') + ' ' + (mus[mi].chars || 0) + ' 字');
    out.push('  使用材料：' + mt.join('、') + '（本系统从未抓取或下载全文）');
  }
  if (!a.ok) {
    out.push('  未产出结论的原因：' + (a.failureDetail || a.note || '—'));
    return out;
  }
  if (a.note) out.push('  整体说明：' + a.note);

  /* ① 逐项对照 */
  var dims = a.dimensions || [];
  if (dims.length) {
    out.push('  ① 课题要求 vs 文献实际（逐项对照）：');
    for (var d = 0; d < dims.length; d++) {
      var dm = dims[d];
      out.push('     · ' + (dm.label || '') + '：' + (dm.verdictText || ''));
      out.push('         课题这边要求：' + (dm.topicText || '—'));
      out.push('         分析服务判断：' + (dm.actualText || '—') +
        (dm.downgraded ? '［原判定无摘录支撑，已降为无法判断］' : ''));
      if (dm.note) out.push('         判断说明：' + dm.note);
      var dq = dm.quotes || [];
      for (var dq1 = 0; dq1 < dq.length; dq1++) {
        out.push('         原文摘录：' + '“' + (dq[dq1].text || '') + '”');
        out.push('           出处标记：' + (dq[dq1].locator || '未提供页码 / 章节') +
          '｜定位结论：' + (dq[dq1].locateText || '—'));
      }
      if (!dq.length) out.push('         （本项没有给出可定位的摘录，不作结论）');
    }
  }

  /* ② 匹配点 / 差异 */
  if ((a.matches || []).length) {
    out.push('  ② 匹配点：');
    for (var m2 = 0; m2 < a.matches.length; m2++) out.push('     - ' + a.matches[m2]);
  }
  if ((a.gaps || []).length) {
    out.push('  ② 差异 / 局限：');
    for (var g2 = 0; g2 < a.gaps.length; g2++) out.push('     - ' + a.gaps[g2]);
  }

  /* ③ 主张核验 */
  var cls = a.claims || [];
  out.push('  ③ 拟引用主张核验：');
  if (!cls.length) {
    out.push('     （本次没有核验到任何主张：可能未填写说法，或没有可定位的摘录）');
  } else {
    for (var c2 = 0; c2 < cls.length; c2++) {
      var cl = cls[c2];
      out.push('     · 主张 ' + (cl.claimId || '') + '：' + (cl.verdictText || ''));
      out.push('         你写的说法：' + (cl.claimText || '—'));
      var cq = cl.quotes || [];
      for (var c3 = 0; c3 < cq.length; c3++) {
        out.push('         原文摘录：' + '“' + (cq[c3].text || '') + '”');
        out.push('           页码 / 章节：' + (cq[c3].locator || '未提供') +
          '｜来源：' + (cq[c3].materialLabel || '—'));
        out.push('           定位结论：' + (cq[c3].locateText || '—'));
      }
      if (!cq.length) out.push('         （没有可定位的摘录 → 证据不足）');
      if (cl.downgraded && cl.downgradeText) out.push('         ' + cl.downgradeText);
      if (cl.note) out.push('         说明：' + cl.note);
    }
  }
  var unc = a.uncheckedClaims || [];
  for (var u2 = 0; u2 < unc.length; u2++) {
    out.push('     · 未核验主张：' + (unc[u2].text || '—') + '（本次没有可定位的摘录）');
  }

  /* ④ 用途：自动建议 vs 人工修订 */
  out.push('  ④ 用途：');
  if (a.usage) {
    out.push('     分析服务建议：' + (a.usage.text || '—') +
      (a.usage.why ? '（理由：' + a.usage.why + '）' : '') +
      (a.usage.caveat ? '（限定：' + a.usage.caveat + '）' : ''));
  }
  var ud = ref.usageDecision;
  if (ud) {
    out.push('     当前生效用途：' + (ud.text || '—') + '［来源：' + (ud.sourceText || ud.source || '—') +
      '｜' + (ud.at || '—') + '］');
    if (ud.reason) out.push('     你写的理由：' + ud.reason);
  } else {
    out.push('     当前生效用途：（无）');
  }
  var uh = ref.usageHistory || [];
  if (uh.length) {
    out.push('     用途变更历史（' + uh.length + ' 条，自动建议与人工修订各自保留）：');
    for (var h2 = 0; h2 < uh.length; h2++) {
      out.push('       - ' + (uh[h2].at || '—') + ' ' + (uh[h2].text || '') +
        '［' + (uh[h2].sourceText || uh[h2].source || '') + '］' +
        (uh[h2].reason ? '｜理由：' + uh[h2].reason : ''));
    }
  }

  /* ⑤ 确认状态：没确认过就写未确认 */
  if (ref.adaptConfirm) {
    out.push('  ⑤ 确认状态：已确认（' + (ref.adaptConfirm.at || '—') + '）' +
      (ref.adaptConfirm.note ? '｜备注：' + ref.adaptConfirm.note : ''));
  } else {
    out.push('  ⑤ 确认状态：未确认（自动结论不会自己变成已确认，需你本人在小程序内确认）');
  }

  /* ⑥ 下一轮检索建议（只给词，不给文献） */
  var nq = a.nextQueries || [];
  if (nq.length) {
    out.push('  ⑥ 下一轮检索建议（只给检索词，不推荐替代文献；替代文献也须同样核验）：');
    for (var n2 = 0; n2 < nq.length; n2++) {
      out.push('     - [' + (n2 + 1) + '] ' + (nq[n2].text || '') +
        (nq[n2].why ? '（' + nq[n2].why + '）' : ''));
    }
  }

  /* ⑦ 被机器校验拦下的内容 */
  var dr = a.dropped || [];
  if (dr.length) {
    out.push('  ⑦ 被机器校验拦下的内容（' + dr.length + ' 条）：');
    for (var d2 = 0; d2 < dr.length; d2++) {
      out.push('     - ' + (dr[d2].text || '') + '｜原因：' + (dr[d2].reason || ''));
    }
  }

  var st = a.stats || {};
  if (st.quotes) {
    out.push('  摘录校验：共 ' + st.quotes + ' 条，定位成功 ' + (st.located || 0) +
      '，未能定位 ' + (st.unlocated || 0) +
      '；剔除匹配度百分数 ' + (st.percentRemoved || 0) + ' 处，剔除「近年」表述 ' + (st.recencyRemoved || 0) + ' 处');
  }
  if (topic && a.topicRevision && a.topicRevision !== topic.revision) {
    out.push('  ［注意］这份结论基于课题第 ' + a.topicRevision + ' 版，当前已是第 ' + topic.revision + ' 版，需重新分析。');
  }
  return out;
}

/** 单独导出一条文献的适配记录（适配页「复制本条适配记录」用） */
function buildAdaptText(topic, ref) {
  var head = [];
  head.push('文献适配助手 · 课题适配与主张核验（单条）');
  head.push('导出时间：' + store.formatTime(new Date()));
  head.push('课题：' + (topic && topic.name || '—') + '（第 ' + (topic && topic.revision || '?') + ' 版）');
  head.push('文献：' + (trim(ref.title) || '（未填写）') +
    '｜' + (trim(ref.authors) || '') + '｜' + (trim(ref.year) || '') + '｜' + (trim(ref.venue) || ''));
  head.push('运行时说明：结论由小程序运行时调用的分析服务产出；未抓取全文；' +
    '开发阶段的助手（WorkBuddy）不参与运行时。');
  head.push('');
  return head.concat(adaptLines(topic, ref)).join('\n');
}

function verdictText(v) {
  if (v === 'match') return '一致';
  if (v === 'mismatch') return '冲突';
  if (v === 'weak') return '需人工核对';
  if (v === 'year_ambiguous') return '在线/卷期年份不同，请人工复核';
  if (v === 'input_missing') return '你未填写，未比对';
  if (v === 'record_missing') return '来源无此字段，未比对';
  return String(v || '');
}

function safe(obj, key) {
  if (!obj) return '—';
  return obj[key] || '—';
}

function buildFullText(topic, refs) {
  var now = store.formatTime(new Date());
  var head = [];
  head.push('文献适配助手 · 核验记录导出');
  head.push('导出时间：' + now);
  head.push('阶段说明：第二阶段版本。「文献身份和题录」可经由云函数自动核验（OpenAlex 优先，Crossref 降级）；');
  head.push('  「对本课题的用途」「对拟引用主张的支持」仍为由你粘贴材料得出的本地初判，不是对内容的核实。');
  head.push('能力边界：自动核验仅覆盖公开元数据库中有记录的外文文献；中文文献、学位论文、书籍、');
  head.push('  无 DOI 文献大概率无法自动核验，不代表文献虚假，统一进入人工核验流程。');
  head.push('数据来源：' + (topic.origin === 'sample' ? '含演示样例数据（流程演示样例，非实时核验结果）' : '用户本机输入'));
  head.push('');
  head.push('【课题信息】');
  head.push(line('课题名称', topic.name));
  head.push(line('研究问题', topic.problem));
  head.push(line('对象或场景', topic.target));
  head.push(line('期望完成的任务', topic.task));
  head.push(line('可用数据与条件', topic.resources));
  head.push(line('拟让文献支持的说法', topic.claim));
  if (topic.customFields && topic.customFields.length) {
    for (var i = 0; i < topic.customFields.length; i++) {
      head.push(line('学科补充项-' + topic.customFields[i].label, topic.customFields[i].value));
    }
  }
  head.push('课题版本：第 ' + topic.revision + ' 版（最后修改 ' + (topic.updatedAt || '—') + '）');
  head.push('文献条数：' + refs.length);
  head.push('');
  head.push('================ 逐条记录 ================');
  head.push('');

  var body = [];
  for (var k = 0; k < refs.length; k++) {
    body.push(buildRefText(topic, refs[k], k + 1, refs.length));
  }

  var foot = [];
  foot.push('================ 使用提醒 ================');
  foot.push('1. 「待核验/当前未核实」表示题录没有经过外部来源确认，引用前请自行在数据库或出版社页面核对。');
  foot.push('2. 「本地初判」基于你粘贴的材料做字面重合比对，不等价于文献内容核实，也不代表结论可直接套用。');
  foot.push('3. 「原文支持 / 与原文不符」只能由人工确认给出，请回原文核对语义、限定条件与适用范围。');
  foot.push('4. 课题要求修改后，旧版本产出的初判会标记为「需重新评估」，不要继续沿用。');
  foot.push('5. 「课题适配与主张核验」里的摘录都会标明定位结论；定位失败的按【证据不足】处理，不要当作原文依据。');
  foot.push('6. 只有摘要的条目一律标注「基于摘要初筛」，不能作为全文内容的证据；用途未确认前不会写成已确认。');
  foot.push('');
  foot.push('保存范围：本记录由本机小程序生成并保存，未上传服务器，未与其他用户数据共享。');

  return head.concat(body).concat(foot).join('\n');
}

function buildRefSingle(topic, ref) {
  return buildRefText(topic, ref, 1, 1);
}

/**
 * 检索推荐留痕导出（第三阶段）
 * 把一次「帮我找文献」的全过程原样落成文本：
 * 课题版本 → 检索式（模型产出 + 你的修改）→ 真实检索日志与候选集
 * → 去重与筛选理由 → 关系分析（推荐 / 待阅读线索 / 被丢弃的模型输出）。
 */
function buildDiscoverText(topic, run) {
  run = run || {};
  var out = [];
  out.push('文献适配助手 · 检索推荐留痕');
  out.push('导出时间：' + store.formatTime(new Date()));
  out.push('留痕编号：' + (run.id || '—') + '｜状态：' + (run.status || '—') +
    '｜创建：' + (run.createdAt || '—') + '｜更新：' + (run.updatedAt || '—'));
  out.push('');
  out.push('【课题信息（第 ' + ((topic && topic.revision) || (run.topicRevision) || '?') + ' 版）】');
  var tb = run.topicBrief || {};
  out.push(line('课题名称', tb.name || (topic && topic.name)));
  out.push(line('研究问题', tb.problem || (topic && topic.problem)));
  out.push(line('对象或场景', tb.target || (topic && topic.target)));
  out.push(line('期望完成的任务', tb.task || (topic && topic.task)));
  out.push(line('拟让文献支持的说法', tb.claim || (topic && topic.claim)));
  out.push(line('本次补充要求', run.hint));
  out.push('');

  out.push('【① 检索式】');
  var plan = run.plan || null;
  if (!plan) {
    out.push('（尚未生成检索式）');
  } else {
    out.push('生成方式：' + (plan.fallback ? '未按模型生成，使用课题原文机械拼接' : '通义千问生成（未开联网检索）'));
    out.push('关键词：' + ((plan.keywords || []).join('、') || '（无）'));
    out.push('同义词：' + ((plan.synonyms || []).join('、') || '（无）'));
    var qs = plan.queries || [];
    out.push('检索式 ' + qs.length + ' 条：');
    for (var i = 0; i < qs.length; i++) {
      out.push('  [' + (qs[i].enabled === false ? '未选' : '已选') + '][' + (qs[i].lang || '?') + '] ' +
        (qs[i].text || '') + (qs[i].why ? '（' + qs[i].why + '）' : ''));
    }
    var dr = plan.dropped || [];
    if (dr.length) {
      out.push('被丢弃的模型输出 ' + dr.length + ' 条：');
      for (var d = 0; d < dr.length; d++) {
        out.push('  · ' + (dr[d].text || '') + '：' + (dr[d].reason || ''));
      }
    }
    if (plan.scopeNote) out.push('模型给出的边界提示：' + plan.scopeNote);
  }
  out.push('');

  out.push('【② 真实检索】');
  var sr = run.search || null;
  if (!sr) {
    out.push('（尚未检索）');
  } else {
    out.push('结果状态：' + (sr.status === 'ok' ? '检索到候选'
      : (sr.status === 'empty' ? '检索成功但零结果' : '检索失败')));
    out.push('检索时间：' + (sr.at || '—'));
    var svs = sr.services || [];
    out.push('检索服务：' + (svs.map(function (s) {
      return s.name + (s.used ? '（已用）' : '（未用）');
    }).join('、') || '—'));
    out.push('实际发出的检索式：' + ((sr.executedQueries || []).map(function (q) {
      return '「' + q + '」';
    }).join('，') || '—'));
    if (sr.filters && (sr.filters.yearFrom || sr.filters.yearTo)) {
      out.push('年份筛选：' + (sr.filters.yearFrom || '不限') + ' ~ ' + (sr.filters.yearTo || '不限'));
    }
    out.push('逐次请求日志：');
    var lg = sr.log || [];
    for (var l = 0; l < lg.length; l++) {
      out.push('  · ' + lg[l].providerName + '｜HTTP ' + lg[l].httpStatus +
        '｜返回 ' + lg[l].returned + ' 条｜' + (lg[l].requestedAt || '') +
        (lg[l].failureKind ? '｜失败：' + (lg[l].failureDetail || lg[l].failureKind) : ''));
      out.push('    检索式：' + (lg[l].query || ''));
      out.push('    ' + (lg[l].apiUrl || ''));
    }
    var cov = sr.coverage || null;
    if (cov) {
      out.push('覆盖范围（如实）：' + cov.text);
      out.push('未覆盖：' + (cov.notCovered || []).join('；'));
      out.push(cov.notVerified || '');
    }
    out.push('排序说明：' + (sr.orderNote || ''));
    var cands = sr.candidates || [];
    out.push('去重后候选 ' + cands.length + ' 条（保存的完整候选集）：');
    for (var c = 0; c < cands.length; c++) {
      var cd = cands[c];
      out.push('  #' + (cd.id || (c + 1)) + ' ' + (cd.title || '') + '｜' + (cd.authors || '') +
        '｜' + (cd.venue || '') + '｜' + (cd.year || '') + '｜' + (cd.doi || '无 DOI'));
      out.push('     来源 ' + (cd.source || '') + '｜检索式 ' + (cd.query || '') +
        '｜取得 ' + (cd.retrievedAt || '') + '｜链接 ' + (cd.url || '（无）'));
      out.push('     阅读依据：' + (cd.evidenceText || '') +
        (cd.hasAbstract ? '（有摘要）' : '（无摘要）'));
      if (cd.missing && cd.missing.length) out.push('     题录缺失：' + cd.missing.join('、'));
      if (cd.alsoIn && cd.alsoIn.length) out.push('     同时也在：' + cd.alsoIn.join('、'));
    }
    var rm = sr.removedDuplicates || [];
    if (rm.length) {
      out.push('去重合并 ' + rm.length + ' 条（筛选理由）：');
      for (var r2 = 0; r2 < rm.length; r2++) {
        out.push('  · ' + (rm[r2].title || '') + '（' + (rm[r2].source || '') + '）：' + (rm[r2].reason || ''));
      }
    }
  }
  out.push('');

  out.push('【③ 关系分析】');
  var an = run.analysis || null;
  if (!an) {
    out.push('（尚未分析）');
  } else {
    out.push('分析模型：' + (an.model || '—') + '（未开联网检索，只依据真实检索到的记录）');
    out.push('分析时间：' + (an.at || '—') + '｜交给模型 ' + (an.analyzedCount || 0) +
      ' 条，未分析 ' + (an.unanalyzedCount || 0) + ' 条');
    if (an.percentRemoved) out.push('已删除模型给出的百分数评分 ' + an.percentRemoved + ' 处（无法验证）');
    if (an.note) out.push('模型整体说明：' + an.note);
    function dump(list, title) {
      out.push(title + '（' + (list || []).length + ' 条）：');
      for (var k = 0; k < (list || []).length; k++) {
        var it = list[k] || {};
        var cc = it.cand || {};
        out.push('  · ' + (cc.title || '') + '｜' + (cc.authors || '') + '｜' + (cc.venue || '') + '｜' + (cc.year || ''));
        out.push('     阅读依据：' + (cc.evidenceText || '') + '｜链接：' + (cc.url || '（无）'));
        if (it.why) out.push('     推荐理由：' + it.why);
        if (it.match && it.match.length) out.push('     匹配点：' + it.match.join('；'));
        if (it.gap && it.gap.length) out.push('     差异 / 局限：' + it.gap.join('；'));
        if (it.todo && it.todo.length) out.push('     仍需验证：' + it.todo.join('；'));
        if (it.uses && it.uses.length) out.push('     建议用途：' + it.uses.join('、'));
      }
    }
    dump(an.recommended, '推荐清单');
    dump(an.leads, '待阅读线索（材料不足，匹配程度尚未确认）');
    dump(an.others, '其余已分析条目');
    var dp = an.dropped || [];
    if (dp.length) {
      out.push('被丢弃的模型输出 ' + dp.length + ' 条：');
      for (var q2 = 0; q2 < dp.length; q2++) {
        out.push('  · ' + (dp[q2].id || '') + '：' + (dp[q2].reason || ''));
      }
    }
  }
  out.push('');
  out.push('说明：本留痕只记录「用哪些检索式、在哪些服务、查到了什么」，' +
    '检索到记录不等于论文质量已核实，也不代表原文已被读过。');
  return out.join('\n');
}

module.exports = {
  buildFullText: buildFullText,
  buildRefSingle: buildRefSingle,
  buildRefText: buildRefText,
  buildDiscoverText: buildDiscoverText,
  buildAdaptText: buildAdaptText,
  adaptLines: adaptLines
};
