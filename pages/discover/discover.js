var store = require('../../utils/store.js');
var rules = require('../../utils/rules.js');
var record = require('../../utils/record.js');
var ds = require('../../utils/discover-service.js');

/**
 * 「帮我找文献」页面
 * ------------------------------------------------------------
 * 步骤（与云函数 discover.js 一一对应，顺序固定）：
 *   ① 确认课题要求        —— 复用「我的课题」里已保存的课题（带版本号）
 *   ② 生成检索式          —— 通义千问给关键词 / 同义词 / 检索式，用户可改可补
 *   ③ 真实检索            —— 云函数实际调用 Crossref + OpenAlex
 *   ④ 关系分析 + 推荐清单  —— 模型只依据真实检索到的记录解释关系
 *   ⑤ 选用途 → 加入项目文献库（复用原有人共确认与导出流程）
 *
 * 诚实边界（页面层面同样守住）：
 *   - 推荐条目的题录、DOI、链接【全部来自真实检索记录】，模型不得凭记忆补齐；
 *   - 检索失败与「检索成功但没找到」分开提示；
 *   - 只展示真实数据支持的筛选项，不把「近年」当「更可信」；
 *   - 没有摘要就显示没有摘要，不展示任何编造的摘要 / 页码 / 原文摘录。
 */

var USES = ['了解背景', '借鉴方法', '寻找直接相关研究'];

Page({
  data: {
    hasTopic: false,
    topic: {},
    step: 1,

    hint: '',
    planning: false,
    plan: null,
    planStatus: '',
    planError: '',
    extraSyn: '',
    yearFrom: '',
    yearTo: '',

    searching: false,
    search: null,
    searchError: '',
    facets: { years: [], langs: [], types: [] },
    filterLang: '',
    filterType: '',
    showLog: false,

    analyzing: false,
    analysis: null,
    analysisError: '',

    recItems: [],
    leadItems: [],
    otherItems: [],

    runId: '',
    filteredCount: 0,
    showFacets: false,

    /* 历史检索清单：每次真实检索封存一份，可反复回看 */
    history: [],
    showHistory: false,
    viewingHistoryId: '',
    viewingHistoryAt: ''
  },

  onLoad: function () {
    this.loadTopic();
    this.loadHistory();
    this.restoreRun();
    this.takeSeed();
  },

  /**
   * 从「课题适配」页带过来的下一轮检索建议。
   * 只带【检索词 / 检索式】，不带任何文献——替代文献也必须同样走一遍核验，
   * 所以这里绝不预填题名、DOI 或链接。
   */
  takeSeed: function () {
    try {
      var seed = wx.getStorageSync('lfa_next_query_seed');
      if (!seed || !seed.text) return;
      wx.removeStorageSync('lfa_next_query_seed');
      this.setData({ hint: seed.text });
      wx.showToast({ title: '已带入检索建议：' + String(seed.text).slice(0, 12), icon: 'none', duration: 2400 });
    } catch (e) { /* 取不到就用空提示框，用户自己填也一样 */ }
  },

  onShow: function () {
    /* 从「我的课题」改完回来，或加入文献库后回来，都要按最新状态刷新 */
    this.loadTopic();
    this.loadHistory();
    this.markSaved();
  },

  /* ---------------- 历史检索清单 ---------------- */

  loadHistory: function () {
    var topic = store.getActiveTopic();
    if (!topic) { this.setData({ history: [] }); return; }
    this.setData({ history: store.getDiscoverHistory(topic.id) });
  },

  toggleHistory: function () {
    this.setData({ showHistory: !this.data.showHistory });
  },

  /**
   * 打开一份历史清单：把当时封存的检索式 / 候选 / 分析原样载入视图。
   * 只是【回看】，不重新发起任何检索请求。
   */
  openHistoryItem: function (e) {
    var id = e.currentTarget.dataset.id;
    var h = store.getDiscoverHistoryItem(id);
    if (!h) { wx.showToast({ title: '这份历史记录已不存在', icon: 'none' }); return; }
    var patch = {
      viewingHistoryId: h.id,
      viewingHistoryAt: h.createdAt,
      hint: h.hint || '',
      plan: h.plan || null,
      planStatus: 'ok',
      search: h.search || null,
      searchError: '',
      facets: (h.search && h.search.facets) || { years: [], langs: [], types: [] },
      filterLang: (h.filters && h.filters.lang) || '',
      filterType: (h.filters && h.filters.type) || '',
      yearFrom: (h.filters && h.filters.yearFrom) || '',
      yearTo: (h.filters && h.filters.yearTo) || '',
      analysis: h.analysis || null,
      step: h.analysis ? 4 : 3,
      recItems: [], leadItems: [], otherItems: []
    };
    this.setData(patch);
    this.updateFilteredCount();
    if (h.analysis) this.buildItems();
    this.markSaved();
    wx.showToast({ title: '已载入 ' + h.createdAt + ' 的清单', icon: 'none', duration: 2000 });
  },

  /** 退出回看：恢复当前这一轮的工作区（若有），否则清空回到第一步 */
  exitHistory: function () {
    var that = this;
    this.setData({
      viewingHistoryId: '', viewingHistoryAt: '',
      plan: null, planStatus: '', search: null, searchError: '',
      facets: { years: [], langs: [], types: [] }, filterLang: '', filterType: '',
      analysis: null, recItems: [], leadItems: [], otherItems: [], step: 1
    });
    this.restoreRun();
    wx.showToast({ title: '已退出回看', icon: 'none' });
  },

  copyHistoryItem: function (e) {
    var id = e.currentTarget.dataset.id;
    var h = store.getDiscoverHistoryItem(id);
    var topic = store.getActiveTopic();
    if (!h) { wx.showToast({ title: '这份历史记录已不存在', icon: 'none' }); return; }
    var text = record.buildDiscoverText(topic, h);
    wx.setClipboardData({
      data: text,
      success: function () { wx.showToast({ title: '该次清单已复制', icon: 'none' }); }
    });
  },

  removeHistoryItem: function (e) {
    var id = e.currentTarget.dataset.id;
    var that = this;
    wx.showModal({
      title: '删除这份历史清单',
      content: '只删除这份检索留痕，已经加入文献库的条目不受影响。确定删除？',
      confirmText: '删除', cancelText: '取消',
      success: function (r) {
        if (!r.confirm) return;
        store.removeDiscoverHistory(id);
        if (that.data.viewingHistoryId === id) that.exitHistory();
        that.loadHistory();
        wx.showToast({ title: '已删除', icon: 'none' });
      }
    });
  },

  loadTopic: function () {
    var topic = store.getActiveTopic();
    if (!topic) {
      this.setData({ hasTopic: false, topic: {} });
      return;
    }
    this.setData({
      hasTopic: true, topic: topic,
      step: this.data.step || 1
    });
  },

  /** 恢复上一次的检索留痕（不重新检索，只是让你接着看上次的结果） */
  restoreRun: function () {
    var topic = store.getActiveTopic();
    if (!topic) return;
    var run = store.getLatestDiscoverRun(topic.id);
    if (!run) return;
    var patch = { runId: run.id, hint: run.hint || '' };
    if (run.plan) { patch.plan = run.plan; patch.planStatus = run.planStatus || 'ok'; patch.step = 2; }
    if (run.search) {
      patch.search = run.search;
      patch.facets = (run.search && run.search.facets) || { years: [], langs: [], types: [] };
      patch.filterLang = (run.filters && run.filters.lang) || '';
      patch.filterType = (run.filters && run.filters.type) || '';
      patch.step = 3;
    }
    if (run.analysis) {
      patch.analysis = run.analysis;
      patch.step = 4;
    }
    this.setData(patch);
    this.updateFilteredCount();
    if (run.analysis) this.buildItems();
    this.markSaved();
  },

  /* ---------------- ① 课题 ---------------- */

  onHint: function (e) { this.setData({ hint: e.detail.value }); },

  goTopic: function () {
    var app = getApp();
    if (app && app.globalData) app.globalData.openTopicForm = true;
    wx.switchTab({ url: '/pages/topic/topic' });
  },

  /* ---------------- ② 检索式 ---------------- */

  genPlan: function () {
    if (this.data.planning) return;
    var topic = store.getActiveTopic();
    if (!topic) return;
    var that = this;
    this.setData({ planning: true, planError: '' });
    wx.showLoading({ title: '生成检索式', mask: true });

    ds.plan(topic, this.data.hint).then(function (r) {
      wx.hideLoading();
      var plan = r.plan || null;
      var qs = (plan && plan.queries) || [];
      var patch = {
        planning: false,
        planStatus: r.status || (r.ok ? 'ok' : 'failed'),
        planError: (r.ok || r.status === 'fallback') ? '' : (r.failureDetail || r.error || '检索式生成失败'),
        plan: plan ? {
          keywords: plan.keywords || [],
          synonyms: plan.synonyms || [],
          queries: qs.map(function (q) {
            return { text: q.text, lang: q.lang, why: q.why || '', enabled: true };
          }),
          dropped: plan.dropped || [],
          scopeNote: plan.scopeNote || '',
          fallback: !!plan.fallback
        } : null,
        planNote: r.note || '',
        planModel: r.model || '',
        coverage: r.coverage || null,
        step: 2
      };
      that.setData(patch);
      that.saveRun();
      if (!qs.length) {
        wx.showModal({
          title: '没拿到可用检索式',
          content: (r.failureDetail || '模型没有给出检索式') +
            '。你可以自己在下面填写检索式后再检索——本功能不会用任何预置结果充数。',
          showCancel: false, confirmText: '知道了'
        });
      }
    });
  },

  toggleQuery: function (e) {
    var i = e.currentTarget.dataset.index;
    var v = !this.data.plan.queries[i].enabled;
    this.setData({ ['plan.queries[' + i + '].enabled']: v }, this.saveRunSafe);
  },

  onEditQuery: function (e) {
    var i = e.currentTarget.dataset.index;
    this.setData({ ['plan.queries[' + i + '].text']: e.detail.value }, this.saveRunSafe);
  },

  onExtraSyn: function (e) { this.setData({ extraSyn: e.detail.value }); },

  /** 把「补充的同义词」变成一条新检索式（用户自己写的，不是模型编的） */
  addSynonymQuery: function () {
    var s = (this.data.extraSyn || '').replace(/^\s+|\s+$/g, '');
    if (!s) { wx.showToast({ title: '先填写同义词', icon: 'none' }); return; }
    var plan = this.data.plan || { keywords: [], synonyms: [], queries: [], dropped: [], scopeNote: '' };
    var queries = plan.queries.slice();
    queries.push({ text: s.slice(0, 120), lang: /[\u4e00-\u9fff]/.test(s) ? 'zh' : 'en', why: '你补充的同义词', enabled: true });
    this.setData({
      plan: {
        keywords: plan.keywords, synonyms: plan.synonyms.concat([s.slice(0, 40)]),
        queries: queries, dropped: plan.dropped, scopeNote: plan.scopeNote,
        fallback: plan.fallback
      },
      extraSyn: ''
    }, this.saveRunSafe);
  },

  onYearFrom: function (e) { this.setData({ yearFrom: e.detail.value }); },
  onYearTo: function (e) { this.setData({ yearTo: e.detail.value }); },

  /* ---------------- ③ 真实检索 ---------------- */

  doSearch: function () {
    if (this.data.searching) return;
    var plan = this.data.plan;
    var qs = ((plan && plan.queries) || []).filter(function (q) { return q.enabled && q.text; })
      .map(function (q) { return q.text; });
    if (!qs.length) { wx.showToast({ title: '至少勾选一条检索式', icon: 'none' }); return; }
    var that = this;
    this.setData({ searching: true, searchError: '' });
    wx.showLoading({ title: '检索中，最长约 15 秒', mask: true });

    ds.search(qs, this.data.yearFrom, this.data.yearTo).then(function (r) {
      wx.hideLoading();
      that.setData({
        searching: false,
        search: r,
        searchError: (r.status === 'failed') ? (r.failureDetail || r.error || '检索失败') : '',
        facets: r.facets || { years: [], langs: [], types: [] },
        filterLang: '', filterType: '',
        /* 重新检索后，上一次的分析结论不再成立，清空而不是沿用 */
        analysis: null, recItems: [], leadItems: [], otherItems: [], analysisError: '',
        step: 3
      });
      that.updateFilteredCount();
      that.saveRun();
      /* 真实检索完成 → 封存一份清单到历史，之后可以反复回看 */
      var run = that.data.runId ? store.getDiscoverRun(that.data.runId) : null;
      if (run) {
        store.archiveDiscoverSearch(run, { queries: qs, status: r.status });
        that.setData({ viewingHistoryId: '', viewingHistoryAt: '' });
        that.loadHistory();
      }
      var msg = '';
      if (r.status === 'failed') {
        msg = '检索失败：' + (r.failureDetail || r.error || '接口不可用') +
          '。这不是「没有相关文献」，而是这次没查成，请稍后重试或调整检索式。';
      } else if (r.status === 'empty') {
        msg = (r.emptyKind === 'no_relevant')
          ? ('检索成功，两个服务返回了 ' + ((r.removedIrrelevant || []).length + 0) +
            ' 条与检索式毫无词面重合的记录，已全部剔除，因此没有可推荐的候选。' +
            '请换个说法、放宽年份，或改用中文库（知网 / 万方）与学校图书馆检索。')
          : '检索成功，但两个公开服务都没有返回任何记录。请换个说法、放宽年份，或改用中文库（知网 / 万方）与学校图书馆检索。';
      } else {
        msg = '检索到 ' + (r.candidates || []).length + ' 条候选（已去重）。';
      }
      wx.showModal({
        title: r.status === 'ok' ? '检索完成' : (r.status === 'empty' ? '没有找到结果' : '检索失败'),
        content: msg, showCancel: false, confirmText: '知道了'
      });
    });
  },

  toggleLog: function () { this.setData({ showLog: !this.data.showLog }); },
  toggleFacets: function () { this.setData({ showFacets: !this.data.showFacets }); },

  pickLang: function (e) {
    var v = e.currentTarget.dataset.value;
    this.setData({ filterLang: this.data.filterLang === v ? '' : v }, this.applyFilter);
  },
  pickType: function (e) {
    var v = e.currentTarget.dataset.value;
    this.setData({ filterType: this.data.filterType === v ? '' : v }, this.applyFilter);
  },

  /** 筛选只在【真实候选集】上做，选项也只来自真实数据 */
  applyFilter: function () {
    this.updateFilteredCount();
    this.saveRunSafe();
  },

  updateFilteredCount: function () {
    this.setData({ filteredCount: this.filteredCandidates().length });
  },

  filteredCandidates: function () {
    var all = (this.data.search && this.data.search.candidates) || [];
    var lang = this.data.filterLang, type = this.data.filterType;
    if (!lang && !type) return all;
    return all.filter(function (c) {
      if (lang && c.lang !== lang) return false;
      if (type && c.type !== type) return false;
      return true;
    });
  },

  /* ---------------- ④ 关系分析 + 推荐清单 ---------------- */

  doAnalyze: function () {
    if (this.data.analyzing) return;
    var cands = this.filteredCandidates();
    if (!cands.length) { wx.showToast({ title: '当前筛选下没有候选', icon: 'none' }); return; }
    var topic = store.getActiveTopic();
    var that = this;
    this.setData({ analyzing: true, analysisError: '' });
    wx.showLoading({ title: '分析关系，最长约 15 秒', mask: true });

    ds.analyze(topic, cands).then(function (r) {
      wx.hideLoading();
      that.setData({
        analyzing: false,
        analysis: r,
        analysisError: (r.status === 'failed') ? (r.failureDetail || r.error || '分析未完成') : '',
        step: 4
      });
      that.buildItems();
      that.saveRun();
      /* 分析结论回填到对应的历史清单，回看时能看到「当时分析出了什么」 */
      that.backfillHistoryAnalysis(r);
      if (r.status === 'failed') {
        wx.showModal({
          title: '分析未完成',
          content: (r.failureDetail || '模型未返回结果') +
            '。候选记录已经真实检索到了，你可以直接按题录自行判断；本系统不会编造推荐理由。',
          showCancel: false, confirmText: '知道了'
        });
      }
    });
  },

  /**
   * 把分析结论回填到历史清单。
   * 优先回填「正在回看的那份」；否则回填当前 run 最近封存的那份。
   */
  backfillHistoryAnalysis: function (analysis) {
    var id = this.data.viewingHistoryId;
    if (!id) {
      var hs = store.getDiscoverHistory(store.getActiveTopic() ? store.getActiveTopic().id : '');
      for (var i = 0; i < hs.length; i++) {
        if (hs[i].runId && hs[i].runId === this.data.runId) { id = hs[i].id; break; }
      }
    }
    if (!id) return;
    store.updateHistoryAnalysis(id, analysis);
    this.loadHistory();
  },

  /** 把分析结论 + 真实候选拼成可渲染的视图模型 */
  buildItems: function () {
    var a = this.data.analysis || {};
    function item(entry, kind) {
      var c = entry.cand || {};
      var uses = USES.map(function (u) {
        return { key: u, suggested: (entry.uses || []).indexOf(u) >= 0, picked: false };
      });
      return {
        id: c.id,
        kind: kind,
        title: c.title || '（该来源未提供题名）',
        authors: c.authors || '（该来源未提供作者）',
        year: c.year || '（未提供年份）',
        venue: c.venue || '（未提供出处）',
        doi: c.doi || '',
        url: c.url || '',
        source: c.source || '',
        query: c.query || '',
        apiUrl: c.apiUrl || '',
        retrievedAt: c.retrievedAt || '',
        evidenceText: c.evidenceText || '',
        hasAbstract: !!c.hasAbstract,
        oaText: (c.oa && c.oa.pdfUrl)
          ? '来源标注为开放获取，PDF 地址：' + c.oa.pdfUrl + '（本次未下载、未阅读）'
          : '',
        abstractText: c.hasAbstract ? (c.abstract || '') : '',
        match: (entry.match || []).map(function (t) { return { text: t }; }),
        gap: (entry.gap || []).map(function (t) { return { text: t }; }),
        todo: (entry.todo || []).map(function (t) { return { text: t }; }),
        why: entry.why || '',
        uses: uses,
        saved: false,
        exists: false
      };
    }
    var recItems = (a.recommended || []).map(function (x) { return item(x, 'rec'); });
    var leadItems = (a.leads || []).map(function (x) { return item(x, 'lead'); });
    var otherItems = (a.others || []).map(function (x) { return item(x, 'other'); });
    this.setData({ recItems: recItems, leadItems: leadItems, otherItems: otherItems });
    this.markSaved();
  },

  toggleUse: function (e) {
    var kind = e.currentTarget.dataset.kind;
    var i = e.currentTarget.dataset.index;
    var u = e.currentTarget.dataset.key;
    var key = kind === 'lead' ? 'leadItems' : (kind === 'other' ? 'otherItems' : 'recItems');
    var arr = this.data[key];
    var j = -1;
    for (var k = 0; k < arr[i].uses.length; k++) if (arr[i].uses[k].key === u) j = k;
    if (j < 0) return;
    this.setData({ [key + '[' + i + '].uses[' + j + '].picked']: !arr[i].uses[j].picked });
  },

  pickedUses: function (it) {
    var out = [];
    for (var i = 0; i < (it.uses || []).length; i++) if (it.uses[i].picked) out.push(it.uses[i].key);
    return out;
  },

  /** 找出该项对应的原始候选（题录以候选为准，不取视图里的文本） */
  findEntry: function (kind, id) {
    var a = this.data.analysis || {};
    var list = kind === 'lead' ? (a.leads || []) : (kind === 'other' ? (a.others || []) : (a.recommended || []));
    for (var i = 0; i < list.length; i++) if (list[i].cand && list[i].cand.id === id) return list[i];
    return null;
  },

  addOne: function (e) {
    var kind = e.currentTarget.dataset.kind;
    var index = Number(e.currentTarget.dataset.index);
    var key = kind === 'lead' ? 'leadItems' : (kind === 'other' ? 'otherItems' : 'recItems');
    var it = this.data[key][index];
    var uses = this.pickedUses(it);
    if (!uses.length) {
      wx.showToast({ title: '先选择用途（可多选）', icon: 'none' });
      return;
    }
    var entry = this.findEntry(kind, it.id);
    if (!entry) { wx.showToast({ title: '找不到该条目的原始检索记录', icon: 'none' }); return; }

    var topic = store.getActiveTopic();
    var run = this.data.runId ? store.getDiscoverRun(this.data.runId) : null;
    /* 题录【必须】来自原始检索记录：entry.cand 就是上一步真实检索到的那条 */
    var res = store.addDiscoverRef(topic.id, {
      cand: entry.cand,
      match: entry.match, gap: entry.gap, todo: entry.todo,
      uses: uses, why: entry.why
    }, run, topic);

    if (res.error) {
      wx.showToast({ title: res.error, icon: 'none' });
      return;
    }

    if (res.existed) {
      wx.showModal({
        title: '已在文献库中',
        content: '这条记录已经在你的文献库里了（同 DOI 或同题名+年份），本次【没有】新建、也没有改写原有条目。' +
          '如需调整用途，请到「核验卡」里做人工确认。',
        showCancel: false, confirmText: '知道了'
      });
      this.setData({ [key + '[' + index + '].exists']: true });
      return;
    }

    /* 复用原有的自动初判流程（与粘贴导入的条目完全一致） */
    store.addEval(res.ref.id, rules.evaluate(topic, res.ref));
    if (this.data.viewingHistoryId) store.markHistoryAdded(this.data.viewingHistoryId, res.ref.id);
    this.setData({ [key + '[' + index + '].saved']: true });
    this.saveRunSafe();
    var that = this;
    wx.showModal({
      title: '已加入项目文献库',
      content: '已按真实检索记录新增一条文献（用途：' + uses.join('、') + '）。' +
        '系统推荐与你将要做的人工确认分开保存，人工确认不会改写原始推荐。\n\n现在去「核验卡」确认用途吗？',
      confirmText: '去核验卡', cancelText: '留在本页',
      success: function (r) {
        if (r.confirm) wx.navigateTo({ url: '/pages/verify/verify' });
        else that.markSaved();
      }
    });
    this.markSaved();
  },

  /** 标记哪些条目已经在文献库里（避免重复加入，也提醒不要被新检索改写） */
  markSaved: function () {
    var topic = store.getActiveTopic();
    if (!topic) return;
    var refs = store.getRefs(topic.id);
    var dois = {}, titles = {};
    for (var i = 0; i < refs.length; i++) {
      if (refs[i].doi) dois[String(refs[i].doi).toLowerCase()] = true;
      if (refs[i].title) titles[store.titleKey(refs[i].title)] = true;
    }
    /* 只标「是否已在库里」；加入过一次的条目保持 saved 标记，互不覆盖 */
    function walk(key) {
      var arr = this.data[key] || [];
      var changed = false;
      for (var k = 0; k < arr.length; k++) {
        var inLib = !!(arr[k].doi && dois[String(arr[k].doi).toLowerCase()]) ||
          !!(arr[k].title && titles[store.titleKey(arr[k].title)]);
        if (inLib && !arr[k].exists) { arr[k].exists = true; changed = true; }
      }
      return { arr: arr, changed: changed };
    }
    var a = walk.call(this, 'recItems'), b = walk.call(this, 'leadItems'), c = walk.call(this, 'otherItems');
    if (a.changed || b.changed || c.changed) {
      this.setData({ recItems: a.arr, leadItems: b.arr, otherItems: c.arr });
    }
  },

  /* ---------------- 留痕保存 / 导出 ---------------- */

  saveRunSafe: function () { this.saveRun(); },

  saveRun: function () {
    var topic = store.getActiveTopic();
    if (!topic) return;
    var run = this.data.runId ? store.getDiscoverRun(this.data.runId) : null;
    if (!run) run = store.newDiscoverRun(topic.id, topic);
    run.topicId = topic.id;
    run.topicRevision = topic.revision;
    run.topicBrief = {
      name: topic.name || '', problem: topic.problem || '', target: topic.target || '',
      task: topic.task || '', claim: topic.claim || ''
    };
    run.hint = this.data.hint || '';
    run.plan = this.data.plan || null;
    run.planStatus = this.data.planStatus || '';
    run.search = this.data.search || null;
    run.analysis = this.data.analysis || null;
    run.filters = { lang: this.data.filterLang || '', type: this.data.filterType || '', yearFrom: this.data.yearFrom || '', yearTo: this.data.yearTo || '' };
    run.status = this.data.analysis ? 'analyzed' : (this.data.search ? 'searched' : 'planned');
    store.saveDiscoverRun(run);
    this.setData({ runId: run.id });
  },

  copyRun: function () {
    var topic = store.getActiveTopic();
    var run = this.data.runId ? store.getDiscoverRun(this.data.runId) : null;
    if (!run) { wx.showToast({ title: '还没有检索留痕', icon: 'none' }); return; }
    var text = record.buildDiscoverText(topic, run);
    wx.setClipboardData({
      data: text,
      success: function () { wx.showToast({ title: '检索留痕已复制', icon: 'none' }); }
    });
  },

  restart: function () {
    var that = this;
    wx.showModal({
      title: '重新检索',
      content: '将清空本次的检索式、候选与分析（已加入文献库的条目不受影响）。确定？',
      confirmText: '重新开始', cancelText: '取消',
      success: function (r) {
        if (!r.confirm) return;
        if (that.data.runId) store.removeDiscoverRun(that.data.runId);
        that.setData({
          step: 1, plan: null, planStatus: '', planError: '', extraSyn: '',
          yearFrom: '', yearTo: '', search: null, searchError: '',
          facets: { years: [], langs: [], types: [] }, filterLang: '', filterType: '',
          analysis: null, analysisError: '', recItems: [], leadItems: [], otherItems: [],
          runId: '', showLog: false
        });
      }
    });
  },

  goImport: function () { wx.navigateTo({ url: '/pages/import/import' }); },
  goVerify: function () { wx.navigateTo({ url: '/pages/verify/verify' }); },

  copyLink: function (e) {
    var url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: function () {
        wx.showModal({
          title: '链接已复制',
          content: url + '\n\n小程序内不自动打开外链，请粘贴到浏览器自行核对。',
          showCancel: false, confirmText: '知道了'
        });
      }
    });
  },

  showCoverage: function () {
    var c = (this.data.search && this.data.search.coverage) ||
      (this.data.coverage) || null;
    if (!c) return;
    wx.showModal({
      title: '覆盖范围（如实说明）',
      content: c.text + '\n\n未覆盖：\n· ' + (c.notCovered || []).join('\n· ') +
        '\n\n' + (c.notVerified || ''),
      showCancel: false, confirmText: '知道了'
    });
  }
});
