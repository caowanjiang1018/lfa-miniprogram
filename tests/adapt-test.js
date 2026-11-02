'use strict';
/**
 * 第四阶段测试：课题适配 + 拟引用主张核验
 * ------------------------------------------------------------
 * 锁死这几条最容易造假的口子：
 *   A. 摘录必须能在用户提供的材料里定位；定位不到 → 证据不足，且维度/主张判定被降级
 *   B. 没有任何材料（连摘要都没有）→ 不做 AI 分析，返回 no_material
 *   C. 运行时分析服务未配置 → config_failed，明确「未执行 AI 分析」，绝不假装完成
 *   D. 不输出匹配度 / 可信度百分数；「近年发表」不能当匹配点
 *   E. 用途只认白名单，且必须包含「可借鉴方法，但不能作为目标场景效果的直接证据」
 *   F. 下一轮检索建议只能是检索词：含链接 / DOI 的一律丢弃（不推荐替代文献）
 *   G. 视图层任何形态都不许抛异常（上一轮的教训：一处空指针让整页记录全消失）
 *   H. 导出：未确认就写「未确认」，定位失败写「证据不足」
 *
 * 运行：node tests/adapt-test.js
 */

var path = require('path');
var CF = path.resolve(__dirname, '../cloudfunctions/lfaVerify');
var adapt = require(path.join(CF, 'adapt.js'));
var view = require('../utils/adapt-view.js');
var record = require('../utils/record.js');

var pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  << ' + detail : '')); }
}

/* 一段【构造的测试样例】原文节选，不指向任何真实论文 */
var EXCERPT = '本文以北京市某 1990 年代老旧小区为对象，对围护结构改造后的冬季供暖能耗进行了连续两个采暖季的实测。' +
  '结果表明，改造后单位面积供暖能耗下降 18.3%，室内平均温度提高 2.1℃。样本仅覆盖 3 栋住宅楼，' +
  '未涵盖极端低温工况，也未与未改造建筑做同期对照。';

var mats = adapt.buildMaterials({ evidence: { excerpt: EXCERPT, abstract: '' } });

console.log('===== A. 摘录定位（这条决定「能不能声称读过」）=====');
check('A1 原文一致可定位', !!adapt.locateIn(mats, '改造后单位面积供暖能耗下降 18.3%'));
check('A2 忽略标点空格后可定位', !!adapt.locateIn(mats, '改造后单位面积供暖能耗下降18.3%'));
check('A3 编造的页码句定位失败', adapt.locateIn(mats, '第 12 页指出能耗下降 25%') === null);
check('A4 材料里没有的摘录定位失败', adapt.locateIn(mats, '作者在上海开展了同类研究') === null);
check('A5 定位失败文案说明「证据不足」',
  /未能|证据不足/.test(adapt.locateText(null)), adapt.locateText(null));
check('A6 证据等级：有节选 = excerpt', adapt.evidenceLevelOf(mats).level === 'excerpt');
check('A7 证据等级：只有残摘要 = citation（不做分析）',
  adapt.evidenceLevelOf([{ kind: 'abstract', text: '太短', chars: 4 }]).level === 'citation');
check('A8 证据等级：足够长摘要 = abstract',
  adapt.evidenceLevelOf([{ kind: 'abstract', text: new Array(200).join('字'), chars: 199 }]).level === 'abstract');

console.log('\n===== B. 材料不足 / 服务未配置：必须如实，不许假装完成 =====');

/* B 组跑纯函数：直接构造 no_material 与 config_failed 的判定条件 */
check('B1 无任何材料时 buildMaterials 为空', adapt.buildMaterials({ evidence: {} }).length === 0);
check('B2 只有题录时证据等级为 citation', adapt.evidenceLevelOf([]).level === 'citation');
check('B3 未配置分析服务时 available() 为假（本测试环境无密钥）',
  require(path.join(CF, 'sources/qwen.js')).available() === false);

console.log('\n===== C. 机器校验：百分数 / 用途白名单 / 检索式 =====');

var MODEL_OUT = {
  dimensions: [
    { key: 'object', topicText: '北方老旧小区', actualText: '北京市老旧小区', verdict: 'match',
      quotes: ['本文以北京市某 1990 年代老旧小区为对象'], note: '对象一致' },
    { key: 'task', topicText: '供暖能耗评估', actualText: '冬季供暖能耗实测', verdict: 'match',
      quotes: ['对围护结构改造后的冬季供暖能耗进行了连续两个采暖季的实测'], note: '' },
    { key: 'condition', topicText: '严寒地区连续供暖', actualText: '材料未提供', verdict: 'unknown', quotes: [], note: '' },
    { key: 'result', topicText: '节能率', actualText: '下降 25%', verdict: 'match',
      quotes: ['第 12 页显示下降 25%'], note: '' }
  ],
  matches: ['对象同为老旧小区', '匹配度 87%', '近年发表'],
  gaps: ['样本仅 3 栋楼'],
  usage: { value: 'method_only', why: '未涵盖极端低温工况' },
  caveat: '冬季工况不能照搬',
  claims: [
    { claimId: 'c1', verdict: 'supported',
      quotes: [{ text: '改造后单位面积供暖能耗下降 18.3%', locator: '未提供页码' }], note: '' },
    { claimId: 'c2', verdict: 'supported',
      quotes: [{ text: '第 8 页给出节能率 40%', locator: '第 8 页' }], note: '' }
  ],
  nextQueries: [
    { text: '老旧小区 围护结构改造 供暖能耗 实测', why: '补样本量', lang: 'zh' },
    { text: 'https://example.org/paper?id=1', why: '偷渡文献', lang: 'en' },
    { text: 'residential building retrofit heating energy 10.1000/xyz', why: '带 DOI', lang: 'en' }
  ],
  note: '样本偏小'
};

var dropped = [];
var fit = adapt.normFit(MODEL_OUT, {
  materials: mats,
  claims: [{ id: 'c1', text: '改造后供暖能耗下降约两成' }, { id: 'c2', text: '节能率可达四成' }],
  dropped: dropped
});

var dimByKey = {};
fit.dimensions.forEach(function (d) { dimByKey[d.key] = d; });

check('C1 可定位摘录的维度保留判定', dimByKey.object.verdict === 'match');
check('C2 编造摘录的维度降级为 unknown',
  dimByKey.result.verdict === 'unknown' && dimByKey.result.downgraded === true,
  dimByKey.result.verdict);
check('C3 降级时给出可见说明', /未能|无法判断/.test(dimByKey.result.downgradeText), dimByKey.result.downgradeText);
check('C4 百分数被剔除（不出现 87%）',
  JSON.stringify(fit.matches).indexOf('87%') < 0, JSON.stringify(fit.matches));
check('C5 「近年发表」不能作为匹配点',
  !fit.matches.some(function (s) { return /近年|最新/.test(s); }), JSON.stringify(fit.matches));
check('C6 用途白名单含「可借鉴方法但不能作为目标场景效果的直接证据」',
  !!adapt.USAGE.method_only &&
  /可借鉴方法/.test(adapt.USAGE.method_only.text) &&
  /不能作为目标场景效果的直接证据/.test(adapt.USAGE.method_only.text),
  adapt.USAGE.method_only && adapt.USAGE.method_only.text);
check('C7 合法用途建议被保留', fit.usage.value === 'method_only');
check('C8 摘录可定位的主张保持「材料支持」', fit.claims[0].verdict === 'supported');
check('C9 摘录定位失败的主张降为证据不足',
  fit.claims[1].verdict === 'insufficient' && fit.claims[1].downgraded === true,
  fit.claims[1].verdict);
check('C10 检索建议里含链接的被丢弃',
  !fit.nextQueries.some(function (q) { return /https?:\/\//.test(q.text); }),
  JSON.stringify(fit.nextQueries));
check('C11 检索建议里含 DOI 的被丢弃',
  !fit.nextQueries.some(function (q) { return /10\.\d{4,9}\//.test(q.text); }),
  JSON.stringify(fit.nextQueries));
check('C12 合法检索词保留', fit.nextQueries.length === 1);
check('C13 被丢弃的内容都有原因', dropped.length > 0 && dropped.every(function (d) { return !!d.reason; }),
  JSON.stringify(dropped));

var badUsage = adapt.normFit({ usage: { value: '非常好用' } }, { materials: mats, claims: [], dropped: [] });
check('C14 白名单外的用途取值回落为 insufficient', badUsage.usage.value === 'insufficient');

console.log('\n===== D. 视图层健壮性（任何形态都不许抛异常）=====');

function noThrow(name, fn) {
  try { var v = fn(); check(name, true); return v; }
  catch (e) { check(name, false, String(e && e.message || e)); return null; }
}

noThrow('D1 adapt = null', function () { return view.buildAdaptView(null, null, null, null); });
noThrow('D2 adapt = {}（空对象）', function () { return view.buildAdaptView({}, null, null, { revision: 1 }); });
noThrow('D3 未配置状态', function () {
  return view.buildAdaptView({ status: 'config_failed', ok: false, failureDetail: '未配置' }, null, null, null);
});
noThrow('D4 材料不足状态', function () { return view.buildAdaptView({ status: 'no_material', ok: false }, null, null, null); });
noThrow('D5 dimensions 里混进 null', function () {
  return view.buildAdaptView({ ok: true, dimensions: [null, { key: 'object' }], claims: [null], dropped: [null] }, null, null, null);
});
var v3 = view.buildAdaptView({ status: 'config_failed', ok: false }, null, null, null);
check('D6 未配置时状态文案写明「未执行 AI 分析」',
  /未执行 AI 分析|未配置/.test(v3.statusText), v3.statusText);
var vOk = view.buildAdaptView({
  ok: true, status: 'ok', model: 'qwen-plus',
  evidenceLevel: 'abstract', evidenceLevelText: '基于摘要初筛',
  dimensions: fit.dimensions, claims: fit.claims, matches: fit.matches, gaps: fit.gaps,
  usage: fit.usage, nextQueries: fit.nextQueries, dropped: dropped, stats: fit.stats,
  materialsUsed: [{ id: 'm1', kind: 'excerpt', label: '用户粘贴的原文节选', chars: 120 }]
}, null, null, { revision: 2 });
check('D7 只有摘要时视图标出 abstractOnly', vOk.abstractOnly === true);
check('D8 未确认时 confirmed=false 且文案为「未确认」',
  vOk.confirmed === false && /未确认/.test(vOk.confirmText), vOk.confirmText);
check('D9 摘录定位失败的维度在视图里也能看到定位结论',
  vOk.dimensions.some(function (d) { return d.quotes.some(function (q) { return !q.located; }); }));
check('D10 用途选项包含四个取值且含 method_only',
  vOk.usageOptions.length === 4 &&
  vOk.usageOptions.some(function (o) { return o.value === 'method_only'; }));

console.log('\n===== E. 导出：未确认不写成已确认，定位失败写证据不足 =====');

var refForExport = {
  title: '某构造样例文献（测试用，不指向真实论文）',
  authors: '测试作者', year: '2024', venue: '测试出处',
  evidence: { link: '', abstract: '', excerpt: EXCERPT },
  adapt: {
    ok: true, status: 'ok', model: 'qwen-plus', at: '2026-11-01 11:00', ms: 9000,
    evidenceLevel: 'excerpt', evidenceLevelText: '已提供原文节选', readingScope: '仅限你粘贴的这部分原文',
    materialsUsed: [{ id: 'm1', kind: 'excerpt', label: '用户粘贴的原文节选', chars: 120 }],
    dimensions: fit.dimensions, matches: fit.matches, gaps: fit.gaps,
    claims: fit.claims, uncheckedClaims: [], usage: fit.usage,
    nextQueries: fit.nextQueries, dropped: dropped, stats: fit.stats,
    note: '样本偏小', topicRevision: 2
  },
  usageDecision: null,
  usageHistory: [],
  adaptConfirm: null
};

var text = record.buildAdaptText({ name: '测试课题', revision: 2 }, refForExport);
check('E1 导出含逐项对照', /课题要求 vs 文献实际/.test(text));
check('E2 导出含原文摘录与定位结论', /原文摘录/.test(text) && /定位结论/.test(text));
check('E3 导出明确写「未确认」（且不含「确认状态：已确认」）',
  /确认状态：未确认/.test(text) && !/确认状态：已确认/.test(text),
  (text.match(/⑤.*/) || [''])[0]);
check('E4 导出区分分析服务建议与你的修改', /分析服务建议/.test(text));
check('E5 导出含下一轮检索建议且说明不推荐替代文献',
  /下一轮检索建议/.test(text) && /不推荐替代文献/.test(text));
check('E6 导出写明未抓全文', /从未抓取或下载全文|未抓取全文/.test(text));

refForExport.adaptConfirm = { at: '2026-11-01 11:30', note: '用户确认' };
refForExport.usageDecision = {
  value: 'method_only', text: '可借鉴方法，但不能作为目标场景效果的直接证据',
  source: 'human', sourceText: '你的修改', reason: '样本在北方，本课题在夏热冬冷地区', at: '2026-11-01 11:20'
};
var text2 = record.buildAdaptText({ name: '测试课题', revision: 2 }, refForExport);
check('E7 确认后导出写「已确认」', /已确认/.test(text2));
check('E8 人工修改的用途与理由都进导出',
  /你的修改/.test(text2) && /夏热冬冷/.test(text2));
check('E9 自动建议仍保留在导出里', /分析服务建议/.test(text2));

console.log('\n==================================');
console.log('课题适配测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('==================================');
process.exit(fail ? 1 : 0);
