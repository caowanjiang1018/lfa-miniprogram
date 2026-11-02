'use strict';
/**
 * 字段级比对引擎
 * ------------------------------------------------------------
 * 判定取值：
 *   match          一致
 *   mismatch       冲突（核心字段明显不一致）
 *   weak           部分相近，需人工核对
 *   input_missing  你未填写，未比对
 *   record_missing 来源无此字段，未比对
 *
 * 硬性规则：
 *   1. 缺失【绝不】参与一致/冲突判定，更不会自动补造内容。
 *   2. 年份若与来源的「在线发表年」或「印刷/卷期年」任一相同，判为一致；
 *      若都不相同、但来源本身存在多个不同年份取值（在线/卷期跨年），
 *      判为 weak（需人工核对），【不直接判定为冲突】；
 *      仅当来源只有一个年份取值且对不上时，才判为冲突。
 */

var T = require('./text.js');

var trim = T.trim;
var titleSim = T.titleSim;
var authorSim = T.authorSim;
var normalizeDoi = T.normalizeDoi;

var FIELD_LABELS = {
  title: '题名',
  authors: '第一作者/作者',
  year: '出版年份',
  venue: '出处/期刊'
};

/**
 * @param {object} ref 用户输入 {doi,title,authors,year,venue}
 * @param {object} rec 归一化后的来源记录
 * @param {string} providerName 来源名称（用于说明文案）
 */
function compareFields(ref, rec, providerName) {
  var src = providerName || '来源';
  var checks = [];

  /* ---------------- 题名 ---------------- */
  var inTitle = trim(ref.title);
  if (!inTitle) {
    checks.push({
      name: FIELD_LABELS.title, key: 'title', verdict: 'input_missing',
      input: '', record: rec.title, note: '你的输入里没有题名，未参与比对'
    });
  } else if (!rec.title) {
    checks.push({
      name: FIELD_LABELS.title, key: 'title', verdict: 'record_missing',
      input: inTitle, record: '', note: src + ' 这条记录没有题名字段，未参与比对（缺失 ≠ 不一致）'
    });
  } else {
    var ts = titleSim(inTitle, rec.title);
    checks.push({
      name: FIELD_LABELS.title, key: 'title',
      verdict: ts >= 0.85 ? 'match' : (ts >= 0.55 ? 'weak' : 'mismatch'),
      score: round2(ts), input: inTitle, record: rec.title,
      note: ts >= 0.85 ? '文本一致（已忽略标点、大小写与副标题差异）'
        : (ts >= 0.55 ? '部分相近，可能是副标题省略或译名差异，需要你回原文核对'
          : '题名明显不同：这个 DOI 对应的很可能不是你写的这篇')
    });
  }

  /* ---------------- 作者 ---------------- */
  var inAuthors = trim(ref.authors);
  if (!inAuthors) {
    checks.push({
      name: FIELD_LABELS.authors, key: 'authors', verdict: 'input_missing',
      input: '', record: rec.authorText, note: '你的输入里没有作者，未参与比对'
    });
  } else if (!rec.authorItems || !rec.authorItems.length) {
    checks.push({
      name: FIELD_LABELS.authors, key: 'authors', verdict: 'record_missing',
      input: inAuthors, record: '', note: src + ' 这条记录没有作者字段，未参与比对（缺失 ≠ 不一致）'
    });
  } else {
    var au = authorSim(inAuthors, rec.authorItems);
    checks.push({
      name: FIELD_LABELS.authors, key: 'authors',
      verdict: au.score >= 0.6 ? 'match' : (au.score > 0 ? 'weak' : 'mismatch'),
      score: round2(au.score), input: inAuthors, record: rec.authorText,
      note: au.score >= 0.6
        ? '命中姓氏 ' + (au.matched.join('、') || '—') + '（你填 ' + au.inputCount + ' 位 / 记录 ' + au.recordCount + ' 位）' +
        (au.missing.length ? '；未能对应：' + au.missing.join('、') : '')
        : (au.score > 0
          ? '只命中部分作者：' + au.matched.join('、') + '；未能对应：' + au.missing.join('、') +
          '。可能你漏写了合作者，也可能姓名字序写法不同'
          : '姓氏完全不重合，请核对是否同一篇')
    });
  }

  /* ---------------- 年份（在线 / 卷期 / 出版年 分别给值） ---------------- */
  var inYear = trim(ref.year);
  var yearCandidates = dedupeYears(rec.yearSources || []);
  var distinctYears = [];
  var seenV = {};
  for (var di = 0; di < yearCandidates.length; di++) {
    if (!seenV[yearCandidates[di].value]) {
      seenV[yearCandidates[di].value] = 1;
      distinctYears.push(yearCandidates[di].value);
    }
  }
  var allValues = yearCandidates.map(function (c) { return c.kind + ' ' + c.value; }).join('；');

  if (!inYear) {
    checks.push({
      name: FIELD_LABELS.year, key: 'year', verdict: 'input_missing',
      input: '', record: allValues, yearDetail: yearCandidates,
      note: '你的输入里没有年份，未参与比对' + (yearCandidates.length ? '；来源记录的年份取值见上方' : '')
    });
  } else if (!yearCandidates.length) {
    checks.push({
      name: FIELD_LABELS.year, key: 'year', verdict: 'record_missing',
      input: inYear, record: '', yearDetail: [],
      note: src + ' 这条记录没有可用年份字段，未参与比对（缺失 ≠ 不一致）'
    });
  } else {
    var hit = null;
    for (var hi = 0; hi < yearCandidates.length; hi++) {
      if (yearCandidates[hi].value === inYear) { hit = yearCandidates[hi]; break; }
    }
    if (hit) {
      var extra = distinctYears.length > 1
        ? '注意该文献存在多种年份取值：' + allValues +
        '（常见于「在线预发表」与「印刷卷期」跨年），两者都已列出供你复核，未直接判定为冲突。'
        : '';
      checks.push({
        name: FIELD_LABELS.year, key: 'year', verdict: 'match',
        input: inYear, record: allValues, yearDetail: yearCandidates,
        note: '与来源记录的「' + hit.kind + '」一致。' + extra
      });
    } else if (distinctYears.length > 1) {
      /* 来源自身存在多个年份取值（在线预发表 vs 印刷卷期跨年）→
       * 按需求「两个年份都展示给用户复核，不直接判定为冲突」处理：
       * 用独立的 year_ambiguous 判定，不计入冲突。 */
      checks.push({
        name: FIELD_LABELS.year, key: 'year', verdict: 'year_ambiguous',
        input: inYear, record: allValues, yearDetail: yearCandidates,
        note: '你填写的年份与来源记录的任一年份取值都不同，但该来源本身存在多个不同年份取值：' + allValues +
          '。这通常是「在线预发表年份」与「期刊卷期出版年份」的差异，因此【不直接判定为冲突】，' +
          '请你按正式卷期页核对后自行判断。'
      });
    } else {
      checks.push({
        name: FIELD_LABELS.year, key: 'year', verdict: 'mismatch',
        input: inYear, record: allValues, yearDetail: yearCandidates,
        note: '你填写的年份与来源记录不一致。来源实际取值：' + allValues +
          '。请回原文刊登页核对后再决定是否引用。'
      });
    }
  }

  /* ---------------- 出处 / 期刊 ---------------- */
  var inVenue = trim(ref.venue);
  if (!inVenue) {
    checks.push({
      name: FIELD_LABELS.venue, key: 'venue', verdict: 'input_missing',
      input: '', record: rec.container, note: '你的输入里没有出处，未参与比对'
    });
  } else if (!rec.container) {
    checks.push({
      name: FIELD_LABELS.venue, key: 'venue', verdict: 'record_missing',
      input: inVenue, record: '', note: src + ' 这条记录没有期刊名字段，未参与比对（缺失 ≠ 不一致）'
    });
  } else {
    var vs = titleSim(inVenue, rec.container);
    checks.push({
      name: FIELD_LABELS.venue, key: 'venue',
      verdict: vs >= 0.7 ? 'match' : (vs >= 0.4 ? 'weak' : 'mismatch'),
      score: round2(vs), input: inVenue, record: rec.container,
      note: vs >= 0.7 ? '期刊名一致'
        : (vs >= 0.4 ? '期刊名部分相近，可能同名或简写差异，请核对' : '期刊名不同')
    });
  }

  /* ---------------- DOI 一致性（精确查询路径下才可能出现差异） ---------------- */
  var inDoi = normalizeDoi(ref.doi);
  if (inDoi && rec.doi) {
    var same = T.lower(inDoi) === T.lower(rec.doi);
    checks.push({
      name: 'DOI', key: 'doi', verdict: same ? 'match' : 'mismatch',
      input: inDoi, record: rec.doi,
      note: same ? '一致' : '你填写的 DOI 与来源记录返回的 DOI 不一致'
    });
  }

  return checks;
}

function dedupeYears(list) {
  var out = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (!s || !s.year) continue;
    var key = s.kind + '|' + s.year;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ kind: s.kind, value: s.year, full: s.full || s.year });
  }
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }

/** 汇总：把 checks 归成 mismatch / weak / match / missing 四类 */
function summarize(checks) {
  var mismatch = [], weak = [], match = [], missing = [], yearAmbiguous = [];
  for (var i = 0; i < checks.length; i++) {
    var c = checks[i];
    if (c.verdict === 'mismatch') mismatch.push(c);
    else if (c.verdict === 'year_ambiguous') yearAmbiguous.push(c);
    else if (c.verdict === 'weak') weak.push(c);
    else if (c.verdict === 'match') match.push(c);
    else missing.push(c);
  }
  return {
    mismatch: mismatch, weak: weak, match: match,
    missing: missing, yearAmbiguous: yearAmbiguous
  };
}

module.exports = {
  compareFields: compareFields,
  summarize: summarize,
  FIELD_LABELS: FIELD_LABELS
};
