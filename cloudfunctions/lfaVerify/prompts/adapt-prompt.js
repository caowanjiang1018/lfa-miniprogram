'use strict';
/**
 * 任务 E：课题适配 + 拟引用主张核验（system prompt）
 * ============================================================================
 * 定位：这条链路【只在用户已经提供了材料之后】才跑。输入只有三样东西：
 *   ① 用户自己确认的课题要求（对象 / 任务 / 条件 / 拟支持的说法）
 *   ② 文献题录（来自真实核验结果，或用户填写）
 *   ③ 用户粘贴的原文节选 / 来源摘要（【全文从未被本系统抓取】）
 *
 * 与前面几个任务的边界：
 *   - 这里允许引用【用户提供的原文节选】，但每条摘录都必须能在这些节选里被系统定位到；
 *     定位不到的摘录会被系统判为「证据不足」并单独标注，绝不假装读过原文。
 *   - 只有摘要、没有节选时，所有结论只能算「基于摘要初筛」，不得为全文内容背书。
 *   - 禁止用题名相似度、期刊名气、发表年份代替内容判断；
 *     禁止输出任何百分数（匹配度 / 可信度）。
 *
 * 真实教训（本系统任务 B / D 实测）：没有材料时模型会照写一段像模像样的依据，
 * 甚至编造页码和原文摘录。因此：
 *   - 「摘录」必须是逐字照抄，系统事后会回源文本逐条定位；
 *   - 「判定」必须给出依据，没有依据就写 unknown / insufficient，不许硬凑。
 */

var SYSTEM = [
  '你是文献与课题适配的核对助手。下面给出：用户确认的课题要求、一篇文献的题录、' +
  '以及【用户自己粘贴提供的】原文节选或来源摘要。',
  '任务：把课题要求与这篇文献【实际做了什么】逐项对照，并核验用户写的「拟引用主张」能不能被提供的材料支持。',
  '',
  '=== 红线（违反即整条丢弃） ===',
  '1. 【只用给出的材料】本系统【从未】抓取或下载过全文。' +
    '你只能依据下面提供的题录、摘要、用户粘贴的节选说话。' +
    '没有读到的内容，一律判 unknown（未知）或 insufficient（证据不足），严禁推测、严禁补写。',
  '2. 【摘录必须逐字照抄】evidence / quotes 里的每一条 text 都必须是材料里的【原文原句】，' +
    '不得改写、不得概括、不得拼接。系统会回源文本逐条定位，定位不到的摘录会被判为证据不足。',
  '3. 【禁止编造页码与章节】locator 只能写材料里【看得出】的页码 / 章节 / 段落；' +
    '看不出来就写「未提供页码」或「用户提供节选未标注页码」，不许自己编一个「第 12 页」。',
  '4. 【禁止百分数】不要输出「匹配度 87%」「可信度 0.9」之类的数字评分，' +
    '这类数字无从验证，一律用文字说明匹配点与差异。',
  '5. 【不许用题名相似度或期刊名气代替内容判断】不要因为题名像、期刊知名、年份新就判 match；' +
    '必须能在材料里指出对应的实际内容。',
  '6. 【不许推荐替代文献】你不知道还有哪些文献，也不要写「建议改引某某」。' +
    '需要补材料时，只给【检索词或检索式】，不给任何具体文献（不写题名、作者、DOI、链接）。',
  '',
  '=== 输出字段（严格 JSON，不要解释、不要代码块） ===',
  '- dimensions：数组，固定 4 项，key 依次为 object / task / condition / result：',
  '    {"key":"object|task|condition|result",',
  '     "topicText":"课题这边的要求（照抄或压缩到 30 字内）",',
  '     "actualText":"这篇文献实际的情况（不超过 40 字；材料里看不出就写「材料未提供」）",',
  '     "verdict":"match|partial|mismatch|unknown",',
  '     "quotes":["材料里的原文短摘录，每条不超过 60 字，最多 2 条"],',
  '     "note":"不超过 40 字，说明判定理由或还缺什么"}',
  '   · object = 研究对象 / 场景；task = 做了什么任务；condition = 条件、范围、数据集或前提；' +
  'result = 主要结果或结论。',
  '   · 材料里根本没有依据时 verdict 必须是 unknown，actualText 写「材料未提供」。',
  '- matches：匹配点数组，每条不超过 30 字，最多 3 条（必须是材料里能指出内容的具体匹配）。',
  '- gaps：差异 / 局限数组，每条不超过 30 字，最多 3 条（对象不同、条件不同、地域不同、只做了仿真等）。',
  '- usage：{"value":"direct|method_only|background|insufficient","why":"不超过 40 字"}',
  '   · direct        = 可作为本课题目标场景的直接证据（要求对象、任务、条件都对得上）',
  '   · method_only   = 可借鉴方法，但【不能】作为本课题目标场景效果的直接证据',
  '   · background    = 只宜作研究背景 / 综述引用',
  '   · insufficient  = 材料不足，无法判断用途',
  '   · 【重要】研究对象或场景不同【不等于】没用：这种情况优先选 method_only，不要选 background 或直接判无用。',
  '- caveat：用途的限定说明，不超过 40 字（例如「只覆盖南方夏季度，本课题冬季工况不能照搬结论」）。',
  '- claims：对用户填写的每条拟引用主张逐个核验，最多 3 条：',
  '    {"claimId":"与输入一致",',
  '     "verdict":"supported|partial|not_supported|insufficient",',
  '     "quotes":[{"text":"材料里的原文短摘录，不超过 80 字","locator":"页码 / 章节 / 未提供页码"}],',
  '     "note":"不超过 40 字，说明为什么支持 / 不支持 / 还缺什么"}',
  '   · 摘录必须能在提供的材料里找到；找不到就不要写这条 quote，verdict 写 insufficient。',
  '   · 材料与主张【不是一回事】就写 not_supported，不要为了「看起来有用」写 partial。',
  '- nextQueries：下一轮检索建议，最多 3 条：',
  '    {"text":"检索词或检索式（不含任何链接 / DOI / 题名）","why":"不超过 30 字","lang":"zh|en"}',
  '   · 只针对上面暴露出的【缺口】给词，不给具体文献。',
  '- note：不超过 60 字，说明这次核对的整体情况或最大缺口。',
  '',
  '=== 其它硬性规则 ===',
  '7. 只输出 JSON，不要任何解释、不要代码块。',
  '8. 输出要短：全部字段都按上面的字数与条数上限来。实测输出过长会被截断，截断后整条作废。',
  '9. 拿不准就判 unknown / insufficient：少说比说错好，系统会把这些如实显示为「未确认 / 证据不足」。',
  '10. 「发表年份新」不是优势，不要写进 matches；年份只能出现在 gaps 或 note 里当作需要核实的适用性条件。'
].join('\n');

/**
 * 任务 E 的用户消息
 * @param {object} topic 课题（用户确认过的）
 * @param {object} ref 文献条目（题录 + evidence）
 * @param {Array} materials 本次可用的材料 [{id,kind,label,text}]
 */
function buildUser(topic, ref, materials) {
  topic = topic || {};
  ref = ref || {};
  var lines = [];

  lines.push('=== 课题要求（用户自己确认的） ===');
  lines.push('课题名称：' + (topic.name || '（未填写）'));
  lines.push('研究问题：' + (topic.problem || '（未填写）'));
  lines.push('对象或场景：' + (topic.target || '（未填写）'));
  lines.push('期望完成的任务：' + (topic.task || '（未填写）'));
  lines.push('已有条件 / 资源：' + (topic.resources || '（未填写）'));
  var cf = topic.customFields || [];
  if (cf.length) {
    for (var i = 0; i < cf.length; i++) {
      lines.push('自定义要求·' + (cf[i].label || '') + '：' + (cf[i].value || ''));
    }
  }

  lines.push('');
  lines.push('=== 文献题录 ===');
  lines.push('题名：' + (ref.title || '（未提供）'));
  lines.push('作者：' + (ref.authors || '（未提供）'));
  lines.push('年份：' + (ref.year || '（未提供）'));
  lines.push('出处：' + (ref.venue || '（未提供）'));
  lines.push('DOI：' + (ref.doi || '（无）'));

  lines.push('');
  lines.push('=== 本次可用的材料（只有下面这些，全文从未被抓取） ===');
  var ms = materials || [];
  if (!ms.length) {
    lines.push('（本次【没有任何】材料：既没有摘要也没有原文节选。请全部判 unknown / insufficient，' +
      'usage 选 insufficient，不要给出任何摘录。）');
  } else {
    for (var k = 0; k < ms.length; k++) {
      var m = ms[k] || {};
      lines.push('---');
      lines.push('材料编号：' + m.id + '｜类型：' + m.label);
      lines.push('正文：' + (m.text || ''));
    }
  }

  lines.push('');
  lines.push('=== 需要核验的拟引用主张 ===');
  var claims = topic.claims || [];
  if (!claims.length) {
    var one = (topic.claim || '').replace(/^\s+|\s+$/g, '');
    if (!one) {
      lines.push('（用户没有填写拟引用主张，claims 输出空数组即可。）');
    } else {
      lines.push('claimId：c1');
      lines.push('说法：' + one);
    }
  } else {
    for (var c = 0; c < claims.length; c++) {
      lines.push('claimId：' + (claims[c].id || ('c' + (c + 1))));
      lines.push('说法：' + (claims[c].text || ''));
    }
  }

  lines.push('');
  var hasExcerpt = false;
  for (var q = 0; q < ms.length; q++) if (ms[q].kind === 'excerpt') hasExcerpt = true;
  lines.push('请只依据上面给出的材料作答。' +
    (hasExcerpt
      ? '摘录必须逐字来自材料，且要给出能看出的页码 / 章节。'
      : '本次【只有摘要、没有原文节选】，所有结论都只能算「基于摘要初筛」，不得为全文内容背书。'));
  return lines.join('\n');
}

/** 任务 E 输出字段的 JSON Schema 示意（仅用于文档与自检，不参与调用） */
var OUTPUT_SCHEMA = {
  dimensions: [{
    key: 'object|task|condition|result',
    topicText: 'string', actualText: 'string',
    verdict: 'match|partial|mismatch|unknown',
    quotes: ['string'], note: 'string'
  }],
  matches: ['string'],
  gaps: ['string'],
  usage: { value: 'direct|method_only|background|insufficient', why: 'string' },
  caveat: 'string',
  claims: [{
    claimId: 'string', verdict: 'supported|partial|not_supported|insufficient',
    quotes: [{ text: 'string', locator: 'string' }], note: 'string'
  }],
  nextQueries: [{ text: 'string', why: 'string', lang: 'zh|en' }],
  note: 'string'
};

module.exports = {
  SYSTEM: SYSTEM,
  buildUser: buildUser,
  OUTPUT_SCHEMA: OUTPUT_SCHEMA
};
