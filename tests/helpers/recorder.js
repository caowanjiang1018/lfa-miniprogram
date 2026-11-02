'use strict';
/**
 * 测试用传输层：带录制 / 回放。
 * ------------------------------------------------------------
 * 第一次运行（无 fixture）会真的发请求，并把响应写入 probe/fixtures/，
 * 之后运行直接回放，既能离线回归，也保证测试基于【真实接口返回】而非编造。
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var FIXTURE_DIR = path.resolve(__dirname, '../../../probe/fixtures');

function ensureDir() {
  if (!fs.existsSync(FIXTURE_DIR)) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  return FIXTURE_DIR;
}

function keyOf(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 16);
}

function fileOf(url) {
  return path.join(ensureDir(), keyOf(url) + '.json');
}

/** 真实请求（复制自 http.js 的实现，避免测试与实现互相依赖） */
function realRequest(urlStr, opt) {
  var https = require('https');
  var urlLib = require('url');
  var timeout = (opt && opt.timeout) || 12000;
  var started = Date.now();
  var requestedAt = new Date();

  return new Promise(function (resolve) {
    var u = urlLib.parse(urlStr);
    var req = https.request({
      hostname: u.hostname, port: u.port || undefined,
      path: u.path || '/', method: 'GET', headers: opt.headers || {}
    }, function (res) {
      var chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () {
        resolve({
          ok: res.statusCode === 200, status: res.statusCode,
          raw: Buffer.concat(chunks).toString('utf8'), body: null,
          requestedAtText: fmt(requestedAt), ms: Date.now() - started
        });
      });
    });
    req.setTimeout(timeout, function () {
      req.destroy();
      resolve({
        ok: false, status: 0, raw: '', body: null,
      requestedAtText: fmt(requestedAt), ms: Date.now() - started,
        failureKind: 'timeout', failureDetail: '超时'
      });
    });
    req.on('error', function (e) {
      resolve({
        ok: false, status: 0, raw: '', body: null,
      requestedAtText: fmt(requestedAt), ms: Date.now() - started,
        failureKind: 'network', failureDetail: String((e && e.message) || e)
      });
    });
    req.end();
  });
}

function fmt(d) {
  function p(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/**
 * 创建带录制回放的 transport
 * @param {boolean} record true 时强制重录
 */
function createTransport(record) {
  return function (urlStr, opt) {
    var f = fileOf(urlStr);
    if (!record && fs.existsSync(f)) {
      var saved = JSON.parse(fs.readFileSync(f, 'utf8'));
      saved._replayed = true;
      saved.requestedAtText = fmt(new Date());
      return Promise.resolve(saved);
    }
    ensureDir();
    return realRequest(urlStr, opt).then(function (r) {
      r._url = urlStr;
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

function clearFixtures() {
  if (!fs.existsSync(FIXTURE_DIR)) return;
  var files = fs.readdirSync(FIXTURE_DIR);
  for (var i = 0; i < files.length; i++) {
    if (/\.json$/.test(files[i])) fs.unlinkSync(path.join(FIXTURE_DIR, files[i]));
  }
}

module.exports = {
  createTransport: createTransport,
  clearFixtures: clearFixtures,
  FIXTURE_DIR: FIXTURE_DIR
};
