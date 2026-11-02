var store = require('../../utils/store.js');
var record = require('../../utils/record.js');

Page({
  data: {
    topic: null,
    hasTopic: false,
    items: [],
    total: 0,
    confirmedCount: 0,
    staleCount: 0,
    sampleCount: 0
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
      this.setData({ hasTopic: false, topic: null, items: [], total: 0, confirmedCount: 0, staleCount: 0, sampleCount: 0 });
      return;
    }
    var refs = store.getRefs(topic.id);
    var items = [];
    var confirmedCount = 0, staleCount = 0, sampleCount = 0;
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i];
      var ev = store.latestEval(r);
      var cf = store.latestConfirm(r);
      var stale = store.isStale(r, topic);
      if (cf) confirmedCount++;
      if (stale) staleCount++;
      if (r.origin === 'sample') sampleCount++;
      items.push({
        id: r.id,
        index: i,
        no: i + 1,
        title: (r.title || '（未填写题名）'),
        originLabel: r.origin === 'sample' ? '演示样例' : '我的粘贴',
        isSample: r.origin === 'sample',
        hasEval: !!ev,
        ev: ev,
        evalAt: ev ? ev.at : '',
        evalRevision: ev ? ev.revision : 0,
        evalHistoryCount: (r.evals || []).length,
        confirms: r.confirms || [],
        latestConfirm: cf,
        confirmHistoryCount: (r.confirms || []).length,
        stale: stale,
        sources: this.sourceList(r)
      });
    }
    this.setData({
      hasTopic: true, topic: topic, items: items, total: refs.length,
      confirmedCount: confirmedCount, staleCount: staleCount, sampleCount: sampleCount
    });
  },

  sourceList: function (r) {
    var out = [];
    if (r.raw) out.push('粘贴原文');
    if (r.evidence && r.evidence.link) out.push('原始链接');
    if (r.evidence && r.evidence.abstract) out.push('摘要');
    if (r.evidence && r.evidence.excerpt) out.push('原文节选');
    if (r.fieldsEdited) out.push('人工修正字段');
    if (!out.length) out.push('无材料');
    return out.join(' · ');
  },

  copyOne: function (e) {
    var idx = e.currentTarget.dataset.index;
    var ref = store.getRef(this.data.items[idx].id);
    var text = record.buildRefSingle(this.data.topic, ref);
    wx.setClipboardData({
      data: text,
      success: function () { wx.showToast({ title: '该条记录已复制', icon: 'none' }); }
    });
  },

  copyAll: function () {
    var refs = store.getRefs(this.data.topic.id);
    if (!refs.length) {
      wx.showToast({ title: '还没有任何核验记录', icon: 'none' });
      return;
    }
    var text = record.buildFullText(this.data.topic, refs);
    wx.setClipboardData({
      data: text,
      success: function () { wx.showToast({ title: '完整记录已复制', icon: 'none', duration: 2000 }); }
    });
  },

  exportFile: function () {
    var refs = store.getRefs(this.data.topic.id);
    if (!refs.length) {
      wx.showToast({ title: '还没有任何核验记录', icon: 'none' });
      return;
    }
    var text = record.buildFullText(this.data.topic, refs);
    var path = '';
    try {
      var fs = wx.getFileSystemManager();
      path = wx.env.USER_DATA_PATH + '/核验记录_' + Date.now() + '.txt';
      fs.writeFileSync(path, text, 'utf8');
    } catch (err) {
      wx.setClipboardData({ data: text });
      wx.showToast({ title: '文件写入失败，已改为复制文本', icon: 'none' });
      return;
    }
    wx.openDocument({
      filePath: path,
      fileType: 'txt',
      showMenu: true,
      success: function () { wx.showToast({ title: '已生成文本文件', icon: 'none' }); },
      fail: function () {
        wx.setClipboardData({ data: text });
        wx.showModal({
          title: '已生成文件，但无法直接预览',
          content: '文件位置：' + path + '\n\ntxt 预览在当前环境不支持，内容已同时复制到剪贴板，可直接粘贴到笔记或文档里保存。',
          showCancel: false,
          confirmText: '知道了'
        });
      }
    });
  },

  /**
   * 删除单条文献记录（不可逆）。
   * 会连同它的全部留档一起删掉：粘贴原文、自动初判、每一次人工确认、核验历史，
   * 导出里也不再体现，所以必须先说清楚再让用户确认。
   */
  removeOne: function (e) {
    var id = e.currentTarget.dataset.id;
    var title = String(e.currentTarget.dataset.title || '（未填写题名）');
    if (!id) return;
    if (title.length > 24) title = title.slice(0, 24) + '…';
    var that = this;
    wx.showModal({
      title: '删除这条文献记录',
      content: '将删除「' + title + '」的全部留档：粘贴原文、自动初判、' +
        '每一次人工确认与核验历史。删除后无法恢复，导出里也不会再体现。确定删除？',
      confirmText: '删除',
      confirmColor: '#b4232a',
      cancelText: '保留',
      success: function (r) {
        if (!r.confirm) return;
        store.removeRef(id);
        that.refresh();
        wx.showToast({ title: '已删除该条记录', icon: 'none' });
      }
    });
  },

  /* 点击单条记录 → 这条文献专属的核验卡详情页（identity） */
  goDetail: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/identity/identity?refId=' + id });
  },

  goVerify: function () { wx.navigateTo({ url: '/pages/verify/verify' }); },
  goImport: function () { wx.navigateTo({ url: '/pages/import/import' }); }
});
