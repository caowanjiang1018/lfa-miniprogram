Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '开始' },
      { pagePath: '/pages/topic/topic', text: '我的课题' },
      { pagePath: '/pages/record/record', text: '核验记录' }
    ]
  },
  methods: {
    onSwitch: function (e) {
      var path = e.currentTarget.dataset.path;
      wx.switchTab({ url: path });
    }
  }
});
