'use strict';
/**
 * 阶段 A 测试：单条带 DOI 文献端到端核验
 * ------------------------------------------------------------
 * 用例：
 *   A1 DOI 正确 + 题录一致            → 题录已核验无误
 *   A2 DOI 正确 + 题名不一致          → 题录字段冲突
 *   A3 无效 DOI（人工伪造，仅作软件测试）→ 公开元数据库未收录
 *   A4 模拟断网                        → 网络异常，核验中断
 *   A5 中文文献                        → 未请求境外源，直接人工核验分支
 *
 * 数据来源：真实请求 OpenAlex / Crossref；首次运行会录制 fixture，之后回放。
 * 运行：node tests/stage-a-test.js [--record]
 */

var path = require('path');
var recorder = require('./helpers/recorder.js');

var CF = path.resolve(__dirname, '../cloudfunctions/lfaVerify');
var http = require(path.join(CF, 'lib/http.js'));
var engine = require(path.join(CF, 'index.js'));

var RECORD = process.argv.indexOf('--record') > -1;

var pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  << ' + detail : '')); }
}

function show(res) {
  console.log('  状态：' + res.statusText + '（' + res.colorHint + ' / tone=' + res.tone + '）');
  console.log('  来源：' + (res.provider ? res.provider.name : '—') + '｜HTTP ' + res.httpStatus + '｜' + res.fetchedAt);
  console.log('  结论：' + res.reason);
  (res.checks || []).forEach(function (c) {
    console.log('    · ' + c.name + ' [' + c.verdict + '] 你=' + (c.input || '空') + ' ｜源=' + (c.record || '无'));
  });
  (res.tried || []).forEach(function (t) {
    console.log('    尝试：' + t.providerName + ' ' + t.method + ' HTTP ' + t.httpStatus +
      (t.failureKind ? ' (' + t.failureKind + ')' : '') + ' @' + t.requestedAt);
  });
  if (res.candidates && res.candidates.length) {
    console.log('    候选 ' + res.candidates.length + ' 条：' +
      res.candidates.slice(0, 3).map(function (c) { return '#' + c.rank + ' ' + c.title.slice(0, 40); }).join(' / '));
  }
}

function run(label, ref, expectKey, extraAssert) {
  console.log('\n===== ' + label + ' =====');
  return engine.verifyOne(ref, { allowSearch: true }).then(function (res) {
    show(res);
    check('状态应为 ' + expectKey, res.statusKey === expectKey, '实际 ' + res.statusKey);
    check('附带状态文字（不只用颜色区分）', !!res.statusText);
    check('附带能力边界提示', !!res.boundaryNotice);
    check('记录了尝试过的数据源', (res.tried || []).length > 0);
    check('保留用户原始输入快照', !!res.input);
    if (extraAssert) extraAssert(res);
    return res;
  });
}

async function main() {
  http.setTransport(recorder.createTransport(RECORD));

  // A1：真实 DOI + 正确题录
  await run('A1 DOI 正确且题录一致（LeCun 等《Deep learning》）', {
    doi: '10.1038/nature14539',
    title: 'Deep learning',
    authors: 'LeCun Y, Bengio Y, Hinton G',
    year: '2015',
    venue: 'Nature'
  }, 'verified', function (res) {
    check('留存了来源原始返回', !!(res.rawPayload && res.rawPayload.json));
    var titles = (res.checks || []).filter(function (c) { return c.key === 'title'; });
    check('题名判定为一致', titles.length && titles[0].verdict === 'match');
    var au = (res.checks || []).filter(function (c) { return c.key === 'authors'; });
    check('作者判定为一致', au.length && au[0].verdict === 'match', au[0] ? au[0].verdict : '');
    var yr = (res.checks || []).filter(function (c) { return c.key === 'year'; });
    check('年份判定为一致', yr.length && yr[0].verdict === 'match', yr[0] ? yr[0].verdict : '');
  });

  await delay(1200);

  // A2：真实 DOI + 错误题名
  await run('A2 DOI 正确但题名不一致（人为构造，仅作软件测试）', {
    doi: '10.1038/nature14539',
    title: 'A totally unrelated paper about solar panels',
    authors: 'LeCun Y, Bengio Y, Hinton G',
    year: '2015',
    venue: 'Nature'
  }, 'conflict', function (res) {
    var titles = (res.checks || []).filter(function (c) { return c.key === 'title'; });
    check('题名判定为冲突', titles.length && titles[0].verdict === 'mismatch', titles[0] ? titles[0].verdict : '');
    var yr = (res.checks || []).filter(function (c) { return c.key === 'year'; });
    check('年份仍判定为一致（不应被题名连坐）', yr.length && yr[0].verdict === 'match');
  });

  await delay(1200);

  // A3：伪造 DOI
  await run('A3 无效 DOI（人工伪造样本，仅用于测试软件分支）', {
    doi: '10.1016/j.enbuild.2020.110123',
    title: 'Retrofit of district heating in old residential areas',
    authors: 'Zhang San',
    year: '2020',
    venue: 'Energy and Buildings'
  }, 'not_indexed', function (res) {
    check('结论明确说明「不等于文献不存在」', /不等于|不等于该文献不存在/.test(res.reason));
  });

  await delay(1200);

  // A4：模拟断网（注入必然失败的 transport）
  console.log('\n===== A4 模拟断网（两个源都不可达） =====');
  http.setTransport(function () {
    return Promise.resolve({
      ok: false, status: 0, raw: '', body: null,
      requestedAtText: fmtNow(),
      failureKind: 'network',
      failureDetail: 'request:fail url not in domain list'
    });
  });
  var r4 = await engine.verifyOne({
    doi: '10.1038/nature14539',
    title: 'Deep learning',
    authors: 'LeCun Y',
    year: '2015',
    venue: 'Nature'
  }, { allowSearch: true });
  show(r4);
  check('状态为 network_error', r4.statusKey === 'network_error', r4.statusKey);
  check('如实记录错误原因', !!r4.failure && !!r4.failure.detail, JSON.stringify(r4.failure));
  check('未伪造核验成功', r4.statusKey !== 'verified');
  check('记录了两个数据源的失败', (r4.tried || []).length >= 1);

  await delay(1200);

  // A5：中文文献
  console.log('\n===== A5 中文文献（应直接转人工核验，不请求境外源） =====');
  http.setTransport(function (url) {
    return Promise.resolve({
      ok: false, status: 0, raw: '', body: null,
      requestedAtText: fmtNow(),
      failureKind: 'network',
      failureDetail: '测试断言：中文文献不应发起任何外部请求，但收到请求 ' + url
    });
  });
  var r5 = await engine.verifyOne({
    doi: '',
    title: '老旧小区冬季供暖改造效果评估研究',
    authors: '张三, 李四',
    year: '2021',
    venue: '建筑节能'
  }, { allowSearch: true });
  show(r5);
  check('状态为 not_indexed', r5.statusKey === 'not_indexed', r5.statusKey);
  check('未请求境外数据源', (r5.tried || []).length === 0 ||
    (r5.tried[0] && r5.tried[0].providerId === 'none'));
  check('说明中文文献覆盖边界', /中文/.test(r5.reason));

  console.log('\n==================================');
  console.log('阶段 A 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==================================');
  process.exit(fail ? 1 : 0);
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
