/* 一次性冒烟测试：用 Node 跑 util 逻辑，验证解析 / 三项判定 / 版本失效 / 记录导出。不属于小程序代码，可删除。 */
var mem = {};
global.wx = {
  getStorageSync: function (k) { return mem[k]; },
  setStorageSync: function (k, v) { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: function (k) { delete mem[k]; },
  showToast: function (o) { console.log('[toast]', o.title); },
  showModal: function (o) { console.log('[modal]', o.title); },
  getFileSystemManager: function () { return {}; },
  env: { USER_DATA_PATH: '/tmp' },
  setClipboardData: function (o) { o.success && o.success(); }
};

var store = require('../utils/store.js');
var rules = require('../utils/rules.js');
var record = require('../utils/record.js');

// 1) 新建课题
var t = store.newTopic();
t.name = '老旧小区冬季供暖改造效果评估';
t.problem = '围护结构改造能否降低北方老旧小区的供暖能耗';
t.target = '北方城市老旧住宅小区';
t.task = '做出能耗对比评估并给出改造建议';
t.resources = '当地供热公司 3 年能耗数据';
t.claim = '围护结构改造能显著降低北方老旧小区的供暖能耗';
t.customFields = [{ id: 'c1', label: '评价指标', value: '单位面积耗热量' }];
var r1 = store.upsertTopic(t);
console.log('课题保存 → id=' + r1.topic.id + ' revision=' + r1.topic.revision + ' changed=' + r1.requirementChanged);

// 2) 解析 2 条文献（含一条英文）
var paste = [
  '[1] 王强, 李敏. 北方老旧小区围护结构改造节能效果分析[J]. 建筑节能, 2021, 49(3): 12-20.',
  'Smith J, Brown A. Energy retrofit evaluation of old residential buildings. Energy and Buildings, 2020. https://doi.org/10.1016/j.enbuild.2020.110123'
].join('\n');
var parsed = rules.parseRefs(paste, 10);
console.log('解析条数 =', parsed.items.length);
parsed.items.forEach(function (it, i) {
  console.log('  #' + (i + 1), JSON.stringify({ title: it.title, authors: it.authors, year: it.year, venue: it.venue, doi: it.doi }));
});

// 3) 保存 + 初判
var refs = [];
parsed.items.forEach(function (item) {
  var rf = store.newRef(t.id);
  rf.raw = item.raw; rf.title = item.title; rf.authors = item.authors; rf.year = item.year;
  rf.venue = item.venue; rf.doi = item.doi; rf.url = item.url;
  rf.parsed = item.parsed;
  rf.evidence = { link: item.url, abstract: '', excerpt: '' };
  refs.push(rf);
});
store.addRefs(refs);

// 给第 1 条补证据（模拟用户粘贴摘要/节选）
var r0 = refs[0];
r0.evidence.abstract = '以北方老旧住宅小区为对象，评估围护结构改造后的供暖能耗变化，指标为单位面积耗热量。结果显示老旧小区能耗下降，样本来自单一城市，冬季工况受限。';
r0.evidence.excerpt = '改造后单位面积耗热量下降，说明围护结构改造在小范围样本中可以降低北方老旧小区供暖能耗。';
store.replaceRef(r0);

refs.forEach(function (rf) { store.addEval(rf.id, rules.evaluate(t, rf)); });

var shown = store.getRefs(t.id);
shown.forEach(function (rf) {
  var ev = store.latestEval(rf);
  console.log('初判 →', rf.title.slice(0, 18));
  console.log('   1) 身份:', ev.identity.status, '| 字段数:', ev.identity.fields.length);
  console.log('   2) 用途:', ev.usage.status, '|', ev.usage.reason.slice(0, 30));
  console.log('   3) 主张:', ev.claim.status);
});

// 4) 人工确认
store.addConfirm(refs[0].id, { decision: 'method', decisionLabel: '借鉴方法', reason: '样本仅一个城市，结论不能直接套用到我的对象', claimVerdict: '需补充条件', basedOnRevision: t.revision });
console.log('人工确认数 =', store.getRef(refs[0].id).confirms.length);

// 5) 课题要求修改 → 版本号变化 → 失效标记
t.task = '给出能耗对比评估、经济性测算与居民访谈结论';
var r2 = store.upsertTopic(t);
console.log('修改后 revision =', r2.topic.revision, 'changed =', r2.requirementChanged);
shown = store.getRefs(t.id);
console.log('是否需要重新评估 =', shown.map(function (rf) { return store.isStale(rf, r2.topic); }).join(', '));

// 6) 重新初判（历史保留）
store.addEval(refs[0].id, rules.evaluate(r2.topic, store.getRef(refs[0].id)));
console.log('初判历史条数 =', store.getRef(refs[0].id).evals.length, '(应为 2，说明历史未被覆盖)');

// 7) 未填主张时
t.task = '做出能耗对比评估并给出改造建议';
t.claim = '';
var r3 = store.upsertTopic(t);
var ev2 = rules.evaluate(r3.topic, store.getRef(refs[1].id));
console.log('无摘要且无主张 → 身份:', ev2.identity.status, '| 主张:', ev2.claim.status);

// 8) 导出文本
var full = record.buildFullText(r3.topic, store.getRefs(t.id));
console.log('导出文本长度 =', full.length);
console.log('----- 导出片段 -----');
console.log(full.split('\n').slice(0, 14).join('\n'));
console.log('...');
console.log(full.split('\n').filter(function (l) { return l.indexOf('自动初判') === 0 || l.indexOf('人工确认') === 0; }).join('\n'));

// 9) 样例：载入 / 清除
var n = store.loadSamples();
console.log('载入样例 =', n, '| hasSample =', store.hasSample());
store.clearSamples();
console.log('清除后 hasSample =', store.hasSample(), '| 用户条目仍存在 =', store.getRefs(t.id).length);
