var store = require('../../utils/store.js');
var rules = require('../../utils/rules.js');
var identityView = require('../../utils/identity.js');
var verifyService = require('../../utils/verify-service.js');
var record = require('../../utils/record.js');
var adaptView = require('../../utils/adapt-view.js');

/**
 * 核验卡页面
 * ------------------------------------------------------------
 * 第二阶段：第 1 项「文献身份和题录」接入【云函数】自动核验结果。
 * 前端不直接访问 OpenAlex / Crossref，只调云函数 lfaVerify。
 *
 * 原有交互与字段全部保留：三项独立结论、查看来源、补充证据、人工确认、复制判断。
 */

var DECISIONS = [
  { key: 'keep', label: '保留引用', desc: '继续作为本课题的正式引用，题录与用途都站得住' },
  { key: 'background', label: '作背景用', desc: '只放在研究背景/综述里，不承担关键论点' },
  { key: 'method', label: '借鉴方法', desc: '方法或实验设计可参考，但研究对象/任务与本课题不同' },
  { key: 'recheck', label: '补充证据后再决定', desc: '先补摘要、原文节选或稳定来源，回来再看' },
  { key: 'drop', label: '暂不采用', desc: '来源查不到或明显不符合要求，先不用' }
];

var CLAIM_VERDICTS = ['原文支持', '需补充条件', '与原文不符', '证据不足'];

/**
 * 卡片右上角【固定】展示的核验结果。
 * 优先用外部来源自动核验的结论；没做过则用本地初判的「文献身份和题录」状态；
 * 都没有就如实显示「待核验」——绝不显示一个看起来像成功的结果。
 * @param {object} ev  本地初判（可能为 null）
 * @param {object} idn 自动核验视图模型（可能为 null）
 */
function resultChip(ev, idn) {
  if (idn && idn.statusText) {
    return { text: idn.statusText, tone: idn.tone || 'gray', icon: idn.icon || '·' };
  }
  if (ev && ev.identity && ev.identity.label) {
    return { text: ev.identity.label, tone: ev.identity.tone || 'gray', icon: '' };
  }
  return { text: '尚未自动核验（待核验）', tone: 'gray', icon: '·' };
}

Page({
  data: {
    topic: null,
    hasTopic: false,
    cards: [],
    decisions: DECISIONS,
    claimVerdicts: CLAIM_VERDICTS,
    staleCount: 0,
    idnStaleCount: 0,
    batching: false,
    draft: {} // index -> {decision, reason, claimVerdict}
  },

  onShow: function () {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    this.refresh();
  },

  refresh: function () {
    var topic = store.getActiveTopic();
    if (!topic) {
      this.setData({ hasTopic: false, topic: null, cards: [], staleCount: 0, idnStaleCount: 0 });
      return;
    }
    var refs = store.getRefs(topic.id);
    var cards = [];
    var staleCount = 0;
    var idnStaleCount = 0;
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i];
      var ev = store.latestEval(r);
      var cf = store.latestConfirm(r);
      var stale = store.isStale(r, topic);
      var idnStale = store.isIdentityStale(r, topic);
      if (stale) staleCount++;
      if (idnStale) idnStaleCount++;
      /* 自动核验结果的视图模型（算一次，后面多处复用）
       * 用 try/catch 兜住：单条结果的展示层异常不能让整页文献都渲染不出来。 */
      var idn = null;
      try {
        idn = identityView.buildIdentityView(r.identity);
      } catch (err) {
        console.error('[verify] 构建核验视图失败，该条仅显示题录 refId=' + r.id, err);
      }
      var chip = resultChip(ev, idn);
      /* 第五阶段：单一字段冲突的人工确认状态 + 可补全提示 */
      var ack = store.latestConflictAck(r);
      var fill = null;
      try {
        fill = identityView.buildFillPlan(r, r.identity);
      } catch (err2) {
        console.error('[verify] 构建补全方案失败 refId=' + r.id, err2);
      }
      /* 第四阶段：课题适配与主张核验的轻量状态（详情页里做完整对照） */
      var av = null;
      try {
        av = adaptView.buildAdaptView(r.adapt, r.usageDecision, r.adaptConfirm, topic);
      } catch (err) {
        console.error('[verify] 构建适配视图失败 refId=' + r.id, err);
      }
      cards.push({
        adaptText: av ? (av.confirmed
          ? '已确认'
          : (av.ok ? '已分析 · 未确认'
            : (av.status === 'config_failed' ? '运行时服务未配置'
              : (av.status === 'no_material' ? '材料不足' : '未分析')))) : '未分析',
        adaptTone: av ? (av.confirmed ? 'ok' : (av.ok ? 'purple' : 'gray')) : 'gray',
        adaptConfirmed: !!(av && av.confirmed),
        adaptUsage: (av && av.usage) ? av.usage.text : '',
        adaptUsageSource: (av && av.usage) ? av.usage.sourceText : '',
        /* 卡片右上角【固定】展示的核验结果；详细内容默认收起，点「展开详细核验内容」再看 */
        resultText: chip.text,
        resultTone: chip.tone,
        resultIcon: chip.icon,
        /* 「题名一致 + 仅 1 项不一致」：判通过但差异待确认 */
        needsConfirm: !!(idn && idn.needsHumanConfirm),
        conflictNames: idn ? idn.conflictNamesText : '',
        confirmedDiff: !!ack,
        confirmedDiffAt: ack ? ack.at : '',
        /* 核验成功后可一键补全（只补空字段；冲突项需人工确认） */
        canFill: !!(fill && fill.ok),
        fillCount: fill ? fill.canFill : 0,
        fillConflictCount: fill ? fill.canConflict : 0,
        expanded: false,
        id: r.id,
        index: i,
        no: i + 1,
        title: rules.trim(r.title) || '（未填写题名）',
        origin: r.origin,
        originLabel: r.origin === 'sample' ? '演示样例'
          : (r.origin === 'discover' ? '系统检索推荐' : '我的粘贴'),
        isSample: r.origin === 'sample',
        /* 第三阶段：检索推荐进来的条目，把系统原始推荐一并展示（与人工确认分开） */
        recommend: r.recommend || null,
        recommendUses: (r.recommend && r.recommend.uses) ? r.recommend.uses.join('、') : '',
        recommendSource: (r.recommend && r.recommend.source) || '',
        recommendBasis: (r.recommend && r.recommend.evidenceText) || '',
        raw: r.raw,
        note: r.note,
        dupNote: r.dupNote,
        fieldsEdited: r.fieldsEdited,
        fieldsBrief: [
          r.authors, r.year, r.venue, r.doi, r.url
        ].filter(function (x) { return !!x; }).join(' · '),
        ev: ev,
        // 自动核验（云函数）结果的视图模型
        idn: idn,
        // 尚未自动核验时，把「能力边界」直接说清楚，避免用户以为点一下就能核任何文献
        idnBoundary: r.identity ? '' : identityView.boundaryShort(),
        idnBusy: false,
        idnStale: idnStale,
        idnRaw: r.identity,
        manualList: r.manualEvidence || [],
        manualCount: (r.manualEvidence || []).length,
        idnHistoryCount: (r.identityHistory || []).length,
        evalAt: ev ? ev.at : '',
        evalRevision: ev ? ev.revision : 0,
        evalHistoryCount: (r.evals || []).length,
        confirmHistoryCount: (r.confirms || []).length,
        confirm: cf,
        stale: stale,
        hasEval: !!ev,
        evidence: r.evidence || { link: '', abstract: '', excerpt: '' },
        showSource: false,
        showConfirm: false,
        showLog: false
      });
    }
    var draft = this.data.draft || {};
    this.setData({
      hasTopic: true, topic: topic, cards: cards,
      staleCount: staleCount, idnStaleCount: idnStaleCount, draft: draft
    });
  },

  /** 保存一次自动核验结论：旧结果进历史，绝不覆盖 */
  applyResult: function (refId, res) {
    var topic = store.getActiveTopic();
    if (topic) res.topicRevision = topic.revision;
    store.setIdentity(refId, res);
    var fresh = store.getRef(refId);
    if (topic) store.addEval(refId, rules.evaluate(topic, fresh));
  },

  /** 单条：调用云函数做真实身份核验 */
  verifyIdentity: function (e) {
    var idx = e.currentTarget.dataset.index;
    var card = this.data.cards[idx];
    var ref = store.getRef(card.id);
    if (!ref || this.data.batching) return;

    this.setData({ ['cards[' + idx + '].idnBusy']: true });
    var that = this;
    /* 接入通义千问兜底后，走联网检索的条目实测要 8~15 秒，
     * 必须给出明确等待提示，否则用户会以为点了没反应。 */
    wx.showLoading({ title: '核验中，最长约 20 秒', mask: true });

    verifyService.verifyOne(ref).then(function (res) {
      wx.hideLoading();
      that.applyResult(ref.id, res);
      wx.showToast({ title: '核验结论：' + (res.statusText || '未完成'), icon: 'none', duration: 2200 });
      that.refresh();
    }).catch(function (err) {
      wx.hideLoading();
      that.setData({ ['cards[' + idx + '].idnBusy']: false });
      wx.showModal({
        title: '核验未完成',
        content: '程序内部错误，没有拿到任何核验结论：' + String((err && err.message) || err) +
          '。这与该文献是否存在无关，请重试或人工补证。',
        showCancel: false, confirmText: '知道了'
      });
    });
  },

  /** 打开身份核验详情页：候选选择 + 人工补证 */
  openIdentityDetail: function (e) {
    var idx = e.currentTarget.dataset.index;
    wx.navigateTo({ url: '/pages/identity/identity?refId=' + this.data.cards[idx].id });
  },

  /** 打开课题适配与主张核验页：逐项对照 + 原文证据 + 用途修订 */
  openAdapt: function (e) {
    var idx = e.currentTarget.dataset.index;
    wx.navigateTo({ url: '/pages/adapt/adapt?refId=' + this.data.cards[idx].id });
  },

  /** 批量核验：单次最多 10 条，串行执行（间隔由云函数中转层的队列统一控制） */
  verifyAll: function () {
    var refs = store.getRefs(this.data.topic.id);
    if (!refs.length) { wx.showToast({ title: '没有文献', icon: 'none' }); return; }

    var batch = refs.slice(0, verifyService.MAX_BATCH);
    var that = this;

    wx.showModal({
      title: '批量核验说明',
      content: '单次最多处理 ' + verifyService.MAX_BATCH + ' 条' +
        (refs.length > verifyService.MAX_BATCH
          ? '（当前课题共 ' + refs.length + ' 条，本次只处理前 ' + verifyService.MAX_BATCH + ' 条）'
          : '（当前课题共 ' + refs.length + ' 条）') +
        '。将按顺序逐条请求云函数（OpenAlex 优先，失败自动降级 Crossref；' +
        '条与条之间留约 1.2 秒间隔，防止上游限流）。' +
        '核验只比对题录字段，不代表内容结论已被核实。',
      confirmText: '开始', cancelText: '取消',
      success: function (r) { if (r.confirm) that.runBatch(batch); }
    });
  },

  /** 串行执行批量核验；返回 Promise，便于调用方等待与测试 */
  runBatch: function (batch) {
    var total = batch.length;
    var done = 0;
    var that = this;
    this.setData({ batching: true });
    wx.showLoading({ title: '核验 0/' + total, mask: true });

    return new Promise(function (resolve) {
      function next(i) {
        if (i >= batch.length) {
          wx.hideLoading();
          that.setData({ batching: false });
          that.refresh();
          wx.showModal({
            title: '批量核验完成',
            content: '共处理 ' + total + ' 条。结果已写入各自核验卡，请逐条查看。' +
              '「网络异常，核验中断」表示接口侧问题，不等于文献不存在；' +
              '「公开元数据库未收录」表示两个源都没查到，也不等于文献不存在。',
            showCancel: false, confirmText: '知道了'
          });
          resolve({ total: total, done: done });
          return;
        }
        verifyService.verifyOne(batch[i]).then(function (res) {
          that.applyResult(batch[i].id, res);
          done++;
          wx.showLoading({ title: '核验 ' + done + '/' + total, mask: true });
          next(i + 1);
        }).catch(function () {
          done++;
          next(i + 1);
        });
      }
      next(0);
    });
  },

  /**
   * 云函数连通性自检。
   * 用于快速区分「云开发没开通 / 函数没部署 / 上游接口不通」这几类问题，
   * 避免用户把「没验成」误读成「文献有问题」。
   */
  pingCloud: function () {
    var that = this;
    wx.showLoading({ title: '自检中', mask: true });
    verifyService.ping().then(function (r) {
      wx.hideLoading();
      if (r && r.ok) {
        var limit = Number(r.platformTimeoutMs || 0);
        var limitText = limit
          ? ('\n云函数执行超时：' + limit + ' 毫秒' +
            (limit < 8000 ? '（偏小，双源降级可能跑不完，建议调到 20000）' : ''))
          : '';
        var qw = r.qwen || {};
        var qwText = '\n通义千问：' + (qw.configured
          ? ('已配置（' + (qw.keySource || '环境变量') + '）｜提取 ' +
            (qw.modelExtract || '—') + '｜检索 ' + (qw.modelSearch || '—'))
          : '【未配置】环境变量 QWEN_API_KEY 缺失，千问提取与联网检索兜底都不会执行' +
            '（其余功能不受影响）');
        wx.showModal({
          title: '云函数可用',
          content: '云函数 lfaVerify 连接正常。\n引擎版本：' + (r.engineVersion || '—') +
            '\n数据源顺序：' + (r.sources || []).join(' → ') + limitText + qwText +
            '\n时间：' + (r.at || '—'),
          showCancel: false, confirmText: '知道了'
        });
      } else {
        wx.showModal({
          title: '云函数不可用',
          content: (r && r.reason) || '未获得云函数响应。',
          showCancel: false, confirmText: '知道了'
        });
      }
    }).catch(function (e) {
      wx.hideLoading();
      wx.showModal({
        title: '云函数不可用',
        content: '自检失败：' + String((e && e.message) || e),
        showCancel: false, confirmText: '知道了'
      });
    });
  },

  goImport: function () {
    wx.navigateTo({ url: '/pages/import/import' });
  },

  goEdit: function (e) {
    var idx = e.currentTarget.dataset.index;
    var card = this.data.cards[idx];
    wx.navigateTo({ url: '/pages/import/import?mode=edit&refId=' + card.id });
  },

  toggleSource: function (e) {
    var idx = e.currentTarget.dataset.index;
    var patch = {};
    patch['cards[' + idx + '].showSource'] = !this.data.cards[idx].showSource;
    this.setData(patch);
  },

  toggleConfirm: function (e) {
    var idx = e.currentTarget.dataset.index;
    var patch = {};
    patch['cards[' + idx + '].showConfirm'] = !this.data.cards[idx].showConfirm;
    this.setData(patch);
  },

  /** 展开 / 收起该条的详细核验内容（默认收起） */
  toggleCard: function (e) {
    var idx = e.currentTarget.dataset.index;
    var patch = {};
    patch['cards[' + idx + '].expanded'] = !this.data.cards[idx].expanded;
    this.setData(patch);
  },

  toggleLog: function (e) {
    var idx = e.currentTarget.dataset.index;
    var patch = {};
    patch['cards[' + idx + '].showLog'] = !this.data.cards[idx].showLog;
    this.setData(patch);
  },

  reJudge: function (e) {
    var idx = e.currentTarget.dataset.index;
    var that = this;
    var card = this.data.cards[idx];
    wx.showModal({
      title: '按当前课题重新初判',
      content: '将基于课题第 ' + this.data.topic.revision + ' 版重新计算三项判断。原有初判会保留在历史里，不会被删除或覆盖。',
      confirmText: '重新初判',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        var ref = store.getRef(card.id);
        var ev = rules.evaluate(that.data.topic, ref);
        store.addEval(ref.id, ev);
        that.refresh();
        wx.showToast({ title: '已按第 ' + that.data.topic.revision + ' 版重新初判', icon: 'none' });
      }
    });
  },

  reJudgeAll: function () {
    var that = this;
    if (!this.data.staleCount) return;
    wx.showModal({
      title: '全部重新初判',
      content: '有 ' + this.data.staleCount + ' 条记录的初判基于旧版课题，将按第 ' + this.data.topic.revision + ' 版重算（历史保留）。',
      confirmText: '全部重算',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        var refs = store.getRefs(that.data.topic.id);
        var n = 0;
        for (var i = 0; i < refs.length; i++) {
          if (store.isStale(refs[i], that.data.topic)) {
            store.addEval(refs[i].id, rules.evaluate(that.data.topic, refs[i]));
            n++;
          }
        }
        that.refresh();
        wx.showToast({ title: '已重算 ' + n + ' 条', icon: 'success' });
      }
    });
  },

  pickDecision: function (e) {
    var idx = e.currentTarget.dataset.index;
    var patch = {};
    patch['draft[' + idx + '].decision'] = e.currentTarget.dataset.key;
    this.setData(patch);
  },

  pickVerdict: function (e) {
    var idx = e.currentTarget.dataset.index;
    var patch = {};
    patch['draft[' + idx + '].claimVerdict'] = e.currentTarget.dataset.val;
    this.setData(patch);
  },

  onReason: function (e) {
    var idx = e.currentTarget.dataset.index;
    var patch = {};
    patch['draft[' + idx + '].reason'] = e.detail.value;
    this.setData(patch);
  },

  submitConfirm: function (e) {
    var idx = e.currentTarget.dataset.index;
    var card = this.data.cards[idx];
    var d = this.data.draft[idx] || {};
    var that = this;
    if (!d.decision) {
      wx.showToast({ title: '先选择一个使用决定', icon: 'none' });
      return;
    }
    var label = '';
    for (var i = 0; i < DECISIONS.length; i++) {
      if (DECISIONS[i].key === d.decision) label = DECISIONS[i].label;
    }

    function write() {
      store.addConfirm(card.id, {
        decision: d.decision,
        decisionLabel: label,
        reason: d.reason || '',
        claimVerdict: d.claimVerdict || '未选择',
        basedOnRevision: that.data.topic.revision
      });
      that.refresh();
      wx.showToast({ title: '已记录人工确认', icon: 'success' });
    }

    if (card.stale) {
      wx.showModal({
        title: '该条初判已过期',
        content: '这张核验卡的三项初判基于课题第 ' + card.evalRevision + ' 版，当前已是第 ' + that.data.topic.revision + ' 版。建议先「按当前课题重新初判」再确认。仍然要现在记录吗？',
        confirmText: '仍然记录',
        cancelText: '先重判',
        success: function (r) { if (r.confirm) write(); }
      });
      return;
    }
    write();
  },

  copyEval: function (e) {
    var idx = e.currentTarget.dataset.index;
    var card = this.data.cards[idx];
    var text = record.buildRefSingle(this.data.topic, store.getRef(card.id));
    wx.setClipboardData({
      data: text,
      success: function () { wx.showToast({ title: '已复制该条判断', icon: 'none' }); }
    });
  },

  copyRaw: function (e) {
    var idx = e.currentTarget.dataset.index;
    var idn = this.data.cards[idx].idnRaw;
    if (!idn || !idn.rawPayload || !idn.rawPayload.json) {
      wx.showToast({ title: '没有留存的原始返回', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: idn.rawPayload.json,
      success: function () { wx.showToast({ title: '来源原始返回已复制', icon: 'none' }); }
    });
  },

  openLink: function (e) {
    var url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: function () {
        wx.showModal({
          title: '链接已复制',
          content: url + '\n\n小程序内不自动打开外链，请粘贴到浏览器自行核对来源是否可访问。',
          showCancel: false,
          confirmText: '知道了'
        });
      }
    });
  }
});
