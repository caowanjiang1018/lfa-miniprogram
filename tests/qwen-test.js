'use strict';
/**
 * 通义千问（DashScope）接入测试
 * ============================================================================
 * 覆盖：
 *   任务 A  结构化提取（中文烂文本 / 英文烂文本 / 无凭证 / 非法 JSON 容错）
 *   任务 B  联网检索兜底（真实联网 / 链接合法性过滤 / 解析失败如实上报）
 *   串行编排 A → OpenAlex/Crossref → B（命中不调 B / 未命中调 B / 中文跳过境外源）
 *   时间预算（预算不足时不发起请求，如实标注）
 *
 * 真实性说明：
 *   - 首次运行加 --record 会真实调用 DashScope，响应落盘到 probe/fixtures/qw_*.json，
 *     之后离线回放。测试用例中的文献题录里，「张三/李四/王五《基于能耗监测的…》」
 *     是【人为构造】的测试样本（真实存在的建筑科学期刊 + 虚构作者与标题），
 *     用于验证模型在查不到时能否如实返回 not found —— 不是真实文献。
 *   - 测试脚本不会把任何 API key 写入文件；回放模式不需要真实 key。
 *
 * 用法：node tests/qwen-test.js [--record]
 */
var path = require('path');
var http = require(path.join(__dirname, '../cloudfunctions/lfaVerify/lib/http.js'));
var qwen = require(path.join(__dirname, '../cloudfunctions/lfaVerify/sources/qwen.js'));
var engine = require(path.join(__dirname, '../cloudfunctions/lfaVerify/index.js'));
var openalex = require(path.join(__dirname, '../cloudfunctions/lfaVerify/sources/openalex.js'));
var qrec = require(path.join(__dirname, 'helpers/qwen-recorder.js'));
var rec = require(path.join(__dirname, 'helpers/recorder.js'));

var RECORD = process.argv.indexOf('--record') >= 0;
var REAL_KEY = process.env.QWEN_API_KEY || '';

/* 回放模式也要让 available() 为真，否则代码会走「未配置」分支而不是真实逻辑。
 * 传输层被注入，因此不会真的带着这个占位 key 发请求。 */
process.env.QWEN_API_KEY = REAL_KEY || 'test-placeholder-key';
process.env.QWEN_MODEL_EXTRACT = process.env.QWEN_MODEL_EXTRACT || 'qwen-flash';
process.env.QWEN_MODEL_SEARCH = process.env.QWEN_MODEL_SEARCH || 'qwen-plus';

var postT = qrec.createTransport(RECORD);
var getT = rec.createTransport(false);       // 学术库沿用已录制的 fixture，不重复消耗额度
var spy = { calls: [] };
http.setTransport(qrec.combine(getT, postT, spy));

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function head(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length))); }

var MESSY_CN = '张三;李四;王五.基于能耗监测的老旧小区冬季供暖改造效果评估研究[J]建筑科学2020年36卷2期45-52页';
var MESSY_EN = 'lecun y bengio y hinton g deep learning nature 2015 521 436 444';

async function main() {
  console.log('通义千问接入测试' + (RECORD ? '（真实录制模式）' : '（离线回放模式）'));
  console.log('说明：题录「张三/李四/王五《基于能耗监测的…》」是人为构造的测试样本，不是真实文献。');

  /* ================= 任务 A ================= */
  head('任务 A：结构化提取');

  var ex = await qwen.extract(MESSY_CN, { timeout: 15000 });
  ok(ex.ok, 'A1 中文烂文本提取调用成功', ex.failureDetail);
  if (ex.ok) {
    var f = ex.fields;
    ok(!!f.title && /^[A-Za-z0-9 ,:()\-]+$/.test(f.title), 'A2 中文题名被译为英文（适合学术检索）', f.title);
    ok(f.titleOrig.indexOf('老旧小区') >= 0, 'A3 保留中文原题名', f.titleOrig);
    ok(f.authors.length === 3, 'A4 拆出 3 位作者', JSON.stringify(f.authors));
    ok(f.year === '2020', 'A5 年份提取正确', f.year);
    ok(!!f.venue && /Building Science/i.test(f.venue), 'A6 期刊名给出英文译名', f.venue);
    ok(f.doi === '', 'A7 原文无 DOI 时不编造', JSON.stringify(f.doi));
    ok(f.lang === 'zh', 'A8 语种判定为 zh', f.lang);
    ok(f.confidence != null, 'A9 返回把握度', String(f.confidence));
  }
  console.log('    提取结果：' + JSON.stringify(ex.fields && {
    title: ex.fields.title, authors: ex.fields.authors,
    year: ex.fields.year, venue: ex.fields.venue
  }));

  var ex2 = await qwen.extract(MESSY_EN, { timeout: 15000 });
  ok(ex2.ok, 'A10 英文烂文本提取成功', ex2.failureDetail);
  if (ex2.ok) {
    ok(/deep learning/i.test(ex2.fields.title), 'A11 还原出英文题名', ex2.fields.title);
    ok(ex2.fields.authors.length >= 3, 'A12 拆出作者', JSON.stringify(ex2.fields.authors));
    ok(ex2.fields.year === '2015', 'A13 年份正确', ex2.fields.year);
    ok(/nature/i.test(ex2.fields.venue), 'A14 期刊名正确', ex2.fields.venue);
  }

  var exEmpty = await qwen.extract('', {});
  ok(!exEmpty.ok && exEmpty.failureKind === 'input', 'A15 原文为空时不调用接口，如实报 input 失败');

  /* JSON 容错：模型输出带代码块 / 前后废话 */
  var loose1 = qwen.parseJsonLoose('```json\n{"a":1,"b":[1,2]}\n```');
  ok(loose1 && loose1.a === 1, 'A16 能剥掉 ```json 代码块');
  var loose2 = qwen.parseJsonLoose('好的，结果如下：\n{"title_en":"X"}');
  ok(loose2 && loose2.title_en === 'X', 'A17 能剥掉前后废话');
  ok(qwen.parseJsonLoose('完全没有 JSON') === null, 'A18 纯文本返回 null（不硬凑）');

  /* 无凭证 */
  var savedKey = process.env.QWEN_API_KEY;
  delete process.env.QWEN_API_KEY;
  var before = spy.calls.length;
  var exNoKey = await qwen.extract(MESSY_CN, { timeout: 8000 });
  ok(!exNoKey.ok && exNoKey.failureKind === 'config', 'A19 未配置 key 时返回 config 失败');
  ok(spy.calls.length === before, 'A20 未配置 key 时【零网络请求】');
  ok(!qwen.available(), 'A21 available() 正确反映未配置');
  process.env.QWEN_API_KEY = savedKey;

  /* ================= 任务 B ================= */
  head('任务 B：联网检索兜底');

  var sv = await qwen.searchVerify({
    title: '基于能耗监测的老旧小区冬季供暖改造效果评估研究',
    authors: '张三; 李四; 王五', year: '2020', venue: '建筑科学',
    volume: '36', issue: '2', pages: '45-52', raw: MESSY_CN
  }, { timeout: 20000 });
  var noFixture = (!sv.ok && sv.failureKind === 'no_fixture');
  if (noFixture) {
    /* 任务 B 的 prompt 这次改动较大（新增 recordMeta 字段），离线 fixture 已失效。
     * 没有真实 API key 时不去编一个响应来骗自己通过，如实跳过并说明原因。
     * 结构正确性由下面「注入响应体」的离线用例（B21 起）完整覆盖。 */
    console.log('  ⚠ 跳过 B1–B5：本次请求没有可用的离线录制（prompt 已变更），' +
      '需要真实 API key 后执行 node tests/qwen-test.js --record 重新录制。');
    console.log('    → ' + sv.failureDetail);
  } else {
    ok(sv.ok, 'B1 联网检索调用成功', sv.failureDetail);
    if (sv.ok) {
      ok(!!sv.verdict, 'B2 解析出结论对象');
      ok(['yes', 'no', 'uncertain'].indexOf(sv.verdict.exists) >= 0, 'B3 exists 取值合法', sv.verdict.exists);
      var allHttp = sv.verdict.candidateLinks.every(function (l) { return /^https?:\/\//i.test(l.url); });
      ok(allHttp, 'B4 所有链接都是 http(s)（过滤掉拼凑的裸字符串）',
        JSON.stringify(sv.verdict.candidateLinks.map(function (l) { return l.url; })));
      ok(sv.verdict.candidateLinks.length <= 6, 'B5 链接不超过 6 条', String(sv.verdict.candidateLinks.length));
      console.log('    模型回答：exists=' + sv.verdict.exists + '｜链接 ' + sv.verdict.candidateLinks.length +
        ' 条｜真的触发联网搜索=' + sv.searched + '（searchCount=' + sv.searchCount + '）');
      console.log('    结果状态：' + sv.verdict.outcome + '（' + (qwen.OUTCOME_TEXT[sv.verdict.outcome] || '') + '）');
      if (sv.verdict.exists === 'yes' && sv.verdict.candidateLinks.length) {
        console.log('    ！注意：模型对这条构造题录判了 yes，正好验证「必须人工甄别」的设计必要性');
      }
    }
  }

  /* 链接过滤：伪造非 http 的 url */
  var vv = qwen.normVerdict({
    exists: 'yes',
    links: [{ url: 'https://example.com/a', kind: 'official', note: 'x' },
      { url: 'www.bad.com/b', kind: 'cnki', note: '不是合法 url' },
      { url: '10.1000/xyz', kind: 'other', note: 'DOI 当链接' }],
    year: '二〇二〇年', doi: 'not-a-doi', confidence: 95
  });
  ok(vv.candidateLinks.length === 1, 'B6 非法 / 拼凑链接被过滤，只留 1 条', JSON.stringify(vv.candidateLinks));
  ok(vv.year === '2020', 'B7 中文年份归一化为四位', vv.year);
  ok(vv.doi === '', 'B8 非法 DOI 被清空', JSON.stringify(vv.doi));
  ok(vv.confidence === 0.95, 'B9 把握度 95 归一化为 0.95', String(vv.confidence));

  /* 解析失败：注入一个返回非 JSON 的响应 */
  http.setTransport(function (url, opt) {
    return Promise.resolve({
      ok: true, status: 200,
      raw: JSON.stringify({ output: { choices: [{ message: { content: '抱歉，我无法完成这个请求。' } }] } }),
      requestedAtText: '2026-10-31 00:00:00', ms: 10
    });
  });
  var bad = await qwen.searchVerify({ title: 'X' }, { timeout: 5000 });
  ok(!bad.ok && bad.failureKind === 'parse', 'B10 模型返回非 JSON 时如实报 parse 失败（不伪造结果）');
  http.setTransport(qrec.combine(getT, postT, spy));

  /* ------- 链接治理（2026-10-31 新增）：光靠模型自觉挡不住假链接 ------- */
  head('链接治理：禁止编造 / 必须能说清来源 / 没有就标 url_not_found');

  var vg = qwen.normVerdict({
    exists: 'yes',
    sources: [
      { name: 'CVPR Open Access', url: 'https://openaccess.thecvf.com/content_cvpr_2016/html/He_X_CVPR_2016_paper.html' }
    ],
    links: [
      /* 合格：域名在声明的来源里 + 详情页形态 + 来源名 */
      { url: 'https://openaccess.thecvf.com/content_cvpr_2016/html/He_X_CVPR_2016_paper.html', source: 'CVPR Open Access', kind: 'publisher', note: '官网' },
      /* 域名不在本次声明的来源里 —— 说不清出处，疑为编造 */
      { url: 'https://www.sciencep.com/book/4050', source: '科学出版社', kind: 'publisher', note: '出版社页' },
      /* 站点首页，不是详情页 */
      { url: 'https://openaccess.thecvf.com/', source: 'CVPR', kind: 'publisher', note: '首页' },
      /* 检索结果页，不是详情页 */
      { url: 'https://openaccess.thecvf.com/search?q=deep', source: 'CVPR', kind: 'publisher', note: '检索页' },
      /* 路径含 10 位以上连续数字 —— 凭空生成的编号的典型特征 */
      { url: 'https://openaccess.thecvf.com/book/1023456789', source: 'CVPR', kind: 'publisher', note: '编号页' }
    ],
    linkStatus: 'ok'
  });
  ok(vg.candidateLinks.length === 1, 'B11 只保留「说得清来源 + 详情页形态」的链接，其余全部丢弃',
    JSON.stringify(vg.candidateLinks.map(function (l) { return l.url; })));
  ok(vg.candidateLinks[0] && vg.candidateLinks[0].source === 'CVPR Open Access', 'B12 链接带上来源名称', JSON.stringify(vg.candidateLinks[0]));
  ok(vg.linkStatus === 'ok', 'B13 有合格链接时 linkStatus=ok', vg.linkStatus);
  var reasons = (vg.linkAudit || []).filter(function (a) { return !a.kept; }).map(function (a) { return a.reason; }).join(' | ');
  ok(/疑似编造/.test(reasons) && /首页/.test(reasons) && /检索结果页/.test(reasons) && /连续数字/.test(reasons),
    'B14 每条被丢弃的链接都留了具体原因（便于人工排查）', reasons);

  /* 一条都不合格的场景：必须标记 url_not_found，而不是硬塞个地址给用户 */
  var vz = qwen.normVerdict({
    exists: 'yes',
    sources: [{ name: '某个来源', url: 'https://www.example.org/detail/1' }],
    links: [{ url: 'https://www.worldcat.org/title/0123456789', source: 'WorldCat', kind: 'other', note: '书目' }],
    linkStatus: 'ok'
  });
  ok(vz.candidateLinks.length === 0, 'B15 不合格的链接不会出现在结果里', JSON.stringify(vz.candidateLinks));
  ok(vz.linkStatus === 'url_not_found', 'B16 没有可靠链接时如实标记 url_not_found', vz.linkStatus);
  ok(vz.declaredLinkStatus === 'ok', 'B17 保留模型自评 linkStatus，用于核对「模型说有、实际没有」',
    String(vz.declaredLinkStatus));

  /* 可达性探测：明确 404 才算无效，403 / 5xx / 超时 / 网络失败只能算「未能确认」。
   * 线下不做真实联网（测试要可离线跑），只验证函数存在与「拒绝内网地址」这条安全边界。 */
  var h2 = require(path.join(__dirname, '../cloudfunctions/lfaVerify/lib/http.js'));
  ok(typeof h2.probeReachable === 'function', 'B18 提供链接可达性真实探测能力');
  var home = await h2.probeReachable('http://127.0.0.1:9/x', { timeout: 1500 });
  ok(home.kind === 'network' && /内网/.test(home.detail), 'B19 探测拒绝访问内网地址（防被诱导打内网）', JSON.stringify(home));

  /* ================= 结果解耦：recordMeta / candidateLinks ================= */
  /*
   * 这一节全部离线：用 http.setTransport 注入模型响应体（测试构造，非真实返回），
   * 验证「题录」与「链接」两条线真的互不依赖，且状态判定符合需求的三分法。
   */
  head('结果解耦：题录不看链接脸色 / 三种结果状态');

  function injectOnce(content, usage) {
    http.setTransport(function (url, opt) {
      return Promise.resolve({
        ok: true, status: 200,
        raw: JSON.stringify({
          output: { choices: [{ message: { content: content } }] },
          usage: usage || { plugins: { search: { count: 2 } } }
        }),
        requestedAtText: '2026-11-01 09:00:00', ms: 100
      });
    });
  }

  var CVPR_SRC = 'https://openaccess.thecvf.com/content_cvpr_2016/html/He_X_CVPR_2016_paper.html';
  var FULL_ABSTRACT = 'Deeper neural networks are more difficult to train. ' +
    'We present a residual learning framework to ease the training of networks that are substantially deeper.';

  /* ---- ① 查到文献信息 + 有效链接 ---- */
  injectOnce(JSON.stringify({
    exists: 'yes',
    title: 'Deep Residual Learning for Image Recognition',
    authors: ['Kaiming He', 'Xiangyu Zhang'], year: '2016',
    venue: 'CVPR', doi: '10.1109/CVPR.2016.90',
    abstract: FULL_ABSTRACT, sourceName: 'CVPR Open Access',
    sources: [
      { name: 'CVPR Open Access', url: CVPR_SRC },
      { name: '知网', url: 'https://kns.cnki.net/kcms2/article/abstract?v=abc123' }
    ],
    links: [{ url: CVPR_SRC, source: 'CVPR Open Access', kind: 'publisher', note: '官网' }],
    linkStatus: 'ok', summary: '在 CVPR Open Access 找到该文', confidence: 0.9
  }));
  var rFull = await qwen.searchVerify({ title: 'Deep Residual Learning' }, { timeout: 8000, silentLog: true });
  var vFull = rFull.verdict || {};
  ok(vFull.outcome === 'record_and_link', 'B20 有题录 + 有链接 → record_and_link', String(vFull.outcome));
  ok(vFull.recordMeta && vFull.recordMeta.credible, 'B21 recordMeta 被判为可信');
  ok(vFull.recordMeta.title === 'Deep Residual Learning for Image Recognition', 'B22 题名来自本次搜索摘要',
    String(vFull.recordMeta.title));
  ok(vFull.recordMeta.hasAbstract && vFull.recordMeta.abstract === FULL_ABSTRACT,
    'B23 摘要照抄本次搜索摘要（未补齐、未改写）');
  ok(vFull.recordMeta.sourceName === 'CVPR Open Access', 'B24 题录标出了来源名称', String(vFull.recordMeta.sourceName));
  ok(vFull.candidateLinks.length === 1, 'B25 合格链接进主展示区', String(vFull.candidateLinks.length));
  ok(vFull.rawCandidateLinks.length === 2, 'B26 本次搜索的原始 sources 链接全部进入折叠区（2 条）',
    String(vFull.rawCandidateLinks.length));
  ok(vFull.rawCandidateLinks[0].inMain === true && vFull.rawCandidateLinks[1].inMain === false,
    'B27 折叠区标出哪些原始链接已进主展示区', JSON.stringify(vFull.rawCandidateLinks));

  /* ---- ② 查到文献信息，但没有可用链接（链接被全部判为拼凑） ---- */
  injectOnce(JSON.stringify({
    exists: 'yes',
    title: '既有建筑围护结构改造节能效果实测分析',
    authors: ['李明'], year: '2019', venue: '建筑科学', doi: '',
    abstract: '', sourceName: '万方（模型自述）',
    sources: [{ name: '万方', url: 'https://d.wanfangdata.com.cn/periodical/xxx/2019-3' }],
    links: [{ url: 'https://www.worldcat.org/title/0123456789', source: 'WorldCat', kind: 'other', note: '书目' }],
    linkStatus: 'ok', summary: '只在万方摘要页看到条目', confidence: 0.6
  }));
  var rNoLink = await qwen.searchVerify({ title: '既有建筑围护结构改造' }, { timeout: 8000, silentLog: true });
  var vNoLink = rNoLink.verdict || {};
  ok(vNoLink.outcome === 'record_only', 'B28 有题录但零条合格链接 → record_only', String(vNoLink.outcome));
  ok(vNoLink.candidateLinks.length === 0, 'B29 拼凑链接被丢弃（路径 10 位以上数字）',
    String(vNoLink.candidateLinks.length));
  ok(vNoLink.recordMeta.credible && vNoLink.recordMeta.title.indexOf('围护结构') >= 0,
    'B30 【关键】链接全废了，题录照样完整保留');
  ok(vNoLink.recordMeta.hasAbstract === false && vNoLink.recordMeta.abstract === '',
    'B31 来源没给摘要就是没有，系统不撰写摘要', JSON.stringify(vNoLink.recordMeta.abstract));
  ok(vNoLink.recordMeta.fieldsAbsent.indexOf('摘要') >= 0 && vNoLink.recordMeta.fieldsAbsent.indexOf('DOI') >= 0,
    'B32 缺哪些字段如实列出', JSON.stringify(vNoLink.recordMeta.fieldsAbsent));

  /* 结果组装层面：有题录就不许判「未检索到」 */
  var built = engine.buildAiSearchResult(
    { title: '既有建筑围护结构改造' },
    { ok: true, verdict: vNoLink, model: 'qwen-plus', searched: true, searchCount: 2,
      apiUrl: 'https://example.invalid', requestedAt: '2026-11-01 09:00:00', httpStatus: 200, ms: 100 },
    [], '');
  ok(built.statusKey === 'ai_found', 'B33 【关键】有题录无链接时状态仍是 ai_found，不是 ai_not_found', built.statusKey);
  ok(built.aiSearch.outcome === 'record_only', 'B34 结果状态如实标为 record_only', built.aiSearch.outcome);
  ok(/本次检索未找到可稳定访问的原文链接/.test(built.aiSearch.linkStatusText),
    'B35 链接区文案是「未找到可稳定访问的链接」，不是「未检索到该文献」', built.aiSearch.linkStatusText);
  ok(built.aiSearch.linkStatus === 'url_not_found', 'B36 linkStatus 仍如实标 url_not_found（只描述链接）');
  ok(built.aiSearch.recordMeta.credible === true && built.aiSearch.hasRecordMeta === true,
    'B37 核验结果里带上完整 recordMeta 供前端展示');
  ok(built.aiSearch.rawCandidateLinks.length === 1 && built.aiSearch.hasRawCandidateLinks === true,
    'B38 折叠区数据随结果下发', String(built.aiSearch.rawCandidateLinks.length));

  /* ---- ③ 完全没有检索线索 ---- */
  injectOnce(JSON.stringify({
    exists: 'no', title: '', authors: [], year: '', venue: '', doi: '', abstract: '',
    sourceName: '', sources: [], links: [], linkStatus: 'url_not_found',
    summary: '在多个平台检索未见该文', confidence: 0.3
  }));
  var rNone = await qwen.searchVerify({ title: '根本不存在的论文' }, { timeout: 8000, silentLog: true });
  ok(rNone.verdict.outcome === 'no_clue', 'B39 完全无线索 → no_clue', String(rNone.verdict.outcome));
  ok(rNone.verdict.recordMeta.credible === false, 'B40 此时 recordMeta 不可信');
  var builtNone = engine.buildAiSearchResult(
    { title: '根本不存在的论文' },
    { ok: true, verdict: rNone.verdict, model: 'qwen-plus', searched: true, searchCount: 2,
      apiUrl: 'https://example.invalid', requestedAt: '2026-11-01 09:00:00', httpStatus: 200, ms: 100 },
    [], '');
  ok(builtNone.statusKey === 'ai_not_found', 'B41 只有完全无线索时才展示「未检索到」', builtNone.statusKey);

  /* 没真联网的作答不能被当成题录 */
  injectOnce(JSON.stringify({
    exists: 'yes', title: '凭记忆写的题名', authors: ['记忆'], year: '2020', venue: 'X',
    doi: '', abstract: '凭记忆写的摘要', sourceName: '模型记忆', sources: [], links: [],
    linkStatus: 'url_not_found', summary: '', confidence: 0.5
  }), {});   // usage 里没有 plugins.search ⇒ searched=false
  var rNoSearch = await qwen.searchVerify({ title: '某篇论文' }, { timeout: 8000, silentLog: true });
  ok(rNoSearch.verdict.recordMeta.credible === false &&
    /没有触发联网检索/.test(rNoSearch.verdict.recordMeta.reason),
    'B42 没触发联网检索时，模型自述的题录不予采用（按记忆作答不算）', rNoSearch.verdict.recordMeta.reason);

  /* 探测状态映射：只有 404/410 丢弃，403/429/超时/5xx 一律保留并标注 */
  ok(qwen.probeStateOf({ probe: { kind: 'ok' } }) === 'ok', 'B43 探测通过 → 主展示区');
  ok(qwen.probeStateOf({ probe: { kind: 'not_found' } }) === 'dropped', 'B44 明确 404/410 → 丢弃');
  var keepKinds = ['unverified', 'timeout', 'network', 'skipped'];
  ok(keepKinds.every(function (k) { return qwen.probeStateOf({ probe: { kind: k } }) === 'unverified'; }),
    'B45 403/429/5xx/超时/未探测 → unverified（保留展示，标暂无法验证连通性）');
  ok(/暂无法验证/.test(qwen.probeStateTextOf({ probe: { kind: 'timeout' } })),
    'B46 未确认的链接文案是「暂无法验证连通性」', qwen.probeStateTextOf({ probe: { kind: 'timeout' } }));

  /* 输出被截断时抢救题录，而不是整条作废 */
  http.setTransport(function (url, opt) {
    return Promise.resolve({
      ok: true, status: 200,
      raw: JSON.stringify({
        output: { choices: [{ message: { content: '{"exists":"yes","title":"被截断的论文","year":"2021","abstract":"截' } }] },
        finish_reason: 'length',
        usage: { plugins: { search: { count: 1 } } }
      }),
      requestedAtText: '2026-11-01 09:00:00', ms: 100
    });
  });
  var rCut = await qwen.searchVerify({ title: '某论文' }, { timeout: 8000, silentLog: true });
  ok(rCut.truncatedRecovery === true, 'B47 模型输出被截断时进入抢救分支（不整条作废）',
    JSON.stringify(rCut.failureKind || ''));
  ok(rCut.verdict && rCut.verdict.recordMeta.partialRecovery === true &&
    rCut.verdict.recordMeta.title === '被截断的论文',
    'B48 抢救出的题录如实标注 partialRecovery', JSON.stringify(rCut.verdict && rCut.verdict.recordMeta));
  ok(rCut.verdict.outcome === 'record_only', 'B49 截断场景没有链接，状态为 record_only');

  http.setTransport(qrec.combine(getT, postT, spy));

  /* ================= 串行编排 ================= */
  head('串行编排：A → OpenAlex/Crossref → B');

  /* 中文文献：应跳过境外源，直接进任务 B */
  spy.calls = [];
  var zhRes = await engine.verifyOne(
    { raw: MESSY_CN, title: '基于能耗监测的老旧小区冬季供暖改造效果评估研究', authors: '张三; 李四; 王五', year: '2020', venue: '建筑科学' },
    { timeBudgetMs: 15000 }
  );
  var hosts = spy.calls.map(function (c) { return (c.url.match(/https?:\/\/([^/]+)/) || [])[1] || ''; });
  var hitOa = hosts.some(function (h) { return /openalex/.test(h); });
  var hitCr = hosts.some(function (h) { return /crossref/.test(h); });
  ok(!hitOa && !hitCr, 'C1 中文文献未请求 OpenAlex / Crossref', hosts.join(', '));
  ok(hosts.some(function (h) { return /maas\.aliyuncs/.test(h); }), 'C2 调用了千问', hosts.join(', '));
  ok(['ai_found', 'ai_not_found', 'not_indexed'].indexOf(zhRes.statusKey) >= 0,
    'C3 中文文献最终状态为 AI 检索类或未收录', zhRes.statusKey);
  ok(zhRes.aiExtract && zhRes.aiExtract.fields, 'C4 结果里留存了任务 A 的提取字段');
  if (zhRes.aiSearch) {
    ok(zhRes.aiSearch.searched === true || zhRes.aiSearch.searched === false,
      'C5 记录了是否真的触发联网搜索', String(zhRes.aiSearch.searched));
    ok(typeof zhRes.aiSearch.summary === 'string', 'C6 留存了模型给出的依据摘要');
    ok(!!zhRes.rawPayload, 'C7 留存了接口原始返回');
  }
  console.log('    中文条目状态：' + zhRes.statusKey + ' / ' + zhRes.statusText);

  /* 真实 DOI 命中：不应再调任务 B */
  spy.calls = [];
  var hitRes = await engine.verifyOne(
    { raw: MESSY_EN, doi: '10.1038/nature14539', title: 'Deep learning', authors: 'LeCun Y; Bengio Y; Hinton G', year: '2015', venue: 'Nature' },
    { timeBudgetMs: 15000 }
  );
  ok(hitRes.statusKey === 'verified' || hitRes.statusKey === 'conflict',
    'C8 真实 DOI 走学术库并给出结论', hitRes.statusKey + ' / ' + hitRes.statusText);
  ok(!hitRes.aiSearch, 'C9 学术库已命中，【没有】再调千问联网检索', JSON.stringify(hitRes.aiSearch));
  ok(hitRes.provider && hitRes.provider.id !== 'dashscope', 'C10 结论来源是学术库', hitRes.provider && hitRes.provider.id);
  var hosts2 = spy.calls.map(function (c) { return (c.url.match(/https?:\/\/([^/]+)/) || [])[1] || ''; });
  ok(hosts2.some(function (h) { return /maas\.aliyuncs/.test(h); }), 'C11 任务 A（提取）仍作为前置步骤执行了', hosts2.join(', '));

  /* 学术库未命中 → 进入任务 B */
  spy.calls = [];
  var missRes = await engine.verifyOne(
    { raw: 'Fake Author. A Totally Nonexistent Paper About Nothing. Journal of Imaginary Results. 2023.',
      title: 'A Totally Nonexistent Paper About Nothing', authors: 'Fake Author', year: '2023', venue: 'Journal of Imaginary Results' },
    { timeBudgetMs: 15000 }
  );
  console.log('    未命中条目状态：' + missRes.statusKey + ' / ' + missRes.statusText);
  ok(['ai_found', 'ai_not_found', 'multi_candidate', 'not_indexed', 'network_error'].indexOf(missRes.statusKey) >= 0,
    'C12 学术库未命中时状态合法', missRes.statusKey);
  if (missRes.aiSearch) {
    ok(missRes.aiSearch.exists !== undefined, 'C13 未命中时确实进入了任务 B', missRes.aiSearch.exists);
  }

  /* 未配置千问：不调用、如实说明 */
  delete process.env.QWEN_API_KEY;
  spy.calls = [];
  var noKey = await engine.verifyOne(
    { raw: MESSY_CN, title: '基于能耗监测的老旧小区冬季供暖改造效果评估研究', authors: '张三', year: '2020', venue: '建筑科学' },
    { timeBudgetMs: 15000 }
  );
  var hosts3 = spy.calls.map(function (c) { return (c.url.match(/https?:\/\/([^/]+)/) || [])[1] || ''; });
  ok(!hosts3.some(function (h) { return /maas\.aliyuncs/.test(h); }), 'C14 未配置 key 时零千问请求');
  ok(noKey.statusKey === 'not_indexed', 'C15 未配置 key 时仍给出「未收录」而非伪造结论', noKey.statusKey);
  ok(/QWEN_API_KEY/.test(noKey.reason), 'C16 原因里如实说明未配置环境变量');
  process.env.QWEN_API_KEY = savedKey;

  /* 时间预算不足：不发起、如实标注 */
  var tiny = await engine.verifyOne(
    { raw: MESSY_CN, title: '基于能耗监测的老旧小区冬季供暖改造效果评估研究', authors: '张三', year: '2020', venue: '建筑科学' },
    { timeBudgetMs: 300 }
  );
  var anyBudget = (tiny.tried || []).some(function (t) { return t.failureKind === 'budget_exhausted'; });
  ok(['ai_found', 'ai_not_found', 'not_indexed'].indexOf(tiny.statusKey) >= 0, 'C17 极小预算下仍返回合法状态', tiny.statusKey);
  ok(anyBudget || /剩余执行时间|预算/.test(tiny.reason), 'C18 预算不足被如实记录/说明', tiny.reason.slice(0, 120));

  /* ================= 结构对齐 ================= */
  head('返回结构对齐（前端无需改解析）');
  var keys = ['ok', 'statusKey', 'statusText', 'statusDesc', 'colorHint', 'tone', 'label',
    'reason', 'provider', 'method', 'record', 'rawPayload', 'checks', 'candidates', 'tried', 'input'];
  var sample = zhRes.statusKey.indexOf('ai_') === 0 ? zhRes : missRes;
  var missing = keys.filter(function (k) { return !(k in sample); });
  ok(missing.length === 0, 'D1 AI 结果包含与学术库结果完全一致的外壳字段', '缺少：' + missing.join(','));
  ok(typeof sample.tone === 'string' && typeof sample.colorHint === 'string', 'D2 文字 + 颜色双标识齐备');
  ok(Array.isArray(sample.tried) && Array.isArray(sample.candidates), 'D3 tried / candidates 为数组');
  ok(sample.statusKey !== 'verified', 'D4 千问结果【绝不】被标为「题录已核验无误」', sample.statusKey);

  console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试异常：', e && e.stack || e);
  process.exit(1);
});
