/**
 * 把 lfaVerify 的全部代码原样同步到 lfa_qwen。
 * ------------------------------------------------------------------
 * 为什么两个云函数要同源？
 * 云开发的【环境变量按函数隔离】：QWEN_API_KEY 只配在 lfa_qwen 上，
 * AMINER_TOKEN 只配在 lfaVerify 上，两边都读不到对方的 Key。
 * 让它们跑同一份代码的好处：某个源没配就自动跳过（available()=false），
 * 行为完全由环境变量决定，代码层面不再有分叉。
 *
 * 为什么必须有这个脚本？
 * 手工 cp 漏一个文件（如 adapt.js / discover.js）就会让云函数 require 崩溃，
 * 报 -504002 「functions execute fail」，且线上看不出是缺文件。
 * 所以改为整体重建 + 落地后逐文件校验，不一致直接报错退出。
 *
 * 用法：node cloudfunctions/sync-qwen.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'lfaVerify');
const DST = path.join(__dirname, 'lfa_qwen');

/* 需要复制的顶层文件（目录另行递归） */
const TOP_FILES = ['index.js', 'adapt.js', 'discover.js'];
const DIRS = ['lib', 'prompts', 'sources'];

function walk(dir, base, acc) {
  fs.readdirSync(dir).forEach(function (name) {
    const abs = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(abs).isDirectory()) walk(abs, rel, acc);
    else acc.push(rel);
  });
  return acc;
}

function listAll() {
  const out = TOP_FILES.slice();
  DIRS.forEach(function (d) {
    walk(path.join(SRC, d), d, out);
  });
  return out.sort();
}

function main() {
  if (!fs.existsSync(SRC)) { console.error('找不到源目录：' + SRC); process.exit(1); }

  const files = listAll();
  /* 重建目标目录的代码部分（保留 package.json：那里写着函数名 lfa_qwen） */
  DIRS.forEach(function (d) {
    const target = path.join(DST, d);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  });
  files.forEach(function (rel) {
    const dst = path.join(DST, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(SRC, rel), dst);
  });

  /* package.json 存在则只改 name，不存在则按源生成 */
  const pkgPath = path.join(DST, 'package.json');
  let pkg = { dependencies: {} };
  if (fs.existsSync(pkgPath)) pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  else pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
  pkg.name = 'lfa_qwen';
  pkg.description = '通义千问服务（与 lfaVerify 同源，只差环境变量）';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  /* 逐文件校验字节一致 */
  let bad = 0;
  files.forEach(function (rel) {
    const a = fs.readFileSync(path.join(SRC, rel));
    const b = fs.readFileSync(path.join(DST, rel));
    if (!a.equals(b)) { console.error('  ✗ 不一致：' + rel); bad++; }
  });

  console.log('已同步 ' + files.length + ' 个文件到 lfa_qwen' +
    (bad ? '，其中 ' + bad + ' 个校验失败' : '，全部字节一致 ✓'));
  process.exit(bad ? 1 : 0);
}

main();
