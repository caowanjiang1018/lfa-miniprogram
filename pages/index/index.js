var store = require('../../utils/store.js');
var rules = require('../../utils/rules.js');

Page({
  data: {
    hasTopic: false,
    topic: {},
    refCount: 0,
    confirmedCount: 0,
    pendingCount: 0,
    staleCount: 0,
    discoverCount: 0
  },

  onShow: function () {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    this.refresh();
  },

  refresh: function () {
    var topic = store.getActiveTopic();
    if (!topic) {
      this.setData({
        hasTopic: false, topic: {}, refCount: 0,
        confirmedCount: 0, pendingCount: 0, staleCount: 0, discoverCount: 0
      });
      return;
    }
    var refs = store.getRefs(topic.id);
    var confirmed = 0, stale = 0;
    for (var i = 0; i < refs.length; i++) {
      if (refs[i].confirms && refs[i].confirms.length) confirmed++;
      if (store.isStale(refs[i], topic)) stale++;
    }
    this.setData({
      hasTopic: true,
      topic: topic,
      refCount: refs.length,
      confirmedCount: confirmed,
      pendingCount: refs.length - confirmed,
      staleCount: stale,
      /* 第三阶段：检索推荐留痕次数（与核验记录共用同一个课题） */
      discoverCount: store.getDiscoverRuns(topic.id).length
    });
  },

  goTopic: function () {
    // 让「我的课题」页进来就展开当前课题的填写表单
    var app = getApp();
    if (app && app.globalData) app.globalData.openTopicForm = true;
    wx.switchTab({ url: '/pages/topic/topic' });
  },

  goImport: function () {
    if (!this.data.hasTopic) {
      wx.showToast({ title: '先填写「我的课题」，再导入文献', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/import/import' });
  },

  goVerify: function () { wx.navigateTo({ url: '/pages/verify/verify' }); },
  goRecord: function () { wx.switchTab({ url: '/pages/record/record' }); },

  /** 「帮我找文献」：与「核验已有文献」共用已保存的课题、文献卡与核验记录 */
  goDiscover: function () {
    if (!this.data.hasTopic) {
      wx.showToast({ title: '先填写「我的课题」，再检索文献', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/discover/discover' });
  },

  showStorageNote: function () {
    wx.showModal({
      title: '保存范围',
      content: '第一阶段全部数据保存在本机微信小程序的本地缓存里（当前小程序独立读取，不上传服务器、不使用云开发、不需要登录）。因此：\n\n1. 你看不到别人的记录，别人也看不到你的；\n2. 换手机、卸载微信或清理缓存会导致数据丢失；\n3. 需要留档请用「核验记录」页的复制 / 导出文本。',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
