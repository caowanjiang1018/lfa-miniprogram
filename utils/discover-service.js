/**
 * 检索推荐服务（前端侧）
 * ============================================================================
 * 架构约束：与「核验已有文献」完全一样——前端【只调用云函数 lfaVerify】，
 * 不直接访问 Crossref / OpenAlex / 通义千问。接口地址、请求头、节流与模型调用
 * 全部在云函数内完成，前端不保存任何外部接口地址与密钥。
 *
 * 三个 action（与云函数 discover.js 一一对应）：
 *   discover-plan    让模型按课题生成检索词 / 同义词 / 检索式（不开联网检索）
 *   discover-search  用这些检索式去真实检索 Crossref + OpenAlex
 *   discover-analyze 让模型【只依据真实检索到的记录】解释与课题的关系
 *
 * 诚实边界：
 *   - 云函数不可用时不返回任何预置结果，只返回 status='failed' 的原因；
 *   - 检索成功但没有候选时返回 status='empty'，与「失败」严格区分。
 */

var vs = require('./verify-service.js');

function packTopic(topic) {
  topic = topic || {};
  return {
    name: topic.name || '',
    problem: topic.problem || '',
    target: topic.target || '',
    task: topic.task || '',
    resources: topic.resources || '',
    claim: topic.claim || ''
  };
}

/** 云函数不可用时的统一外壳：只说「没做」，不编任何结果 */
function failedShell(status, detail) {
  return {
    ok: false, status: status || 'failed',
    failureKind: 'cloud_unavailable', failureDetail: detail || '',
    coverage: null, services: [], candidates: [], log: []
  };
}

/** ① 生成检索式 */
function plan(topic, hints) {
  return vs.callFn({
    action: 'discover-plan',
    topic: packTopic(topic),
    hints: hints || ''
  }).then(function (r) {
    if (!r || typeof r !== 'object') return failedShell('failed', '云函数返回内容异常');
    return r;
  });
}

/** ② 真实检索 */
function search(queries, yearFrom, yearTo) {
  var qs = (queries || []).map(function (q) {
    return typeof q === 'string' ? q : (q && q.text);
  }).filter(function (x) { return !!x; });
  if (!qs.length) {
    return Promise.resolve(failedShell('failed', '没有勾选任何检索式，未发起检索。'));
  }
  return vs.callFn({
    action: 'discover-search',
    queries: qs,
    yearFrom: yearFrom || '',
    yearTo: yearTo || ''
  }).then(function (r) {
    if (!r || typeof r !== 'object') return failedShell('failed', '云函数返回内容异常');
    return r;
  });
}

/** ③ 关系分析（候选必须是真实检索到的记录） */
function analyze(topic, candidates) {
  if (!candidates || !candidates.length) {
    return Promise.resolve({
      ok: true, status: 'empty', recommended: [], leads: [], others: [],
      note: '没有候选记录，不做分析。'
    });
  }
  return vs.callFn({
    action: 'discover-analyze',
    topic: packTopic(topic),
    /* 只把题录与摘要回传（摘要缺失就是缺失），不夹带任何本地编造内容 */
    candidates: candidates.slice(0, 6).map(function (c) {
      return {
        id: c.id, title: c.title, authors: c.authors, year: c.year,
        venue: c.venue, publisher: c.publisher, type: c.type, lang: c.lang,
        doi: c.doi, url: c.url, hasAbstract: !!c.hasAbstract,
        abstract: c.hasAbstract ? (c.abstract || '') : '',
        oa: c.oa || { isOa: false, pdfUrl: '' },
        evidenceLevel: c.evidenceLevel, evidenceText: c.evidenceText,
        query: c.query, source: c.source, apiUrl: c.apiUrl, retrievedAt: c.retrievedAt
      };
    })
  }).then(function (r) {
    if (!r || typeof r !== 'object') return failedShell('failed', '云函数返回内容异常');
    return r;
  });
}

module.exports = {
  plan: plan,
  search: search,
  analyze: analyze
};
