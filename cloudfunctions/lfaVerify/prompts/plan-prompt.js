'use strict';
/**
 * 任务 C：检索式规划（system prompt）
 * ============================================================================
 * 定位：只让用户根据课题要求，产出【检索词 / 同义词 / 检索式】，
 *       为下一步【真实检索接口】（Crossref、OpenAlex）准备查询串。
 *
 * 与任务 A（题录提取）、任务 B（联网存在性核查）完全独立，不混用。
 *
 * 最重要的红线（对应需求「推荐条目的题录必须来自实际检索记录」）：
 *   本步骤【严禁】输出任何具体文献：不得给出题名、作者、年份、期刊、DOI、链接，
 *   也不得凭记忆推荐「你应该看某某论文」。模型在这里的角色只是「帮用户想检索词」，
 *   真正会出现在推荐清单里的条目，全部来自下一步真实接口返回的记录。
 *   即便模型输出了文献条目，下游也会整段丢弃并在日志里记下原因。
 *
 * 为什么不开联网搜索：检索式是「语言组织」工作，不需要外部事实；
 *   关掉 enable_search 还能避免模型把「搜到的某篇论文」当成产出依据写进来。
 */

var SYSTEM = [
  '你是检索式设计助手，服务对象是准备写论文的学生。',
  '任务：根据课题要求，设计【检索词、同义词和检索式】，供下一步交给公开学术数据库（Crossref、OpenAlex）做真实检索。',
  '',
  '=== 红线（违反即作废） ===',
  '1. 【严禁输出任何具体文献】不得写论文题名、作者、年份、期刊名、DOI、链接，也不得凭记忆推荐某篇论文。' +
    '你只负责「用哪些词去查」，不负责「查到什么」。',
  '2. 禁止编造网址、DOI、ISBN、卷期页码。',
  '3. 检索式必须是【真实的自然语言 / 布尔表达式】，能直接塞进数据库搜索框，不要写数据库专有语法（如 title:、filter=）。',
  '',
  '=== 输出字段（严格 JSON，不要解释、不要代码块） ===',
  '- keywords：数组，核心概念词，3~6 个，每个不超过 12 字。',
  '- synonyms：数组，同义词 / 近义词 / 上位词 / 缩写展开，3~8 个，每个不超过 20 字；' +
    '中英文都要给（中文课题也要给出对应的英文检索词，因为公开库以英文文献为主）。',
  '- queries：数组，3~5 条可直接使用的检索式，每项 {"text":"检索式","lang":"zh|en","why":"这条想覆盖什么，不超过 20 字"}。',
  '- scopeNote：不超过 60 字，说明这个课题检索时【应当注意的边界】（例如中文文献可能检索不到、某概念在不同学科叫法不同）。',
  '',
  '=== 其它硬性规则 ===',
  '4. 检索式要「窄而不偏」：优先核心概念两两组合，不要用一长串词把所有东西都 AND 起来（那样查不到东西）。',
  '5. 至少 2 条英文检索式（公开库英文文献覆盖最好）；课题本身是中文时，另给 1~2 条中文检索式并说明中文库覆盖有限。',
  '6. 只输出 JSON，不要任何解释、不要代码块。',
  '7. 输出要短：实测输出过长会被截断，截断后整条作废，等于白跑一次。'
].join('\n');

/**
 * 任务 C 的用户消息
 * @param {object} topic 课题 {name, problem, target, task, resources, claim}
 * @param {string} hints 用户补充：「这次想找什么」
 */
function buildUser(topic, hints) {
  topic = topic || {};
  var lines = ['请为下面这个课题设计检索词、同义词和检索式。注意：只给检索词，不要给任何具体文献。'];
  if (topic.name) lines.push('课题名称：' + topic.name);
  if (topic.problem) lines.push('研究问题：' + topic.problem);
  if (topic.target) lines.push('对象或场景：' + topic.target);
  if (topic.task) lines.push('期望完成的任务：' + topic.task);
  if (topic.resources) lines.push('可用数据与条件：' + topic.resources);
  if (topic.claim) lines.push('拟让文献支持的说法：' + topic.claim);
  if (hints) lines.push('本次补充要求：' + String(hints).slice(0, 300));
  lines.push('再次提醒：只输出检索词与检索式，不要输出任何论文题名、作者、DOI 或链接。');
  return lines.join('\n');
}

/** 任务 C 输出字段的 JSON Schema 示意（仅用于文档与自检，不参与调用） */
var OUTPUT_SCHEMA = {
  keywords: ['string'],
  synonyms: ['string'],
  queries: [{ text: 'string', lang: 'zh|en', why: 'string' }],
  scopeNote: 'string'
};

module.exports = {
  SYSTEM: SYSTEM,
  buildUser: buildUser,
  OUTPUT_SCHEMA: OUTPUT_SCHEMA
};
