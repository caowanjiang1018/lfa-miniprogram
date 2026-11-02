var store = require('../../utils/store.js');
var rules = require('../../utils/rules.js');
var record = require('../../utils/record.js');
var adaptService = require('../../utils/adapt-service.js');
var adaptView = require('../../utils/adapt-view.js');

/**
 * 课题适配与主张核验页
 * ------------------------------------------------------------
 * 这一页回答两个问题：
 *   ① 这篇文献【实际做了什么】和你课题要求的【对象 / 任务 / 条件 / 结果】逐项对得上吗？
 *   ② 你写下的「拟引用主张」，能不能被你提供的原文材料支持？
 *
 * 铁律（页面层同样守住）：
 *   - AI 推断与原文摘录【分开呈现】，摘录必须带定位结论，定位不到就是证据不足；
 *   - 没有全文：只有摘要时全文结论一律标注「基于摘要初筛」；
 *   - 自动结论永远显示「未确认」，只有用户点确认后才标「已确认」；
 *   - 用户可以改用途并写理由，改完【另存一层】，自动结论原样保留；
 *   - 运行时分析服务未配置 / 调用失败 / 材料不足，都有可见状态，不假装完成。
 */

Page({
  data: {
    refId: '',
    ref: null,
    topic: null,
    view: null,
    usageDraft: '',      // 用户选中的用途 value
    reasonDraft: '',     // 用户写的理由
    editingUsage: false,
    busy: false,
    showRuntime: false,
    showDropped: false,
    showRaw: false,
    materialBlocked: false,
    materialBlockedText: '',
    notice: null
  },

  onLoad: function (q) {
    this.setData({
      refId: (q && q.refId) || '',
      notice: adaptService.runtimeNotice()
    });
  },

  onShow: function () {
    this.load();
  },

  load: function () {
    var ref = store.getRef(this.data.refId);
    if (!ref) {
      this.setData({ ref: null, view: null });
      return;
    }
    var topic = store.getActiveTopic();
    var view = adaptView.buildAdaptView(ref.adapt, ref.usageDecision, ref.adaptConfirm, topic);
    /* 课题换版后旧结论不能沿用 */
    if (view.ok && store.isAdaptStale(ref, topic)) {
      view.statusText = '结论已过期，需按当前课题重新分析';
      view.statusTone = 'orange';
    }
    this.setData({
      ref: ref,
      topic: topic,
      view: view,
      usageDraft: (ref.usageDecision && ref.usageDecision.value) || '',
      reasonDraft: (ref.usageDecision && ref.usageDecision.reason) || ''
    });
  },

  /* ---------------- 发起分析 ---------------- */

  run: function () {
    var that = this;
    var ref = this.data.ref;
    var topic = this.data.topic;
    if (!ref || !topic || this.data.busy) return;

    /* 材料不足时不必浪费一次调用：直接把可见状态告诉用户。
     * 除了弹窗，还在页面里留一块常驻提示——弹窗关掉后原因依然看得见。 */
    var hasMat = !!(rules.trim(ref.evidence.abstract) || rules.trim(ref.evidence.excerpt));
    if (!hasMat) {
      var why = '这条文献既没有摘要，也没有你粘贴的原文节选。' +
        '在只有题录的情况下做「内容判断」就是编造，因此系统不会发起分析。' +
        '请先去「补充证据 / 修正字段」粘贴摘要或结论段落。';
      this.setData({ materialBlocked: true, materialBlockedText: why });
      wx.showModal({
        title: '没有可用材料', content: why, showCancel: false, confirmText: '知道了'
      });
      return;
    }
    this.setData({ materialBlocked: false, materialBlockedText: '' });

    this.setData({ busy: true });
    wx.showLoading({ title: '分析中，最长约 20 秒', mask: true });

    adaptService.analyzeFit(topic, ref, {}).then(function (res) {
      wx.hideLoading();
      that.setData({ busy: false });
      store.setAdapt(ref.id, res, topic);
      that.load();
      var v = adaptView.buildAdaptView(res, null, null, topic);
      if (res.ok) {
        wx.showToast({ title: '分析完成，结论待你确认', icon: 'none', duration: 2400 });
      } else if (res.status === 'config_failed') {
        wx.showModal({
          title: '运行时分析服务未配置',
          content: '云函数环境变量 QWEN_API_KEY 缺失，本次【没有】执行任何 AI 分析，' +
            '页面不会显示任何分析结论。配置并重新部署云函数后可再次发起。',
          showCancel: false, confirmText: '知道了'
        });
      } else {
        wx.showModal({
          title: v.statusText || '分析未完成',
          content: v.failureText || v.note || '本次没有产出任何结论。',
          showCancel: false, confirmText: '知道了'
        });
      }
    });
  },

  /* ---------------- 用途修订 ---------------- */

  toggleUsageEdit: function () {
    this.setData({ editingUsage: !this.data.editingUsage });
  },

  pickUsage: function (e) {
    this.setData({ usageDraft: e.currentTarget.dataset.value });
  },

  onReason: function (e) {
    this.setData({ reasonDraft: e.detail.value });
  },

  saveUsage: function () {
    var that = this;
    var v = this.data.usageDraft;
    if (!v) { wx.showToast({ title: '先选择一种用途', icon: 'none' }); return; }
    var op = adaptView.usageOption(v);
    if (!op) { wx.showToast({ title: '用途取值无效', icon: 'none' }); return; }

    store.setUsageDecision(
      this.data.refId, v, op.text, this.data.reasonDraft, this.data.topic
    );
    this.setData({ editingUsage: false });
    this.load();
    wx.showToast({ title: '已记录你的用途决定（自动结论保留）', icon: 'none', duration: 2400 });
  },

  /** 把用途改回分析服务的建议（同样是新增一层，不删历史） */
  restoreAiUsage: function () {
    var ref = this.data.ref;
    var ai = null;
    for (var i = (ref.usageHistory || []).length - 1; i >= 0; i--) {
      if (ref.usageHistory[i].source === 'ai') { ai = ref.usageHistory[i]; break; }
    }
    if (!ai) { wx.showToast({ title: '没有可恢复的分析服务建议', icon: 'none' }); return; }
    var that = this;
    wx.showModal({
      title: '恢复分析服务的建议',
      content: '将把用途改回「' + ai.text + '」。你之前的修改会保留在历史里，不会丢失。',
      confirmText: '恢复', cancelText: '取消',
      success: function (r) {
        if (!r.confirm) return;
        store.setUsageDecision(that.data.refId, ai.value, ai.text, '恢复为分析服务建议', that.data.topic);
        that.load();
      }
    });
  },

  /* ---------------- 人工确认 ---------------- */

  confirm: function () {
    var that = this;
    var ref = this.data.ref;
    if (!ref || !ref.adapt || !ref.adapt.ok) {
      wx.showToast({ title: '没有可确认的分析结论', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '确认为「已确认」',
      content: '确认表示：你已经看过上面的逐项对照与原文摘录，并接受当前用途。' +
        '自动结论不会因此被改写；之后课题换版会重新标记为「需重新分析」。',
      confirmText: '确认', cancelText: '取消',
      success: function (r) {
        if (!r.confirm) return;
        store.confirmAdapt(ref.id, '用户确认', that.data.topic);
        that.load();
        wx.showToast({ title: '已标记为已确认', icon: 'success' });
      }
    });
  },

  /* ---------------- 折叠区 ---------------- */

  toggleRuntime: function () { this.setData({ showRuntime: !this.data.showRuntime }); },
  toggleDropped: function () { this.setData({ showDropped: !this.data.showDropped }); },
  toggleRaw: function () { this.setData({ showRaw: !this.data.showRaw }); },

  /* ---------------- 下一轮检索建议 ---------------- */

  copyQuery: function (e) {
    var text = e.currentTarget.dataset.text;
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: function () { wx.showToast({ title: '检索式已复制', icon: 'none' }); }
    });
  },

  /** 带着这条建议去「帮我找文献」：只传检索式，不传任何文献 */
  useQuery: function (e) {
    var text = e.currentTarget.dataset.text;
    if (!text) return;
    try {
      wx.setStorageSync('lfa_next_query_seed', { text: text, at: Date.now() });
    } catch (err) { /* 存不下就直接跳，用户在页面上自己贴也一样 */ }
    wx.navigateTo({ url: '/pages/discover/discover' });
  },

  /* ---------------- 导出 / 复制 ---------------- */

  copyRecord: function () {
    var text = record.buildAdaptText(this.data.topic, this.data.ref);
    wx.setClipboardData({
      data: text,
      success: function () { wx.showToast({ title: '该条适配记录已复制', icon: 'none' }); }
    });
  },

  goEvidence: function () {
    wx.navigateTo({ url: '/pages/import/import?mode=edit&refId=' + this.data.refId });
  },

  goDiscover: function () {
    wx.navigateTo({ url: '/pages/discover/discover' });
  }
});
