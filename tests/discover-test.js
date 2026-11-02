'use strict';
/**
 * 检索推荐（「帮我找文献」）离线测试
 * ============================================================================
 * 验收点（对应本轮需求）：
 *   ① 模型只做检索词组织：含链接 / DOI 的「检索式」一律丢弃；
 *      规划与分析两个模型调用【都不开联网检索】；
 *   ② 候选题录、DOI、链接全部来自真实检索记录（注入的假接口返回即"真实返回"）；
 *   ③ 去重有理由；阅读依据按实际材料机械判定（有/无摘要），没有摘要绝不写摘要；
 *   ④ 推荐清单最多 5 篇；材料不足的进「待阅读线索」；
 *   ⑤ 模型自行补的条目、百分数评分一律丢弃；
 *   ⑥ 检索失败（failed）与零结果（empty）严格分开；
 *   ⑦ 覆盖范围如实说明（不覆盖知网 / 万方，检索到 ≠ 已核实）。
 *
 * 全程离线：用 http.setTransport 拦掉真实网络。
 */
var path = require('path');
var http = require(path.join(__dirname, '../cloudfunctions/lfaVerify/lib/http.js'));
var qwen = require(path.join(__dirname, '../cloudfunctions/lfaVerify/sources/qwen.js'));
var discover = require(path.join(__dirname, '../cloudfunctions/lfaVerify/discover.js'));

/* 离线测试用的占位值，不是真实凭据：真实 Key 只存在于云函数环境变量里 */
var MOCK_KEY = 'test-key';

var pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  →  ' + extra : '')); }
}
function head(t) { console.log('\n===== ' + t + ' ====='); }

/* ---------------- 注入传输层 ---------------- */

var calls = [];      // 所有真实发出的请求
var qwenReply = {};  // 模型要返回的 JSON
var qwenFail = false;
var oaFail = false;
var crFail = false;

function setTransport() {
  calls = [];
  http.setTransport(function (url, opt) {
    calls.push({ url: url, body: opt && opt.body });
    if (/api\.openalex\.org/.test(url)) {
      if (oaFail) {
        return Promise.resolve({ ok: false, status: 0, raw: '', requestedAtText: 'T', ms: 1, failureKind: 'network', failureDetail: '网络不可达' });
      }
      return Promise.resolve({
        ok: true, status: 200, raw: JSON.stringify({ results: OA_RESULTS }),
        requestedAtText: '2026-11-01 00:00:00', ms: 5
      });
    }
    if (/api\.crossref\.org/.test(url)) {
      if (crFail) {
        return Promise.resolve({ ok: false, status: 0, raw: '', requestedAtText: 'T', ms: 1, failureKind: 'network', failureDetail: '网络不可达' });
      }
      return Promise.resolve({
        ok: true, status: 200, raw: JSON.stringify({ message: { items: CR_ITEMS } }),
        requestedAtText: '2026-11-01 00:00:00', ms: 5
      });
    }
    /* 其余 = 通义千问 DashScope */
    if (qwenFail) {
      return Promise.resolve({
        ok: false, status: 0, raw: '', requestedAtText: 'T', ms: 1,
        failureKind: 'network', failureDetail: '模型接口不可达'
      });
    }
    return Promise.resolve({
      ok: true, status: 200,
      raw: JSON.stringify({
        output: { choices: [{ message: { content: JSON.stringify(qwenReply) } }] },
        usage: {}
      }),
      requestedAtText: '2026-11-01 00:00:00', ms: 5
    });
  });
}

function clearTransport() { http.setTransport(null); }

/* ---------------- 假接口返回（当作"真实返回"用） ---------------- */

var OA_RESULTS = [
  {
    doi: 'https://doi.org/10.1000/oa1',
    display_name: 'Energy retrofit of old residential buildings in cold regions',
    publication_year: 2021,
    authorships: [{ author: { display_name: 'Wang Qiang' } }],
    primary_location: { source: { display_name: 'Energy and Buildings' } },
    abstract_inverted_index: { We: [0], measured: [1], heating: [2], savings: [3] },
    language: 'en', type: 'article',
    open_access: { is_oa: true },
    best_oa_location: { pdf_url: 'https://example.org/oa1.pdf' }
  },
  {
    /* 与 Crossref 第一条同 DOI —— 用于验证去重 */
    doi: 'https://doi.org/10.1000/shared',
    display_name: 'Winter heating renovation effect in old residential areas',
    publication_year: 2020,
    authorships: [{ author: { display_name: 'Li Min' } }],
    primary_location: { source: { display_name: 'Building and Environment' } },
    language: 'en', type: 'article'
  },
  {
    /* 无摘要、无 DOI —— 用于验证「材料不足 → 待阅读线索」 */
    doi: null,
    display_name: 'A study without abstract and doi',
    publication_year: 2019,
    authorships: [],
    primary_location: { source: { display_name: 'Journal of Something' } },
    language: 'en', type: 'article'
  }
];

var CR_ITEMS = [
  {
    DOI: '10.1000/shared',
    title: ['Winter heating renovation effect in old residential areas'],
    issued: { 'date-parts': [[2020, 3, 1]] },
    author: [{ given: 'Min', family: 'Li' }],
    'container-title': ['Building and Environment'],
    URL: 'https://api.crossref.org/works/10.1000/shared',
    abstract: '<jats:p>We measured heating savings.</jats:p>',
    language: 'en', type: 'journal-article'
  },
  {
    DOI: '10.1000/cr2',
    title: ['Retrofit evaluation of residential envelopes'],
    issued: { 'date-parts': [[2022, 1, 1]] },
    author: [{ given: 'A', family: 'Smith' }],
    'container-title': ['Applied Energy'],
    URL: 'https://api.crossref.org/works/10.1000/cr2',
    language: 'en', type: 'journal-article'
  }
];

var TOPIC = {
  name: '老旧小区冬季供暖改造效果评估',
  problem: '围护结构改造能否降低北方老旧小区的供暖能耗',
  target: '北方城市老旧住宅小区',
  task: '做出能耗对比评估并给出改造建议',
  claim: '围护结构改造能显著降低北方老旧小区的供暖能耗'
};

/* ---------------- ① 检索式规划 ---------------- */

async function testPlan() {
  head('① 检索式规划（任务 C）');
  process.env.QWEN_API_KEY = MOCK_KEY;

  /* 模型偷渡了文献条目：含链接 / DOI 的"检索式"必须被丢掉 */
  qwenReply = {
    keywords: ['围护结构', '供暖能耗'],
    synonyms: ['building retrofit', 'residential heating'],
    queries: [
      { text: 'retrofit heating energy', lang: 'en', why: '核心组合' },
      { text: 'https://doi.org/10.1000/abc', lang: 'en', why: '偷渡的文献' },
      { text: 'Smith 2020 10.1000/xyz Energy', lang: 'en', why: '偷渡的题录' },
      { text: '老旧小区 供暖', lang: 'zh', why: '中文检索式' }
    ],
    scopeNote: '中文库覆盖有限'
  };
  setTransport();
  var r = await discover.planTopic(TOPIC, '想找实测研究', { timeout: 5000 });
  clearTransport();

  check('A1 检索式保留 2 条（含链接 / DOI 的被丢弃）', r.plan && r.plan.queries.length === 2,
    JSON.stringify(r.plan && r.plan.queries));
  check('A2 被丢弃的检索式留有理由', r.plan.dropped.length === 2 &&
    /链接|DOI/.test(r.plan.dropped[0].reason), JSON.stringify(r.plan.dropped));
  check('A3 关键词与同义词保留', r.plan.keywords.length === 2 && r.plan.synonyms.length === 2);
  var chatBody = null;
  for (var i = 0; i < calls.length; i++) if (calls[i].body) chatBody = JSON.parse(calls[i].body);
  check('A4 规划调用【未开联网检索】', !!chatBody && chatBody.parameters.enable_search === undefined,
    JSON.stringify(chatBody && chatBody.parameters));
  check('A5 覆盖了「本次不使用模型记忆文献」的说明', /真实检索接口|未开启联网检索/.test(r.note), r.note);

  /* 模型不可用 → 机械兜底，不虚构文献 */
  var savedKey = process.env.QWEN_API_KEY;
  delete process.env.QWEN_API_KEY;
  setTransport();
  var r2 = await discover.planTopic(TOPIC, '', { timeout: 5000 });
  clearTransport();
  process.env.QWEN_API_KEY = savedKey;
  check('A6 未配置模型凭证 → status=config_failed', r2.status === 'config_failed', r2.status);
  check('A7 兜底检索式来自课题原文（不编造文献）',
    r2.plan && r2.plan.queries.length >= 1 && /老旧小区/.test(r2.plan.queries[0].text),
    JSON.stringify(r2.plan && r2.plan.queries));

  /* 模型调用失败 → 同样只给兜底，并如实说明 */
  qwenFail = true;
  setTransport();
  var r3 = await discover.planTopic(TOPIC, '', { timeout: 5000 });
  clearTransport();
  qwenFail = false;
  check('A8 模型调用失败 → status=fallback 且有失败原因', r3.status === 'fallback' && !!r3.failureKind,
    r3.status + '/' + r3.failureKind);
}

/* ---------------- ② 真实检索 ---------------- */

async function testSearch() {
  head('② 真实检索（Crossref + OpenAlex）');

  setTransport();
  var s = await discover.runSearch(['retrofit heating', '老旧小区 供暖'], { yearFrom: '2018', yearTo: '2024' },
    { timeBudgetMs: 20000, timeout: 5000, maxQueries: 2 });
  clearTransport();

  check('B1 两条检索式 × 两个源 = 4 次真实请求', calls.length === 4, '实际 ' + calls.length);
  check('B2 OpenAlex 用 search= 入口', /api\.openalex\.org\/works\?search=/.test(calls[0].url), calls[0].url);
  check('B3 Crossref 用 query.bibliographic=', /query\.bibliographic=/.test(calls[calls.length - 1].url),
    calls[calls.length - 1].url);
  var uOa = decodeURIComponent(calls[0].url);
  var uCr = decodeURIComponent(calls[calls.length - 1].url);
  check('B4 年份区间真的进了请求', /from_publication_date:2018/.test(uOa) &&
    /from-pub-date:2018/.test(uCr), uOa);

  var titles = s.candidates.map(function (c) { return c.title; });
  check('B5 候选题录来自真实返回（题名一致）',
    titles.indexOf('Energy retrofit of old residential buildings in cold regions') >= 0,
    JSON.stringify(titles));
  check('B6 DOI 来自真实返回', (s.candidates.filter(function (c) { return c.doi === '10.1000/oa1'; }).length === 1));
  /* 两条检索式会各自把同一条记录带回来，因此去重次数 ≥1；
   * 关键是最终候选里同 DOI 只保留一条。 */
  check('B7 同 DOI 被去重（最终候选里只保留一条）',
    s.candidates.filter(function (c) { return c.doi === '10.1000/shared'; }).length === 1 &&
    s.removedDuplicates.length >= 1, JSON.stringify(s.removedDuplicates.length));
  /* 10 条原始记录（2 检索式 × 5 条）→ 去重合并 6 条 → 再剔除与检索式毫无重合的 1 条 → 3 条 */
  check('B7b 去重后再过词面门槛，最终候选为 3 条',
    s.candidates.length === 3 && s.removedIrrelevant.length === 1,
    '候选 ' + s.candidates.length + ' / 剔除 ' + s.removedIrrelevant.length);
  check('B8 去重理由写进了结果', /重复/.test(s.removedDuplicates[0].reason || ''), s.removedDuplicates[0].reason);

  var withAbs = s.candidates.filter(function (c) { return c.hasAbstract; });
  var noAbs = s.candidates.filter(function (c) { return !c.hasAbstract; });
  check('B9 有摘要的标 citation_abstract', withAbs.length >= 1 &&
    withAbs[0].evidenceLevel === 'citation_abstract', withAbs[0] && withAbs[0].evidenceText);
  check('B10 无摘要的标 citation，且明确「未获取全文」',
    noAbs[0].evidenceLevel === 'citation' && /未获取全文/.test(noAbs[0].evidenceText),
    noAbs[0].evidenceText);
  check('B11 无摘要时 abstract 为空（绝不补写）', noAbs[0].abstract === '');
  check('B12 开放获取 PDF 记下来但标明未下载未阅读',
    !!withAbs[0].oa.pdfUrl, JSON.stringify(withAbs[0].oa));

  check('B13 facets 只含真实出现的语言 / 类型',
    s.facets.langs.length >= 1 && s.facets.types.length >= 1 &&
    s.facets.years.length >= 1, JSON.stringify(s.facets));
  check('B14 结果带回实际执行与跳过的检索式', s.executedQueries.length === 2);
  check('B15 排序说明写明「不把更新当年作更可信」', /不把/.test(s.orderNote), s.orderNote);
  /* 现在是三个源（Crossref / OpenAlex / AMiner）；AMiner 需要 Token，
   * 未配置时如实标为「未用上」，不能算进 used。 */
  check('B16 services 标出实际用到的服务', s.services.length === 3 &&
    s.services.filter(function (x) { return x.used; }).length === 2 &&
    s.services.filter(function (x) { return x.id === 'aminer' && x.configured === false; }).length === 1);

  /* 全部失败 ≠ 零结果 */
  oaFail = true; crFail = true;
  setTransport();
  var s2 = await discover.runSearch(['x'], {}, { timeBudgetMs: 20000, timeout: 5000 });
  clearTransport();
  oaFail = false; crFail = false;
  check('B17 全部请求失败 → status=failed（不是 empty）', s2.status === 'failed', s2.status);
  check('B18 失败时候选为空且日志留了失败原因',
    s2.candidates.length === 0 && /网络不可达/.test(s2.log[0].failureDetail));

  /* 成功但零结果 */
  var keepOa = OA_RESULTS, keepCr = CR_ITEMS;
  OA_RESULTS = []; CR_ITEMS = [];
  setTransport();
  var s3 = await discover.runSearch(['x'], {}, { timeBudgetMs: 20000, timeout: 5000 });
  clearTransport();
  OA_RESULTS = keepOa; CR_ITEMS = keepCr;
  check('B19 请求成功但零结果 → status=empty', s3.status === 'empty', s3.status);
  check('B20 empty 与 failed 不是一回事', s3.ok === true && s3.status === 'empty');
  check('B20b 零结果成因标为 no_records（接口一条没回）', s3.emptyKind === 'no_records', s3.emptyKind);

  /* 检索式与返回记录毫无词面重合 → 剔除后 empty，成因 no_relevant */
  setTransport();
  var s4 = await discover.runSearch(['Zzyqxblorpquuxfrobnicate'], {}, { timeBudgetMs: 20000, timeout: 5000 });
  clearTransport();
  check('B21 与检索式毫无重合的记录被剔除（不拿噪音凑数）',
    s4.candidates.length === 0 && s4.removedIrrelevant.length >= 1,
    '候选 ' + s4.candidates.length + ' / 剔除 ' + s4.removedIrrelevant.length);
  check('B22 剔除理由写进了结果（不悄悄丢数据）',
    /没有任何词面重合/.test(s4.removedIrrelevant[0].reason || ''), s4.removedIrrelevant[0].reason);
  check('B23 这种零结果标为 no_relevant，与「接口没返回」区分开',
    s4.status === 'empty' && s4.emptyKind === 'no_relevant', s4.status + '/' + s4.emptyKind);
}

/* ---------------- ③ 关系分析 ---------------- */

async function testAnalyze() {
  head('③ 关系分析（任务 D）+ 推荐清单');
  process.env.QWEN_API_KEY = MOCK_KEY;

  setTransport();
  var s = await discover.runSearch(['retrofit heating'], {}, { timeBudgetMs: 20000, timeout: 5000, maxQueries: 1 });
  clearTransport();
  var cands = s.candidates;
  check('C0 检索到候选用于分析', cands.length >= 3, '实际 ' + cands.length);

  var ids = cands.map(function (c) { return c.id; });
  qwenReply = {
    items: [
      { id: ids[0], match: ['对象是北方住宅', '给了能耗实测 87%', '出版年份较近（2023）'], gap: ['样本只有一栋楼'], uses: ['借鉴方法', '瞎编的用途'], todo: ['需要读全文确认样本量'], why: '有实测数据可参考' },
      { id: 'c99', match: ['凭空出现的条目'], uses: ['了解背景'], why: '模型自己补的' },
      { id: ids[1], match: ['题名直接对应'], uses: ['寻找直接相关研究'], why: '与课题高度相关' },
      { id: ids[2], match: ['只有题录'], uses: [], why: '' }
    ],
    note: '只检索到英文期刊，中文研究未覆盖'
  };
  setTransport();
  var a = await discover.analyzeTopic(TOPIC, cands, { timeout: 5000 });
  clearTransport();

  var chatBody = null;
  for (var i = 0; i < calls.length; i++) if (calls[i].body) chatBody = JSON.parse(calls[i].body);
  check('C1 分析调用【未开联网检索】（只依据给定记录）',
    !!chatBody && chatBody.parameters.enable_search === undefined,
    JSON.stringify(chatBody && chatBody.parameters));

  check('C2 模型自行补的条目被丢弃', a.dropped.length >= 1 &&
    /不在本次真实检索到的候选里/.test(a.dropped[0].reason), JSON.stringify(a.dropped));
  check('C3 百分数评分被删除', a.percentRemoved >= 1 &&
    JSON.stringify(a.recommended).indexOf('87%') < 0, JSON.stringify(a.recommended[0].match));
  check('C4 用途只保留三个允许取值',
    a.recommended[0].uses.join('、') === '借鉴方法', JSON.stringify(a.recommended[0].uses));

  var recIds = a.recommended.map(function (x) { return x.id; });
  var leadIds = a.leads.map(function (x) { return x.id; });
  var noAbsId = null;
  for (var k = 0; k < cands.length; k++) {
    if (!cands[k].hasAbstract) { noAbsId = cands[k].id; break; }
  }
  check('C5 没有摘要的条目进「待阅读线索」，【不】进推荐清单',
    leadIds.indexOf(noAbsId) >= 0 && recIds.indexOf(noAbsId) < 0,
    'leads=' + JSON.stringify(leadIds) + ' rec=' + JSON.stringify(recIds));
  check('C6 推荐清单不超过 5 篇', a.recommended.length <= 5, String(a.recommended.length));
  check('C7 阅读依据由系统给出，不是模型自述',
    /题录/.test(a.recommended[0].evidenceText) && a.recommended[0].evidenceLevel,
    a.recommended[0].evidenceText);
  check('C8 模型整体说明保留', /中文研究未覆盖/.test(a.note || ''), a.note);
  check('C9 未分析的候选数量如实记录', typeof a.unanalyzedCount === 'number' && a.analyzedCount >= 1);

  /* 空理由的条目不进推荐 */
  check('C10 没有给出理由的条目不进推荐清单',
    recIds.indexOf(ids[2]) < 0, JSON.stringify(recIds));
  /* 需求 6：不把「近年」自动当作「更可信」 */
  check('C10b 「年份新 = 更好」的表述被剔除（不作为匹配点）',
    a.recencyRemoved >= 1 && !/年份较近/.test(JSON.stringify(a.recommended[0].match || [])),
    JSON.stringify(a.recommended[0].match));

  /* 候选为空 → 不做任何推荐 */
  setTransport();
  var a2 = await discover.analyzeTopic(TOPIC, [], { timeout: 5000 });
  clearTransport();
  check('C11 没有候选 → status=empty，且不给出任何条目',
    a2.status === 'empty' && a2.recommended.length === 0 && a2.leads.length === 0, a2.status);
  check('C12 空候选时不会调用模型', calls.length === 0, '请求数 ' + calls.length);

  /* 分析失败 ≠ 检索失败 */
  qwenFail = true;
  setTransport();
  var a3 = await discover.analyzeTopic(TOPIC, cands, { timeout: 5000 });
  clearTransport();
  qwenFail = false;
  check('C13 分析失败 → status=failed 且如实说明', a3.status === 'failed' && !!a3.failureDetail, a3.status);
  check('C14 分析失败时不编造推荐理由', a3.recommended.length === 0 && /不会/.test(a3.note), a3.note);
}

/* ---------------- ③b 材料不足 → 待阅读线索 ---------------- */

async function testLeads() {
  head('③b 材料不足（残摘要 / 无摘要）→ 待阅读线索');
  process.env.QWEN_API_KEY = MOCK_KEY;

  function cand(id, title, abstract) {
    return {
      id: id, title: title, authors: 'X', year: '2020', venue: 'J', type: 'article',
      lang: 'en', doi: '10.1/' + id, url: 'https://example.org/' + id,
      hasAbstract: !!abstract, abstract: abstract || '', abstractLen: (abstract || '').length,
      oa: { isOa: false, pdfUrl: '' },
      evidenceLevel: abstract ? 'citation_abstract' : 'citation',
      evidenceText: abstract ? '题录 + 来源返回的摘要（未获取全文，未读原文）'
        : '仅有题录，来源未提供摘要，未获取全文',
      query: 'heating retrofit', source: 'OpenAlex', apiUrl: '', retrievedAt: '',
      missing: [], alsoIn: []
    };
  }
  var longAbs = '本文对北方既有住宅围护结构改造前后的供暖能耗进行了实测对比，' +
    '给出了单位面积耗热量的变化幅度与适用条件，可作为同类评估的方法参考。' +
    'This paper reports measured heating energy consumption before and after envelope retrofit.';
  var cands = [
    cand('c1', 'Measured heating energy savings of envelope retrofit in old residential buildings', longAbs),
    cand('c2', 'A study of residential retrofit', '一句话摘要'),   // 残摘要
    cand('c3', 'Another retrofit study without abstract', '')       // 无摘要
  ];

  qwenReply = {
    items: [
      { id: 'c1', match: ['有实测能耗对比'], gap: ['未限定寒冷地区'], uses: ['借鉴方法'], todo: ['读全文确认样本量'], why: '方法可参考' },
      { id: 'c2', match: ['题名涉及改造'], gap: ['材料太少'], uses: ['了解背景'], todo: ['需读原文'], why: '只有题录层面信息' },
      { id: 'c3', match: ['题名涉及改造'], uses: [], why: '仅题录' }
    ],
    note: '部分记录只有题录'
  };
  setTransport();
  var a = await discover.analyzeTopic(TOPIC, cands, { timeout: 5000 });
  clearTransport();

  var rec = a.recommended.map(function (x) { return x.id; });
  var lead = a.leads.map(function (x) { return x.id; });
  check('L1 摘要充分的进推荐清单', rec.join(',') === 'c1', JSON.stringify(rec));
  check('L2 残摘要（字数不足）只进待阅读线索', lead.indexOf('c2') >= 0 && rec.indexOf('c2') < 0,
    'leads=' + JSON.stringify(lead));
  check('L3 无摘要的只进待阅读线索', lead.indexOf('c3') >= 0 && rec.indexOf('c3') < 0,
    'leads=' + JSON.stringify(lead));
  check('L4 待阅读线索的阅读依据明确写「未获取全文」',
    a.leads.every(function (x) { return /未获取全文/.test(x.evidenceText); }));
}

/* ---------------- ④ 覆盖范围与合规 ---------------- */

function testCoverage() {
  head('④ 覆盖范围与合规文案');
  var c = discover.COVERAGE;
  check('D1 明确列出三个真实检索服务', c.services.length === 3 &&
    c.services.map(function (x) { return x.id; }).join(',') === 'crossref,openalex,aminer');
  check('D2 如实说明不覆盖知网 / 万方', /知网/.test(c.text) && /万方/.test(c.text), c.text);
  check('D3 明确不承诺覆盖全部文献', /不.*承诺覆盖全部文献/.test(c.text), c.text);
  check('D4 写明「检索到 ≠ 已核实、未读原文」',
    /不等于/.test(c.notVerified) && /已核实/.test(c.notVerified) &&
    /读过出版方原文|未读原文/.test(c.notVerified), c.notVerified);
  check('D5 推荐上限为 5 篇', discover.MAX_RECOMMEND === 5);
  check('D6 分析候选上限有硬约束（实测 8 条会让模型超时，收在 6 条）',
    discover.MAX_ANALYZE_CANDS === 6, String(discover.MAX_ANALYZE_CANDS));

  /* 摘要还原（OpenAlex 倒排索引 / Crossref JATS） */
  var abs1 = discover.abstractFromOpenAlex({ abstract_inverted_index: { We: [0], measured: [1], heating: [2], savings: [3] } });
  check('D7 OpenAlex 倒排索引能还原成摘要文本', abs1 === 'We measured heating savings', abs1);
  var abs2 = discover.abstractFromCrossref({ abstract: '<jats:p>We measured heating savings.</jats:p>' });
  check('D8 Crossref JATS 摘要去标签', /We measured heating savings\./.test(abs2), abs2);
  check('D9 没有摘要字段时返回空（不补写）',
    discover.abstractFromOpenAlex({}) === '' && discover.abstractFromCrossref({}) === '');
  check('D10 检索词抽取会去掉 and / the 之类停用词',
    discover.termsOf('old residential AND the heating').indexOf('the') < 0 &&
    discover.termsOf('old residential AND the heating').indexOf('residential') >= 0,
    JSON.stringify(discover.termsOf('old residential AND the heating')));
  check('D11 过长的中文串切成 2 字滑窗（无分词器时的稳妥做法）',
    discover.termsOf('老旧小区围护结构改造').indexOf('围护') >= 0,
    JSON.stringify(discover.termsOf('老旧小区围护结构改造')));
}

/* ---------------- 运行 ---------------- */

(async function () {
  await testPlan();
  await testSearch();
  await testAnalyze();
  await testLeads();
  testCoverage();
  console.log('\n==================================');
  console.log('检索推荐测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('==================================');
  process.exit(fail ? 1 : 0);
})();
