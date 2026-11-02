'use strict';
/**
 * 第五阶段测试
 * ------------------------------------------------------------
 * 1) 帮我找文献：检索清单历史记录（封存 / 回看 / 回填分析 / 删除）
 * 2) 核验成功后补全题录与材料（只补空字段、冲突需确认、摘要真实、节选不编造）
 * 3) 「题名一致 + 仅 1 项不一致」判为核验通过，但差异必须列出并人工确认
 *
 * 云函数侧用注入 transport 返回真实结构的响应（不发外网请求）；
 * 前端侧用最小 wx mock 驱动真实的 store / 视图逻辑。
 *
 * 运行：node tests/round5-test.js
 */

var path = require('path');
var CF = path.resolve(__dirname, '../cloudfunctions/lfaVerify');

/* ---------------- 最小 wx mock ---------------- */
var mem = {};
global.wx = {
  getStorageSync: function (k) {
    return mem[k] === undefined ? '' : JSON.parse(JSON.stringify(mem[k]));
  },
  setStorageSync: function (k, v) { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: function (k) { delete mem[k]; },
  showToast: function () { },
  showLoading: function () { },
  hideLoading: function () { },
  showModal: function (o) { if (o && typeof o.success === 'function') o.success({ confirm: true }); },
  navigateTo: function () { },
  switchTab: function () { },
  setClipboardData: function () { }
};

var http = require(path.join(CF, 'lib/http.js'));
var fn = require(path.join(CF, 'index.js'));
var adapt = require(path.join(CF, 'adapt.js'));
var identityView = require('../utils/identity.js');
var store = require('../utils/store.js');
var record = require('../utils/record.js');

var pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  << ' + detail : '')); }
}

/* ---------------- 造一个 OpenAlex 记录 ---------------- */
function oaRecord(over) {
  var r = {
    id: 'https://openalex.org/W1',
    doi: 'https://doi.org/10.1000/abc',
    display_name: 'Winter heating retrofit in old communities',
    type: 'article',
    publication_year: 2020,
    publication_date: '2020-05-01',
    authorships: [{ author: { display_name: 'Zhang San' } }, { author: { display_name: 'Li Si' } }],
    primary_location: {
      source: { display_name: 'Energy and Buildings', host_organization_name: 'Elsevier' },
      landing_page_url: 'https://doi.org/10.1000/abc'
    },
    biblio: { volume: '210', issue: '3', first_page: '110', last_page: '120' },
    abstract_inverted_index: {
      This: [0], study: [1], measured: [2], heating: [3], energy: [4],
      use: [5], in: [6], old: [7], communities: [8],
      after: [9], envelope: [10], retrofit: [11], and: [12], reported: [13],
      a: [14], mean: [15], reduction: [16], of: [17], eighteen: [18],
      percent: [19], across: [20], three: [21], buildings: [22], during: [23],
      the: [24], winter: [25], heating: [26], season: [27], in: [28], Beijing: [29]
    },
    is_retracted: false,
    cited_by_count: 11
  };
  for (var k in (over || {})) r[k] = over[k];
  return r;
}

function setOaTransport(rec) {
  http.setTransport(function (url) {
    if (url.indexOf('api.openalex.org') >= 0) {
      return Promise.resolve({
        ok: true, status: 200, raw: JSON.stringify(rec), body: rec,
        requestedAtText: '2026-11-01 13:00:00', ms: 120
      });
    }
    return Promise.resolve({
      ok: false, status: 404, raw: 'Resource not found.', body: null,
      requestedAtText: '2026-11-01 13:00:00', ms: 80,
      failureKind: 'not_found', failureDetail: '未收录'
    });
  });
}

function call(payload) { return Promise.resolve(fn.main(payload, {})); }

async function main() {
  console.log('\n===== 3) 单一字段冲突：题名一致 + 仅 1 项不一致 =====');

  setOaTransport(oaRecord());
  var all = {
    doi: '10.1000/abc', title: 'Winter heating retrofit in old communities',
    authors: 'Zhang San; Li Si', year: '2020', venue: 'Energy and Buildings'
  };
  var r0 = await call({ action: 'verify', ref: all });
  check('C0 全字段一致 → verified', r0.statusKey === 'verified', r0.statusKey);
  check('C0a 来源返回的摘要能取到（倒排索引按位置还原）',
    /^This study measured .* in Beijing$/.test(((r0.record || {}).abstract || '').trim()),
    (r0.record || {}).abstract);

  var r1 = await call({
    action: 'verify',
    ref: {
      doi: '10.1000/abc', title: 'Winter heating retrofit in old communities',
      authors: 'Zhang San; Li Si', year: '2021', venue: 'Energy and Buildings'
    }
  });
  check('C1 仅年份不一致 → verified_one_conflict（判为通过）',
    r1.statusKey === 'verified_one_conflict', r1.statusKey);
  check('C1a 文案写明「待人工确认」', /待人工确认/.test(r1.statusText || ''), r1.statusText);
  check('C1b 仍需人工确认标记', r1.needsHumanConfirm === true);
  check('C1c 冲突字段原样带出（1 项）', (r1.conflictFields || []).length === 1,
    JSON.stringify(r1.conflictFields || []));
  check('C1d 冲突字段给出双方取值',
    (r1.conflictFields || [])[0] && /2021/.test((r1.conflictFields || [])[0].input) &&
    /2020/.test((r1.conflictFields || [])[0].record));
  check('C1e 结论文字说明是「按规则判为通过」', /判定为核验通过/.test(r1.reason || ''));

  var r2 = await call({
    action: 'verify',
    ref: {
      doi: '10.1000/abc', title: 'Winter heating retrofit in old communities',
      authors: 'Wang Wu', year: '2021', venue: 'Building and Environment'
    }
  });
  check('C2 三处不一致 → 不套宽容规则，仍是 conflict', r2.statusKey === 'conflict', r2.statusKey);
  check('C2a 两处以上不一致时 needsHumanConfirm 不置位（仍走冲突流程）', r2.needsHumanConfirm !== true);

  var r3 = await call({
    action: 'verify',
    ref: {
      doi: '10.1000/abc', title: 'Totally another paper about something else',
      authors: 'Zhang San; Li Si', year: '2021', venue: 'Energy and Buildings'
    }
  });
  check('C3 题名不一致时不套宽容规则', r3.statusKey === 'conflict', r3.statusKey);

  setOaTransport(oaRecord({ is_retracted: true }));
  var r4 = await call({
    action: 'verify',
    ref: {
      doi: '10.1000/abc', title: 'Winter heating retrofit in old communities',
      authors: 'Zhang San; Li Si', year: '2021', venue: 'Energy and Buildings'
    }
  });
  check('C4 撤稿记录即使只差 1 项也不判通过', r4.statusKey === 'conflict', r4.statusKey);

  /* 前端视图：状态与冲突展示 */
  setOaTransport(oaRecord());
  var r5 = await call({
    action: 'verify',
    ref: {
      doi: '10.1000/abc', title: 'Winter heating retrofit in old communities',
      authors: 'Zhang San; Li Si', year: '2021', venue: 'Energy and Buildings'
    }
  });
  var v5 = identityView.buildIdentityView(r5);
  check('C5 视图：hasConflicts', v5 && v5.hasConflicts === true);
  check('C5a 视图：needsHumanConfirm', v5 && v5.needsHumanConfirm === true);
  check('C5b 视图：冲突字段名文本非空', v5 && !!v5.conflictNamesText, v5 && v5.conflictNamesText);
  check('C5c 视图：色调仍为通过（ok）', v5 && v5.tone === 'ok', v5 && v5.tone);

  console.log('\n===== 2) 核验成功后补全题录与材料 =====');

  var ref = store.newRef('topic_x');
  ref.title = 'Winter heating retrofit in old communities';
  ref.authors = '';
  ref.year = '2021';      // 与来源不同 → 冲突项
  ref.venue = '';
  ref.doi = '10.1000/abc';
  ref.evidence = { link: '', abstract: '', excerpt: '' };
  mem['lfa_db_v1'] = { version: 1, topics: [], refs: [ref], settings: { activeTopicId: '' } };

  var plan = identityView.buildFillPlan(ref, r5);
  check('F1 拿到补全方案', plan && plan.ok === true);
  check('F1a 补全来源名来自真实来源', /OpenAlex/.test(plan.sourceName || ''), plan.sourceName);
  var byKey = {};
  plan.fields.forEach(function (f) { byKey[f.key] = f; });
  check('F2 空字段（作者）判为 fill 且默认勾选',
    byKey.authors.mode === 'fill' && byKey.authors.picked === true, byKey.authors.mode);
  check('F2a 空字段（出处）判为 fill', byKey.venue.mode === 'fill', byKey.venue.mode);
  check('F3 与来源不同的年份判为 conflict 且默认【不勾选】',
    byKey.year.mode === 'conflict' && byKey.year.picked === false, byKey.year.mode);
  check('F3a 冲突项给出双方取值', byKey.year.current === '2021' && /2020/.test(byKey.year.incoming));
  check('F4 一致字段判为 same 且不勾选', byKey.title.mode === 'same' && byKey.title.picked === false,
    byKey.title.mode);
  check('F5 来源有摘要 → 摘要可补并默认勾选',
    plan.abstract.mode === 'fill' && plan.abstract.picked === true, plan.abstract.mode);
  check('F5a 摘要文本来自来源真实返回', /This study measured/.test(plan.abstract.text || ''));
  check('F6 原文节选标为「只能手工填写」', plan.excerpt.mode === 'manual');
  check('F6a 节选说明写明「从未抓取全文」', /从未抓取/.test(plan.excerpt.note || ''));

  /* 只补勾选的空字段 */
  var res = store.fillFromIdentity(ref.id, plan, {});
  var ref2 = store.getRef(ref.id);
  check('F7 空字段被补全（作者）', !!ref2.authors && /Zhang San/.test(ref2.authors), ref2.authors);
  check('F7a 空字段被补全（出处）', /Energy and Buildings/.test(ref2.venue || ''), ref2.venue);
  check('F8 未勾选的冲突字段【一个字都没动】', ref2.year === '2021', ref2.year);
  check('F9 摘要写入 evidence.abstract', /This study measured/.test(ref2.evidence.abstract || ''));
  check('F9a 摘要记录来源与取得时间', /OpenAlex/.test(ref2.evidence.abstractSource || ''),
    ref2.evidence.abstractSource);
  check('F10 补全留痕写入 ref.fills', (ref2.fills || []).length === 1);
  check('F10a 留痕记录变更项数', (ref2.fills[0].changed || []).length >= 3,
    JSON.stringify(ref2.fills[0].changed));

  /* 勾选冲突项后才覆盖 */
  plan.fields.forEach(function (f) { if (f.mode === 'conflict') f.picked = true; });
  store.fillFromIdentity(ref.id, plan, {});
  var ref3 = store.getRef(ref.id);
  check('F11 勾选后冲突字段才被覆盖', ref3.year === '2020', ref3.year);
  check('F11a 覆盖后留痕有两条', (ref3.fills || []).length === 2);

  /* 摘要放入材料区：必须标记 excerptOrigin */
  var res4 = store.fillFromIdentity(ref.id, plan, { useAbstractAsMaterial: true });
  var ref4 = store.getRef(ref.id);
  check('F12 材料区放入的是来源摘要', /This study measured/.test(ref4.evidence.excerpt || ''));
  check('F12a 必须标记 excerptOrigin=abstract', ref4.evidence.excerptOrigin === 'abstract',
    ref4.evidence.excerptOrigin);

  var mats = adapt.buildMaterials({ evidence: ref4.evidence });
  var kinds = mats.map(function (m) { return m.kind; });
  check('F13 标记为摘要的材料【不】按原文节选计', kinds.indexOf('excerpt') < 0, JSON.stringify(kinds));
  check('F13a 证据等级为 abstract（不是 excerpt）',
    adapt.evidenceLevelOf(mats).level === 'abstract', adapt.evidenceLevelOf(mats).level);

  /* 没有来源题录时不给补全 */
  var planNone = identityView.buildFillPlan(ref, { statusKey: 'not_indexed' });
  check('F14 没有来源题录 → 无可补全内容', planNone.ok === false);
  check('F14a 说明原因而不是静默', !!planNone.reason);

  /* 来源没给摘要时不能编 */
  setOaTransport((function () { var r = oaRecord(); delete r.abstract_inverted_index; return r; })());
  var rNoAbs = await call({ action: 'verify', ref: all });
  var planNoAbs = identityView.buildFillPlan(ref, rNoAbs);
  check('F15 来源没有摘要 → 摘要判 none，不补写',
    planNoAbs.abstract.mode === 'none' && !planNoAbs.abstract.text, planNoAbs.abstract.mode);
  check('F15a 提示需要用户自行粘贴', /无法补全|粘贴/.test(planNoAbs.abstract.note || ''));

  /* 命中源没给摘要时，改用另一个源按同一 DOI 补取（题录比对仍以命中源为准） */
  var oaNoAbs = oaRecord();
  delete oaNoAbs.abstract_inverted_index;
  var crMsg = {
    DOI: '10.1000/abc', title: ['Winter heating retrofit in old communities'],
    author: [{ given: 'San', family: 'Zhang' }, { given: 'Si', family: 'Li' }],
    container: ['Energy and Buildings'], type: 'journal-article',
    issued: { 'date-parts': [[2020]] },
    abstract: '<jats:p>This study measured heating energy use in old communities in Beijing during two heating seasons and reported a mean reduction of eighteen percent.</jats:p>'
  };
  http.setTransport(function (url) {
    if (url.indexOf('api.openalex.org') >= 0) {
      return Promise.resolve({ ok: true, status: 200, raw: JSON.stringify(oaNoAbs), body: oaNoAbs, requestedAtText: '2026-11-01 13:00:00', ms: 100 });
    }
    if (url.indexOf('api.crossref.org') >= 0) {
      var body = { message: crMsg };
      return Promise.resolve({ ok: true, status: 200, raw: JSON.stringify(body), body: body, requestedAtText: '2026-11-01 13:00:01', ms: 110 });
    }
    return Promise.resolve({ ok: false, status: 404, raw: 'x', body: null, requestedAtText: '', ms: 10, failureKind: 'not_found', failureDetail: 'no' });
  });
  var rTop = await call({ action: 'verify', ref: all });
  check('F16 命中源没摘要 → 改由另一个源补取', /This study measured/.test((rTop.record || {}).abstract || ''),
    (rTop.record || {}).abstract);
  check('F16a 摘要的真实出处被记录', (rTop.record || {}).abstractFrom === 'Crossref',
    (rTop.record || {}).abstractFrom);
  check('F16b 补摘要的请求进了来源日志',
    (rTop.tried || []).some(function (t) { return t.method === 'abstract-topup'; }));
  check('F16c 题录比对仍以命中源为准（状态未受影响）', rTop.statusKey === 'verified', rTop.statusKey);
  var planTop = identityView.buildFillPlan(ref, rTop);
  check('F16d 补取到的摘要可补全，且写明真实出处',
    planTop.abstract.mode === 'fill' && /Crossref/.test(planTop.abstract.sourceName || ''),
    planTop.abstract.sourceName);

  /* 判定为「题录字段冲突」时不提供补全：可能根本不是同一篇 */
  var planConflict = identityView.buildFillPlan(ref, { statusKey: 'conflict', record: r5.record });
  check('F17 字段冲突时不提供补全', planConflict.ok === false);
  check('F17a 说明原因是「先核对是不是同一篇」', /同一篇/.test(planConflict.reason || ''), planConflict.reason);

  console.log('\n===== 3b) 差异的人工确认（只追加，不覆盖自动结论） =====');

  /* 把核验结论与一次本地初判写进条目，才能验证「人工确认不覆盖自动结论」和导出 */
  var refC = store.getRef(ref.id);
  refC.identity = r5;
  refC.evals = [{
    at: '2026-11-01 13:00:00', revision: 1, ruleVersion: store.RULE_VERSION,
    identity: { label: r5.label, reason: r5.reason, identity: r5 },
    usage: { label: '—', reason: '' }, claim: { label: '—', reason: '' }
  }];
  store.replaceRef(refC);
  var before = store.getRef(ref.id).identity.statusKey;
  store.ackConflict(ref.id, {
    fields: [{ key: 'year', name: '出版年份', input: '2021', record: '2020' }],
    statusKey: 'verified_one_conflict',
    note: '我已回原文核对该字段差异'
  });
  var ref5 = store.getRef(ref.id);
  check('A1 人工确认已记录', (ref5.conflictAcks || []).length === 1);
  check('A1a 确认里带时间', !!ref5.conflictAcks[0].at);
  check('A1b 确认里带字段与理由', /出版年份/.test(JSON.stringify(ref5.conflictAcks[0].fields)) &&
    /核对/.test(ref5.conflictAcks[0].note));
  check('A2 自动结论【未被改写】', store.getRef(ref.id).identity.statusKey === before);
  var ack = store.latestConflictAck(ref5);
  check('A3 能取到最近一条确认', ack && ack.at === ref5.conflictAcks[0].at);

  var text = record.buildRefText({ name: '课题', revision: 1 }, ref5, 1, 1);
  check('A4 导出含「差异需人工确认」', /需人工确认|题录差异/.test(text));
  check('A4a 导出含人工确认时间与理由', /人工确认/.test(text) && /核对/.test(text));
  check('A4b 导出含补全留痕', /核验后补全/.test(text));

  console.log('\n===== 1) 检索清单历史记录 =====');

  mem['lfa_db_v1'] = { version: 1, topics: [], refs: [], settings: { activeTopicId: 'topic_x' }, discoverRuns: [] };
  var run = store.newDiscoverRun('topic_x', { name: '老旧小区供暖改造', revision: 1 });
  run.plan = { keywords: ['老旧小区'], synonyms: [], queries: [{ text: 'retrofit heating energy', lang: 'en', enabled: true }], dropped: [] };
  run.search = {
    status: 'ok', at: '2026-11-01 13:00:00', services: [{ id: 'openalex', name: 'OpenAlex', used: true }],
    candidates: [{ id: 'c1', title: 'A paper' }, { id: 'c2', title: 'B paper' }],
    coverage: { text: '覆盖说明' }, log: []
  };
  store.saveDiscoverRun(run);

  var h1 = store.archiveDiscoverSearch(run, { queries: ['retrofit heating energy'], status: 'ok' });
  check('H1 检索后封存一份历史', !!h1 && h1.total === 2, h1 && h1.total);
  check('H1a 历史里保存了检索式', (h1.queries || []).length === 1);
  check('H1b 历史里保存了候选集快照', ((h1.search || {}).candidates || []).length === 2);
  check('H1c 历史条目有独立 id 与创建时间', !!h1.id && !!h1.createdAt);

  var hs = store.getDiscoverHistory('topic_x');
  check('H2 能按课题取出历史', hs.length === 1);
  check('H2a 最新的排在最前', hs[0].id === h1.id);

  store.updateHistoryAnalysis(h1.id, { recommended: [{ cand: { id: 'c1' } }], leads: [] });
  var h1b = store.getDiscoverHistoryItem(h1.id);
  check('H3 分析结论回填到历史', h1b.analysis && h1b.analysis.recommended.length === 1);
  check('H3a 回填后推荐数同步', h1b.recommended === 1, h1b.recommended);

  store.markHistoryAdded(h1.id, 'ref_1');
  store.markHistoryAdded(h1.id, 'ref_1');
  check('H4 记录加入文献库的条目（去重）',
    (store.getDiscoverHistoryItem(h1.id).addedRefIds || []).length === 1);

  /* 第二次检索：历史只追加，不覆盖第一次 */
  var run2 = store.newDiscoverRun('topic_x', { name: '老旧小区供暖改造', revision: 1 });
  run2.search = { status: 'empty', at: '2026-11-01 13:10:00', candidates: [], log: [] };
  store.saveDiscoverRun(run2);
  var h2 = store.archiveDiscoverSearch(run2, { queries: ['另一个说法'], status: 'empty' });
  check('H5 第二次检索【追加】一份历史', store.getDiscoverHistory('topic_x').length === 2);
  check('H5a 第一次的历史仍然完好',
    ((store.getDiscoverHistoryItem(h1.id).search || {}).candidates || []).length === 2);
  check('H5b 没查到那次也如实记录状态', h2.status === 'empty' && h2.total === 0);

  store.removeDiscoverHistory(h2.id);
  check('H6 删除只影响指定那份', store.getDiscoverHistory('topic_x').length === 1 &&
    !!store.getDiscoverHistoryItem(h1.id));

  /* 历史同样可导出复制 */
  var dtext = record.buildDiscoverText({ name: '老旧小区供暖改造', revision: 1 }, h1);
  check('H7 历史清单可导出文本', /老旧小区供暖改造/.test(dtext) && dtext.length > 50);

  console.log('\n========== 第五阶段结果：通过 ' + pass + ' / 失败 ' + fail + ' ==========');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('运行异常：', (e && e.stack) || e);
  process.exit(1);
});
