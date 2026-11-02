var store = require('../../utils/store.js');
var rules = require('../../utils/rules.js');
var identityView = require('../../utils/identity.js');
var verifyService = require('../../utils/verify-service.js');

/**
 * 身份核验详情页
 * ------------------------------------------------------------
 * 只处理「这条文献的题录信息是否对得上」，不涉及内容是否正确、能否支持论点。
 *
 * 三个分支互不相等，都不会被判定为「文献不存在」：
 *   ① 没有 DOI        → 题名检索，给候选，交人工甄别
 *   ② 接口未收录      → 公开元数据库未收录，保留人工补证入口
 *   ③ 网络失败/限流   → 网络异常，核验中断，如实报错
 *
 * 人工补证只【新增】一条备注，绝不覆盖系统自动核验的原始结论。
 */

Page({
  data: {
    ref: null,
    refId: '',
    idn: null,
    idnRaw: null,
    manual: { sourceName: '', url: '', title: '', authors: '', year: '', venue: '', note: '' },
    manualList: [],
    hasIdentity: false,
    busy: false,
    historyCount: 0,
    /* 千问兜底的两个折叠区块默认收起：原始候选链接没做过连通性核验，
     * 不能默认铺开跟主展示区的已校验链接混在一起看 */
    showRawLinks: false,
    showAudit: false,
    /* 核验成功后的「一键补全」：只补空字段，冲突字段需勾选确认 */
    fill: null,
    showFill: false,
    fillNote: '',
    ack: null
  },

  onLoad: function (q) {
    this.setData({ refId: q.refId || '' });
    this.load();
  },

  onShow: function () {
    this.load();
  },

  load: function () {
    var ref = store.getRef(this.data.refId);
    if (!ref) {
      this.setData({ ref: null, hasIdentity: false, idn: null, idnRaw: null, manualList: [] });
      return;
    }
    /* 展示层异常不能让详情页整体白屏：构建失败就只显示题录与人工补证 */
    var idn = null;
    try {
      idn = identityView.buildIdentityView(ref.identity);
    } catch (err) {
      console.error('[identity] 构建核验视图失败 refId=' + ref.id, err);
    }
    /* 补全方案：只有真的拿到了来源题录才有东西可补（核验通过 / 单一冲突 / 千问查到题录）
     * 展示层异常同样不能连累整页 */
    var fill = null;
    try {
      fill = identityView.buildFillPlan(ref, ref.identity);
    } catch (err2) {
      console.error('[identity] 构建补全方案失败 refId=' + ref.id, err2);
    }
    var lastFill = store.latestFill(ref);
    var ack = store.latestConflictAck(ref);
    this.setData({
      ref: ref,
      idn: idn,
      idnRaw: ref.identity || null,
      hasIdentity: !!ref.identity,
      manualList: ref.manualEvidence || [],
      historyCount: (ref.identityHistory || []).length,
      fill: fill,
      showFill: !!(fill && fill.ok),
      fillNote: lastFill ? ('上次补全：' + lastFill.at + '，共 ' + lastFill.changed.length + ' 项（来源：' + (lastFill.sourceName || '—') + '）') : '',
      ack: ack
    });
  },

  /** 用户从候选里选定一条：用它的 DOI 通过云函数做一次严格比对 */
  pickCandidate: function (e) {
    var doi = e.currentTarget.dataset.doi;
    var aminerId = e.currentTarget.dataset.aminerId || '';
    var ref = store.getRef(this.data.refId);
    if (!ref || this.data.busy) return;
    if (!doi && !aminerId) {
      /* 千问联网检索给出的链接往往没有 DOI，也没法按 id 精确查，
       * 只能让用户复制链接自己去核对——不能假装能比。 */
      wx.showToast({
        title: '这条既没有 DOI 也没有可精确查询的 id，无法做题录比对，请复制链接后自行核对',
        icon: 'none', duration: 2600
      });
      return;
    }
    var that = this;
    var how = doi
      ? '将以 DOI「' + doi + '」经云函数向外部元数据库精确查询'
      : '将以 AMiner 论文 id「' + aminerId + '」经云函数向 AMiner 精确查询';
    wx.showModal({
      title: '用这条候选做比对',
      content: how + '，并按题名、作者、年份、出处逐项与你填写的内容比对。' +
        '你选的这条不一定正确，比对结果仍是「是否与你填的一致」，需要你自己判断是否为同一篇。',
      confirmText: '用它比对', cancelText: '取消',
      success: function (r) {
        if (!r.confirm) return;
        that.setData({ busy: true });
        wx.showLoading({ title: '核验中', mask: true });
        verifyService.confirmCandidate(ref, doi, aminerId).then(function (res) {
          wx.hideLoading();
          that.setData({ busy: false });
          that.applyResult(ref.id, res);
          wx.showToast({ title: '结论：' + (res.statusText || '未完成'), icon: 'none', duration: 2200 });
        }).catch(function (err) {
          wx.hideLoading();
          that.setData({ busy: false });
          wx.showModal({
            title: '核验未完成',
            content: '没有拿到任何结论：' + String((err && err.message) || err) + '。这与该文献是否存在无关。',
            showCancel: false, confirmText: '知道了'
          });
        });
      }
    });
  },

  /** 保存自动核验结果：旧结果进历史，不覆盖 */
  applyResult: function (refId, res) {
    var topic = store.getActiveTopic();
    if (topic) res.topicRevision = topic.revision;
    store.setIdentity(refId, res);
    var fresh = store.getRef(refId);
    if (topic) store.addEval(refId, rules.evaluate(topic, fresh));
    this.load();
  },

  onManual: function (e) {
    var k = e.currentTarget.dataset.key;
    var patch = {};
    patch['manual.' + k] = e.detail.value;
    this.setData(patch);
  },

  /**
   * 保存人工补证。
   * 关键：走 addManualEvidence【追加】，不用 setIdentity 覆盖；
   * 因此系统自动核验的原始结论始终完整保留。
   */
  saveManual: function () {
    var m = this.data.manual;
    if (!m.sourceName && !m.url && !m.title && !m.authors && !m.year && !m.note) {
      wx.showToast({ title: '请至少填一项补证内容', icon: 'none' });
      return;
    }
    store.addManualEvidence(this.data.refId, {
      sourceName: m.sourceName || '',
      url: m.url || '',
      title: m.title || '',
      authors: m.authors || '',
      year: m.year || '',
      venue: m.venue || '',
      note: m.note || ''
    });
    var topic = store.getActiveTopic();
    if (topic) {
      store.addEval(this.data.refId, rules.evaluate(topic, store.getRef(this.data.refId)));
    }
    this.setData({ manual: { sourceName: '', url: '', title: '', authors: '', year: '', venue: '', note: '' } });
    this.load();
    wx.showToast({ title: '已新增人工备注', icon: 'success' });
  },

  /** 折叠：本次搜索原始候选链接（未做连通性核验，次要区域） */
  toggleRawLinks: function () {
    this.setData({ showRawLinks: !this.data.showRawLinks });
  },

  /* ---------------- 核验成功后的一键补全 ---------------- */

  toggleFill: function () {
    this.setData({ showFill: !this.data.showFill });
  },

  /** 勾选 / 取消某个字段。冲突项默认不勾，勾选即表示「我确认用来源取值覆盖」 */
  toggleFillField: function (e) {
    var i = Number(e.currentTarget.dataset.index);
    var fill = this.data.fill;
    if (!fill || !fill.fields[i]) return;
    fill.fields[i].picked = !fill.fields[i].picked;
    this.setData({ fill: fill });
  },

  toggleFillAbstract: function () {
    var fill = this.data.fill;
    if (!fill || !fill.abstract) return;
    fill.abstract.picked = !fill.abstract.picked;
    this.setData({ fill: fill });
  },

  /**
   * 执行补全。
   * 只写勾选过的字段；冲突字段不勾就一个字都不动。
   * 摘要来自来源接口真实返回；原文节选不由系统生成（只会按你的选择放入并标注为摘要）。
   */
  doFill: function () {
    var fill = this.data.fill;
    if (!fill || !fill.ok) return;
    var pickedFields = fill.fields.filter(function (f) { return f.picked && f.incoming && f.mode !== 'same'; });
    var wantAbstract = !!(fill.abstract && fill.abstract.picked && fill.abstract.text);
    if (!pickedFields.length && !wantAbstract) {
      wx.showToast({ title: '没有勾选任何要补的内容', icon: 'none' });
      return;
    }
    var conflictsPicked = pickedFields.filter(function (f) { return f.mode === 'conflict'; });
    var that = this;
    var lines = [];
    pickedFields.forEach(function (f) { lines.push('· ' + f.label + '：' + (f.current || '（空）') + ' → ' + f.incoming); });
    if (wantAbstract) lines.push('· 摘要：写入来源返回的摘要（' + fill.abstract.text.length + ' 字）');
    var content = '将按来源「' + fill.sourceName + '」的真实返回补全：\n' + lines.join('\n') +
      '\n\n原文节选不在本次补全范围内：系统从未抓取全文，需要你自己粘贴。' +
      (conflictsPicked.length ? '\n\n其中有 ' + conflictsPicked.length + ' 项是你填过且与来源不同的，勾选表示你确认用来源取值覆盖。' : '');

    wx.showModal({
      title: '补全题录与材料',
      content: content,
      confirmText: '确认补全', cancelText: '再看看',
      success: function (r) {
        if (!r.confirm) return;
        /* 摘要默认只进「摘要区」；是否同时放进材料区，让用户在结果页再决定，
         * 避免把摘要悄悄当成原文节选使用 */
        var res = store.fillFromIdentity(that.data.refId, fill, { note: '' });
        if (res.error) { wx.showToast({ title: res.error, icon: 'none' }); return; }
        that.load();
        wx.showModal({
          title: '已补全 ' + res.changed.length + ' 项',
          content: '补全内容全部来自「' + fill.sourceName + '」的返回，已留痕可查。\n' +
            (wantAbstract ? '\n摘要已写入，现在可以直接做课题适配分析（会标注为「基于摘要初筛」）。' : '') +
            '\n\n原文节选仍需你粘贴原文段落；若暂时只有摘要，可点「把来源摘要放入材料区」，' +
            '它会明确标注为摘要，不会被当成读过的原文。',
          showCancel: false, confirmText: '知道了'
        });
      }
    });
  },

  /**
   * 把来源摘要放进材料区（节选位）。
   * 必须打上 excerptOrigin='abstract'，课题适配仍按「基于摘要」计，不谎称读过原文。
   */
  useAbstractAsMaterial: function () {
    var fill = this.data.fill;
    var ref = store.getRef(this.data.refId);
    if (!fill || !fill.abstract || !fill.abstract.text) {
      wx.showToast({ title: '来源这次没有返回摘要', icon: 'none' });
      return;
    }
    var that = this;
    wx.showModal({
      title: '把来源摘要放入材料区',
      content: '这段内容来自「' + fill.sourceName + '」返回的摘要，不是从原文正文摘录的。' +
        '放入后会被标记为【摘要】，课题适配仍按「基于摘要初筛」计，不会说成读过原文节选。',
      confirmText: '放入并标注为摘要', cancelText: '取消',
      success: function (r) {
        if (!r.confirm) return;
        store.fillFromIdentity(that.data.refId, fill, { useAbstractAsMaterial: true, note: '摘要放入材料区（标注为摘要）' });
        that.load();
        wx.showToast({ title: '已放入，标记为摘要', icon: 'none', duration: 2200 });
      }
    });
  },

  /* ---------------- 单一字段冲突的人工确认 ---------------- */

  /**
   * 「题名一致 + 只有 1 项不一致」时系统判为核验通过，但差异必须人工确认。
   * 这里只【追加】一条确认记录，绝不改写自动结论。
   */
  ackConflict: function () {
    var idn = this.data.idn;
    if (!idn || !idn.needsHumanConfirm) return;
    var that = this;
    wx.showModal({
      title: '确认这项差异',
      content: '冲突字段：' + (idn.conflictNamesText || '—') + '\n' +
        '确认后会在本条记录里留下一条人工确认（时间 + 你填的理由），' +
        '系统自动核验的结论原样保留，不会被改写。',
      confirmText: '我已核对', cancelText: '取消',
      success: function (r) {
        if (!r.confirm) return;
        store.ackConflict(that.data.refId, {
          fields: (idn.conflicts || []).map(function (c) {
            return { key: c.key, name: c.name, input: c.input, record: c.record };
          }),
          statusKey: idn.statusKey,
          note: '我已回原文 / 期刊官网核对该字段差异'
        });
        that.load();
        wx.showToast({ title: '已记录人工确认', icon: 'success' });
      }
    });
  },

  /** 折叠：链接保留 / 丢弃原因的校验日志 */
  toggleAudit: function () {
    this.setData({ showAudit: !this.data.showAudit });
  },

  copySourceLink: function () {
    var url = this.data.idn && this.data.idn.sourceUrl;
    if (!url) { wx.showToast({ title: '没有可复制的链接', icon: 'none' }); return; }
    wx.setClipboardData({
      data: url,
      success: function () { wx.showToast({ title: '来源链接已复制', icon: 'none' }); }
    });
  },

  /** 复制千问联网检索给出的链接（用户需自行打开核对） */
  copyLink: function (e) {
    var url = e.currentTarget.dataset.url;
    if (!url) { wx.showToast({ title: '没有可复制的链接', icon: 'none' }); return; }
    wx.setClipboardData({
      data: url,
      success: function () {
        wx.showToast({ title: '链接已复制，请自行打开核对', icon: 'none', duration: 2200 });
      }
    });
  },

  copyRaw: function () {
    var raw = this.data.idnRaw;
    if (!raw || !raw.rawPayload || !raw.rawPayload.json) {
      wx.showToast({ title: '没有留存的原始返回', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: raw.rawPayload.json,
      success: function () { wx.showToast({ title: '来源原始返回已复制', icon: 'none' }); }
    });
  },

  redo: function () {
    var ref = store.getRef(this.data.refId);
    if (!ref || this.data.busy) return;
    var that = this;
    this.setData({ busy: true });
    wx.showLoading({ title: '核验中', mask: true });
    verifyService.verifyOne(ref).then(function (res) {
      wx.hideLoading();
      that.setData({ busy: false });
      that.applyResult(ref.id, res);
      wx.showToast({ title: '结论：' + (res.statusText || '未完成'), icon: 'none', duration: 2200 });
    }).catch(function () {
      wx.hideLoading();
      that.setData({ busy: false });
      wx.showToast({ title: '核验未完成', icon: 'none' });
    });
  }
});
