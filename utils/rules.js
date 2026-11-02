/**
 * 本地判定规则
 * ------------------------------------------------------------
 * 诚实边界（非常重要）：
 *   1. 第一阶段没有接入任何外部文献数据库，因此「文献身份和题录」永远不会输出
 *      「已核实」，只能输出「当前未核实（待核验）」或「字段冲突」。
 *   2. 「对本课题的用途」「对拟引用主张的支持」是基于用户自己粘贴的材料做本地
 *      关键词/字面重合比对得出的【本地初判】，不是对文献内容的核实。
 *   3. 「原文支持」「与原文不符」需要回原文核对语义与限定条件，自动初判从不给出
 *      这两个结论，只能由用户在「人工确认」中选择。
 */

var STOP = {
  'the': 1, 'of': 1, 'and': 1, 'a': 1, 'an': 1, 'for': 1, 'with': 1, 'on': 1,
  'in': 1, 'to': 1, 'from': 1, 'by': 1, 'at': 1, 'as': 1, 'is': 1, 'are': 1,
  'using': 1, 'based': 1, 'study': 1, 'research': 1, 'paper': 1, 'this': 1,
  '的': 1, '了': 1, '和': 1, '与': 1, '及': 1, '在': 1, '对': 1, '为': 1,
  '是': 1, '中': 1, '其': 1, '该': 1, '或': 1, '并': 1, '本研究': 1, '一种': 1,
  '我们': 1, '本文': 1, '进行': 1, '用于': 1, 'within': 1, 'via': 1
};

function trim(s) { return (s || '').replace(/^\s+|\s+$/g, ''); }

function isCjk(ch) { return /[\u4e00-\u9fa5]/.test(ch); }

/** 极简分词：英文取词，中文取 2-gram */
function tokenize(text) {
  text = (text || '').toLowerCase();
  var out = [];
  var seen = {};
  function push(t) {
    if (t && t.length > 1 && !STOP[t] && !seen[t]) { seen[t] = 1; out.push(t); }
  }
  var latin = text.match(/[a-z][a-z0-9\-]{1,}/g) || [];
  for (var i = 0; i < latin.length; i++) push(latin[i]);
  var cjkRuns = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (var j = 0; j < cjkRuns.length; j++) {
    var run = cjkRuns[j];
    for (var k = 0; k <= run.length - 2; k++) push(run.substr(k, 2));
  }
  return out;
}

function termsOf(text) { return tokenize(text); }

function overlap(listA, setB) {
  var hits = [];
  for (var i = 0; i < listA.length; i++) {
    if (setB[listA[i]] && hits.indexOf(listA[i]) < 0) hits.push(listA[i]);
  }
  return hits;
}

function toSet(arr) {
  var s = {};
  for (var i = 0; i < arr.length; i++) s[arr[i]] = 1;
  return s;
}

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/[\s，,。．、;；:：()（）\[\]【】"'“”‘’\-—_]/g, '');
}

function jaccard(a, b) {
  var sa = toSet(a), sb = toSet(b);
  var inter = 0, unionKeys = {};
  var k;
  for (k in sa) unionKeys[k] = 1;
  for (k in sb) unionKeys[k] = 1;
  var total = 0;
  for (k in unionKeys) {
    total++;
    if (sa[k] && sb[k]) inter++;
  }
  return total ? inter / total : 0;
}

/* ---------------- 参考文献解析 ---------------- */

function extractDoi(line) {
  var m = line.match(/10\.\d{4,9}\/[^\s，,；;）)]+/);
  return m ? m[0] : '';
}

function extractUrl(line) {
  var m = line.match(/https?:\/\/[^\s，,；;）)]+/);
  return m ? m[0] : '';
}

function extractYear(line) {
  var m = line.match(/(19|20)\d{2}(?!\d)/);
  return m ? m[0] : '';
}

function parseOne(line) {
  var raw = trim(line);
  var item = {
    raw: raw, title: '', authors: '', year: '', venue: '', doi: '', url: '',
    note: '', evidence: { link: '', abstract: '', excerpt: '' },
    parsed: { title: '', authors: '', year: '', venue: '', doi: '', url: '' }
  };
  if (!raw) return null;

  item.doi = extractDoi(raw);
  item.url = extractUrl(raw);
  item.year = extractYear(raw);

  var body = raw;
  if (item.doi) body = body.replace(item.doi, ' ');
  if (item.url) body = body.replace(item.url, ' ');
  body = trim(body);

  // 去掉编号前缀：[1] / 1. / (1) / ①
  body = body.replace(/^[\[（(【]?\d{1,2}[\]）)】：.]?\s*/, '');

  // 作者段：第一个中文句号 / 英文句点之前、且较短的一段
  var rest = body;
  var cut = rest.search(/(\.\s|．|。)/);
  if (cut > -1 && cut > 1 && cut < 70) {
    var seg = trim(rest.slice(0, cut));
    if (seg && seg.length < 60) {
      item.authors = seg;
      rest = trim(rest.slice(cut + 1));
    }
  }

  // 题名段：到 [J]/[C]/[M] 标记、句号或句号+空格
  var docType = '';
  var dm = rest.match(/^\[([A-Za-z]{1,2})\]/);
  if (dm) { docType = dm[1]; rest = trim(rest.slice(dm[0].length)); }

  var tEnd = rest.search(/(\.\s|。|\[[A-Za-z]{1,2}\]|,\s*(?:19|20)\d{2}|，\s*(?:19|20)\d{2})/);
  if (tEnd > 0) {
    item.title = trim(rest.slice(0, tEnd));
    var tail = trim(rest.slice(tEnd));
    // 去掉可能出现的文献类型标记 [J]/[C]，再取出处
    tail = tail.replace(/^[\.。，,、]+/, '');
    tail = tail.replace(/^\[[A-Za-z]{1,2}\][\.。，,]*\s*/, '');
    var chunks = tail.split(/[，,。.]/);
    var venue = trim(chunks[0]);
    if (/^\d{2,}$/.test(venue)) venue = (chunks.length > 1 && !/^\d/.test(trim(chunks[1]))) ? trim(chunks[1]) : '';
    item.venue = venue;
  } else {
    item.title = trim(rest);
  }
  if (docType && (item.venue === '[J]' || !item.venue)) item.venue = item.venue && item.venue !== '[J]' ? item.venue : '';

  if (!item.title) {
    item.title = raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
    item.note = '未能从粘贴内容中稳定识别题名，请手动修正字段';
  }

  item.parsed = {
    title: item.title, authors: item.authors, year: item.year,
    venue: item.venue, doi: item.doi, url: item.url
  };
  item.evidence.link = item.url;
  return item;
}

function splitLines(text) {
  var arr = (text || '').split(/\r?\n/);
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var line = trim(arr[i]);
    if (!line) continue;
    out.push(line);
  }
  return out;
}

/** 解析最多 max 条 */
function parseRefs(text, max) {
  var lines = splitLines(text);
  var items = [];
  var truncated = false;
  for (var i = 0; i < lines.length; i++) {
    if (i >= max) { truncated = true; break; }
    var it = parseOne(lines[i]);
    if (it) items.push(it);
  }
  return { items: items, total: lines.length, truncated: truncated };
}

/* ---------------- 重复检测 ---------------- */

function findDuplicate(item, existing) {
  var nt = normalizeTitle(item.title);
  if (!nt) return null;
  var tokens = tokenize(item.title);
  for (var i = 0; i < existing.length; i++) {
    var e = existing[i];
    if (normalizeTitle(e.title) === nt) return e;
    if (tokens.length >= 3) {
      var j = jaccard(tokens, tokenize(e.title));
      if (j >= 0.8) return e;
    }
  }
  return null;
}

/* ---------------- 三项判定 ---------------- */

function materialText(ref) {
  return [ref.title, ref.evidence.abstract, ref.evidence.excerpt].join(' ');
}

function hasMaterial(ref) {
  return !!(trim(ref.title) || trim(ref.evidence.abstract) || trim(ref.evidence.excerpt));
}

var FIELD_LABELS = {
  title: '题名', authors: '作者', year: '年份',
  venue: '出处', doi: 'DOI', url: '链接'
};

/**
 * 1) 文献身份和题录
 * 只可能输出：当前未核实（待核验） / 字段冲突
 */
/**
 * 1) 文献身份和题录
 * 第二阶段起：若已做过外部来源核验，结果在 ref.identity 里，直接呈现；
 * 没做过则回落为「待核验（当前未核实）」，仍然【不会】被说成已核实。
 */
function judgeIdentity(ref) {
  if (ref.identity && ref.identity.statusKey) {
    return mergeIdentityResult(ref, ref.identity);
  }
  return judgeIdentityLocal(ref);
}

/** 云函数返回的自动核验结果 → 判定对象（保留本地字段冲突检测作为补充） */
function mergeIdentityResult(ref, idn) {
  // 本地「粘贴解析 vs 人工填写」的字段冲突仍然独立显示，不与外部核验混为一谈
  var local = judgeIdentityLocal(ref);
  var manualCount = (ref.manualEvidence || []).length;
  var reason = idn.reason || '';
  if (manualCount) {
    reason += '［本条另有 ' + manualCount + ' 条人工备注，与系统自动结论并列保存，自动结论未被修改。］';
  }
  return {
    status: idn.statusText || '待核验',
    label: idn.label || idn.statusText || '待核验',
    tone: idn.tone || toneOfIdentity(idn.statusKey),
    reason: reason,
    sourceMark: sourceMarkOf(idn),
    fields: [],
    conflicts: [],
    localConflicts: local.conflicts,
    localFields: local.fields,
    identity: idn
  };
}

function sourceMarkOf(idn) {
  if (!idn.provider) return '自动 · 经云函数中转的外部来源核验';
  var p = idn.provider.id === 'manual'
    ? '人工补证'
    : ('自动 · ' + idn.provider.name + '（经云函数中转）');
  if (idn.fetchedAt) p += '｜取得时间 ' + idn.fetchedAt;
  if (idn.httpStatus) p += '｜HTTP ' + idn.httpStatus;
  return p;
}

/**
 * 5 类核验状态 → 展示色调
 *   ok 绿 / orange 橙 / yellow 黄 / gray 灰
 */
function toneOfIdentity(statusKey) {
  if (statusKey === 'verified') return 'ok';
  /* 题名一致 + 仅 1 项不一致：按用户规则算核验通过（绿），但文案带「待人工确认」 */
  if (statusKey === 'verified_one_conflict') return 'ok';
  if (statusKey === 'conflict') return 'orange';
  if (statusKey === 'multi_candidate') return 'yellow';
  return 'gray';
}

/** 原本的本地比对（无外部来源时使用） */
function judgeIdentityLocal(ref) {
  var conflicts = [];
  var keys = ['title', 'authors', 'year', 'venue', 'doi', 'url'];
  var fields = [];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var cur = trim(ref[k]);
    var parsed = trim(ref.parsed ? ref.parsed[k] : '');
    if (cur) {
      var src = parsed === cur ? '来自粘贴内容解析' : (parsed ? '人工修正（与解析结果不一致）' : '仅人工填写');
      if (parsed && parsed !== cur) {
        conflicts.push({ name: FIELD_LABELS[k], parsed: parsed, current: cur });
      }
      fields.push({ name: FIELD_LABELS[k], value: cur, source: src });
    }
  }

  var status = conflicts.length ? '字段冲突' : '当前未核实';
  var reason = conflicts.length
    ? '同一字段存在两个不同来源取值（粘贴内容解析 vs 人工填写/修正），未经外部来源核对。'
    : '这条还没做过外部来源核验，题录信息未经任何外部来源确认。可到「核验卡」里点「核验身份」发起查询。';

  return {
    status: status,
    label: conflicts.length ? '字段冲突' : '待核验（当前未核实）',
    reason: reason,
    tone: conflicts.length ? 'danger' : 'gray',
    sourceMark: '自动 · 本地比对，未连外部来源',
    fields: fields,
    conflicts: conflicts,
    missingAbstract: !trim(ref.title)
  };
}

function topicTerms(topic) {
  var core = tokenize([topic.target, topic.task].join(' '));
  var problem = tokenize(topic.problem);
  var side = tokenize([topic.claim, (topic.customFields || []).map(function (f) { return f.value; }).join(' ')].join(' '));
  return { core: core, problem: problem, side: side };
}

/**
 * 2) 对本课题的用途（本地初判）
 */
function judgeUsage(topic, ref) {
  if (!hasMaterial(ref)) {
    return {
      status: '信息不足', label: '信息不足（缺少可用材料）', tone: 'gray',
      reason: '未提供题名、摘要或原文节选中的任何一项，无法判断是否与课题相关。',
      sourceMark: '自动 · 本地初判', hits: [], detail: []
    };
  }
  var mat = materialText(ref);
  var matSet = toSet(tokenize(mat));
  var tt = topicTerms(topic);

  var targetSet = toSet(tokenize(topic.target));
  var taskSet = toSet(tokenize(topic.task));
  var probSet = toSet(tokenize(topic.problem));
  var sideSet = toSet(tt.side);

  var hitTarget = overlap(tokenize(topic.target), matSet);
  var hitTask = overlap(tokenize(topic.task), matSet);
  var hitProb = overlap(tokenize(topic.problem), matSet);
  var hitSide = overlap(tt.side, matSet);

  var detail = [];
  var titleOnly = !trim(ref.evidence.abstract) && !trim(ref.evidence.excerpt);
  if (tokenize(topic.target).length) detail.push('对象/场景：命中 ' + hitTarget.length + '/' + tokenize(topic.target).length + (hitTarget.length ? '（' + hitTarget.slice(0, 6).join('、') + '）' : ''));
  if (tokenize(topic.task).length) detail.push('期望任务：命中 ' + hitTask.length + '/' + tokenize(topic.task).length + (hitTask.length ? '（' + hitTask.slice(0, 6).join('、') + '）' : ''));
  if (tokenize(topic.problem).length) detail.push('研究问题：命中 ' + hitProb.length + '/' + tokenize(topic.problem).length + (hitProb.length ? '（' + hitProb.slice(0, 6).join('、') + '）' : ''));
  if (tt.side.length) detail.push('补充条件/自定义项：命中 ' + hitSide.length + '/' + tt.side.length);

  var status, reason;
  if (hitTarget.length && hitTask.length) {
    status = '直接相关研究';
    reason = '材料同时出现课题「对象/场景」与「期望任务」的相关表述，字面重合度高。注意：这只是字面重合，不等于结论适用。';
  } else if (hitTarget.length || hitTask.length) {
    status = '方法借鉴';
    reason = hitTarget.length
      ? '材料出现课题对象/场景相关表述，但未出现与你的研究任务直接相关的表述。可能适合借鉴对象界定或方法，需你核对研究任务是否一致。'
      : '材料出现与你研究任务相近的表述，但对象/场景未见对应。可能仅方法可借鉴，请核对研究对象是否一致。';
  } else if (hitProb.length || hitSide.length) {
    status = '背景参考';
    reason = '材料仅与研究问题主题或补充条件有字面重合，未见对象、任务层面的对应表述，建议只作背景。';
  } else if (titleOnly) {
    // 只有题名，没有任何摘要/节选：不足以判断相关性，不能据此说「不符」
    status = '信息不足';
    reason = '目前只有题名，没有摘要或原文节选，不足以判断它与本课题的关系。可用「补充证据」粘贴摘要或结论段后重新初判。';
  } else {
    status = '与当前要求不符';
    reason = '在你提供的材料中未发现与课题对象、任务、研究问题相关的表述。可能是研究对象不同或任务不同，不要直接当作本课题证据使用。';
  }

  return {
    status: status, label: status, tone: toneOfUsage(status),
    reason: reason, sourceMark: '自动 · 本地初判（关键词/字面重合比对）',
    hits: hitTarget.concat(hitTask).concat(hitProb).concat(hitSide).slice(0, 10),
    detail: detail
  };
}

function toneOfUsage(status) {
  if (status === '直接相关研究') return 'info';
  if (status === '方法借鉴') return 'purple';
  if (status === '背景参考') return 'gray';
  if (status === '与当前要求不符') return 'danger';
  return 'gray';
}

/**
 * 3) 对拟引用主张的支持（本地初判，永不输出「原文支持 / 与原文不符」）
 */
function judgeClaim(topic, ref) {
  var claim = trim(topic.claim);
  if (!claim) {
    return {
      status: '未检查主张', label: '未检查主张（课题未填写拟支持说法）', tone: 'gray',
      reason: '「我的课题」页还没有填写「希望文献支持的说法」，因此不与任何主张比对。可先在课题页补充。',
      sourceMark: '自动 · 本地初判', hits: [], detail: []
    };
  }
  if (!trim(ref.evidence.abstract) && !trim(ref.evidence.excerpt)) {
    return {
      status: '证据不足', label: '证据不足（无摘要/节选）', tone: 'gray',
      reason: '未提供摘要或原文节选，无法判断它是否支持你写下的说法。可用「补充证据」粘贴原文节选后重新初判。',
      sourceMark: '自动 · 本地初判', hits: [], detail: []
    };
  }
  var evSet = toSet(tokenize([ref.evidence.abstract, ref.evidence.excerpt].join(' ')));
  var claimTokens = tokenize(claim);
  var hits = overlap(claimTokens, evSet);
  var policyWords = ['所有', '全部', '均', '必然', '一定', 'all', 'always', 'never', '主要原因', '唯一'];
  var hasAbsolute = false;
  for (var i = 0; i < policyWords.length; i++) {
    if (claim.indexOf(policyWords[i]) > -1) hasAbsolute = true;
  }

  var detail = ['你拟让文献支持的说法：' + claim];
  detail.push('主张关键词命中 ' + hits.length + '/' + claimTokens.length + (hits.length ? '（' + hits.slice(0, 8).join('、') + '）' : ''));
  if (hasAbsolute) detail.push('提示：说法中包含全称/绝对化表述，即便关键词命中，也容易构成范围扩大，务必回原文核对限定条件。');

  if (!hits.length) {
    return {
      status: '证据不足', label: '证据不足（未见对应表述）', tone: 'gray',
      reason: '你提供的摘要/节选中未出现该说法的实质表述。不要用它来支持这句话，或先补充更完整的原文节选。',
      sourceMark: '自动 · 本地初判', hits: [], detail: detail
    };
  }
  return {
    status: '需补充条件', label: '需补充条件（字面命中，不代表原文支持）', tone: 'warn',
    reason: '节选中出现部分与该说法相关的表述，但自动比对无法判断语义、适用条件与结论范围是否一致。请回原文核对限定条件后，在「人工确认」中给出你的判断。',
    sourceMark: '自动 · 本地初判', hits: hits, detail: detail
  };
}

function evaluate(topic, ref) {
  return {
    revision: topic.revision,
    at: '',
    // 课题版本快照：用于记录「当时依据的课题要求」
    snapshot: {
      name: topic.name, target: topic.target, task: topic.task,
      problem: topic.problem, claim: topic.claim,
      customFields: (topic.customFields || []).map(function (f) {
        return { label: f.label, value: f.value };
      })
    },
    identity: judgeIdentity(ref),
    usage: judgeUsage(topic, ref),
    claim: judgeClaim(topic, ref)
  };
}

module.exports = {
  RULE_VERSION: 'stage1-local-heuristic-v1',
  tokenize: tokenize,
  termsOf: termsOf,
  parseRefs: parseRefs,
  parseOne: parseOne,
  splitLines: splitLines,
  findDuplicate: findDuplicate,
  normalizeTitle: normalizeTitle,
  judgeIdentity: judgeIdentity,
  judgeUsage: judgeUsage,
  judgeClaim: judgeClaim,
  evaluate: evaluate,
  hasMaterial: hasMaterial,
  trim: trim
};
