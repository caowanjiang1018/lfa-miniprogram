'use strict';
/**
 * 两段式检索测试（离线，注入传输层）
 * ============================================================================
 * 验收点（对应需求）：
 *   ① 顺序固定：先【宽松】再【精确】，宽松只用 search= / query.bibliographic= 传题名，
 *      不带任何字段限定；
 *   ② 精确检索带上标题字段限定 + 作者 + 年份；
 *   ③ 宽松已经拿到合格候选时【不再】浪费一次精确检索；
 *   ④ 宽松没有合格候选时才补精确检索，结果里如实写出「本次检索过程」；
 *   ⑤ 日志 / tried 里能查到本次真正发出去的 query。
 *
 * 全程离线：用 http.setTransport 拦掉真实网络。
 */
var path = require('path');
var http = require(path.join(__dirname, '../cloudfunctions/lfaVerify/lib/http.js'));
var engine = require(path.join(__dirname, '../cloudfunctions/lfaVerify/index.js'));
var openalex = require(path.join(__dirname, '../cloudfunctions/lfaVerify/sources/openalex.js'));
var crossref = require(path.join(__dirname, '../cloudfunctions/lfaVerify/sources/crossref.js'));

var pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  →  ' + extra : '')); }
}
function head(t) { console.log('\n===== ' + t + ' =====\n'); }

/** 构造一次调用：记录所有请求 URL，并按 host 返回不同类型的响应 */
function runWith(opts) {
  var calls = [];
  http.setTransport(function (url, o) {
    calls.push(url);
    var isOa = /api\.openalex\.org/.test(url);
    var body;
    if (isOa) {
      body = { results: opts.oa };
    } else {
      body = { message: { items: opts.cr } };
    }
    return Promise.resolve({
      ok: true, status: 200, raw: JSON.stringify(body),
      requestedAtText: '2026-10-31 00:00:00', ms: 5
    });
  });
  return engine.verifyOne(opts.ref, { timeBudgetMs: 20000, aiExtract: false, aiSearch: false })
    .then(function (res) { http.setTransport(null); return { calls: calls, res: res }; });
}

function oaWork(title, year, author, container) {
  return {
    doi: 'https://doi.org/10.1000/oa-' + encodeURIComponent(title).slice(0, 10),
    display_name: title,
    publication_year: year,
    authorships: [{ author: { display_name: author } }],
    primary_location: { source: { display_name: container } }
  };
}

function crItem(title, year, author, container) {
  return {
    DOI: '10.1000/cr-' + encodeURIComponent(title).slice(0, 10),
    title: [title],
    issued: { 'date-parts': [[year, 1, 1]] },
    author: [{ given: String(author).split(' ')[0], family: String(author).split(' ').pop() }],
    'container-title': [container],
    URL: 'https://api.crossref.org/works/' + encodeURIComponent(title)
  };
}

var TITLE = 'Winter Heating Renovation Effect in Old Residential Areas';

(async function main() {
  console.log('两段式检索测试（离线）');
  console.log('说明：所有响应都是注入的构造数据，不代表真实接口返回。\n');

  /* ---------- 场景 1：宽松就能命中 → 只发一次请求，不再走精确 ---------- */
  head('场景 1：宽松检索就有合格候选');
  {
    var hit = await runWith({
      oa: [oaWork(TITLE, 2020, 'John Smith', 'Building Science')],
      cr: [],
      ref: { doi: '', title: TITLE, authors: 'Smith J', year: '2020', venue: 'Building Science' }
    });
    check('只发了 1 次请求（宽松命中后不再补精确检索）', hit.calls.length === 1,
      String(hit.calls.length) + ' 次：' + JSON.stringify(hit.calls));
    check('第一段用的是 OpenAlex', /api\.openalex\.org/.test(hit.calls[0] || ''), hit.calls[0]);
    check('宽松检索走 search= 入口', /\/works\?search=/.test(hit.calls[0] || ''), hit.calls[0]);
    check('宽松检索【不带】title.search 字段限定', !/title\.search|filter=/.test(hit.calls[0] || ''), hit.calls[0]);
    check('宽松检索【不带】作者/年份参数', !/author|publication_year/.test(decodeURIComponent(hit.calls[0] || '')),
      decodeURIComponent(hit.calls[0] || ''));
    check('query 里就是题名原文', decodeURIComponent((hit.calls[0] || '').split('search=')[1] || '').split('&')[0] === TITLE,
      decodeURIComponent(hit.calls[0] || ''));
    check('结果为 multi_candidate', hit.res.statusKey === 'multi_candidate', hit.res.statusKey);
    check('method 标注为宽松检索', hit.res.method === 'loose-title-search', hit.res.method);
    check('结果里回填了本次 query，便于核对', !!(hit.res.query && hit.res.query === TITLE), hit.res.query);
    check('tried 里也留了 query', !!(hit.res.tried || []).length && hit.res.tried[0].query === TITLE,
      JSON.stringify((hit.res.tried || []).map(function (t) { return t.query; })));
  }

  /* ---------- 场景 2：宽松没有合格候选 → 补一次精确字段检索 ---------- */
  head('场景 2：宽松没命中，补充精确字段检索');
  {
    /* 返回的记录与输入毫无关系 → 信息校验匹配判不合格 */
    var miss = await runWith({
      oa: [oaWork('Completely unrelated article about frogs', 1999, 'Nobody Here', 'Other Journal')],
      cr: [crItem('Another unrelated paper on bananas', 2005, 'Someone Else', 'Different Journal')],
      ref: { doi: '', title: TITLE, authors: 'Smith J', year: '2020', venue: 'Building Science' }
    });
    var oaCalls = miss.calls.filter(function (u) { return /openalex/.test(u); });
    var crCalls = miss.calls.filter(function (u) { return /crossref/.test(u); });

    check('OpenAlex 发了两段（宽松 + 精确）', oaCalls.length === 2, JSON.stringify(oaCalls.map(decodeURIComponent)));
    check('① 宽松先发：走 search= 且无字段限定',
      /\/works\?search=/.test(oaCalls[0] || '') && !/title\.search/.test(oaCalls[0] || ''), decodeURIComponent(oaCalls[0] || ''));
    var oaSecond = decodeURIComponent(oaCalls[1] || '');
    check('② 精确后发：带 title.search', /filter=title\.search:/.test(oaSecond), oaSecond);
    check('② 精确带作者限定 raw_author_name.search', /raw_author_name\.search:/.test(oaSecond), oaSecond);
    check('② 精确带年份限定 publication_year', /publication_year:2020/.test(oaSecond), oaSecond);

    check('Crossref 同样发了两段', crCalls.length === 2, JSON.stringify(crCalls.map(decodeURIComponent)));
    check('Crossref ① 宽松走 query.bibliographic= 且无字段限定',
      /query\.bibliographic=/.test(crCalls[0] || '') && !/query\.title=/.test(crCalls[0] || ''), decodeURIComponent(crCalls[0] || ''));
    var crSecond = decodeURIComponent(crCalls[1] || '');
    check('Crossref ② 精确走 query.title=', /query\.title=/.test(crSecond), crSecond);
    check('Crossref ② 精确带 query.author=', /query\.author=/.test(crSecond), crSecond);
    check('Crossref ② 精确带出版年区间 filter', /from-pub-date:2020-01-01/.test(crSecond) && /until-pub-date:2020-12-31/.test(crSecond), crSecond);

    check('最终状态为 not_indexed（不是网络异常）', miss.res.statusKey === 'not_indexed', miss.res.statusKey);
    check('method 标注为精确检索', miss.res.method === 'precise-field-search', miss.res.method);
    check('结论里如实写出本次检索过程', /本次检索过程/.test(miss.res.reason || ''), (miss.res.reason || '').slice(-160));
    check('过程里写明了「没有一条通过信息校验匹配」', /没有一条通过信息校验匹配/.test(miss.res.reason || ''));
  }

  /* ---------- 场景 3：精确检索才能救回的条目（近似题名 + 同名文献） ---------- */
  head('场景 3：宽松返回的是同名混淆条目，精确检索救回正确条目');
  {
    /* 宽松返回一堆毫不相干的；精确返回真正对得上的那条 */
    http.setTransport(function (url) {
      var isPrecise = /title\.search|query\.title/.test(decodeURIComponent(url));
      var isOa = /api\.openalex\.org/.test(url);
      var body = isOa
        ? { results: isPrecise ? [oaWork(TITLE, 2020, 'John Smith', 'Building Science')]
          : [oaWork('A commentary on heating retrofit', 2020, 'Another Person', 'Building Science')] }
        : { message: { items: [] } };
      return Promise.resolve({ ok: true, status: 200, raw: JSON.stringify(body), requestedAtText: 't', ms: 3 });
    });
    var saved = await engine.verifyOne(
      { doi: '', title: TITLE, authors: 'Smith J', year: '2020', venue: 'Building Science' },
      { timeBudgetMs: 20000, aiExtract: false, aiSearch: false }
    );
    http.setTransport(null);
    check('最终给出候选（精确检索救回）', saved.statusKey === 'multi_candidate', saved.statusKey);
    check('候选是真正对得上的那条', (saved.candidates || []).length === 1 && saved.candidates[0].title === TITLE,
      JSON.stringify((saved.candidates || []).map(function (c) { return c.title; })));
    check('method 标注为精确检索', saved.method === 'precise-field-search', saved.method);
  }

  /* ---------- 场景 4：缺作者/年份时，精确检索只退化到还能用的限定项 ---------- */
  head('场景 4：缺作者或年份时的降级');
  {
    /* 构造：OpenAlex 精确 URL 应只含 title.search（没有 author / year） */
    http.setTransport(function (url) {
      var isOa = /api\.openalex\.org/.test(url);
      return Promise.resolve({
        ok: true, status: 200,
        raw: JSON.stringify(isOa ? { results: [] } : { message: { items: [] } }),
        requestedAtText: 't', ms: 2
      });
    });
    /* 只能用 require-able 的直接调用来观察 URL */
    var preciseUrl = '';
    http.setTransport(function (url) {
      if (/api\.openalex\.org/.test(url) && /filter=title\.search/.test(decodeURIComponent(url))) preciseUrl = decodeURIComponent(url);
      var isOa = /api\.openalex\.org/.test(url);
      return Promise.resolve({
        ok: true, status: 200,
        raw: JSON.stringify(isOa ? { results: [] } : { message: { items: [] } }),
        requestedAtText: 't', ms: 2
      });
    });
    await engine.verifyOne({ doi: '', title: TITLE, authors: '', year: '', venue: '' },
      { timeBudgetMs: 20000, aiExtract: false, aiSearch: false });
    http.setTransport(null);
    check('没有作者/年份时，精确检索只保留标题限定（不传空参数）',
      /filter=title\.search:/.test(preciseUrl) && !/author\.search|publication_year/.test(preciseUrl), preciseUrl);
  }

  /* ---------- 场景 5：题名清洗 ---------- */
  head('场景 5：题名清洗（去掉辅助标点，保留原词序）');
  {
    check('去掉方括号与多余标点',
      openalex.cleanTitleWords('基于能耗监测的老旧小区供暖改造效果评估[J]. 建筑科学, 2020, 36(2): 45-52') ===
      '基于能耗监测的老旧小区供暖改造效果评估 J . 建筑科学 2020 36 2 45-52'.replace(/(\d) (\d)/g, '$1 $2')
        .replace(/\s+/g, ' '),
      openalex.cleanTitleWords('基于能耗监测的老旧小区供暖改造效果评估[J]. 建筑科学, 2020, 36(2): 45-52'));
    check('逗号被当作分隔符清掉', !/[，,]/.test(openalex.cleanTitleWords('Energy, buildings and people')),
      openalex.cleanTitleWords('Energy, buildings and people'));
    check('取第一作者（多人只取一个，避免漏召回）',
      openalex.firstAuthor({ authors: '张三; 李四; 王五' }) === '张三',
      openalex.firstAuthor({ authors: '张三; 李四; 王五' }));
    check('四位年份提取', openalex.year4({ year: '2020年' }) === '2020', openalex.year4({ year: '2020年' }));
    check('Crossref 清洗与 OpenAlex 一致',
      crossref.cleanTitleWords('Deep residual learning [C]// CVPR. 2016') === openalex.cleanTitleWords('Deep residual learning [C]// CVPR. 2016'),
      crossref.cleanTitleWords('Deep residual learning [C]// CVPR. 2016'));
  }

  console.log('\n==================================');
  console.log('两段式检索测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==================================');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
