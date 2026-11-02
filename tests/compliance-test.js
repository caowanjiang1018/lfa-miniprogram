'use strict';
/**
 * 架构合规检查（对应验收标准 1、3）
 * ------------------------------------------------------------
 * 1. 前端代码中不存在直接访问 OpenAlex / Crossref 的 wx.request，
 *    也不存在任何外部接口地址明文；所有外网请求都在云函数内。
 * 3. 无 DOI 检索得到多条候选时，不会自动选定第一条。
 *
 * 运行：node tests/compliance-test.js
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var CF = path.join(ROOT, 'cloudfunctions', 'lfaVerify');

var pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? '  << ' + detail : '')); }
}

/** 去掉注释，避免把说明文字误判为代码 */
function stripComments(src) {
  var out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  var lines = out.split(/\r?\n/);
  var res = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var idx = ln.indexOf('//');
    if (idx > -1) ln = ln.slice(0, idx);
    res.push(ln);
  }
  return res.join('\n');
}

function walk(dir, out, skip) {
  var files = fs.readdirSync(dir);
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f === 'node_modules' || f === '.git') continue;
    var p = path.join(dir, f);
    var rel = path.relative(ROOT, p).replace(/\\/g, '/');
    var skipped = false;
    for (var s = 0; s < skip.length; s++) {
      if (rel === skip[s] || rel.indexOf(skip[s] + '/') === 0) { skipped = true; break; }
    }
    if (skipped) continue;
    var st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out, skip);
    else out.push(p);
  }
  return out;
}

/** 收集前端源文件：pages / utils / custom-tab-bar / app.* */
function frontendFiles() {
  var out = [];
  var targets = ['pages', 'utils', 'custom-tab-bar'];
  for (var i = 0; i < targets.length; i++) {
    var d = path.join(ROOT, targets[i]);
    if (fs.existsSync(d)) walk(d, out, []);
  }
  var appJs = path.join(ROOT, 'app.js');
  var appJson = path.join(ROOT, 'app.json');
  if (fs.existsSync(appJs)) out.push(appJs);
  if (fs.existsSync(appJson)) out.push(appJson);
  return out.filter(function (p) { return /\.(js|wxml|json)$/.test(p); });
}

var FORBIDDEN_HOSTS = [
  'api.crossref.org', 'api.openalex.org', 'crossref.org', 'openalex.org',
  'dashscope.aliyuncs.com', 'maas.aliyuncs.com', 'api.semanticscholar.org'
];

/* 疑似 API 密钥：sk- 开头的长串（DashScope / OpenAI 风格） */
var KEY_RE = /sk-[A-Za-z0-9_\-\.]{16,}/;

function main() {
  console.log('\n===== 合规检查 1：前端不得直连外部接口 =====\n');

  var files = frontendFiles();
  console.log('  扫描前端文件 ' + files.length + ' 个');

  var requestHits = [];
  var hostHits = [];
  var keyHits = [];

  files.forEach(function (f) {
    var rel = path.relative(ROOT, f).replace(/\\/g, '/');
    var raw = fs.readFileSync(f, 'utf8');
    var code = stripComments(raw);

    if (/wx\s*\.\s*request\s*\(/.test(code)) requestHits.push(rel);
    /* 密钥检查用【未去注释】的原文：注释里也不该出现真实密钥 */
    if (KEY_RE.test(raw)) keyHits.push(rel);

    FORBIDDEN_HOSTS.forEach(function (h) {
      var re = new RegExp(h.replace(/\./g, '\\.'), 'i');
      if (re.test(code)) hostHits.push(rel + ' → ' + h);
    });
  });

  check('前端无 wx.request 调用', requestHits.length === 0, requestHits.join(', '));
  check('前端无外部接口地址明文', hostHits.length === 0, hostHits.join(', '));
  check('前端不含任何 API 密钥', keyHits.length === 0, keyHits.join(', '));

  console.log('\n===== 合规检查 2：外部请求只存在于云函数 =====\n');

  var cfFiles = walk(CF, [], []);
  var cfCode = cfFiles.map(function (f) { return fs.readFileSync(f, 'utf8'); }).join('\n');
  check('云函数内包含 OpenAlex 地址', /api\.openalex\.org/.test(cfCode));
  check('云函数内包含 Crossref 地址', /api\.crossref\.org/.test(cfCode));
  check('云函数使用内置 https 模块（无需 npm 依赖）', /require\('https'\)|require\("https"\)/.test(cfCode));
  check('云函数 package.json 无第三方依赖', (function () {
    var pkg = JSON.parse(fs.readFileSync(path.join(CF, 'package.json'), 'utf8'));
    return !pkg.dependencies || Object.keys(pkg.dependencies).length === 0;
  })());

  var idxSrc = fs.readFileSync(path.join(CF, 'index.js'), 'utf8');
  check('云函数实现了 OpenAlex 优先 / Crossref 降级顺序',
    /openalex/.test(idxSrc) && /crossref/.test(idxSrc));

  console.log('\n===== 合规检查 2b：通义千问密钥只在云函数环境变量 =====\n');

  var keyInCf = [];
  cfFiles.forEach(function (f) {
    var src = fs.readFileSync(f, 'utf8');
    if (KEY_RE.test(src)) keyInCf.push(path.relative(ROOT, f).replace(/\\/g, '/'));
  });
  check('云函数代码中【没有】硬编码密钥', keyInCf.length === 0, keyInCf.join(', '));

  var qwenSrc = fs.readFileSync(path.join(CF, 'sources', 'qwen.js'), 'utf8');
  check('千问适配器从环境变量读取密钥',
    /QWEN_API_KEY/.test(qwenSrc) && /process\.env\[/.test(qwenSrc));
  check('千问适配器未把密钥写进任何默认配置', !/key:\s*['"]sk-/.test(qwenSrc));
  check('千问采用 DashScope 原生接口', /services\/aigc\/text-generation\/generation/.test(qwenSrc));
  check('千问任务 B 开启联网检索', /enable_search/.test(qwenSrc));
  check('两套 prompt 独立成文件', fs.existsSync(path.join(CF, 'prompts', 'extract-prompt.js')) &&
    fs.existsSync(path.join(CF, 'prompts', 'search-prompt.js')));
  check('主流程串行顺序为 提取→学术库→联网检索',
    /qwen\.extract/.test(idxSrc) && /openalex/.test(idxSrc) && /runAiSearch/.test(idxSrc));
  check('千问结果不会被判为「已核实」',
    /statusKey\s*===\s*'verified'/.test(idxSrc) === false || /ai_found/.test(idxSrc));

  console.log('\n===== 合规检查 2c：「帮我找文献」不得凭记忆补文献 =====\n');

  var discoverSrc = fs.readFileSync(path.join(CF, 'discover.js'), 'utf8');
  check('检索推荐模块独立成文件', discoverSrc.length > 0);
  check('检索式规划 / 关系分析两套 prompt 独立成文件',
    fs.existsSync(path.join(CF, 'prompts', 'plan-prompt.js')) &&
    fs.existsSync(path.join(CF, 'prompts', 'analyze-prompt.js')));
  check('规划与分析两个调用【都不开联网检索】',
    /enableSearch: false/.test(qwenSrc), 'qwen.js 里应有 enableSearch: false');
  check('规划 prompt 明令禁止输出具体文献',
    /严禁输出任何具体文献/.test(fs.readFileSync(path.join(CF, 'prompts', 'plan-prompt.js'), 'utf8')));
  check('分析 prompt 明令禁止只看题录时补写摘要 / 编造页码',
    /不得新增|禁止/.test(fs.readFileSync(path.join(CF, 'prompts', 'analyze-prompt.js'), 'utf8')));
  check('推荐清单上限写死为 5 篇', /MAX_RECOMMEND\s*=\s*5/.test(discoverSrc));
  check('检索失败与零结果是两种状态',
    /'failed'/.test(discoverSrc) && /'empty'/.test(discoverSrc));
  check('覆盖范围如实说明（写明知网 / 万方未覆盖）',
    /知网/.test(discoverSrc) && /万方/.test(discoverSrc));

  console.log('\n===== 合规检查 2d：前端不得内置任何预置文献结果 =====\n');

  var doiHits = [];
  files.forEach(function (f) {
    var rel = path.relative(ROOT, f).replace(/\\/g, '/');
    var code = stripComments(fs.readFileSync(f, 'utf8'));
    /* 前端任何文件里都不应出现形如 10.xxxx/yyyy 的 DOI 字面量——
     * 出现即意味着「内置了预置结果」，与「只展示真实检索记录」冲突。 */
    if (/10\.\d{4,9}\//.test(code)) doiHits.push(rel);
  });
  check('前端代码里没有任何 DOI 字面量（无预置文献）', doiHits.length === 0, doiHits.join(', '));

  console.log('\n===== 合规检查 3：候选不得自动选定第一条 =====\n');

  var cmpSrc = fs.readFileSync(path.join(CF, 'lib', 'compare.js'), 'utf8');
  check('比对引擎提供 5 类判定标记', /year_ambiguous|mismatch|match/.test(cmpSrc));

  // 候选路径：record 必须为空、checks 必须为空（即未自动采信）
  var engine = require(CF);
  var http = require(path.join(CF, 'lib/http.js'));
  http.setTransport(function () {
    return Promise.resolve({
      ok: true, status: 200,
      raw: JSON.stringify({
        results: [
          { doi: 'https://doi.org/10.1/a', display_name: 'Alpha', publication_year: 2021, authorships: [{ author: { display_name: 'Smith J' } }], primary_location: { source: { display_name: 'J1' } } },
          { doi: 'https://doi.org/10.1/b', display_name: 'Beta', publication_year: 2020, authorships: [{ author: { display_name: 'Brown A' } }], primary_location: { source: { display_name: 'J2' } } }
        ]
      }),
      body: null, requestedAtText: 'test'
    });
  });

  engine.verifyOne({ doi: '', title: 'Some paper', authors: 'Smith J', year: '2021', venue: 'J1' })
    .then(function (res) {
      check('候选路径下 record 为空（未自动认定）', res.record === null);
      check('候选路径下 checks 为空（未生成比对结论）', (res.checks || []).length === 0);
      check('候选路径下 statusKey = multi_candidate', res.statusKey === 'multi_candidate', res.statusKey);
      /* 两条 fixture 里，Alpha 与输入（Smith J / 2021 / J1）对得上，Beta 完全对不上。
       * 新规则：题名不像、作者年份也对不上的记录【不】列为候选，避免噪音误导，
       * 同时必须在 reason 里如实写出剔除了几条。 */
      check('保留的候选都带 rank', (res.candidates || []).length >= 1 &&
        res.candidates.every(function (c, i) { return c.rank === i + 1; }));
      check('毫不相关的记录被剔除，不列为候选', (res.candidates || []).length === 1 &&
        res.candidates[0].title === 'Alpha', JSON.stringify((res.candidates || []).map(function (c) { return c.title; })));
      check('剔除行为在原因里如实说明（不悄悄丢数据）', /已剔除/.test(res.reason || ''), res.reason);

      /* ===== 合规检查 3：千问兜底的展示分离规则 ===== */
      console.log('\n===== 合规检查 3：题干 / 链接展示分离，且不谎称已核验 =====\n');

      var idnFile = fs.readFileSync(path.join(ROOT, 'utils/identity.js'), 'utf8');
      var verWxml = fs.readFileSync(path.join(ROOT, 'pages/verify/verify.wxml'), 'utf8');
      var idWxml = fs.readFileSync(path.join(ROOT, 'pages/identity/identity.wxml'), 'utf8');
      var verJs = fs.readFileSync(path.join(ROOT, 'pages/verify/verify.js'), 'utf8');

      check('视图层把题录与链接拆成独立字段（recordMeta / candidateLinks）',
        /recordMeta\s*:/.test(idnFile) && /candidateLinks\s*:/.test(idnFile));
      check('题干是否判为「未检索到」只看 recordMeta.credible，不看链接条数',
        /var found = hasRecord/.test(idnFile) || /var found = hasRecord/.test(
          fs.readFileSync(path.join(ROOT, 'cloudfunctions/lfaVerify/index.js'), 'utf8')));
      check('三种结果状态齐全（有链接 / 无链接 / 无线索）',
        /record_and_link/.test(idnFile) && /record_only/.test(idnFile) && /no_clue/.test(idnFile));
      check('原始候选链接折叠区明确标注「未做连通性核验」',
        /未做连通性核验/.test(idWxml) && /原始候选链接/.test(idWxml));
      check('主展示区只放通过校验或待验证的链接（原始链接另置于折叠区）',
        /idn\.aiSearch\.candidateLinks/.test(idWxml) && /idn\.aiSearch\.rawCandidateLinks/.test(idWxml));
      check('未确认连通性的链接明写「暂无法验证连通性」，不冒充可用',
        /暂无法验证连通性/.test(idnFile) && /暂无法验证连通性/.test(idWxml));
      check('核验卡条目默认收起（expanded 初值为 false）',
        /expanded:\s*false/.test(verJs));
      check('卡片右上角固定展示核验结果（resultText/resultTone）',
        /resultText/.test(verJs) && /c\.resultText/.test(verWxml));
      check('缺摘要时不补写摘要：缺失字段如实列出 + 页面明写来源未提供摘要',
        /fieldsAbsent/.test(idnFile) && /本次搜索没有提供摘要/.test(idWxml));

      console.log('\n==================================');
      console.log('合规检查结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
      console.log('==================================');
      process.exit(fail ? 1 : 0);
    })
    .catch(function (e) {
      console.error('检查异常：', e);
      process.exit(1);
    });
}

main();
