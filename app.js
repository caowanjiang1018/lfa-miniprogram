var store = require('./utils/store.js');
var cloudConfig = require('./utils/cloud-config.js');

App({
  globalData: {
    ruleVersion: 'stage2-cloud-verify-v1',
    stage: '2',
    cloudReady: false,
    cloudError: ''
  },
  onLaunch: function () {
    // 第一阶段：仅本地存储，不做登录、不同步云端、不收集联系方式
    store.ensure();

    // 第二阶段：初始化云开发。
    // 说明：所有 OpenAlex / Crossref 请求都在云函数 lfaVerify 内发起，
    // 这里只负责建立云开发通道，前端不保存、不直连任何外部接口地址。
    this.initCloud();
  },

  initCloud: function () {
    if (typeof wx === 'undefined' || !wx.cloud) {
      this.globalData.cloudError = '当前环境不支持云开发（wx.cloud 不存在）。';
      return false;
    }
    try {
      var opt = { traceUser: true };
      if (cloudConfig.env) opt.env = cloudConfig.env;
      wx.cloud.init(opt);
      this.globalData.cloudReady = true;
      return true;
    } catch (e) {
      this.globalData.cloudError = '云开发初始化失败：' +
        String((e && e.message) || e) +
        '。请先在开发者工具左上角「云开发」中开通环境，' +
        '并把环境 ID 填进 utils/cloud-config.js 的 env 字段。';
      return false;
    }
  }
});
