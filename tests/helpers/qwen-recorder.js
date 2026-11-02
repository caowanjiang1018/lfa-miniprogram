'use strict';
/**
 * 通义千问测试用传输层：POST + 录制 / 回放。
 * ------------------------------------------------------------
 * 与 helpers/recorder.js（GET，用于 OpenAlex / Crossref）配套使用。
 * 首次运行加 --record 会真实调用 DashScope 并把响应写入 probe/fixtures/，
 * 之后离线回放，保证回归基于【真实接口返回】而非编造内容。
 *
 * 注意：录制内容只包含「响应体」，鉴权头不在其中；
 * 回放时也【不需要】真实的 API key（测试会自行设置一个占位 key 让 available() 为真）。
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var FIXTURE_DIR = path.resolve(__dirname, '../../../probe/fixtures');

function ensureDir() {
  if (!fs.existsSync(FIXTURE_DIR)) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  return FIXTURE_DIR;
}

function fileOf(url, body) {
  var k = crypto.createHash('md5').update(url + '|' + String(body || '')).digest('hex').slice(0, 16);
  return path.join(ensureDir(), 'qw_' + k + '.json');
}

function fmt(d) {
  function p(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function realPost(urlStr, opt) {
  var https = require('https');
  var urlLib = require('url');
  var started = Date.now();
  var requestedAt = new Date();
  var body = opt.body || '';
  var headers = opt.headers || {};

  return new Promise(function (resolve) {
    var u = urlLib.parse(urlStr);
    var req = https.request({
      hostname: u.hostname, port: u.port || undefined,
      path: u.path || '/', method: 'POST', headers: headers
    }, function (res) {
      var chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () {
        resolve({
          ok: res.statusCode === 200, status: res.statusCode,
          raw: Buffer.concat(chunks).toString('utf8'),
          requestedAtText: fmt(requestedAt), ms: Date.now() - started
        });
      });
    });
    req.setTimeout(opt.timeout || 20000, function () {
      req.destroy();
      resolve({
        ok: false, status: 0, raw: '', requestedAtText: fmt(requestedAt),
        ms: Date.now() - started, failureKind: 'timeout', failureDetail: '超时'
      });
    });
    req.on('error', function (e) {
      resolve({
        ok: false, status: 0, raw: '', requestedAtText: fmt(requestedAt),
        ms: Date.now() - started, failureKind: 'network', failureDetail: String((e && e.message) || e)
      });
    });
    if (body) req.write(body);
    req.end();
  });
}

function createTransport(record) {
  return function (urlStr, opt) {
    var f = fileOf(urlStr, opt && opt.body);
    if (!record && fs.existsSync(f)) {
      var saved = JSON.parse(fs.readFileSync(f, 'utf8'));
      saved.requestedAtText = fmt(new Date());
      return Promise.resolve(saved);
    }
    if (!record) {
      /* 回放模式缺 fixture 时【不再悄悄发真实请求】。
       * 以前这会带着占位 key 直接打到 DashScope，返回 HTTP 401，
       * 于是「prompt 改了导致 fixture 失效」被误报成「接口有问题」，排查方向全错。
       * 现在明确告诉你：这条请求没有对应的录制内容，请 --record 重新录制。 */
      return Promise.resolve({
        ok: false, status: 0, raw: '',
        requestedAtText: fmt(new Date()), ms: 0,
        failureKind: 'no_fixture',
        failureDetail: '离线回放模式下找不到对应的录制内容（fixture 文件 ' +
          path.basename(f) + ' 不存在）。请求内容（prompt / 参数）可能已改动，' +
          '请用 node tests/qwen-test.js --record 重新真实录制，或改用注入传输层的离线用例。'
      });
    }
    ensureDir();
    return realPost(urlStr, opt).then(function (r) {
      var out = {
        ok: r.ok, status: r.status, raw: r.raw, ms: r.ms,
        requestedAtText: r.requestedAtText, _url: urlStr
      };
      if (!r.ok && r.failureKind) {
        out.failureKind = r.failureKind;
        out.failureDetail = r.failureDetail;
      }
      fs.writeFileSync(f, JSON.stringify(out), 'utf8');
      return out;
    });
  };
}

/**
 * 合并 GET（学术库）与 POST（千问）两个传输层，供端到端测试使用。
 * @param {function} getTransport
 * @param {function} postTransport
 * @param {object} spy { calls: [] } 可选，记录每次请求的 url 与 method
 */
function combine(getTransport, postTransport, spy) {
  return function (urlStr, opt) {
    opt = opt || {};
    if (spy) spy.calls.push({ url: urlStr, method: opt.method || 'GET' });
    return (opt.method === 'POST') ? postTransport(urlStr, opt) : getTransport(urlStr, opt);
  };
}

module.exports = {
  createTransport: createTransport,
  combine: combine,
  FIXTURE_DIR: FIXTURE_DIR
};
