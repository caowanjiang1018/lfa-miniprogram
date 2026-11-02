'use strict';
/**
 * 核验结果视图模型测试（前端 utils/identity.js）
 * ------------------------------------------------------------
 * 回归背景（2026-11-01 修复）：
 *   buildIdentityView() 里直接读 identity.aiSearch.recordMeta。
 *   但只有走过千问联网检索的结果才带 aiSearch，OpenAlex / Crossref 直接命中的条目这一项是 null。
 *   一旦读到 null，函数抛 TypeError —— 而它是核验卡列表渲染每条卡片的必经路径，
 *   一抛异常 refresh() 整段中断、setData 从未执行，结果是【核验卡一条记录都不显示】。
 *
 * 本套用例锁死：任何形态的 identity 都【不许抛异常】，且题录/状态照常产出。
 *
 * 运行：node tests/identity-view-test.js
 */

var identityView = require('../utils/identity.js');

var pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  << ' + detail : '')); }
}

/** 构造各类 identity，任何一条都不许让 buildIdentityView 抛异常 */
function build(name, idn) {
  try {
    return { ok: true, v: identityView.buildIdentityView(idn) };
  } catch (e) {
    check(name + ' 不抛异常', false, String(e && e.message || e));
    return { ok: false, v: null };
  }
}

console.log('===== ① 没有千问兜底结果（aiSearch 缺失 / 为 null）=====');

var r1 = build('无 aiSearch', {
  statusKey: 'verified', statusText: '题录一致', tone: 'ok',
  checks: [{ name: '题名', verdict: 'match', input: 'a', record: 'a' }],
  candidates: [], tried: [{ providerName: 'OpenAlex', method: 'doi-exact' }],
  provider: { name: 'OpenAlex' }
});
check('无 aiSearch 时不抛异常', r1.ok);
check('无 aiSearch 时状态照常给出', r1.ok && r1.v.statusKey === 'verified', r1.ok ? r1.v.statusKey : '');
check('无 aiSearch 时 hasAiSearch=false（不显示千问区块）', r1.ok && r1.v.hasAiSearch === false);
check('无 aiSearch 时逐字段比对照常展示', r1.ok && r1.v.hasChecks === true);

var r2 = build('aiSearch = null', {
  statusKey: 'not_indexed', statusText: '公开元数据库未收录', tone: 'gray', aiSearch: null
});
check('aiSearch=null 时不抛异常', r2.ok);
check('aiSearch=null 时状态照常给出', r2.ok && r2.v.statusKey === 'not_indexed');

var r3 = build('identity 只有 statusKey', { statusKey: 'insufficient_input' });
check('极简 identity 不抛异常', r3.ok);

check('identity 为 null 时返回 null（未核验）', identityView.buildIdentityView(null) === null);
check('identity 无 statusKey 时返回 null', identityView.buildIdentityView({ foo: 1 }) === null);

console.log('\n===== ② 有千问兜底结果（解耦后的三类形态）=====');

var r4 = build('record_only（有题录、无链接）', {
  statusKey: 'ai_found', statusText: 'AI 检索到题录',
  aiSearch: {
    outcome: 'record_only',
    recordMeta: {
      credible: true, title: '工程控制论', authorsText: '钱学森', year: '1958',
      hasAbstract: false, fieldsAbsent: ['DOI'], sourceName: '搜索摘要'
    },
    candidateLinks: [], rawCandidateLinks: [{ name: 'n', url: 'https://example.org/x' }]
  }
});
check('record_only 不抛异常', r4.ok);
check('record_only 保留题录（不被链接状态拖没）', r4.ok && r4.v.aiSearch.hasRecordMeta === true);
check('record_only 标记为 recordOnly', r4.ok && r4.v.aiSearch.recordOnly === true);
check('record_only 不算 noClue（不显示「未检索到」）', r4.ok && r4.v.aiSearch.noClue === false);
check('record_only 原始链接进折叠区', r4.ok && r4.v.aiSearch.hasRawCandidateLinks === true);

var r5 = build('record_and_link', {
  statusKey: 'ai_found',
  aiSearch: {
    outcome: 'record_and_link',
    recordMeta: { credible: true, title: '深度学习', hasAbstract: true, abstract: 'x' },
    candidateLinks: [{ url: 'https://book.douban.com/subject/1', probeState: 'ok', source: '豆瓣读书' }],
    rawCandidateLinks: []
  }
});
check('record_and_link 主展示区有链接', r5.ok && r5.v.aiSearch.hasLinks === true);
check('可用链接标「已实测可访问」',
  r5.ok && r5.v.aiSearch.candidateLinks[0].probeStateText === '已实测可访问',
  r5.ok ? r5.v.aiSearch.candidateLinks[0].probeStateText : '');

var r6 = build('老结构（无 recordMeta，用顶层字段兼容）', {
  statusKey: 'ai_found',
  aiSearch: {
    exists: 'yes', title: '深度学习', doi: '10.1000/xyz',
    links: [{ url: 'https://a.example.org', probeState: 'unverified' }],
    sources: [{ name: '豆瓣', url: 'https://b.example.org' }]
  }
});
check('老结构不抛异常', r6.ok);
check('老结构按顶层字段补出 recordMeta', r6.ok && r6.v.aiSearch.recordMeta.credible === true);
check('老结构补出的 outcome 为 record_and_link',
  r6.ok && r6.v.aiSearch.outcome === 'record_and_link', r6.ok ? r6.v.aiSearch.outcome : '');
check('未确认连通性的链接标「暂无法验证连通性」',
  r6.ok && r6.v.aiSearch.candidateLinks[0].probeStateText === '暂无法验证连通性');

console.log('\n==================================');
console.log('核验视图测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('==================================');
process.exit(fail ? 1 : 0);
