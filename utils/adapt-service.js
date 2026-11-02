/**
 * 课题适配与主张核验服务（前端侧）
 * ============================================================================
 * 与 verify-service.js 一样的架构约束：本文件【只调用小程序云函数】，
 * 不直接访问任何模型接口，也不持有任何密钥。密钥只在云端环境变量里。
 *
 * 运行时真实服务（务必如实理解，别把开发助手的能力算进来）：
 *   - 【分析模型】通义千问（DashScope），由云函数 lfaVerify 中转调用；
 *     未配置 QWEN_API_KEY 时，云函数返回 status='config_failed'，
 *     页面会明确显示「运行时分析服务未配置，本次未执行 AI 分析」，绝不假装完成。
 *   - 【检索服务】Crossref / OpenAlex（只出现在「帮我找文献」与身份核验链路里）。
 *   - 【开发助手】WorkBuddy 只在这个项目的【开发阶段】帮我写代码，
 *     它自己的联网搜索、检索能力【不属于】上线后小程序的运行时能力。
 *
 * 诚实边界：调用失败 / 云函数不可用 / 服务未配置，都如实返回对应状态，
 * 不返回预置样例，不生成假结论。
 */

var CONFIG = require('./cloud-config.js');

var cloudState = { inited: false, error: '' };

function initCloud() {
  if (cloudState.inited) return cloudState;
  if (typeof wx === 'undefined' || !wx.cloud) {
    cloudState.error = '当前环境不支持云开发（wx.cloud 不存在）。请在微信开发者工具或微信客户端中运行。';
    return cloudState;
  }
  try {
    var opt = { traceUser: true };
    if (CONFIG.env) opt.env = CONFIG.env;
    wx.cloud.init(opt);
    cloudState.inited = true;
  } catch (e) {
    cloudState.error = '云开发初始化失败：' + String((e && e.message) || e);
  }
  return cloudState;
}

/** 云函数不可用 / 未配置时的诚实结论：只说「没跑成」，不说文献怎样 */
function unavailable(detail) {
  return {
    ok: false,
    status: 'cloud_unavailable',
    statusText: '未执行适配分析',
    failureKind: 'cloud_unavailable',
    failureDetail: detail,
    evidenceLevel: '',
    evidenceLevelText: '',
    readingScope: '',
    materialsUsed: [],
    dimensions: [],
    matches: [],
    gaps: [],
    usage: null,
    claims: [],
    uncheckedClaims: [],
    nextQueries: [],
    dropped: [],
    note: '本次没有执行任何分析：' + detail + '。这与该文献是否符合课题无关。',
    runtime: null
  };
}

/**
 * 发起一次课题适配 + 主张核验。
 * @param {object} topic 课题（用户确认过的）
 * @param {object} ref 文献条目（含 evidence.abstract / evidence.excerpt）
 * @param {object} opt {claims: [{id, text}]}
 * @returns {Promise<object>} 云函数返回的适配结论
 */
function analyzeFit(topic, ref, opt) {
  opt = opt || {};
  var st = initCloud();
  if (!st.inited) return Promise.resolve(unavailable(st.error));

  var payload = {
    action: 'adapt',
    topic: {
      name: topic.name || '',
      problem: topic.problem || '',
      target: topic.target || '',
      task: topic.task || '',
      resources: topic.resources || '',
      claim: topic.claim || '',
      revision: topic.revision || 1,
      customFields: topic.customFields || []
    },
    ref: {
      title: ref.title || '',
      authors: ref.authors || '',
      year: ref.year || '',
      venue: ref.venue || '',
      doi: ref.doi || '',
      url: ref.url || '',
      evidence: ref.evidence || { link: '', abstract: '', excerpt: '' }
    },
    claims: opt.claims || null
  };

  return new Promise(function (resolve) {
    wx.cloud.callFunction({
      /* 课题适配需要大模型，而 QWEN_API_KEY 只配在「千问那个云函数」上
       * （云开发环境变量按函数隔离），所以这里必须换函数名，否则一律「未配置，未执行」。 */
      name: CONFIG.qwenFunctionName || CONFIG.functionName,
      data: payload,
      success: function (res) {
        var r = res && res.result;
        if (!r || typeof r !== 'object') {
          resolve(unavailable('云函数返回内容为空或格式异常。'));
          return;
        }
        resolve(r);
      },
      fail: function (err) {
        resolve(unavailable('云函数调用失败：' + String((err && err.errMsg) || err) +
          '。请确认已开通云开发并已上传部署「' + (CONFIG.qwenFunctionName || CONFIG.functionName) + '」云函数。'));
      }
    });
  });
}

/** 运行时的能力说明（页面顶部固定展示，避免把开发助手的能力误当成小程序能力） */
function runtimeNotice() {
  return {
    lines: [
      '本页结论由【小程序运行时】调用的分析服务产出：通义千问（DashScope），经云函数中转，密钥只存在云端环境变量。',
      '运行时检索服务：Crossref、OpenAlex（用于「帮我找文献」与题录核验）。本系统【从未】抓取或下载过任何全文。',
      '开发阶段的助手（WorkBuddy）只负责帮我写这个项目的代码，它自带的联网检索【不是】本小程序的能力，不会在运行时被调用。'
    ]
  };
}

module.exports = {
  analyzeFit: analyzeFit,
  unavailable: unavailable,
  runtimeNotice: runtimeNotice
};
