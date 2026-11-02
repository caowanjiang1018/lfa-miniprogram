'use strict';
/**
 * 阶段 B 测试
 * ------------------------------------------------------------
 * B1 无 DOI 题名检索 → 多条候选，【不自动选定第一条】
 * B2 年份「在线预发表 vs 印刷卷期」区分展示，不直接判冲突
 * B3 字段缺失 → 只标【信息缺失】，不补造、不算冲突
 * B4 中文文献 → 不请求境外源，直接转人工核验分支
 *
 * B1 为真实网络请求（首次录制 fixture，之后回放）；
 * B2/B3 用纯函数比对，其中 B2 的跨年数据为【构造的软件测试样例】，
 *      不指向任何真实文献，会在输出中明确标注。
 *
 * 运行：node tests/stage-b-test.js [--record]
 */

var path = require('path');
var recorder = require('./helpers/recorder.js');

var CF = path.resolve(__dirname, '../cloudfunctions/lfaVerify');
var http = require(path.join(CF, 'lib/http.js'));
var compare = require(path.join(CF, 'lib/compare.js'));
var crossref = require(path.join(CF, 'sources/crossref.js'));
var openalex = require(path.join(CF, 'sources/openalex.js'));
var engine = require(path.join(CF, 'index.js'));

var RECORD = process.argv.indexOf('--record') > -1;

var pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  << ' + detail : '')); }
}

function verdictOf(checks, key) {
  for (var i = 0; i < checks.length; i++) if (checks[i].key === key) return checks[i];
  return null;
}

async function main() {
  /* ============ B2：年份在线/卷期区分（构造样例，非真实文献）============ */
  console.log('\n===== B2 年份区分：在线预发表 vs 印刷卷期（构造样例，非真实文献）=====');
  console.log('  ［说明］以下为软件测试用的合成数据，不指向任何真实论文。');

  var synthMsg = {
    DOI: '10.0000/synthetic.crossyear',
    title: ['Retrofit performance of old residential buildings'],
    'container-title': ['Energy and Buildings'],
    author: [{ given: 'Min', family: 'Li' }, { given: 'Qiang', family: 'Wang' }],
    issued: { 'date-parts': [[2021, 1, 15]] },
    'published-online': { 'date-parts': [[2020, 12, 20]] },
    'published-print': { 'date-parts': [[2021, 2, 1]] }
  };
  var rec = crossref.flattenRecord(synthMsg);

  console.log('  来源记录的年份取值（三类）：');
  rec.yearSources.forEach(function (s) {
    console.log('    · ' + s.kind + '：' + s.year + '（完整日期 ' + s.full + '）');
  });
  check('同时保留在线与印刷两类年份取值', rec.yearSources.length >= 2,
    '实际 ' + rec.yearSources.length);

  var base = {
    title: 'Retrofit performance of old residential buildings',
    authors: 'Li M, Wang Q', year: '', venue: 'Energy and Buildings',
    doi: '10.0000/synthetic.crossyear'
  };

  // 输入年份 = 在线年份 → 一致
  var c2020 = compare.compareFields(merge(base, { year: '2020' }), rec, 'Crossref');
  var y2020 = verdictOf(c2020, 'year');
  console.log('  输入 2020（等于在线年份）→ ' + y2020.verdict);
  check('输入等于在线年份时判为一致', y2020.verdict === 'match', y2020.verdict);

  // 输入年份 = 印刷年份 → 一致
  var c2021 = compare.compareFields(merge(base, { year: '2021' }), rec, 'Crossref');
  var y2021 = verdictOf(c2021, 'year');
  console.log('  输入 2021（等于印刷/出版年份）→ ' + y2021.verdict);
  check('输入等于印刷年份时判为一致', y2021.verdict === 'match', y2021.verdict);

  // 输入年份都不相同，且源存在多个年份 → year_ambiguous（不判冲突）
  var c2022 = compare.compareFields(merge(base, { year: '2022' }), rec, 'Crossref');
  var y2022 = verdictOf(c2022, 'year');
  console.log('  输入 2022（两者都不是）→ ' + y2022.verdict);
  check('两者都不是且源存在多年份时，判为需人工复核而非冲突',
    y2022.verdict === 'year_ambiguous', y2022.verdict);
  check('年份明细完整列出供复核', (y2022.yearDetail || []).length >= 2);
  console.log('  提示文案：' + y2022.note);

  /* ============ B3：缺失字段不补造 ============ */
  console.log('\n===== B3 字段缺失：只标缺失，不补造 =====');

  var noAuthorRec = crossref.flattenRecord({
    DOI: '10.0000/synthetic.noauthor',
    title: ['Retrofit performance of old residential buildings'],
    'container-title': ['Energy and Buildings'],
    author: []
  });
  var cNoAuthor = compare.compareFields(
    merge(base, { year: '2021', doi: '' }), noAuthorRec, 'Crossref');
  var au = verdictOf(cNoAuthor, 'authors');
  console.log('  记录无作者字段 → ' + au.verdict + '｜' + au.note);
  check('记录缺失作者时标记为缺失', au.verdict === 'record_missing', au.verdict);
  check('缺失文案不含「冲突」字样', !/冲突/.test(au.note));

  var noYearRec = crossref.flattenRecord({
    DOI: '10.0000/synthetic.noyear',
    title: ['Retrofit performance of old residential buildings'],
    'container-title': ['Energy and Buildings'],
    author: [{ given: 'Min', family: 'Li' }]
  });
  var cNoYear = compare.compareFields(
    merge(base, { year: '2021', doi: '' }), noYearRec, 'Crossref');
  var yr = verdictOf(cNoYear, 'year');
  console.log('  记录无年份字段 → ' + yr.verdict + '｜' + yr.note);
  check('记录缺失年份时标记为缺失', yr.verdict === 'record_missing', yr.verdict);

  var sNoYear = compare.summarize(cNoYear);
  check('缺失字段不计入冲突', sNoYear.mismatch.length === 0);

  /* ============ B1：无 DOI 检索（真实请求）============ */
  console.log('\n===== B1 无 DOI 题名检索（真实请求，经云函数引擎）=====');
  http.setTransport(recorder.createTransport(RECORD));

  var r1 = await engine.verifyOne({
    doi: '',
    title: 'Machine learning for building energy consumption prediction',
    authors: 'Ji, Yu, Wang',
    year: '2025',
    venue: 'Journal of Building Engineering'
  }, { allowSearch: true });

  console.log('  状态：' + r1.statusText + '（' + r1.colorHint + '）');
  console.log('  结论：' + r1.reason);
  console.log('  候选数：' + (r1.candidates || []).length);
  (r1.candidates || []).slice(0, 5).forEach(function (c) {
    console.log('    #' + c.rank + ' 综合 ' + c.sim.overall +
      '｜题名 ' + c.sim.title + '｜' + String(c.title).slice(0, 50));
  });
  (r1.tried || []).forEach(function (t) {
    console.log('    尝试：' + t.providerName + ' ' + t.method + ' HTTP ' + t.httpStatus +
      (t.failureKind ? ' (' + t.failureKind + ')' : '') + ' @' + t.requestedAt);
  });

  check('状态为 multi_candidate 或 not_indexed 或 network_error（三者都合法，取决于上游）',
    ['multi_candidate', 'not_indexed', 'network_error'].indexOf(r1.statusKey) > -1,
    r1.statusKey);

  if (r1.statusKey === 'multi_candidate') {
    check('返回了多条候选', (r1.candidates || []).length > 0);
    check('【关键】未自动选定第一条：record 为空、未生成 checks',
      r1.record === null && (r1.checks || []).length === 0,
      'record=' + JSON.stringify(r1.record));
    check('候选按综合分排序且带 rank', (function () {
      for (var i = 0; i < r1.candidates.length; i++) {
        if (r1.candidates[i].rank !== i + 1) return false;
      }
      return true;
    })());
  }
  check('留存了来源原始返回', !!(r1.rawPayload && r1.rawPayload.json));
  check('记录了逐源访问日志', (r1.tried || []).length > 0);

  await delay(1000);

  /* ============ B4：中文文献 ============ */
  console.log('\n===== B4 中文文献（应不请求境外源，直接转人工核验）=====');
  var requested = [];
  http.setTransport(function (url) {
    requested.push(url);
    return Promise.resolve({
      ok: false, status: 0, raw: '', body: null,
      requestedAtText: fmtNow(), failureKind: 'network',
      failureDetail: '测试断言：中文文献不应发起外部请求'
    });
  });

  var r2 = await engine.verifyOne({
    doi: '',
    title: '北方老旧小区围护结构改造节能效果分析',
    authors: '王强, 李敏',
    year: '2021',
    venue: '建筑节能'
  }, { allowSearch: true });

  console.log('  状态：' + r2.statusText + '（' + r2.colorHint + '）');
  console.log('  结论：' + r2.reason);
  check('状态为 not_indexed', r2.statusKey === 'not_indexed', r2.statusKey);
  check('【关键】未发起任何境外接口请求', requested.length === 0,
    '发起了 ' + requested.length + ' 次：' + requested.join(', '));
  check('结论说明中文文献覆盖边界', /中文/.test(r2.reason));

  console.log('\n==================================');
  console.log('阶段 B 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==================================');
  process.exit(fail ? 1 : 0);
}

function merge(a, b) {
  var o = {};
  var k;
  for (k in a) o[k] = a[k];
  for (k in b) o[k] = b[k];
  return o;
}

function fmtNow() {
  var d = new Date();
  function p(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

main().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
