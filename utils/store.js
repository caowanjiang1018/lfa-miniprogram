/**
 * 本地存储层
 * ------------------------------------------------------------
 * 保存范围说明（第一阶段）：
 *   - 所有数据写入本机微信小程序本地缓存（wx.getStorageSync，单键 lfa_db_v1）
 *   - 不上传服务器、不使用云开发、无账号体系
 *   - 数据只在当前手机 + 当前小程序内可见，不同用户互不共享，不会混显
 *   - 清除小程序缓存 / 卸载微信会导致数据丢失，导出记录请走「复制记录」
 */

var KEY = 'lfa_db_v1';
var RULE_VERSION = 'stage1-local-heuristic-v1';

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function formatTime(d) {
  if (!d) d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function newId(p) {
  return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function emptyDb() {
  return {
    version: 1,
    topics: [],
    refs: [],
    settings: { activeTopicId: '', sampleLoaded: false, createdAt: '' }
  };
}

function ensure() {
  try {
    var db = wx.getStorageSync(KEY);
    if (!db || typeof db !== 'object') {
      db = emptyDb();
      db.settings.createdAt = formatTime();
      wx.setStorageSync(KEY, db);
    }
    return db;
  } catch (e) {
    return emptyDb();
  }
}

function readDb() {
  var db = null;
  try { db = wx.getStorageSync(KEY); } catch (e) { db = null; }
  if (!db || typeof db !== 'object') db = emptyDb();
  if (!db.topics) db.topics = [];
  if (!db.refs) db.refs = [];
  /* 第三阶段：检索推荐（「帮我找文献」）的留痕。
   * 每次检索都把【检索式 / 真实候选集 / 去重与筛选理由 / 分析留痕】整份存下来，
   * 便于事后回看「当时到底用哪些词、在哪些服务、查到了什么」。 */
  if (!db.discoverRuns) db.discoverRuns = [];
  if (!db.settings) db.settings = { activeTopicId: '', sampleLoaded: false };
  return db;
}

function writeDb(db) {
  try { wx.setStorageSync(KEY, db); } catch (e) {
    wx.showToast({ title: '本地保存失败，缓存可能已满', icon: 'none' });
  }
}

/* ---------------- 课题 ---------------- */

function newTopic() {
  return {
    id: '',
    name: '',
    problem: '',
    target: '',
    task: '',
    resources: '',
    claim: '',
    customFields: [],
    revision: 1,
    requirementHash: '',
    createdAt: '',
    updatedAt: '',
    origin: 'user'
  };
}

function cleanCustomFields(list) {
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var f = list[i];
    var label = (f.label || '').replace(/^\s+|\s+$/g, '');
    var value = (f.value || '').replace(/^\s+|\s+$/g, '');
    if (label && value) out.push({ id: f.id || newId('cf'), label: label, value: value });
  }
  return out;
}

// 只有影响匹配判断的字段参与版本哈希；课题名称改动不触发重新评估
function hashRequirement(topic) {
  var cf = cleanCustomFields(topic.customFields);
  return JSON.stringify([
    topic.problem || '',
    topic.target || '',
    topic.task || '',
    topic.resources || '',
    topic.claim || '',
    cf.map(function (f) { return f.label + '=' + f.value; }).join('|')
  ]);
}

function getTopics() {
  var db = readDb();
  return db.topics.filter(function (t) { return t.origin !== 'sample'; }).concat(
    db.topics.filter(function (t) { return t.origin === 'sample'; })
  );
}

function getTopic(id) {
  var ts = readDb().topics;
  for (var i = 0; i < ts.length; i++) if (ts[i].id === id) return ts[i];
  return null;
}

function getActiveTopic() {
  var db = readDb();
  if (db.settings.activeTopicId) {
    var t = getTopic(db.settings.activeTopicId);
    if (t) return t;
  }
  var ts = db.topics;
  return ts.length ? ts[ts.length - 1] : null;
}

function setActiveTopic(id) {
  var db = readDb();
  db.settings.activeTopicId = id;
  writeDb(db);
}

/** 课题编辑草稿：用户点了「新建另一个课题」但还没保存时，内容临时存在这里，避免切页/重启丢内容 */
function getDraft() {
  var db = readDb();
  return (db.settings && db.settings.draft) || null;
}

function saveDraft(topic) {
  var db = readDb();
  db.settings.draft = topic;
  writeDb(db);
}

function clearDraft() {
  var db = readDb();
  if (db.settings) db.settings.draft = null;
  writeDb(db);
}

function removeTopic(id) {
  var db = readDb();
  db.topics = db.topics.filter(function (t) { return t.id !== id; });
  db.refs = db.refs.filter(function (r) { return r.topicId !== id; });
  if (db.settings.activeTopicId === id) {
    db.settings.activeTopicId = db.topics.length ? db.topics[db.topics.length - 1].id : '';
  }
  if (db.settings.draft && db.settings.draft.id === id) db.settings.draft = null;
  writeDb(db);
}

/** 保存课题；若影响匹配的字段发生变化，版本号自增 */
function upsertTopic(topic) {
  var db = readDb();
  var hash = hashRequirement(topic);
  var isNew = !topic.id;
  var changed = false;
  topic.customFields = cleanCustomFields(topic.customFields);
  topic.requirementHash = hash;
  topic.updatedAt = formatTime();

  if (isNew) {
    topic.id = newId('topic');
    topic.revision = 1;
    topic.createdAt = topic.updatedAt;
    if (!topic.origin) topic.origin = 'user';
    db.topics.push(topic);
  } else {
    for (var i = 0; i < db.topics.length; i++) {
      if (db.topics[i].id === topic.id) {
        var old = db.topics[i];
        if (old.requirementHash !== hash) {
          topic.revision = (old.revision || 1) + 1;
          changed = true;
        } else {
          topic.revision = old.revision || 1;
        }
        topic.createdAt = old.createdAt;
        topic.origin = old.origin || topic.origin || 'user';
        db.topics[i] = topic;
        break;
      }
    }
  }
  db.settings.activeTopicId = topic.id;
  writeDb(db);
  return { topic: topic, requirementChanged: changed };
}

/* ---------------- 文献条目 ---------------- */

function newRef(topicId) {
  return {
    id: newId('ref'),
    topicId: topicId,
    origin: 'user', // user | sample
    raw: '',
    title: '',
    authors: '',
    year: '',
    venue: '',
    doi: '',
    url: '',
    note: '',
    parsed: { title: '', authors: '', year: '', venue: '', doi: '', url: '' },
    evidence: { link: '', abstract: '', excerpt: '' },
    dupNote: '',
    fieldsEdited: false,
    createdAt: formatTime(),
    updatedAt: formatTime(),
    evals: [],   // 自动初判历史（不可被人工修改覆盖）
    confirms: [],// 人工确认历史
    identity: null,      // 当前生效的【系统自动核验】原始结果（第二阶段起）
    identityHistory: [], // 历史自动核验结果，追加不覆盖
    manualEvidence: [],  // 人工补证 / 人工备注，只追加，绝不覆盖自动结果
    /* 第四阶段：课题适配与主张核验
     *   adapt          —— 运行时分析服务给出的【自动结论】（追加保存，不被覆盖）
     *   adaptHistory   —— 历史自动结论
     *   usageDecision  —— 当前生效的用途（可能来自 AI 建议，也可能是用户改过的）
     *   usageHistory   —— 用途变更历史，自动建议与人工修订都在里面，各自带来源标记
     *   adaptConfirm   —— 人工确认记录；【只有它存在，这条才算「已确认」】 */
    adapt: null,
    adaptHistory: [],
    usageDecision: null,
    usageHistory: [],
    adaptConfirm: null,
    /* 第三阶段：「帮我找文献」进来的条目，保存【系统当时的原始推荐】。
     * 与 confirms（用户决定）分开保存，用户确认不会改写它，新的检索也不会覆盖它。 */
    recommend: null,
    recommendHistory: [],
    /* 第五阶段：
     *   conflictAcks —— 「单一字段冲突」的人工确认记录（追加，不覆盖自动结论）
     *   fills        —— 核验成功后的补全记录：补了哪些字段、值从哪来、来源名与时间 */
    conflictAcks: [],
    fills: []
  };
}

/* ---------------- 检索推荐（「帮我找文献」）留痕 ---------------- */

/** 题名归一化：用于判断是否已经在文献库里 */
function titleKey(t) {
  return String(t || '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/g, '').slice(0, 120);
}

function newDiscoverRun(topicId, topic) {
  topic = topic || {};
  return {
    id: newId('drun'),
    topicId: topicId,
    topicRevision: topic.revision || 1,
    topicBrief: {
      name: topic.name || '', problem: topic.problem || '', target: topic.target || '',
      task: topic.task || '', claim: topic.claim || ''
    },
    hint: '',
    createdAt: formatTime(),
    updatedAt: formatTime(),
    plan: null,        // 检索式规划（模型产出 + 用户修改）
    search: null,      // 真实检索结果（候选集 / 日志 / 覆盖说明）
    filters: {},       // 用户实际使用的筛选条件
    analysis: null,    // 关系分析（模型解释 + 系统判定的阅读依据）
    status: 'planned'  // planned | searched | analyzed | failed | empty
  };
}

/** 保存 / 更新一次检索留痕（整份覆盖当前 run，历史 run 不动） */
function saveDiscoverRun(run) {
  if (!run || !run.id) return null;
  var db = readDb();
  run.updatedAt = formatTime();
  var hit = false;
  for (var i = 0; i < db.discoverRuns.length; i++) {
    if (db.discoverRuns[i].id === run.id) { db.discoverRuns[i] = run; hit = true; break; }
  }
  if (!hit) db.discoverRuns.push(run);
  writeDb(db);
  return run;
}

function getDiscoverRun(id) {
  var rs = readDb().discoverRuns;
  for (var i = 0; i < rs.length; i++) if (rs[i].id === id) return rs[i];
  return null;
}

function getDiscoverRuns(topicId) {
  var rs = readDb().discoverRuns;
  var out = [];
  for (var i = 0; i < rs.length; i++) if (!topicId || rs[i].topicId === topicId) out.push(rs[i]);
  return out;
}

function getLatestDiscoverRun(topicId) {
  var rs = getDiscoverRuns(topicId);
  return rs.length ? rs[rs.length - 1] : null;
}

function removeDiscoverRun(id) {
  var db = readDb();
  db.discoverRuns = db.discoverRuns.filter(function (r) { return r.id !== id; });
  writeDb(db);
}

/* --------------------------------------------------------------------------
 *  检索清单【历史记录】
 * --------------------------------------------------------------------------
 *  discoverRuns 是「当前这一轮」的工作区（会被反复改写）；
 *  discoverHistory 是每次真实检索完成后【封存的一份快照】，只追加、不改写，
 *  用来满足「查到过的清单可以反复回看」：换课题、重新检索、清缓存前都能翻。
 *
 *  封存内容＝当时真正生效的东西：检索式、候选集、覆盖说明、检索日志、筛选条件、
 *  分析结论（分析完成后回填）、加入文献库的条目 id。
 */
function getDiscoverHistory(topicId) {
  var db = readDb();
  if (!db.discoverHistory) db.discoverHistory = [];
  var out = [];
  for (var i = 0; i < db.discoverHistory.length; i++) {
    var h = db.discoverHistory[i];
    if (!topicId || h.topicId === topicId) out.push(h);
  }
  /* 最新的排前面，方便回看 */
  out.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
  return out;
}

function getDiscoverHistoryItem(id) {
  var hs = getDiscoverHistory();
  for (var i = 0; i < hs.length; i++) if (hs[i].id === id) return hs[i];
  return null;
}

/**
 * 封存一次真实检索的清单。
 * 只在【确实发出过检索请求并有结果/结论】之后调用；没有候选也照样封存，
 * 但要带上 status，回看时才知道那次是「查到了」还是「没查到 / 失败了」。
 */
function archiveDiscoverSearch(run, extra) {
  if (!run) return null;
  extra = extra || {};
  var db = readDb();
  if (!db.discoverHistory) db.discoverHistory = [];
  var search = run.search || {};
  var cands = search.candidates || [];
  var item = {
    id: newId('dhis'),
    runId: run.id || '',
    topicId: run.topicId || '',
    topicRevision: run.topicRevision || 1,
    topicBrief: run.topicBrief || {},
    hint: run.hint || '',
    queries: extra.queries || [],
    filters: run.filters || {},
    plan: run.plan || null,
    search: search,
    analysis: run.analysis || null,
    status: extra.status || (search.status || (cands.length ? 'ok' : 'empty')),
    total: cands.length,
    recommended: ((run.analysis || {}).recommended || []).length,
    addedRefIds: [],
    createdAt: formatTime(),
    updatedAt: formatTime()
  };
  db.discoverHistory.push(item);
  writeDb(db);
  return item;
}

/** 分析完成后回填到对应历史条目（只补 analysis，不动画面里已封存的候选） */
function updateHistoryAnalysis(id, analysis) {
  var db = readDb();
  if (!db.discoverHistory) db.discoverHistory = [];
  for (var i = 0; i < db.discoverHistory.length; i++) {
    if (db.discoverHistory[i].id === id) {
      db.discoverHistory[i].analysis = analysis || null;
      db.discoverHistory[i].recommended = ((analysis || {}).recommended || []).length;
      db.discoverHistory[i].updatedAt = formatTime();
      writeDb(db);
      return db.discoverHistory[i];
    }
  }
  return null;
}

/** 记录某条历史清单里哪些条目被加入了文献库 */
function markHistoryAdded(id, refId) {
  var db = readDb();
  if (!db.discoverHistory) db.discoverHistory = [];
  for (var i = 0; i < db.discoverHistory.length; i++) {
    if (db.discoverHistory[i].id === id) {
      var arr = db.discoverHistory[i].addedRefIds || [];
      if (arr.indexOf(refId) < 0) arr.push(refId);
      db.discoverHistory[i].addedRefIds = arr;
      db.discoverHistory[i].updatedAt = formatTime();
      writeDb(db);
      return db.discoverHistory[i];
    }
  }
  return null;
}

function removeDiscoverHistory(id) {
  var db = readDb();
  if (!db.discoverHistory) db.discoverHistory = [];
  db.discoverHistory = db.discoverHistory.filter(function (h) { return h.id !== id; });
  writeDb(db);
}

/**
 * 把推荐清单里的一条【加入项目文献库】。
 * 规则（需求 9）：
 *   - 题录全部来自真实检索记录，不做任何补全；
 *   - 已存在的同 DOI / 同题名条目【不新建、不覆盖】（包括用户已人工确认的条目）；
 *   - 系统原始推荐写进 ref.recommend，与用户后续的人工确认分开保存。
 * @returns {{ref: object, existed: boolean}}
 */
function addDiscoverRef(topicId, item, run, topic) {
  var cand = (item && item.cand) || {};
  /* 守卫：没有原始检索记录就不许入库——宁可什么都不加，也不加一条题录为空的条目 */
  if (!cand.title) {
    return { ref: null, existed: false, error: '缺少原始检索记录，未加入（题录必须来自真实检索）' };
  }
  var refs = getRefs(topicId);
  var doi = String(cand.doi || '').trim().toLowerCase();
  var tkey = titleKey(cand.title);

  for (var i = 0; i < refs.length; i++) {
    var r0 = refs[i];
    var sameDoi = doi && String(r0.doi || '').trim().toLowerCase() === doi;
    var sameTitle = tkey && titleKey(r0.title) === tkey &&
      (!cand.year || !r0.year || String(r0.year) === String(cand.year));
    if (sameDoi || sameTitle) return { ref: r0, existed: true };
  }

  var r = newRef(topicId);
  r.origin = 'discover';
  r.title = cand.title || '';
  r.authors = cand.authors || '';
  r.year = cand.year || '';
  r.venue = cand.venue || '';
  r.doi = cand.doi || '';
  r.url = cand.url || '';
  r.parsed = {
    title: r.title, authors: r.authors, year: r.year,
    venue: r.venue, doi: r.doi, url: r.url
  };
  /* raw 用真实字段拼成一条可复制的题录，不添加任何来源没有的内容 */
  r.raw = [
    r.title,
    r.authors,
    [r.venue, r.year].filter(Boolean).join(', '),
    r.doi ? ('DOI: ' + r.doi) : '',
    r.url
  ].filter(Boolean).join('. ');
  r.evidence = {
    link: cand.url || '',
    /* 摘要【只】在检索接口真的返回了时才写入；没有就留空，绝不补写 */
    abstract: cand.hasAbstract ? (cand.abstract || '') : '',
    excerpt: ''
  };
  r.note = '系统推荐条目（来自「' + (cand.source || '检索服务') + '」真实检索，检索式：' +
    (cand.query || '—') + '）。摘要若存在也是接口返回的原文摘要，本系统未读原文。';

  r.recommend = {
    runId: (run && run.id) || '',
    candId: cand.id || '',
    source: cand.source || '',
    sourceId: cand.sourceId || '',
    apiUrl: cand.apiUrl || '',
    query: cand.query || '',
    retrievedAt: cand.retrievedAt || '',
    evidenceLevel: cand.evidenceLevel || 'citation',
    evidenceText: cand.evidenceText || '',
    hasAbstract: !!cand.hasAbstract,
    oaPdfUrl: (cand.oa && cand.oa.pdfUrl) || '',
    match: (item && item.match) || [],
    gap: (item && item.gap) || [],
    todo: (item && item.todo) || [],
    uses: (item && item.uses) || [],
    why: (item && item.why) || '',
    model: (run && run.analysis && run.analysis.model) || '',
    analyzedAt: (run && run.analysis && run.analysis.at) || '',
    analysisNote: (run && run.analysis && run.analysis.note) || '',
    topicRevision: (topic && topic.revision) || (run && run.topicRevision) || 1,
    savedAt: formatTime()
  };
  r.recommendHistory = [];
  addRefs([r]);
  return { ref: r, existed: false };
}

function getRefs(topicId) {
  var rs = readDb().refs;
  var out = [];
  for (var i = 0; i < rs.length; i++) if (rs[i].topicId === topicId) out.push(rs[i]);
  return out;
}

function getRef(id) {
  var rs = readDb().refs;
  for (var i = 0; i < rs.length; i++) if (rs[i].id === id) return rs[i];
  return null;
}

function addRefs(items) {
  var db = readDb();
  for (var i = 0; i < items.length; i++) db.refs.push(items[i]);
  writeDb(db);
}

function replaceRef(ref) {
  var db = readDb();
  for (var i = 0; i < db.refs.length; i++) {
    if (db.refs[i].id === ref.id) { db.refs[i] = ref; break; }
  }
  writeDb(db);
}

function removeRef(id) {
  var db = readDb();
  db.refs = db.refs.filter(function (r) { return r.id !== id; });
  writeDb(db);
}

/** 追加一次自动初判，历史保留 */
function addEval(refId, evalObj) {
  var ref = getRef(refId);
  if (!ref) return null;
  evalObj.id = evalObj.id || newId('eval');
  evalObj.ruleVersion = evalObj.ruleVersion || RULE_VERSION;
  evalObj.at = formatTime();
  ref.evals.push(evalObj);
  ref.updatedAt = evalObj.at;
  replaceRef(ref);
  return ref;
}

/** 追加一次人工确认，历史保留，不覆盖 evals */
function addConfirm(refId, confirmObj) {
  var ref = getRef(refId);
  if (!ref) return null;
  confirmObj.id = confirmObj.id || newId('cfm');
  confirmObj.at = confirmObj.at || formatTime();
  confirmObj.source = 'human';
  ref.confirms.push(confirmObj);
  ref.updatedAt = confirmObj.at;
  replaceRef(ref);
  return ref;
}

/**
 * 写入一次【系统自动核验】结果。
 * 规则（需求 四.1/四.2）：
 *   - 旧结果进 identityHistory，【追加保存、不被覆盖】；
 *   - 人工补证走 addManualEvidence，永远不会写到这里。
 */
function setIdentity(refId, identityObj) {
  var ref = getRef(refId);
  if (!ref) return null;
  if (!ref.identityHistory) ref.identityHistory = [];
  if (ref.identity) ref.identityHistory.push(ref.identity);
  ref.identity = identityObj;
  ref.updatedAt = formatTime();
  replaceRef(ref);
  return ref;
}

/**
 * 「单一字段冲突」的人工确认。
 * 只【追加】一条确认记录，绝不改写 identity 里的自动结论——
 * 系统判的是什么就一直是什么，人工确认只是叠加在上面。
 */
function ackConflict(refId, entry) {
  var ref = getRef(refId);
  if (!ref) return null;
  if (!ref.conflictAcks) ref.conflictAcks = [];
  entry = entry || {};
  entry.id = entry.id || newId('ack');
  entry.at = entry.at || formatTime();
  entry.source = 'human';
  ref.conflictAcks.push(entry);
  ref.updatedAt = entry.at;
  replaceRef(ref);
  return ref;
}

/** 最近一条冲突确认（没有就是 null） */
function latestConflictAck(ref) {
  if (!ref || !ref.conflictAcks || !ref.conflictAcks.length) return null;
  return ref.conflictAcks[ref.conflictAcks.length - 1];
}

/**
 * 核验成功后的一键补全。
 * ------------------------------------------------------------
 * 硬约束：
 *   - 只写入【勾选过】的字段；未勾选的冲突字段【一个都不动】
 *   - 值全部来自 plan（plan 来自来源接口真实返回），不在此处做任何生成或推测
 *   - 摘要写入 evidence.abstract 并记 abstractSource（来源名 + 取得时间）
 *   - 原文节选永远不在此生成；若用户选择「把摘要放进材料区」，
 *     必须标记 evidence.excerptOrigin='abstract'，让课题适配仍按摘要计
 *   - 全过程留痕到 ref.fills（追加，不覆盖）
 */
function fillFromIdentity(refId, plan, opt) {
  var ref = getRef(refId);
  if (!ref) return { ref: null, changed: [], error: '条目不存在' };
  opt = opt || {};
  plan = plan || {};
  var changed = [];
  var ev = ref.evidence || {};

  var fields = plan.fields || [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (!f.picked) continue;
    if (!f.incoming) continue;
    if (f.mode === 'same') continue;
    if (ref[f.key] === f.incoming) continue;
    ref[f.key] = f.incoming;
    changed.push({ field: f.label, from: f.current || '（空）', to: f.incoming, mode: f.mode });
  }

  var ab = plan.abstract || {};
  if (ab.picked && ab.text) {
    ev.abstract = ab.text;
    ev.abstractSource = (ab.sourceName || '来源') + (plan.fetchedAt ? '｜取得时间 ' + plan.fetchedAt : '');
    changed.push({ field: '摘要', from: (ev.abstract && ev.abstract !== ab.text) ? '（已有摘要，被覆盖）' : '（空）', to: '来源返回的摘要（' + ab.text.length + ' 字）', mode: 'abstract' });
  }

  /* 把来源摘要放进材料区：必须打上 excerptOrigin，否则会被误当成读过原文节选 */
  if (opt.useAbstractAsMaterial && ab.text) {
    ev.excerpt = ab.text;
    ev.excerptOrigin = 'abstract';
    ev.excerptSource = (ab.sourceName || '来源') + (plan.fetchedAt ? '｜取得时间 ' + plan.fetchedAt : '');
    changed.push({ field: '材料区（节选位）', from: '（空）', to: '放入来源摘要，标注为「摘要」', mode: 'material' });
  }

  ref.evidence = ev;
  ref.fieldsEdited = true;
  ref.updatedAt = formatTime();
  if (!ref.fills) ref.fills = [];
  ref.fills.push({
    id: newId('fill'),
    at: ref.updatedAt,
    sourceName: plan.sourceName || '',
    sourceKind: plan.sourceKind || '',
    fetchedAt: plan.fetchedAt || '',
    changed: changed,
    note: opt.note || ''
  });
  replaceRef(ref);
  return { ref: ref, changed: changed, error: '' };
}

/** 补全留痕的最新一条 */
function latestFill(ref) {
  if (!ref || !ref.fills || !ref.fills.length) return null;
  return ref.fills[ref.fills.length - 1];
}

/**
 * 追加一条【人工补证 / 人工备注】。
 * 只新增，不修改也不删除系统自动核验的原始结论。
 */
function addManualEvidence(refId, entry) {
  var ref = getRef(refId);
  if (!ref) return null;
  if (!ref.manualEvidence) ref.manualEvidence = [];
  entry.id = entry.id || newId('mev');
  entry.at = entry.at || formatTime();
  entry.source = 'human';
  ref.manualEvidence.push(entry);
  ref.updatedAt = entry.at;
  replaceRef(ref);
  return ref;
}

function latestManualEvidence(ref) {
  if (!ref || !ref.manualEvidence || !ref.manualEvidence.length) return null;
  return ref.manualEvidence[ref.manualEvidence.length - 1];
}

/* ---------------- 第四阶段：课题适配与主张核验 ---------------- */

/**
 * 写入一次【运行时分析服务】的适配结论。旧结论进历史，追加不覆盖。
 * 同时把模型建议的用途写进 usageDecision（来源标记为 ai），
 * 之后用户可以改；改完另存一条 human 记录，自动建议仍留在历史里。
 */
function setAdapt(refId, adaptObj, topic) {
  var ref = getRef(refId);
  if (!ref) return null;
  if (!ref.adaptHistory) ref.adaptHistory = [];
  if (!ref.usageHistory) ref.usageHistory = [];
  if (ref.adapt) ref.adaptHistory.push(ref.adapt);

  adaptObj.savedAt = formatTime();
  adaptObj.topicRevision = (topic && topic.revision) || adaptObj.topicRevision || 0;
  ref.adapt = adaptObj;

  /* 只有真正拿到结论（ok）才把模型建议写为当前用途；失败 / 未配置不写，避免假装有个建议 */
  if (adaptObj.ok && adaptObj.usage && adaptObj.usage.value &&
    adaptObj.usage.value !== 'insufficient') {
    var d = {
      value: adaptObj.usage.value,
      text: adaptObj.usage.text,
      caveat: adaptObj.usage.caveat || '',
      why: adaptObj.usage.why || '',
      source: 'ai',
      sourceText: '运行时分析服务建议',
      reason: '',
      model: adaptObj.model || '',
      at: formatTime(),
      topicRevision: adaptObj.topicRevision
    };
    if (ref.usageDecision) ref.usageHistory.push(ref.usageDecision);
    ref.usageDecision = d;
  }
  ref.updatedAt = formatTime();
  replaceRef(ref);
  return ref;
}

/**
 * 用户修改用途（记录理由）。
 * 铁律：只【新增】一层人工决定，绝不改写自动结论（ref.adapt 原样保留）。
 */
function setUsageDecision(refId, value, text, reason, topic) {
  var ref = getRef(refId);
  if (!ref) return null;
  if (!ref.usageHistory) ref.usageHistory = [];
  if (ref.usageDecision) ref.usageHistory.push(ref.usageDecision);
  ref.usageDecision = {
    value: value,
    text: text,
    caveat: '',
    why: '',
    source: 'human',
    sourceText: '你的修改',
    reason: reason || '',
    model: '',
    at: formatTime(),
    topicRevision: (topic && topic.revision) || 0
  };
  ref.updatedAt = formatTime();
  replaceRef(ref);
  return ref;
}

/**
 * 人工确认：只有用户点了确认，这条适配结论才算「已确认」。
 * 自动结论永远不会自己变成「已确认」。
 */
function confirmAdapt(refId, note, topic) {
  var ref = getRef(refId);
  if (!ref) return null;
  ref.adaptConfirm = {
    at: formatTime(),
    note: note || '',
    topicRevision: (topic && topic.revision) || 0,
    usageAtConfirm: ref.usageDecision
      ? { value: ref.usageDecision.value, text: ref.usageDecision.text, source: ref.usageDecision.source }
      : null
  };
  ref.updatedAt = formatTime();
  replaceRef(ref);
  return ref;
}

/** 适配结论是否过期：课题需求变更后不能沿用旧结论 */
function isAdaptStale(ref, topic) {
  if (!ref || !ref.adapt) return false;
  if (!topic) return false;
  return ref.adapt.topicRevision !== topic.revision;
}

/**
 * 身份核验结论是否过期：课题需求变更后，旧的自动核验结论不能沿用。
 */
function isIdentityStale(ref, topic) {
  if (!ref || !ref.identity) return false;
  if (!topic) return false;
  return ref.identity.topicRevision !== topic.revision;
}

function latestEval(ref) {
  if (!ref || !ref.evals || !ref.evals.length) return null;
  return ref.evals[ref.evals.length - 1];
}

function latestConfirm(ref) {
  if (!ref || !ref.confirms || !ref.confirms.length) return null;
  return ref.confirms[ref.confirms.length - 1];
}

/** 最新初判所基于的课题版本是否仍是最新的 */
function isStale(ref, topic) {
  var ev = latestEval(ref);
  if (!ev) return false;
  return !!topic && ev.revision !== topic.revision;
}

/* ---------------- 演示样例 ---------------- */

function loadSamples() {
  var topic = getActiveTopic();
  if (!topic) {
    topic = newTopic();
    topic.name = '［演示占位课题］仅用于流程演示';
    topic.problem = '［占位］演示用研究问题，不指向任何真实课题';
    topic.target = '［占位］演示用对象或场景';
    topic.task = '［占位］演示用期望完成的任务';
    topic.origin = 'sample';
    upsertTopic(topic);
  }
  var list = [
    {
      title: '［样例占位条目 A］未粘贴任何材料的演示条目',
      authors: '',
      year: '',
      venue: '',
      doi: '',
      url: '',
      raw: '［样例占位条目 A］本条目为占位文案，不含任何真实论文的题名、作者或 DOI。',
      note: '［占位］刻意留空摘要与节选，用于演示「信息不足 / 未检查主张」状态',
      evidence: { link: '', abstract: '', excerpt: '' }
    },
    {
      title: '［样例占位条目 B］带占位节选的演示条目',
      authors: '',
      year: '',
      venue: '',
      doi: '',
      url: '',
      raw: '［样例占位条目 B］本条目为占位文案，不含任何真实论文的题名、作者或 DOI。',
      note: '［占位］节选为演示文字，不是任何论文的原文',
      evidence: {
        link: '',
        abstract: '［占位摘要］这段占位文字用于跑通「用途」与「主张」的本地初判流程，不代表任何真实文献的内容。',
        excerpt: '［占位节选］本样例刻意不提供真实原文，请在自查时使用你自己的节选材料。'
      }
    }
  ];

  var refs = [];
  for (var i = 0; i < list.length; i++) {
    var r = newRef(topic.id);
    r.origin = 'sample';
    r.title = list[i].title;
    r.authors = list[i].authors;
    r.year = list[i].year;
    r.venue = list[i].venue;
    r.raw = list[i].raw;
    r.note = list[i].note;
    r.evidence = list[i].evidence;
    r.parsed = { title: r.title, authors: '', year: '', venue: '', doi: '', url: '' };
    refs.push(r);
  }
  addRefs(refs);

  // 样例载入后立即按当前课题跑一次本地初判，方便直接看到卡片三态
  var rules = require('./rules.js');
  var topicNow = getActiveTopic();
  for (var k = 0; k < refs.length; k++) {
    addEval(refs[k].id, rules.evaluate(topicNow, refs[k]));
  }

  var db = readDb();
  db.settings.sampleLoaded = true;
  writeDb(db);
  return refs.length;
}

function clearSamples() {
  var db = readDb();
  db.refs = db.refs.filter(function (r) { return r.origin !== 'sample'; });
  db.topics = db.topics.filter(function (t) { return t.origin !== 'sample'; });
  if (db.topics.length) {
    db.settings.activeTopicId = db.topics[db.topics.length - 1].id;
  } else {
    db.settings.activeTopicId = '';
  }
  db.settings.sampleLoaded = false;
  writeDb(db);
}

function hasSample() {
  var db = readDb();
  for (var i = 0; i < db.refs.length; i++) if (db.refs[i].origin === 'sample') return true;
  return false;
}

function resetAll() {
  try { wx.removeStorageSync(KEY); } catch (e) { }
}

module.exports = {
  RULE_VERSION: RULE_VERSION,
  KEY: KEY,
  /* 第三阶段：检索推荐留痕 */
  newDiscoverRun: newDiscoverRun,
  saveDiscoverRun: saveDiscoverRun,
  getDiscoverRun: getDiscoverRun,
  getDiscoverRuns: getDiscoverRuns,
  getLatestDiscoverRun: getLatestDiscoverRun,
  removeDiscoverRun: removeDiscoverRun,
  /* 第五阶段：检索清单历史（只追加，可反复回看） */
  getDiscoverHistory: getDiscoverHistory,
  getDiscoverHistoryItem: getDiscoverHistoryItem,
  archiveDiscoverSearch: archiveDiscoverSearch,
  updateHistoryAnalysis: updateHistoryAnalysis,
  markHistoryAdded: markHistoryAdded,
  removeDiscoverHistory: removeDiscoverHistory,
  addDiscoverRef: addDiscoverRef,
  /* 第五阶段：核验成功后的一键补全 + 单字段冲突人工确认 */
  fillFromIdentity: fillFromIdentity,
  latestFill: latestFill,
  ackConflict: ackConflict,
  latestConflictAck: latestConflictAck,
  titleKey: titleKey,
  formatTime: formatTime,
  newId: newId,
  ensure: ensure,
  readDb: readDb,
  writeDb: writeDb,
  newTopic: newTopic,
  newRef: newRef,
  hashRequirement: hashRequirement,
  getTopics: getTopics,
  getTopic: getTopic,
  getActiveTopic: getActiveTopic,
  setActiveTopic: setActiveTopic,
  getDraft: getDraft,
  saveDraft: saveDraft,
  clearDraft: clearDraft,
  removeTopic: removeTopic,
  upsertTopic: upsertTopic,
  getRefs: getRefs,
  getRef: getRef,
  addRefs: addRefs,
  replaceRef: replaceRef,
  setIdentity: setIdentity,
  addManualEvidence: addManualEvidence,
  latestManualEvidence: latestManualEvidence,
  isIdentityStale: isIdentityStale,
  setAdapt: setAdapt,
  setUsageDecision: setUsageDecision,
  confirmAdapt: confirmAdapt,
  isAdaptStale: isAdaptStale,
  removeRef: removeRef,
  addEval: addEval,
  addConfirm: addConfirm,
  latestEval: latestEval,
  latestConfirm: latestConfirm,
  isStale: isStale,
  loadSamples: loadSamples,
  clearSamples: clearSamples,
  hasSample: hasSample,
  resetAll: resetAll
};
