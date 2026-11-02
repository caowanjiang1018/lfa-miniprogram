'use strict';
/**
 * 文本归一化与相似度
 * ------------------------------------------------------------
 * 设计要点（都是实测踩过的坑）：
 *   - normalize 去标签去标点：Crossref 的 title 可能带 <jats:title> 等标记
 *   - 中文用 2-gram、英文用单词：混在一起算 Jaccard 会互相稀释，必须分治
 *   - 作者按「人」分组而非摊平成集合："LeCun Y" 摊平后会多出一个永不命中的
 *     token "y"，导致明明正确的作者被判成部分匹配（已修复）
 */

function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

function stripTags(s) {
  return String(s || '').replace(/<[^>]{1,80}>/g, ' ');
}

function lower(s) { return String(s || '').toLowerCase(); }

function normalize(s) {
  s = stripTags(s);
  s = lower(s);
  s = s.replace(/&[a-z#0-9]{1,8};/gi, ' ');
  s = s.replace(/[\u2019\u2018]/g, "'");
  s = s.replace(/[^0-9a-z\u4e00-\u9fa5]+/g, ' ');
  return trim(s.replace(/\s+/g, ' '));
}

function latinTokens(s) {
  var t = normalize(s).match(/[a-z][a-z0-9]{1,}/g) || [];
  var out = {};
  for (var i = 0; i < t.length; i++) out[t[i]] = 1;
  return Object.keys(out);
}

function cjkBigrams(s) {
  var runs = normalize(s).match(/[\u4e00-\u9fa5]{2,}/g) || [];
  var out = {};
  for (var i = 0; i < runs.length; i++) {
    var r = runs[i];
    if (r.length === 1) { out[r] = 1; continue; }
    for (var k = 0; k <= r.length - 2; k++) out[r.substr(k, 2)] = 1;
  }
  return Object.keys(out);
}

function hasCjk(s) { return /[\u4e00-\u9fa5]/.test(s || ''); }

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  var setA = {};
  for (var i = 0; i < a.length; i++) setA[a[i]] = 1;
  var inter = 0;
  for (var j = 0; j < b.length; j++) if (setA[b[j]]) inter++;
  var union = a.length + b.length - inter;
  return union ? inter / union : 0;
}

/** 标题相似度：中英文分治取较大值 */
function titleSim(a, b) {
  if (!trim(a) || !trim(b)) return 0;
  var la = latinTokens(a), lb = latinTokens(b);
  var ca = cjkBigrams(a), cb = cjkBigrams(b);
  var sl = jaccard(la, lb);
  var sc = jaccard(ca, cb);
  var arr = [];
  if (la.length && lb.length) arr.push(sl);
  if (ca.length && cb.length) arr.push(sc);
  if (!arr.length) return hasCjk(a) && hasCjk(b) ? sc : sl;
  var max = 0;
  for (var i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  return max;
}

/**
 * 作者串 → 每位作者一组姓氏候选。
 * 兼容：Smith J / Yann LeCun / 张三 / van der Berg J / Smith J, Brown A
 */
function authorItems(s) {
  var raw = trim(s);
  if (!raw) return [];
  var parts = raw.split(/[;；]|\s*,\s*|\s+and\s+/i);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = trim(parts[i]).replace(/[0-9]{1,2}$/, '');
    if (!p) continue;
    if (hasCjk(p)) {
      var cn = p.match(/[\u4e00-\u9fa5]{2,4}/);
      if (cn) out.push([cn[0].slice(0, 2)]);
      continue;
    }
    var toks = lower(p).match(/[a-z][a-z\-]*/g) || [];
    if (!toks.length) continue;
    if (toks.length === 1) { out.push([toks[0]]); continue; }
    var set = {};
    set[toks[0]] = 1;
    set[toks[toks.length - 1]] = 1;
    out.push(Object.keys(set));
  }
  return out;
}

function authorSurnames(s) {
  return authorItems(s).map(function (g) { return g[0]; });
}

/** 记录侧姓氏候选（兼容 [{family,given}] 与 [{name}] 与 ['字符串']） */
function recordSurnameItems(authors) {
  var out = [];
  if (!authors) return out;
  for (var i = 0; i < authors.length; i++) {
    var a = authors[i];
    if (typeof a === 'string') {
      var g = authorItems(a);
      if (g.length) out.push(g[0]);
      continue;
    }
    var family = trim(a.family);
    if (family) { out.push([lower(family)]); continue; }
    var nm = trim(a.name || a.display_name);
    if (!nm) continue;
    if (hasCjk(nm)) {
      var cn = nm.match(/[\u4e00-\u9fa5]{2,4}/);
      if (cn) out.push([cn[0].slice(0, 2)]);
      continue;
    }
    var toks = lower(nm).match(/[a-z][a-z\-]*/g) || [];
    if (!toks.length) continue;
    var set = {};
    set[toks[0]] = 1;
    set[toks[toks.length - 1]] = 1;
    out.push(Object.keys(set));
  }
  return out;
}

function recordSurnameSet(authors) {
  var groups = recordSurnameItems(authors);
  var set = {};
  for (var i = 0; i < groups.length; i++) {
    for (var j = 0; j < groups[i].length; j++) set[groups[i][j]] = 1;
  }
  return { set: set, count: groups.length };
}

/** 作者相似度 = 被记录覆盖的输入作者数 / 输入作者数 */
function authorSim(inputAuthors, recAuthorItems) {
  var inGroups = authorItems(inputAuthors);
  var rc = recordSurnameSet(recAuthorItems);
  if (!inGroups.length || !rc.count) {
    return { score: 0, matched: [], missing: [], inputCount: inGroups.length, recordCount: rc.count };
  }
  var matched = [], missing = [];
  for (var i = 0; i < inGroups.length; i++) {
    var hit = null;
    for (var j = 0; j < inGroups[i].length; j++) {
      if (rc.set[inGroups[i][j]]) { hit = inGroups[i][j]; break; }
    }
    if (hit) matched.push(hit); else missing.push(inGroups[i][0]);
  }
  return {
    score: matched.length / inGroups.length,
    matched: matched,
    missing: missing,
    inputCount: inGroups.length,
    recordCount: rc.count
  };
}

function normalizeDoi(s) {
  s = trim(s);
  if (!s) return '';
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/^doi:\s*/i, '');
  s = s.replace(/^DOI\s*/i, '');
  return trim(s.replace(/\s+/g, ''));
}

module.exports = {
  trim: trim,
  stripTags: stripTags,
  lower: lower,
  normalize: normalize,
  latinTokens: latinTokens,
  cjkBigrams: cjkBigrams,
  hasCjk: hasCjk,
  jaccard: jaccard,
  titleSim: titleSim,
  authorItems: authorItems,
  authorSurnames: authorSurnames,
  recordSurnameSet: recordSurnameSet,
  authorSim: authorSim,
  normalizeDoi: normalizeDoi
};
