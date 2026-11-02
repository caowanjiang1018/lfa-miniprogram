var store = require('../../utils/store.js');
var rules = require('../../utils/rules.js');

var MAX = 10;

Page({
  data: {
    mode: 'new',
    topic: {},
    hasTopic: false,
    paste: '',
    lineCount: 0,
    overLimit: false,
    items: [],
    ref: null,
    fieldKeys: [
      { key: 'title', label: '题名' },
      { key: 'authors', label: '作者' },
      { key: 'year', label: '年份' },
      { key: 'venue', label: '出处' },
      { key: 'doi', label: 'DOI' },
      { key: 'url', label: '链接' }
    ]
  },

  checkDraft: function () {
    var d = store.getDraft();
    var name = d && d.name ? ('' + d.name).replace(/^\s+|\s+$/g, '') : '';
    this.setData({ draftName: name || '' });
  },

  onLoad: function (options) {
    var topic = store.getActiveTopic();
    var mode = options.mode === 'edit' ? 'edit' : 'new';
    this.setData({ mode: mode, topic: topic || {}, hasTopic: !!topic });
    if (mode === 'edit' && options.refId) {
      var ref = store.getRef(options.refId);
      if (ref) this.setData({ ref: ref, refId: options.refId });
    }
    this.checkDraft();
  },

  onShow: function () {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    this.checkDraft();
    if (this.data.mode === 'edit' && this.data.refId) {
      var ref = store.getRef(this.data.refId);
      if (ref) this.setData({ ref: ref });
    }
  },

  onPasteInput: function (e) {
    var v = e.detail.value || '';
    var lines = rules.splitLines(v);
    this.setData({ paste: v, lineCount: lines.length, overLimit: lines.length > MAX });
  },

  doParse: function () {
    var topic = store.getActiveTopic();
    if (!topic) {
      wx.showToast({ title: '请先到「我的课题」保存课题', icon: 'none' });
      return;
    }
    if (!this.data.paste.replace(/^\s+|\s+$/g, '')) {
      wx.showToast({ title: '先粘贴参考文献', icon: 'none' });
      return;
    }
    var res = rules.parseRefs(this.data.paste, MAX);
    var existing = store.getRefs(topic.id);
    var pool = existing.slice();
    for (var i = 0; i < res.items.length; i++) {
      var dup = rules.findDuplicate(res.items[i], pool);
      if (dup) {
        res.items[i].dupNote = '疑似重复：已存在「' + (dup.title || '未命名条目') + '」（已另行保存原条目，本条仍会导入）';
      }
      pool.push(res.items[i]);
    }
    this.setData({ items: res.items, topic: topic, hasTopic: true });
    if (res.truncated) {
      wx.showToast({ title: '本次只解析前 ' + MAX + ' 条，共 ' + res.total + ' 条，请分批导入', icon: 'none', duration: 2500 });
    } else {
      wx.showToast({ title: '已解析 ' + res.items.length + ' 条，请核对字段', icon: 'none' });
    }
  },

  clearPaste: function () {
    this.setData({ paste: '', lineCount: 0, overLimit: false, items: [] });
  },

  onItemField: function (e) {
    var idx = e.currentTarget.dataset.index;
    var key = e.currentTarget.dataset.key;
    var v = e.detail.value;
    var patch = {};
    patch['items[' + idx + '].' + key] = v;
    this.setData(patch);
  },

  onItemEvidence: function (e) {
    var idx = e.currentTarget.dataset.index;
    var key = e.currentTarget.dataset.key;
    var v = e.detail.value;
    var patch = {};
    patch['items[' + idx + '].evidence.' + key] = v;
    this.setData(patch);
  },

  removeItem: function (e) {
    var idx = e.currentTarget.dataset.index;
    var items = this.data.items;
    items.splice(idx, 1);
    this.setData({ items: items });
  },

  saveAll: function () {
    var items = this.data.items;
    if (!items.length) {
      wx.showToast({ title: '先点「解析」核对字段', icon: 'none' });
      return;
    }
    var topic = this.data.topic;
    var refs = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var r = store.newRef(topic.id);
      r.origin = 'user';
      r.raw = item.raw;
      r.title = rules.trim(item.title);
      r.authors = rules.trim(item.authors);
      r.year = rules.trim(item.year);
      r.venue = rules.trim(item.venue);
      r.doi = rules.trim(item.doi);
      r.url = rules.trim(item.url);
      r.note = item.note || '';
      r.dupNote = item.dupNote || '';
      r.evidence = {
        link: rules.trim(item.evidence && item.evidence.link) || rules.trim(item.url),
        abstract: rules.trim(item.evidence && item.evidence.abstract),
        excerpt: rules.trim(item.evidence && item.evidence.excerpt)
      };
      r.parsed = item.parsed || { title: '', authors: '', year: '', venue: '', doi: '', url: '' };
      r.fieldsEdited = this.differsFromParsed(r);
      var ev = rules.evaluate(topic, r);
      r.evals.push(ev);
      refs.push(r);
    }
    store.addRefs(refs);
    wx.showToast({ title: '已保存 ' + refs.length + ' 条', icon: 'success' });
    setTimeout(function () {
      wx.navigateTo({ url: '/pages/verify/verify' });
    }, 700);
  },

  differsFromParsed: function (r) {
    var keys = ['title', 'authors', 'year', 'venue', 'doi', 'url'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var p = rules.trim(r.parsed ? r.parsed[k] : '');
      if (p && p !== rules.trim(r[k])) return true;
    }
    return false;
  },

  /* ---------- 编辑模式（单条：修正字段 / 补充证据） ---------- */

  onRefField: function (e) {
    var key = e.currentTarget.dataset.key;
    var v = e.detail.value;
    var patch = {};
    patch['ref.' + key] = v;
    this.setData(patch);
  },

  onRefEvidence: function (e) {
    var key = e.currentTarget.dataset.key;
    var v = e.detail.value;
    var patch = {};
    patch['ref.evidence.' + key] = v;
    this.setData(patch);
  },

  onRefNote: function (e) {
    this.setData({ 'ref.note': e.detail.value });
  },

  saveEdit: function () {
    var ref = this.data.ref;
    var topic = store.getTopic(ref.topicId);
    if (!ref.title && !ref.evidence.abstract && !ref.evidence.excerpt) {
      wx.showToast({ title: '至少保留题名或一段材料', icon: 'none' });
      return;
    }
    ref.fieldsEdited = this.differsFromParsed(ref);
    ref.updatedAt = store.formatTime();
    store.replaceRef(ref);
    var ev = rules.evaluate(topic, ref);
    store.addEval(ref.id, ev);
    wx.showToast({ title: '已保存并按当前课题重新初判', icon: 'success' });
    setTimeout(function () { wx.navigateBack(); }, 700);
  },

  goVerify: function () { wx.navigateTo({ url: '/pages/verify/verify' }); }
});
