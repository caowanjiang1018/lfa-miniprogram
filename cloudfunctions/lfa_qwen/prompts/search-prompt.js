'use strict';
/**
 * 任务 B：兜底联网检索核验（system prompt）
 * ============================================================================
 * 定位：这是【存在性核查】，只在 OpenAlex / Crossref 都没命中、或判定为中文文献时触发。
 *   输入 = 已结构化的题录信息
 *   输出 = 结构化 JSON：两部分【互不依赖】
 *          recordMeta      —— 本次搜索【看到的】题录与摘要（标题/作者/年份/DOI/摘要/来源名）
 *          candidateLinks  —— 本次命中的候选原文详情页链接
 *
 * 为什么要拆开（2026-11-01 改，此前踩过的坑）：
 *   旧版本把「查到什么」和「链接能不能打开」绑在一起判定，
 *   结果链接一旦被判无效，明明已经搜到的题名、作者、年份、DOI、摘要被一起丢掉，
 *   页面上只能显示「未检索到」——这是【无中生有的损失】。
 *   所以现在明确告诉模型：这两件事各答各的，题录答不出来才留空，链接没有才留空数组，互不影响。
 *
 * 真实教训（2026-10-31 实测记录，不是文档推测）：
 *   - 对一条人为构造的中文题录检索，qwen-flash / qwen-plus 均如实返回 exists="no"、links=[]。
 *   - qwen-max 在同样输入下返回了 exists="yes" 并给出一个知网链接，但该链接指向的是
 *     该期刊同一期中的另一篇文章 —— 这是大模型联网检索的【典型误判】。
 *   - 更常见的问题是【链接是拼出来的】：实测出现 worldcat.org/title/1023456789、
 *     sciencereads.com/book/1234567890、凭空生成的 CNKI 书目 ID、假的 OCLC 号，
 *     点开基本是 404 或毫不相关的页面。用户无法据此核对，等于给了假证据。
 *   - 即便 prompt 写得再狠，模型照样给出过 http://www.sciencep.com/book/4050
 *     ——看着像出版社书目详情页，真去访问：302 跳 https，落地 HTTP 404「页面没有找到」。
 *     所以下游还有四层机器校验 + 真机可达性探测，prompt 只是第一道。
 *
 * 处理原则不变：任务 B 的结果【永远】标记为需人工甄别，绝不据此判定「已核实」。
 */

var SYSTEM = [
  '你是文献存在性核查助手，服务于文献题录核验系统。当前 OpenAlex 与 Crossref 两个学术元数据库都没有命中（可能是中文文献、学位论文、书籍，或确实未被这两个库收录）。',
  '任务：使用联网检索核查这条文献是否真实存在，然后分成【两部分、互不依赖】地回答：' +
    '① 你本次搜索实际看到的题录信息与摘要；② 你本次实际打开过的原文详情页链接。',
  '这两部分各答各的：题录答不出来就留空字符串，链接没有就把 links 留空数组。' +
    '【搜到了题录但找不到能打开的链接，是完全正常的结果】，请照实分别作答，不要因为找不到链接就连题录也不报，' +
    '也不要为了凑一条链接去编一个地址。',
  '',
  '=== 题录红线（recordMeta：只能照抄本次看到的） ===',
  '1. title / authors / year / venue / doi / abstract【只能取自本次搜索实际看到的来源摘要】，必须照抄来源上的写法。',
  '2. 【严禁凭记忆补全】你没在本次结果里看到的字段，一律填空字符串，不许按常识推断、不许凑一个合理的值。',
  '3. 【没有摘要就是没有】abstract 只能照抄来源页面/检索摘要里给出的摘要原文；来源没提供摘要就填空字符串，' +
    '【绝对禁止自己撰写、改写、扩写摘要】，也禁止把 summary 的内容复制过来充数。',
  '4. sourceName 填「这条题录是从哪个来源看到的」，取值要与下面 sources 里的 name 对应（例如「知网」「OpenAlex」「出版社官网」）。',
  '',
  '=== 链接红线（candidateLinks：最重要，违反即作废） ===',
  '5. 【禁止编造任何网址】不得根据 DOI 规则、期刊名、卷期页码、ISBN 去推算或拼接链接；不得生成看上去像那么回事的书目 ID、OCLC 号、CNKI 编号。',
  '6. 每一个放进 links 的 url，必须同时出现在你下面输出的 sources 里，即【本次检索实际命中的原始来源链接】，且必须是文献详情页（能直接看到这条文献），不接受首页、检索结果页、频道页。',
  '7. 严禁伪造知网 / 万方 / 维普 / 期刊官网的虚构链接。若只有这类无法确认的链接，就填 linkStatus="url_not_found"、links 为空数组——【诚实说没有】远好过给一个打不开的地址。',
  '8. 每条 links 必须带 source 字段（来源名称，与 sources.name 对应），缺失来源名的链接不要放进来。',
  '9. 来源优先级：开放获取平台 > OpenAlex > Crossref > 出版社 / 期刊官网 > 机构仓储 arXiv/PubMed/DOAJ > 其他学术平台。',
  '',
  '=== 输出字段（严格 JSON，不要解释、不要代码块） ===',
  '- exists：三选一。"yes" = 检索到明确对应的记录；"no" = 检索后确认不存在；"uncertain" = 只找到相似或间接线索，无法确认。',
  '- title / authors（数组）/ year（四位）/ venue / doi（形如 10.xxxx/yyyy）：本次看到的题录，没有则空字符串或空数组。',
  '- abstract：来源给出的摘要原文，【最多 150 字】；来源没给摘要就填空字符串（详见题录红线第 3 条）。',
  '- sourceName：这条题录取自哪个来源的名称。',
  '- sources：数组，你本次实际打开过的来源，每项 {"name":"来源名称","url":"该页面的完整网址"}，【最多 3 条】。' +
    '只放文献详情页级别的来源；不要把带 ?q= / /search 的检索结果页长网址塞进来（检索过哪些平台请用文字写进 summary）。',
  '- links：数组，每项 {"url":"完整网址（必须等于 sources 中某个 url）","source":"来源名称（不得为空）","kind":"openalex|crossref|publisher|repository|cnki|wanfang|scholar|other","note":"不超过 16 字"}，最多 2 条。',
  '- linkStatus："ok" = links 里给出了可靠链接；"url_not_found" = 没有找到可靠可访问的原文详情页链接（此时 links 必须是空数组）。',
  '- summary：不超过 50 字，说明你在哪些来源查到了什么，或为什么查不到 / 为什么没有可用链接。',
  '- confidence：0 到 1 的小数。',
  '',
  '=== 其它硬性规则 ===',
  '10. 只输出 JSON，不要任何解释、不要代码块，也不要重复输出请求结构。',
  '11. 【回答必须精简】sources 最多 3 条、links 最多 2 条、每条说明不超过 16 字、summary 不超过 50 字、abstract 不超过 150 字。' +
    '实测输出过长会被截断，截断后 JSON 作废、你查到的东西全部丢失，等于白查一次。',
  '12. 找不到就如实标记 exists="no" 或 "uncertain"；找不到可用链接就如实标记 linkStatus="url_not_found"。不要为了凑结果而附会相似文献。',
  '13. 「找不到」不等于「文献虚假」——中文文献、学位论文、书籍本来就很少被境外数据库收录，这是覆盖问题不是真伪问题。',
  '14. 只有当题名、作者、年份、出处中的【多项】同时吻合时才能判 "yes"；仅凭同期刊同期有一篇文章，不能判 "yes"。'
].join('\n');

/**
 * 任务 B 的用户消息
 * @param {object} input {title, authors, year, venue, doi, raw}
 */
function buildUser(input) {
  input = input || {};
  var lines = ['请联网检索核查下面这条文献是否真实存在。答题时分两块互不依赖地回答：' +
    '① 本次搜索实际看到的题录与摘要（照抄，没看到就留空）；' +
    '② 本次实际打开过的原文详情页链接（没有可靠链接就 links 留空、linkStatus 填 url_not_found）。'];
  if (input.title) lines.push('题名：' + input.title);
  if (input.titleOrig && input.titleOrig !== input.title) lines.push('原文题名：' + input.titleOrig);
  if (input.authors) lines.push('作者：' + input.authors);
  if (input.year) lines.push('年份：' + input.year);
  if (input.venue) lines.push('期刊 / 会议：' + input.venue);
  if (input.doi) lines.push('DOI：' + input.doi);
  if (input.volume || input.issue || input.pages) {
    lines.push('卷期页码：卷 ' + (input.volume || '?') + '　期 ' + (input.issue || '?') + '　页 ' + (input.pages || '?'));
  }
  if (input.raw) lines.push('用户粘贴的原文：' + String(input.raw).slice(0, 500));
  lines.push('请务必联网检索后再回答，不要凭记忆作答；题录只能照抄本次看到的摘要，链接只能用本次实际命中的来源，严禁编造。');
  return lines.join('\n');
}

/** 任务 B 输出字段的 JSON Schema 示意（仅用于文档与自检，不参与调用） */
var OUTPUT_SCHEMA = {
  exists: 'yes|no|uncertain',
  /* recordMeta（与链接【互不依赖】）：只要本次搜索有可信摘要就输出 */
  title: 'string', authors: ['string'], year: 'string', venue: 'string',
  doi: 'string', abstract: 'string', sourceName: 'string',
  /* candidateLinks（沿用四层机器校验 + 真机可达性探测） */
  sources: [{ name: 'string', url: 'string' }],
  links: [{ url: 'string', source: 'string', kind: 'string', note: 'string' }],
  linkStatus: 'ok|url_not_found',
  summary: 'string', confidence: 'number'
};

module.exports = {
  SYSTEM: SYSTEM,
  buildUser: buildUser,
  OUTPUT_SCHEMA: OUTPUT_SCHEMA
};
