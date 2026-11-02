'use strict';
/**
 * 云函数入口集成测试
 * ------------------------------------------------------------
 * 直接调用 exports.main（前端 wx.cloud.callFunction 实际执行的入口），
 * 验证 5 类状态、降级顺序、日志留存与「不伪造成功」的硬性要求。
 *
 * 运行：node tests/cloud-entry-test.js [--record]
 */

var path = require('path');
var recorder = require('./helpers/recorder.js');

var CF = path.resolve(__dirname, '../cloudfunctions/lfaVerify');
var http = require(path.join(CF, 'lib/http.js'));
var fn = require(path.join(CF, 'index.js'));

var RECORD = process.argv.indexOf('--record') > -1;
var pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  << ' + detail : '')); }
}

function call(payload) {
  return Promise.resolve(fn.main(payload, {}));
}

async function main() {
  /* ---------- ping ---------- */
  console.log('\n===== 入口自检 ping =====');
  var p = await call({ action: 'ping' });
  console.log('  ' + JSON.stringify(p));
  check('ping 返回 ok', p && p.ok === true);
  check('ping 声明数据源顺序 openalex → crossref',
    p.sources && p.sources[0] === 'openalex' && p.sources[1] === 'crossref',
    JSON.stringify(p.sources));

  /* ---------- 参数缺失 ---------- */
  console.log('\n===== 参数缺失：应如实报错，不伪造 =====');
  var bad = await call({ action: 'verify' });
  check('缺少 ref 时返回 network_error', bad.statusKey === 'network_error', bad.statusKey);
  check('缺少 ref 时不返回 verified', bad.statusKey !== 'verified');

  /* ---------- 5 类状态（真实请求）---------- */
  console.log('\n===== 5 类核验状态（真实接口请求）=====');
  http.setTransport(recorder.createTransport(RECORD));

  var t1 = await call({
    action: 'verify',
    ref: {
      doi: '10.1038/nature14539',
      title: 'Deep learning',
      authors: 'LeCun Y, Bengio Y, Hinton G',
      year: '2015', venue: 'Nature'
    }
  });
  console.log('  [1] 一致 → ' + t1.statusText + '（' + t1.colorHint + '）');
  check('[1] verified（题录已核验无误/绿色）',
    t1.statusKey === 'verified' && t1.colorHint === '绿色', t1.statusKey);

  await delay(1200);

  var t2 = await call({
    action: 'verify',
    ref: {
      doi: '10.1038/nature14539',
      title: 'A completely unrelated study of solar panel soiling',
      authors: 'Nobody Here',
      year: '1999', venue: 'Journal of Nothing'
    }
  });
  console.log('  [2] 冲突 → ' + t2.statusText + '（' + t2.colorHint + '）');
  check('[2] conflict（题录字段冲突/橙色）',
    t2.statusKey === 'conflict' && t2.colorHint === '橙色', t2.statusKey);

  await delay(1200);

  var t3 = await call({
    action: 'verify',
    ref: {
      doi: '10.1016/j.enbuild.2020.110123',
      title: 'Retrofit of district heating in old residential areas',
      authors: 'Zhang San', year: '2020', venue: 'Energy and Buildings'
    },
    allowSearch: false
  });
  console.log('  [3] 未收录 → ' + t3.statusText + '（' + t3.colorHint + '）');
  check('[3] not_indexed（公开元数据库未收录/灰色）',
    t3.statusKey === 'not_indexed' && t3.colorHint === '灰色', t3.statusKey);
  check('[3] 明确说明不等于文献不存在', /不等于/.test(t3.reason));

  await delay(1200);

  var t4 = await call({
    action: 'verify',
    ref: {
      doi: '',
      title: 'Machine learning for building energy prediction',
      authors: 'Ji, Yu', year: '2025', venue: 'Journal of Building Engineering'
    }
  });
  console.log('  [4] 多候选 → ' + t4.statusText + '（' + t4.colorHint + '）');
  check('[4] 状态属于 multi_candidate / not_indexed / network_error 之一',
    ['multi_candidate', 'not_indexed', 'network_error'].indexOf(t4.statusKey) > -1, t4.statusKey);
  if (t4.statusKey === 'multi_candidate') {
    check('[4] 黄色', t4.colorHint === '黄色');
    check('[4] 未自动选定第一条（record 为空）', t4.record === null);
  }

  await delay(1200);

  /* ---------- 断网：禁止伪造成功 ---------- */
  console.log('\n===== 断网 / 限流：必须如实报错 =====');
  http.setTransport(function () {
    return Promise.resolve({
      ok: false, status: 0, raw: '', body: null,
      requestedAtText: fmtNow(), failureKind: 'ratelimit',
      failureDetail: 'HTTP 429：配额耗尽（模拟）'
    });
  });
  var t5 = await call({
    action: 'verify',
    ref: { doi: '10.1038/nature14539', title: 'Deep learning', authors: 'LeCun Y', year: '2015', venue: 'Nature' },
    allowSearch: false
  });
  console.log('  [5] 网络异常 → ' + t5.statusText + '（' + t5.colorHint + '）');
  check('[5] network_error', t5.statusKey === 'network_error', t5.statusKey);
  check('[5] 灰色', t5.colorHint === '灰色');
  check('[5] 不伪造为已核验', t5.statusKey !== 'verified');
  check('[5] 记录了失败原因', !!t5.failure && !!t5.failure.detail);
  check('[5] 无来源原始返回（确实没拿到数据）', !t5.rawPayload);

  /* ---------- 中文文献 ---------- */
  console.log('\n===== 中文文献：不请求境外源 =====');
  var hits = [];
  http.setTransport(function (url) {
    hits.push(url);
    return Promise.resolve({
      ok: false, status: 0, raw: '', body: null,
      requestedAtText: fmtNow(), failureKind: 'network',
      failureDetail: '测试断言：中文文献不应发起外部请求'
    });
  });
  var t6 = await call({
    action: 'verify',
    ref: {
      doi: '',
      title: '北方老旧小区围护结构改造节能效果分析',
      authors: '王强, 李敏', year: '2021', venue: '建筑节能'
    }
  });
  console.log('  [6] → ' + t6.statusText + '（' + t6.colorHint + '）');
  check('[6] not_indexed', t6.statusKey === 'not_indexed', t6.statusKey);
  check('[6] 未发起任何外部请求', hits.length === 0, '发起了 ' + hits.length + ' 次');

  console.log('\n==================================');
  console.log('云函数入口测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
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
