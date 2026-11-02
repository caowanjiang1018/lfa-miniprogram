'use strict';
/**
 * 阶段 C 测试
 * ------------------------------------------------------------
 * C1 批量处理：单次最多 10 条，条间自动留间隔防限流
 * C2 日志持久化：① 用户原始输入 ② 各源原始返回 + 链接 + 请求时间 ③ 自动比对结论
 * C3 课题变更 → 历史匹配结果自动标记「需重新评估」
 *
 * 前端页面依赖 wx 环境，这里用最小 mock 驱动真实的页面逻辑，
 * 云函数侧用注入的 transport 返回真实结构的响应（不发外网请求）。
 *
 * 运行：node tests/stage-c-test.js
 */

var path = require('path');
var CF = path.resolve(__dirname, '../cloudfunctions/lfaVerify');

/* ---------------- 最小 wx mock ---------------- */

var mem = {};
var callLog = [];
var modalAutoConfirm = true;
var lastModal = null;

global.wx = {
  /* 真实 wx.getStorageSync 每次返回【反序列化出的新对象】，这里保持一致语义，
   * 否则「旧 hash vs 新 hash」的比较会因为拿到同一个引用而永远相等。 */
  getStorageSync: function (k) {
    return mem[k] === undefined ? '' : JSON.parse(JSON.stringify(mem[k]));
  },
  setStorageSync: function (k, v) { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: function (k) { delete mem[k]; },
  showToast: function () { },
  showLoading: function () { },
  hideLoading: function () { },
  showModal: function (o) {
    lastModal = o;
    if (o && typeof o.success === 'function') {
      o.success({ confirm: !!modalAutoConfirm, cancel: !modalAutoConfirm });
    }
  },
  navigateTo: function () { },
  switchTab: function () { },
  cloud: {
    init: function () { },
    callFunction: function (o) {
      callLog.push({ at: Date.now(), name: o.name, data: o.data });
      if (typeof o.success === 'function') {
        o.success({ result: fakeCloudResult(o.data) });
      }
    }
  }
};

/** 模拟云函数返回（结构与真实返回一致） */
function fakeCloudResult(data) {
  var ref = data.ref || {};
  var hasDoi = !!ref.doi;
  if (!hasDoi) {
    return {
      ok: true, statusKey: 'multi_candidate',
      statusText: '多条匹配项，请人工甄别',
      statusDesc: '返回多条候选记录，无法唯一锁定',
      colorHint: '黄色', tone: 'yellow',
      label: '多条匹配项，请人工甄别（3 条）',
      reason: '没有 DOI，已按题名等字段检索到 3 条候选。',
      provider: { id: 'crossref', name: 'Crossref' },
      sourceUrl: '', apiUrl: 'https://api.crossref.org/works?rows=5',
      fetchedAt: '2026-10-31 19:00:00', httpStatus: 200,
      method: 'bibliographic-search', query: ref.title,
      record: null,
      rawPayload: {
        provider: 'Crossref', apiUrl: 'https://api.crossref.org/works?rows=5',
        requestedAt: '2026-10-31 19:00:00', httpStatus: 200,
        truncated: false, note: '完整原始返回', json: '{"message":{}}'
      },
      checks: [],
      candidates: [
        { rank: 1, doi: '10.1/a', title: 'A', authors: 'X', container: 'J1', yearIssued: '2021', sim: { overall: 0.8 } },
        { rank: 2, doi: '10.1/b', title: 'B', authors: 'Y', container: 'J2', yearIssued: '2020', sim: { overall: 0.6 } },
        { rank: 3, doi: '10.1/c', title: 'C', authors: 'Z', container: 'J3', yearIssued: '2019', sim: { overall: 0.4 } }
      ],
      tried: [
        { providerId: 'crossref', providerName: 'Crossref', method: 'bibliographic-search', apiUrl: 'https://api.crossref.org/works?rows=5', requestedAt: '2026-10-31 19:00:00', httpStatus: 200, ok: true }
      ],
      input: ref
    };
  }

  return {
    ok: true, statusKey: 'verified',
    statusText: '题录已核验无误', statusDesc: '全部核心字段匹配一致',
    colorHint: '绿色', tone: 'ok',
    label: '题录已核验无误',
    reason: '存在该 DOI 记录，且所有可比对的核心字段一致。',
    provider: { id: 'openalex', name: 'OpenAlex' },
    sourceUrl: 'https://doi.org/' + ref.doi, apiUrl: 'https://api.openalex.org/works/doi:' + ref.doi,
    fetchedAt: '2026-10-31 19:00:00', httpStatus: 200,
    method: 'doi-exact',
    record: { doi: ref.doi, title: ref.title, authors: ref.authors, container: ref.venue, yearIssued: ref.year },
    rawPayload: {
      provider: 'OpenAlex', apiUrl: 'https://api.openalex.org/works/doi:' + ref.doi,
      requestedAt: '2026-10-31 19:00:00', httpStatus: 200,
      truncated: false, note: '完整原始返回', json: '{"id":"W1"}'
    },
    checks: [
      { name: '题名', key: 'title', verdict: 'match', input: ref.title, record: ref.title, note: '一致' }
    ],
    candidates: [],
    tried: [
      { providerId: 'openalex', providerName: 'OpenAlex', method: 'doi-exact', apiUrl: 'https://api.openalex.org/works/doi:' + ref.doi, requestedAt: '2026-10-31 19:00:00', httpStatus: 200, ok: true }
    ],
    input: ref
  };
}

var captured = null;
global.Page = function (obj) { captured = obj; };

var store = require(path.join(__dirname, '../utils/store.js'));
var verifyService = require(path.join(__dirname, '../utils/verify-service.js'));

/* 加载页面模块：Page({...}) 会被 mock 捕获，得到真实的页面逻辑对象 */
require(path.join(__dirname, '../pages/verify/verify.js'));
var verifyPage = captured;

if (!verifyPage) {
  console.error('无法捕获页面对象，测试中止');
  process.exit(1);
}

var pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  << ' + detail : '')); }
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function makePage(topicId) {
  var inst = Object.create(verifyPage);
  inst.data = { topic: { id: topicId }, cards: [], draft: {} };
  inst.setData = function (patch) {
    for (var k in patch) {
      if (k.indexOf('[') > -1) continue; // 简化：忽略数组路径
      inst.data[k] = patch[k];
    }
  };
  inst.refresh = function () { inst._refreshed = (inst._refreshed || 0) + 1; };
  return inst;
}

async function main() {
  store.ensure();

  /* ---------------- 准备课题与 13 条文献 ---------------- */
  var topic = store.newTopic();
  topic.name = '批量核验测试课题';
  topic.problem = '测试用研究问题';
  topic.target = '测试对象';
  topic.task = '测试任务';
  topic.claim = '测试主张';
  store.upsertTopic(topic);

  var refs = [];
  for (var i = 0; i < 13; i++) {
    var r = store.newRef(topic.id);
    r.title = '测试文献 ' + (i + 1);
    r.authors = 'Author ' + (i + 1);
    r.year = '202' + (i % 5);
    r.venue = 'Test Journal';
    r.raw = '原始粘贴文本 ' + (i + 1);
    refs.push(r);
  }
  store.addRefs(refs);

  /* ---------------- C1：批量上限 10 条 + 间隔 ---------------- */
  console.log('\n===== C1 批量处理：单次最多 10 条 + 自动间隔 =====');

  check('批量上限常量为 10', verifyService.MAX_BATCH === 10, String(verifyService.MAX_BATCH));

  var page = makePage(topic.id);
  var batchResult = await verifyPage.runBatch.call(page, refs.slice(0, verifyService.MAX_BATCH));
  console.log('  批量返回：' + JSON.stringify(batchResult));

  /* 现在一次「条目核验」内部会拆成多段调用（提取 → 学术库 → 千问联网），
   * 所以不能再按调用次数判断处理了几条，要按【涉及的条目】去重统计。 */
  var touchedRefs = {};
  callLog.forEach(function (c) {
    var t = c.data && c.data.ref && c.data.ref.title;
    if (t) touchedRefs[t] = 1;
  });
  var touchedCount = Object.keys(touchedRefs).length;
  check('只处理了 10 条（共 13 条）', touchedCount === 10, '实际 ' + touchedCount);

  /* 间隔只看「条目之间」，不能被同一条目内部的多段调用稀释 */
  var firstAtOf = {};
  callLog.forEach(function (c) {
    var t = c.data && c.data.ref && c.data.ref.title;
    if (t && firstAtOf[t] == null) firstAtOf[t] = c.at;
  });
  var starts = Object.keys(firstAtOf).map(function (k) { return firstAtOf[k]; }).sort(function (a, b) { return a - b; });
  var gaps = [];
  for (var g = 1; g < starts.length; g++) gaps.push(starts[g] - starts[g - 1]);
  var minGap = gaps.length ? Math.min.apply(null, gaps) : 0;
  console.log('  相邻条目起始间隔(ms)：' + gaps.join(', '));
  check('条与条之间留了间隔（≥1000ms）', minGap >= 1000, '最小间隔 ' + minGap + 'ms');

  check('每次调用都打到真实存在的云函数（且只有这两个）', callLog.every(function (c) {
    return c.name === 'lfaVerify' || c.name === 'lfa_qwen';
  }), callLog.map(function (c) { return c.name; }).join(','));

  /* 环境隔离是本轮核心：依赖 QWEN_API_KEY 的段必须打到 lfa_qwen，
   * 打到 lfaVerify 会因为没有 Key 而「未配置、未执行」，结论全是假的。 */
  var NEED_QWEN = { 'extract': 1, 'ai-verify': 1, 'discover-plan': 1, 'discover-analyze': 1, 'adapt': 1 };
  var misrouted = callLog.filter(function (c) {
    var act = c.data && c.data.action;
    return NEED_QWEN[act] && c.name !== 'lfa_qwen';
  });
  check('走大模型的段必定打到 lfa_qwen（Key 只配在那里）', misrouted.length === 0,
    '错路由 ' + misrouted.length + ' 次：' +
    misrouted.map(function (c) { return (c.data && c.data.action) + '@' + c.name; }).join(', '));

  var misScholar = callLog.filter(function (c) {
    return c.data && c.data.action === 'verify' && c.name !== 'lfaVerify';
  });
  check('学术库检索段打到 lfaVerify（AMiner Key 在那里）', misScholar.length === 0,
    '错路由 ' + misScholar.length + ' 次');

  /* ---------------- C2：日志持久化 ---------------- */
  console.log('\n===== C2 日志持久化：三份不可覆盖内容 =====');

  var ref0 = store.getRef(refs[0].id);
  var idn = ref0.identity;

  check('① 保留用户原始输入快照', !!(idn && idn.input && idn.input.title === '测试文献 1'),
    JSON.stringify(idn && idn.input));
  check('② 保留了各源原始返回 + 接口地址 + 请求时间',
    !!(idn && idn.rawPayload && idn.rawPayload.json && idn.rawPayload.apiUrl && idn.rawPayload.requestedAt));
  check('③ 保留了系统自动比对结论', !!(idn && idn.checks && idn.checks.length >= 0 && idn.statusKey));
  check('记录了逐源访问日志', !!(idn && idn.tried && idn.tried.length > 0));
  check('结论带有课题版本号，便于判定是否过期', idn.topicRevision === topic.revision,
    'idn=' + idn.topicRevision + ' topic=' + topic.revision);

  // 再核验一次 → 旧结果必须进入历史，不被覆盖
  var before = JSON.stringify(ref0.identity);
  page.applyResult = verifyPage.applyResult.bind(page);
  await verifyService.verifyOne(refs[0]).then(function (res) {
    page.applyResult(refs[0].id, res);
  });
  var after = store.getRef(refs[0].id);
  check('重新核验后，旧结果进入 history 而非被丢弃',
    (after.identityHistory || []).length === 1,
    'history=' + (after.identityHistory || []).length);
  check('history 中保留的是上一次的原始结论',
    JSON.stringify(after.identityHistory[0]) === before ||
    (after.identityHistory[0] && after.identityHistory[0].input.title === '测试文献 1'));

  /* ---------------- C2b：人工备注只追加，不覆盖 ---------------- */
  console.log('\n===== C2b 人工备注：只新增，不覆盖自动结论 =====');
  var autoBefore = JSON.stringify(store.getRef(refs[0].id).identity);
  store.addManualEvidence(refs[0].id, {
    sourceName: '知网', url: 'https://example.cn', note: '已人工核对卷期页码'
  });
  var r0 = store.getRef(refs[0].id);
  check('人工备注已追加', (r0.manualEvidence || []).length === 1);
  check('【关键】系统自动核验结论未被修改',
    JSON.stringify(r0.identity) === autoBefore);
  check('人工备注带时间戳', !!r0.manualEvidence[0].at);

  /* ---------------- C3：课题变更 → 需重新评估 ---------------- */
  console.log('\n===== C3 课题变更 → 历史结果自动标记「需重新评估」 =====');

  var before3 = store.isStale(r0, store.getActiveTopic());
  check('变更前：三项初判不算过期', before3 === false);
  check('变更前：自动核验结论不算过期',
    store.isIdentityStale(r0, store.getActiveTopic()) === false);

  // 修改课题需求字段 → revision 自增
  var t2 = store.getTopic(topic.id);
  t2.target = '变更后的测试对象';
  t2.task = '变更后的测试任务';
  var saved = store.upsertTopic(t2);

  var r3 = store.getRef(refs[0].id);
  var nowTopic = store.getActiveTopic();

  check('课题版本号已自增', saved.requirementChanged === true && nowTopic.revision === topic.revision + 1,
    'revision=' + nowTopic.revision);
  check('【关键】旧的三项初判被标记为需重新评估', store.isStale(r3, nowTopic) === true);
  check('【关键】旧的自动核验结论被标记为需重新评估',
    store.isIdentityStale(r3, nowTopic) === true);

  console.log('\n  （说明）页面层在课题保存后会弹出提示，告知旧结果已标记需重新评估；');
  console.log('   这里验证的是底层判定逻辑，弹窗部分在模拟器里人工确认。');

  console.log('\n==================================');
  console.log('阶段 C 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==================================');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
