var store = require('../../utils/store.js');

var PRESETS = [
  '研究对象 / 工况参数',
  '评价指标',
  '使用范围 / 限定条件',
  '调查对象 / 样本',
  '数据来源',
  '设计约束'
];

function trim(s) { return (s || '').replace(/^\s+|\s+$/g, ''); }

/** 表单里是否已经有用户输入的内容（决定要不要存草稿、要不要提示未保存） */
function hasContent(t) {
  if (!t) return false;
  if (trim(t.name) || trim(t.problem) || trim(t.target) || trim(t.task) ||
    trim(t.resources) || trim(t.claim)) return true;
  var cf = t.customFields || [];
  for (var i = 0; i < cf.length; i++) {
    if (trim(cf[i].label) || trim(cf[i].value)) return true;
  }
  return false;
}

Page({
  data: {
    topic: {},
    formVisible: false,   // 表单是否展开
    formMode: 'new',      // new = 新建空白；edit = 修改已有课题
    dirty: false,         // 有未保存的修改
    presets: PRESETS,
    newFieldLabel: '',
    topics: [],
    topicCount: 0
  },

  onLoad: function () {
    // 优先恢复上次没保存的草稿，避免切页或重启后输入内容丢失
    var draft = store.getDraft();
    if (draft && hasContent(draft)) {
      this.setData({
        topic: draft,
        formVisible: true,
        formMode: draft.id ? 'edit' : 'new',
        dirty: true
      });
    } else {
      var t = store.getActiveTopic();
      if (!t) t = store.newTopic();
      this.setData({
        topic: t,
        formVisible: false,
        formMode: t.id ? 'edit' : 'new',
        dirty: false
      });
    }
    this.refreshList();
  },

  onShow: function () {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    // 从首页「查看 / 修改课题」进来时展开当前课题表单（有未保存草稿则不打断）
    var app = getApp();
    if (app && app.globalData && app.globalData.openTopicForm) {
      app.globalData.openTopicForm = false;
      var busy = this.data.dirty && hasContent(this.data.topic);
      if (!busy) {
        var t = store.getActiveTopic();
        if (t) {
          this.setData({ topic: t, formVisible: true, formMode: 'edit', dirty: false, newFieldLabel: '' });
        }
      }
    }
    this.refreshList();
  },

  /** 刷新课题列表（不会覆盖正在编辑的表单内容） */
  refreshList: function () {
    var topics = store.getTopics();
    var cur = this.data.topic;
    var list = [];
    for (var i = 0; i < topics.length; i++) {
      var t = topics[i];
      list.push({
        id: t.id,
        name: trim(t.name) || '未命名课题',
        revision: t.revision || 1,
        updatedAt: t.updatedAt || '',
        refCount: store.getRefs(t.id).length,
        active: !!(cur && cur.id && t.id === cur.id)
      });
    }
    var patch = {};
    if (JSON.stringify(list) !== JSON.stringify(this.data.topics)) patch.topics = list;
    if (this.data.topicCount !== topics.length) patch.topicCount = topics.length;
    if (patch.topics || patch.topicCount) this.setData(patch);
  },

  scrollToForm: function () {
    var that = this;
    var q = wx.createSelectorQuery();
    if (q.in) q.in(this);
    q.select('#topic-form-anchor').boundingClientRect(function (rect) {
      if (!rect) return;
      wx.pageScrollTo({
        scrollTop: rect.top + (that._scrollTop || 0) - 20,
        duration: 250
      });
    }).exec();
  },

  onPageScroll: function (e) {
    this._scrollTop = e.scrollTop || 0;
  },

  /** 每次表单变动：标记未保存，并把内容写入草稿 */
  markDirty: function () {
    if (!this.data.dirty) this.setData({ dirty: true });
    if (hasContent(this.data.topic)) store.saveDraft(this.data.topic);
    else store.clearDraft();
  },

  onField: function (e) {
    var f = e.currentTarget.dataset.field;
    var v = e.detail.value;
    var patch = {};
    patch['topic.' + f] = v;
    this.setData(patch);
    this.markDirty();
  },

  onCustomField: function (e) {
    var idx = e.currentTarget.dataset.index;
    var v = e.detail.value;
    var patch = {};
    patch['topic.customFields[' + idx + '].value'] = v;
    this.setData(patch);
    this.markDirty();
  },

  onNewFieldLabel: function (e) {
    this.setData({ newFieldLabel: e.detail.value });
  },

  addCustom: function () {
    var label = trim(this.data.newFieldLabel);
    if (!label) {
      wx.showToast({ title: '先填写补充项名称', icon: 'none' });
      return;
    }
    var list = this.data.topic.customFields || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].label === label) {
        wx.showToast({ title: '该项已存在', icon: 'none' });
        return;
      }
    }
    list.push({ id: store.newId('cf'), label: label, value: '' });
    this.setData({ 'topic.customFields': list, newFieldLabel: '' });
    this.markDirty();
  },

  addPreset: function (e) {
    var label = e.currentTarget.dataset.label;
    var list = this.data.topic.customFields || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].label === label) {
        wx.showToast({ title: '该项已存在', icon: 'none' });
        return;
      }
    }
    list.push({ id: store.newId('cf'), label: label, value: '' });
    this.setData({ 'topic.customFields': list });
    this.markDirty();
  },

  removeField: function (e) {
    var idx = e.currentTarget.dataset.index;
    var list = this.data.topic.customFields || [];
    var that = this;
    wx.showModal({
      title: '删除补充项',
      content: '删除「' + list[idx].label + '」后保存，可能会影响相关初判，需要重新评估。',
      confirmText: '删除',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        list.splice(idx, 1);
        that.setData({ 'topic.customFields': list });
        that.markDirty();
      }
    });
  },

  /** 底部「新建课题」：先保住当前内容，再给一份空白表单 */
  createNew: function () {
    var that = this;
    var start = function () {
      store.clearDraft();
      that.setData({
        topic: store.newTopic(),
        formVisible: true,
        formMode: 'new',
        newFieldLabel: '',
        dirty: false
      });
      that.refreshList();
      that.scrollToForm();
      wx.showToast({ title: '已切换到空白表单，请填写新课题', icon: 'none', duration: 2000 });
    };

    if (!this.data.dirty || !hasContent(this.data.topic)) { start(); return; }

    wx.showModal({
      title: '新建另一个课题',
      content: '当前' + (that.data.formMode === 'new' ? '这份还没保存的新课题' : '课题「' + trim(that.data.topic.name) + '」的修改') + '还没保存。要不要先把它保存下来？',
      confirmText: '先保存它',
      cancelText: '不保存，直接新建',
      success: function (res) {
        if (res.confirm && !that.save(true)) {
          wx.showModal({
            title: '未保存成功',
            content: '当前内容缺少课题名称，无法保存。继续新建会丢弃这些内容，确定继续吗？',
            confirmText: '继续新建',
            cancelText: '返回去填写',
            success: function (r) { if (r.confirm) start(); }
          });
          return;
        }
        start();
      }
    });
  },

  /**
   * 切换课题的统一实现。
   * openForm = true  → 切换后展开该课题的填写表单（「修改」按钮）
   * openForm = false → 只切换当前课题，表单保持收起（点卡片本体）
   */
  _switchTo: function (id, openForm) {
    if (!id) return;
    var that = this;
    var cur = this.data.topic;

    // 已经是当前课题：不弹确认，最多按需展开表单
    if (id === cur.id) {
      if (openForm) {
        this.setData({
          formVisible: true,
          formMode: cur.id ? 'edit' : 'new'
        });
        this.scrollToForm();
      } else {
        wx.showToast({ title: '已经是当前课题', icon: 'none' });
      }
      return;
    }

    var doSwitch = function () {
      var t = store.getTopic(id);
      if (!t) {
        wx.showToast({ title: '该课题已不存在', icon: 'none' });
        that.refreshList();
        return;
      }
      store.setActiveTopic(id);
      store.clearDraft();
      that.setData({
        topic: t,
        formVisible: !!openForm,
        formMode: 'edit',
        dirty: false,
        newFieldLabel: ''
      });
      that.refreshList();
      if (openForm) {
        that.scrollToForm();
        wx.showToast({ title: '已切换到该课题，可开始修改', icon: 'none' });
      } else {
        wx.pageScrollTo({ scrollTop: 0, duration: 200 });
        wx.showToast({ title: '已切换为当前课题', icon: 'none' });
      }
    };

    // 有填了一半还没保存的内容：切换前先问一句，避免丢内容
    if (this.data.dirty && hasContent(this.data.topic)) {
      wx.showModal({
        title: '有未保存的修改',
        content: openForm
          ? '修改其他课题会丢弃当前还没保存的内容。'
          : '切换到其他课题会丢弃当前还没保存的内容。',
        confirmText: '先保存它',
        cancelText: '丢弃并切换',
        success: function (res) {
          // 选择了「先保存它」就尝试保存（缺名称时 save 内部会提示，不阻断切换）
          if (res.confirm) that.save(true);
          doSwitch();
        }
      });
    } else {
      doSwitch();
    }
  },

  /** 点课题卡片本体：只切换当前课题，不展开表单 */
  switchTopic: function (e) {
    var id = (e.currentTarget.dataset && e.currentTarget.dataset.id) || '';
    this._switchTo(id, false);
  },

  /** 点卡片里的「修改」：切换到该课题并展开填写表单 */
  editTopic: function (e) {
    var id = (e.currentTarget.dataset && e.currentTarget.dataset.id) || '';
    if (!id) {
      if (this.data.topic.id) {
        this.setData({ formVisible: true, formMode: 'edit' });
        this.scrollToForm();
      } else {
        this.createNew();
      }
      return;
    }
    this._switchTo(id, true);
  },

  /** 删除课题：卡片内「删除」或表单底部「删除当前课题及其记录」 */
  deleteTopic: function (e) {
    var id = (e.currentTarget.dataset && e.currentTarget.dataset.id) || this.data.topic.id;
    if (!id) return;
    var topic = store.getTopic(id);
    if (!topic) {
      wx.showToast({ title: '该课题已不存在', icon: 'none' });
      this.refreshList();
      return;
    }
    var count = store.getRefs(id).length;
    var that = this;
    wx.showModal({
      title: '删除课题',
      content: '将删除「' + trim(topic.name) + '」以及它下面的 ' + count + ' 条文献与核验记录，且不可恢复。确定删除吗？',
      confirmText: '删除',
      cancelText: '取消',
      success: function (r) {
        if (!r.confirm) return;
        store.removeTopic(id);
        store.clearDraft();
        var next = store.getActiveTopic();
        that.setData({
          topic: next || store.newTopic(),
        formVisible: false,
        formMode: next ? 'edit' : 'new',
        dirty: false,
        newFieldLabel: ''
      });
      that.refreshList();
      wx.pageScrollTo({ scrollTop: 0, duration: 200 });
      wx.showToast({ title: '已删除', icon: 'none' });
      }
    });
  },

  /** 放弃未保存的修改，回到上次保存的内容 */
  discardDraft: function () {
    var that = this;
    wx.showModal({
      title: '放弃未保存的修改',
      content: '将回到上一次保存的内容（若是新建中的课题，会清成空白表单）。',
      confirmText: '放弃修改',
      cancelText: '继续编辑',
      success: function (r) {
        if (!r.confirm) return;
        store.clearDraft();
        if (that.data.formMode === 'new') {
          that.setData({ topic: store.newTopic(), dirty: false, newFieldLabel: '' });
      } else {
        var t = store.getTopic(that.data.topic.id);
        t = t || store.newTopic();
        that.setData({ topic: t, dirty: false, newFieldLabel: '', formMode: t.id ? 'edit' : 'new' });
      }
      that.refreshList();
      }
    });
  },

  /** 收起表单（草稿仍然保留，下次点该课题的「修改」还能继续） */
  collapseForm: function () {
    var that = this;
    var doCollapse = function () {
      that.setData({ formVisible: false });
      wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    };
    if (this.data.dirty && hasContent(this.data.topic)) {
      wx.showModal({
        title: '收起表单',
        content: '未保存的内容会先存为草稿，下次点该课题的「修改」可以继续编辑。确定收起吗？',
        confirmText: '收起',
        cancelText: '继续编辑',
        success: function (r) { if (r.confirm) doCollapse(); }
      });
    } else {
      doCollapse();
    }
  },

  /** 保存；silent=true 用于「新建前自动保存当前」的场景 */
  save: function (silent) {
    silent = silent === true;
    var t = this.data.topic;
    if (!trim(t.name)) {
      wx.showToast({ title: '请填写课题名称', icon: 'none' });
      return false;
    }
    var wasNew = !t.id;
    var res = store.upsertTopic(t);
    store.clearDraft();
    // 保存后自动收起表单，回到课题列表
    this.setData({ topic: res.topic, formVisible: false, formMode: 'edit', dirty: false });
    this.refreshList();
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });

    if (silent) {
      wx.showToast({ title: wasNew ? '已保存为新课题' : '已保存', icon: 'success' });
      return true;
    }

    if (res.requirementChanged) {
      var refs = store.getRefs(res.topic.id);
      var idnCount = 0;
      for (var ri = 0; ri < refs.length; ri++) {
        if (refs[ri].identity) idnCount++;
      }
      var tip = '课题要求更新为第 ' + res.topic.revision + ' 版。已有 ' + refs.length +
        ' 条文献中，基于旧版本作出的三项初判已标记为「需重新评估」，不会静默沿用。';
      if (idnCount) {
        tip += '其中 ' + idnCount + ' 条做过自动来源核验，其核验结论同样已标记「需重新评估」，请到「核验卡」点「重新核验」。';
      } else {
        tip += '请到「核验卡」按当前课题重新初判。';
      }
      wx.showModal({
        title: '已保存 · 课题要求已变化',
        content: tip,
        showCancel: false,
        confirmText: '知道了'
      });
    } else {
      wx.showToast({ title: wasNew ? '已保存为新课题' : '已保存修改', icon: 'success' });
    }
    return true;
  },

  saveTap: function () {
    this.save(false);
  }
});
