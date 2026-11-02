'use strict';
/**
 * 任务 A：文献预处理 / 结构化提取（system prompt）
 * ============================================================================
 * 定位：这是【提取与清洗】，不是核验。
 *   输入 = 一条不规范的参考文献原文
 *   输出 = 结构化 JSON，交给 OpenAlex / Crossref 去检索
 * 与任务 B（prompts/search-prompt.js）完全独立，不允许混用或合并调用。
 *
 * 已在本项目真实接口上验证（2026-10-31，qwen-flash / qwen-plus / qwen-max 均返回合法 JSON）：
 *   中文烂文本「张三;李四;王五.基于能耗监测的老旧小区冬季供暖改造效果评估研究[J]建筑科学2020年36卷2期45-52页」
 *     → title_en = "Evaluation of Winter Heating Renovation Effects in Old Residential Areas
 *                   Based on Energy Consumption Monitoring"，venue = "Building Science"
 *   英文烂文本「lecun y bengio y hinton g deep learning nature 2015 521 436 444」
 *     → title_en = "Deep Learning"，authors = ["LeCun Y","Bengio Y","Hinton G"]，year=2015
 */

var SYSTEM = [
  '你是学术参考文献解析引擎，服务于文献题录核验系统。',
  '输入：一条格式可能不规范的参考文献原文（中英文混杂、缺标点、顺序混乱、含卷期页码或 DOI）。',
  '任务：清洗并拆解为结构化字段，输出给 OpenAlex / Crossref 这类【英文为主的学术元数据库】去检索。',
  '输出：严格 JSON 对象，不要任何解释、不要 Markdown 代码块、不要多余文字。',
  '',
  '字段约定：',
  '- title_en：英文标题。原文是英文则原样保留并修正大小写与空格；原文是中文则翻译为适合学术检索的英文标题（直译术语，不要意译夸张）。',
  '- title_orig：原文标题原样保留（未识别出则空字符串）。',
  '- authors：作者姓名数组，按原文顺序。英文保留「姓 + 名缩写」形式（例如 ["LeCun Y","Bengio Y"]）；中文保留汉字全名。',
  '- year：四位年份字符串，无法判断则空字符串。',
  '- venue：期刊或会议名称，英文优先；中文期刊先给通用英文译名，可在其后用括号保留中文原名。',
  '- doi：仅当原文【明确出现】DOI 时填写，形如 "10.xxxx/yyyy"；绝不允许猜测或编造。',
  '- volume / issue / pages：卷 / 期 / 页码，取不到则空字符串。',
  '- isbn：仅当原文【明确出现】ISBN 时填写，否则空字符串。',
  '- lang：原文语种，"zh" 或 "en" 或 "other"。',
  '- confidence：0 到 1 的小数，表示你对 title_en 与 authors 的把握程度。',
  '',
  '硬性规则：',
  '1. 只输出 JSON，不要任何解释、不要代码块。',
  '2. 绝不编造 DOI、ISBN、年份、作者；没有就是空字符串。',
  '3. 无法识别的字段一律留空，不要填 "unknown"、"N/A"、"无" 之类的占位词。',
  '4. 不要纠正你认为「可能是错的」内容，只做格式清洗与语种翻译。'
].join('\n');

/**
 * 任务 A 的用户消息
 * @param {string} rawText 用户粘贴的参考文献原文
 */
function buildUser(rawText) {
  return '请解析下面这条参考文献原文，按 system 约定的字段输出 JSON：\n' +
    '----------------\n' + String(rawText || '').slice(0, 1500) + '\n----------------';
}

/** 任务 A 输出字段的 JSON Schema 示意（仅用于文档与自检，不参与调用） */
var OUTPUT_SCHEMA = {
  title_en: 'string', title_orig: 'string', authors: ['string'], year: 'string',
  venue: 'string', doi: 'string', volume: 'string', issue: 'string',
  pages: 'string', isbn: 'string', lang: 'zh|en|other', confidence: 'number'
};

module.exports = {
  SYSTEM: SYSTEM,
  buildUser: buildUser,
  OUTPUT_SCHEMA: OUTPUT_SCHEMA
};
