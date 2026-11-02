/**
 * 核验服务（前端侧）
 * ============================================================================
 * 架构硬性约束：本文件【只调用小程序云函数】，不发起任何访问 OpenAlex /
 * Crossref 的 wx.request。外部接口地址、请求头、重试与节流策略全部由云函数
 * cloudfunctions/lfaVerify 内部实现，前端完全不感知。
 *
 * 前端只负责：
 *   - 收集用户题录并传给云函数
 *   - 串行排队（多条文献之间留间隔，避免触发上游限流）
 *   - 429 / 超时 的简单退避重试
 *   - 把云函数返回的结论交给页面渲染
 *
 * 诚实边界：云函数不可用（未开通云开发 / 网络不通）时，如实返回
 * 「网络异常，核验中断」，绝不返回预置样例或假成功。
 */

var CONFIG = require('./cloud-config.js');

/* ---------------- 云开发初始化 ---------------- */

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
    cloudState.error = '云开发初始化失败：' + String((e && e.message) || e) +
      '。请先在开发者工具左上角「云开发」中开通环境，并把环境 ID 填进 utils/cloud-config.js。';
  }
  return cloudState;
}

/* ---------------- 串行队列（多条文献之间留间隔） ---------------- */

var PAUSE = 1200;          // 两条文献之间的最小间隔
var MAX_BATCH = 10;        // 单次批量最多处理条数
var MAX_RETRY = 2;         // 429 / 网络错误退避重试次数

var queue = [];
var running = false;

function enqueue(taskFn) {
  return new Promise(function (resolve) {
    queue.push({ fn: taskFn, resolve: resolve });
    pump();
  });
}

function pump() {
  if (running || !queue.length) return;
  running = true;
  var job = queue.shift();
  var last = pump._last || 0;
  var gap = PAUSE - (Date.now() - last);
  var go = function () {
    job.fn(function (result) {
      pump._last = Date.now();
      running = false;
      job.resolve(result);
      pump();
    });
  };
  if (gap > 0) setTimeout(go, gap); else go();
}

/* ---------------- 云函数调用 ---------------- */

/**
 * 调用云函数。
 * 大模型相关 action 自动打到「千问那个云函数」（见 AI_ACTIONS），其余打到核验云函数。
 */
function callVerify(payload, fnName) {
  var st = initCloud();
  if (!st.inited) {
    return Promise.resolve(unavailable(st.error));
  }
  var name = fnName || fnOf(payload);
  /* 时间预算：两段式之后每一次调用都能拿到接近平台一整段上限的时间 */
  if (payload && payload.timeBudgetMs == null) payload.timeBudgetMs = CONFIG.timeBudgetMs;
  return new Promise(function (resolve) {
    wx.cloud.callFunction({
      name: name,
      data: payload,
      success: function (res) {
        var r = res && res.result;
        if (!r || typeof r !== 'object') {
          resolve(unavailable('云函数返回内容为空或格式异常，未获得任何核验结论。'));
          return;
        }
        resolve(r);
      },
      fail: function (err) {
        var msg = String((err && err.errMsg) || err);
        resolve(unavailable('云函数调用失败：' + msg +
          '。请确认已在开发者工具中开通云开发，并已上传部署「' + name + '」云函数。'));
      }
    });
  });
}

/* 要走大模型的 action：它们依赖 QWEN_API_KEY，
 * 而该 Key 只配在另一个云函数上（配置隔离，不能指望核验云函数读到）。 */
var AI_ACTIONS = {
  'extract': 1,           // 任务 A：题录结构化提取
  'ai-verify': 1,         // 任务 B：千问联网检索（单独一段，独占一整段时间预算）
  'discover-plan': 1,     // 生成检索式
  'discover-analyze': 1,  // 候选与课题的关系分析
  'adapt': 1              // 课题适配与主张核验的 AI 分析
};

function fnOf(payload) {
  var act = payload && payload.action;
  return AI_ACTIONS[act] ? (CONFIG.qwenFunctionName || CONFIG.functionName) : CONFIG.functionName;
}

/** 云函数不可用时的诚实结论：只说「没验成」，不说文献怎样 */
function unavailable(detail) {
  return {
    ok: false,
    statusKey: 'network_error',
    statusText: '网络异常，核验中断',
    statusDesc: '接口超时 / 限流 / 网络报错',
    colorHint: '灰色',
    tone: 'gray',
    label: '网络异常，核验中断',
    reason: '本次自动核验未能完成，【未得出任何题录结论】。原因：' + detail +
      '。这与该文献是否存在无关，请稍后重试或改用「人工补证」。',
    provider: null,
    sourceUrl: '', landingUrl: '', apiUrl: '', fetchedAt: timeText(),
    httpStatus: 0, method: 'cloud-call', query: '',
    record: null, rawPayload: null, checks: [], candidates: [],
    failure: { kind: 'cloud_unavailable', detail: detail },
    tried: [],
    input: { doi: '', title: '', authors: '', year: '', venue: '' },
    engineVersion: 'frontend-fallback',
    boundaryNotice: ''
  };
}

function timeText() {
  var d = new Date();
  function p(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ---------------- 对外接口 ---------------- */

/**
 * 核验一条文献（走云函数，OpenAlex 优先 / Crossref 降级都在云函数内完成）
 * @param {object} ref 文献条目
 * @param {object} opt { allowSearch:boolean, retry:number }
 */
function verifyOne(ref, opt) {
  opt = opt || {};
  var base = {
    /* raw = 你粘贴的参考文献原文，先由大模型做结构化提取，
     * 再用提取结果去查三个学术源；未命中才走千问联网检索兜底。
     * 原文只到云函数，前端不做任何外部请求。 */
    raw: ref.raw || '',
    doi: ref.doi || '',
    title: ref.title || '',
    authors: ref.authors || '',
    year: ref.year || '',
    venue: ref.venue || ''
  };

  return stageExtract(base.raw, opt).then(function (ex) {
    var ref2 = ex ? mergeExtract(base, ex) : base;
    if (ex) ref2.aiExtract = ex;

    /* ② 三个学术源：本段不再做任何大模型调用（提取已在①完成、检索兜底交给③） */
    stageSay(opt, 2, '② 正在检索 OpenAlex / Crossref / AMiner…');
    return withRetry({
      action: 'verify',
      ref: ref2,
      allowSearch: opt.allowSearch !== false,
      /* ①已经提取过了就没必要在同一个补偿里再提取一遍，省一次调用的时间 */
      aiExtract: false,
      /* 关键：本段禁用千问，把千问留到③单独一次调用，
       * 这样学术源能用满一整段预算，千问也不会被预算挤到只剩几秒。 */
      aiSearch: false,
      timeBudgetMs: CONFIG.timeBudgetMs
    }, 0, CONFIG.functionName).then(function (first) {
      return { first: first, ref2: ref2 };
    });
  }).then(function (x) {
    var first = x.first;
    var fb = first && first.aiFallback;
    if (!fb || !fb.available) return first;

    /* ③ 千问联网检索：单独一次调用，独占一整段执行时间预算 */
    stageSay(opt, 3, '③ 学术源未命中，正在用通义千问联网检索（最长约 1 分钟）…');
    return withRetry({
      action: 'ai-verify',
      ref: x.ref2,
      /* 把②的留痕带过去，用户看到的是一条完整链路，而不是两段割裂的日志 */
      priorTried: (first && first.tried) || [],
      timeBudgetMs: CONFIG.timeBudgetMs
    }, 0, CONFIG.qwenFunctionName).then(function (second) {
      if (!second || !second.statusKey) {
        /* 第二段没拿到结论：如实返回第一段，不拿异常冒充结论 */
        return first;
      }
      /* 把第一段的结论挂上去，页面能说清「三个学术源查过了、没查到」 */
      second.stageOne = {
        statusKey: first.statusKey,
        label: first.label || '',
        reason: first.reason || ''
      };
      return second;
    });
  });
}

/**
 * 429 / 网络类错误退避重试。
 * 每一次实际请求都要【经过串行队列】，这样多条文献之间才会被强制拉开间隔，
 * 否则并发打上去很容易触发上游限流（实测 Crossref 2 秒间隔都会被限）。
 * @param {object} payload
 * @param {number} tryIdx
 * @param {string} fnName 显式指定打到哪个云函数（不传则按 action 路由）
 */
function withRetry(payload, tryIdx, fnName) {
  return enqueue(function (cb) {
    callVerify(payload, fnName).then(function (res) { cb(res); }, function () { cb(null); });
  }).then(function (res) {
    var retryable = res && res.statusKey === 'network_error' &&
      res.failure && (res.failure.kind === 'ratelimit' || res.failure.kind === 'timeout');
    if (retryable && tryIdx < MAX_RETRY) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          withRetry(payload, tryIdx + 1, fnName).then(resolve);
        }, 2500 * (tryIdx + 1));
      });
    }
    return res;
  });
}

/* --------------------------------------------------------------------------
 * 核验分三段独立调用（每一段各享一整段云函数执行时间预算）
 * --------------------------------------------------------------------------
 *   ① 识别原文      → 大模型  （打到千问云函数；只有粘贴了原文时才需要）
 *   ② 三个学术源    → OpenAlex / Crossref / AMiner（打到核验云函数）
 *   ③ 千问联网检索  → 大模型  （打到千问云函数；仅当②没给出可比对结果时）
 *
 * 为什么必须拆成多次调用：
 *   单次云函数调用的执行上限就是 60 秒，②③ 在链路上是串行的，
 *   挤在一次调用里「AMiner 等够」就意味着「千问只剩几秒必然超时」，反之亦然。
 *   拆开后每段各自独占接近上限的时间预算，谁也不用让谁。
 * ------------------------------------------------------------------------ */

/**
 * ① 把粘贴的原文交给大模型提取结构化字段。
 * 失败不阻断链路：提取只是为了让②检索得更准，失败就退回用户手填的字段。
 */
function stageExtract(raw, opt) {
  if (!raw || opt.aiExtract === false) return Promise.resolve(null);
  stageSay(opt, 1, '① 正在识别你粘贴的原文…');
  return withRetry({ action: 'extract', raw: raw }, 0, CONFIG.qwenFunctionName);
}

/** 用大模型提取结果补全 ref 的空字段（用户已经填过的字段不做覆盖） */
function mergeExtract(ref, ex) {
  var f = ex && ex.ok && ex.fields;
  if (!f) return ref;
  var out = {
    raw: ref.raw, doi: ref.doi, title: ref.title,
    authors: ref.authors, year: ref.year, venue: ref.venue
  };
  var keys = ['doi', 'title', 'authors', 'year', 'venue'];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!String(out[k] || '').trim() && String(f[k] || '').trim()) {
      out[k] = String(f[k]).trim();
    }
  }
  return out;
}

function stageSay(opt, idx, text) {
  if (opt && typeof opt.onStage === 'function') {
    try { opt.onStage(text, idx); } catch (e) { /* 文案回调不能影响主流程 */ }
  }
}

/**
 * 用户在候选列表里选了一条 → 用它的 DOI 重新精确核验
 * 同样全部在云函数内完成。
 */
function confirmCandidate(ref, doi, aminerId) {
  var payload = {
    action: 'verify',
    ref: {
      doi: doi,
      title: ref.title || '',
      authors: ref.authors || '',
      year: ref.year || '',
      venue: ref.venue || '',
      /* AMiner 的候选项只有内部论文 id：带上它云函数才能按 id 精确查询
       * （AMiner 的论文信息接口只接受 id，不支持按 DOI 查）。 */
      aminerId: aminerId || ''
    },
    allowSearch: false,
    /* 用户已从候选里指定了具体条目：不需要再让大模型提取原文，也不需要联网兜底
     * （这两个都需要 QWEN_API_KEY，只有千问那个云函数上才有）。 */
    aiExtract: false,
    aiSearch: false,
    timeBudgetMs: CONFIG.timeBudgetMs,
    mode: 'candidate-confirm'
  };
  return callVerify(payload).then(function (res) {
    if (res && (res.statusKey === 'verified' || res.statusKey === 'verified_one_conflict') && res.reason) {
      res.reason += '（该结论基于你在候选列表中选定的 DOI，比对规则与 DOI 精确核验一致。）';
    }
    return res;
  });
}

/** 连通性自检，便于排查「云开发没开通 / 函数没部署」这类问题 */
function ping() {
  return callVerify({ action: 'ping' });
}

module.exports = {
  verifyOne: verifyOne,
  confirmCandidate: confirmCandidate,
  ping: ping,
  /* 「帮我找文献」链路复用同一条云开发通道（同一个云函数，不同 action） */
  callFn: callVerify,
  PAUSE: PAUSE,
  MAX_BATCH: MAX_BATCH
};
