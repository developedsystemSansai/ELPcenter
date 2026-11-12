/* ศูนย์ยืม-คืนอุปกรณ์ — หน้าเจ้าหน้าที่ (vanilla JS, ไม่ต้อง build) */
(function () {
'use strict';
var C = window.ELC_CONFIG || {}, API = window.ELC_API;
var $ = function (s, r) { return (r || document).querySelector(s); };
var S = { cfg: null, assets: null, cur: null, sess: null, preselect: null };
var navId = 0, scanStream = null, scanTimer = null;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function icon(n) { return '<svg class="ico" aria-hidden="true"><use href="#i-' + n + '"/></svg>'; }
var MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function fmtDate(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? (+m[3]) + ' ' + MON[+m[2] - 1] + ' ' + (+m[1] + 543) : '-'; }
function fmtDT(s) { var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(s || '')); return m ? fmtDate(m[1]) + ' ' + m[2] + ' น.' : fmtDate(s); }
function addDays(iso, n) { var p = iso.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10); }
function today() { return (S.cfg && S.cfg.today) || new Date().toISOString().slice(0, 10); }
function toast(msg, bad) {
  var el = document.createElement('div'); el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(function () { el.remove(); }, bad ? 6000 : 3500);
}
function goto(h) { if (location.hash === h) route(); else location.hash = h; }
function fd(f) {
  var o = {};
  Array.prototype.forEach.call(f.elements, function (e) {
    if (!e.name) return;
    if (e.type === 'checkbox') o[e.name] = e.checked ? 'Y' : 'N';
    else if (e.type === 'radio') { if (e.checked) o[e.name] = e.value; }
    else o[e.name] = e.value;
  });
  return o;
}
function dlg(html, onClose) {
  var d = $('#dlg'); d.innerHTML = html + '<form method="dialog" style="padding:0 16px 16px;text-align:right"><button class="btn sm">ปิด</button></form>';
  d.onclose = function () { d.innerHTML = ''; if (onClose) onClose(); };
  if (!d.open) d.showModal();
}
function setView(html, title) { $('#view').innerHTML = html; document.title = (title ? title + ' · ' : '') + C.ORG_NAME; window.scrollTo(0, 0); }
function loading() { $('#view').innerHTML = '<p class="loading">กำลังโหลด…</p>'; }
function fail(e, id) { if (id != null && id !== navId) return; if (e && (e.code === 'AUTH_REQUIRED')) return; $('#view').innerHTML = '<div class="empty"><p>' + esc(e.message || 'เกิดข้อผิดพลาด') + '</p><p style="margin-top:12px"><button class="btn" data-do="reload">ลองใหม่</button></p></div>'; }

// ---------- ข้อมูล ----------
function getAssets(force) {
  if (S.assets && !force) return Promise.resolve(S.assets);
  return API.call('assetList').then(function (l) { S.assets = l; return l; });
}
function getAsset(id, force) {
  if (!force && S.cur && S.cur.id === id && Date.now() - S.cur.ts < 90000) return Promise.resolve(S.cur.data);
  return Promise.all([API.call('assetGet', { id: id }), API.call('assetCheckList', { id: id, limit: 8 })]).then(function (r) {
    r[0].checks = r[1]; S.cur = { id: id, ts: Date.now(), data: r[0] }; return r[0];
  });
}
function invalidate() { S.assets = null; S.cur = null; }
function findAsset(id) { return (S.assets || []).filter(function (a) { return a.assetId === id; })[0]; }

// ---------- ตัวช่วยแสดงผล ----------
function statusBadge(a) {
  var s = a.status;
  var cls = s === 'ใช้งานได้' ? 'ok' : (s === 'จำหน่ายแล้ว' ? '' : (s === 'ชำรุด / รอซ่อม' ? 'bad' : 'warn'));
  return '<span class="badge ' + cls + '">' + esc(s) + '</span>';
}
function badges(a) {
  var h = statusBadge(a);
  if (a.loan) h += a.loan.overdue ? '<span class="badge bad">เกินกำหนดคืน ' + a.loan.daysLate + ' วัน</span>' : '<span class="badge acc">ถูกยืม · คืน ' + esc(fmtDate(a.loan.dueDate)) + '</span>';
  else if (a.loanable === 'Y' && a.status === 'ใช้งานได้') h += '<span class="badge acc">พร้อมให้ยืม</span>';
  if (a.checkDue) h += '<span class="badge warn">ถึงกำหนดตรวจสภาพ</span>';
  if (!a.qrText) h += '<span class="badge">ยังไม่มี QR</span>';
  return h;
}
function qrSvg(text, label) {
  var q = window.PT_QR(0, 'M'); q.addData(String(text), 'Byte'); q.make();
  var n = q.getModuleCount(), m = 2, d = '', t = n + m * 2;
  for (var r = 0; r < n; r++) {
    var c = 0;
    while (c < n) { if (q.isDark(r, c)) { var s = c; while (c < n && q.isDark(r, c)) c++; d += 'M' + (s + m) + ' ' + (r + m) + 'h' + (c - s) + 'v1h-' + (c - s) + 'z'; } else c++; }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + t + ' ' + t + '" shape-rendering="crispEdges" role="img" aria-label="' + esc(label || 'QR Code') + '"><rect width="' + t + '" height="' + t + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}
function assetRow(a) {
  var th = a.thumb ? '<img src="' + esc(a.thumb) + '" alt="">' : icon('box');
  return '<a class="li" href="#/asset/' + esc(a.assetId) + '"><span class="th">' + th + '</span><span class="mn"><span class="no">' + esc(a.assetNo || a.assetId) + '</span><div class="t">' + esc(a.name) + '</div><div class="s">' + esc([a.category, a.location].filter(Boolean).join(' · ') || '-') + '</div></span><span class="end">' + badges(a) + '</span></a>';
}
function loanRow(l) {
  var late = l.overdue ? '<span class="badge bad">เกินกำหนด ' + l.daysLate + ' วัน</span>' : (l.daysLeft != null && l.daysLeft <= 2 ? '<span class="badge warn">ครบกำหนด' + (l.daysLeft === 0 ? 'วันนี้' : 'ใน ' + l.daysLeft + ' วัน') + '</span>' : '');
  var tel = l.phone ? ' · <a href="tel:' + esc(String(l.phone).replace(/[^0-9+]/g, '')) + '">' + esc(l.phone) + '</a>' : '';
  return '<div class="li noth"><div class="mn"><div class="t">' + esc((l.assetNo ? l.assetNo + ' · ' : '') + (l.assetName || '')) + '</div><div class="s">' + esc(l.borrowerName) + (l.borrowerType ? ' (' + esc(l.borrowerType) + ')' : '') + tel + ' · คืนภายใน ' + esc(fmtDate(l.dueDate)) + '</div></div><div class="end">' + late +
    '<a class="btn sm pri" href="#/asset/' + esc(l.assetId) + '/return">รับคืน</a><a class="btn sm" href="#/asset/' + esc(l.assetId) + '/extend">ต่อกำหนด</a></div></div>';
}
function listOrEmpty(rows, msg) { return rows.length ? '<div class="list">' + rows.join('') + '</div>' : '<div class="list"><div class="empty">' + esc(msg) + '</div></div>'; }

// ---------- เข้าสู่ระบบ / เปลือกหน้า ----------
function renderLogin(msg) {
  var name = ''; try { name = localStorage.getItem('elc.name') || ''; } catch (e) {}
  $('#root').innerHTML = '<div class="login"><form id="loginForm" autocomplete="on"><div class="mk">' + icon('box') + '</div><div><h1>' + esc(C.ORG_NAME) + '</h1><p class="hint">' + esc(C.ORG_SUB || '') + ' · สำหรับเจ้าหน้าที่</p></div>' +
    '<div><label for="ln">ชื่อผู้ใช้งาน <em>*</em></label><input id="ln" name="name" type="text" autocomplete="name" required minlength="2" maxlength="60" placeholder="ชื่อ-สกุล หรือชื่อเล่น" value="' + esc(name) + '"><p class="hint">ใช้บันทึกว่าใครเป็นผู้ทำรายการ</p></div>' +
    '<div><label for="lp">รหัสผ่าน <em>*</em></label><input id="lp" name="pin" type="password" autocomplete="current-password" required></div>' +
    '<p class="err" role="alert" id="loginErr" ' + (msg ? '' : 'hidden') + '>' + esc(msg || '') + '</p><button class="btn pri" type="submit">เข้าสู่ระบบ</button></form></div>';
  var f = $('#loginForm');
  f.addEventListener('submit', function (e) {
    e.preventDefault(); var b = f.querySelector('button'), er = $('#loginErr'); b.disabled = true; b.classList.add('busy'); er.hidden = true;
    API.login(f.elements.name.value, f.elements.pin.value).then(function () { try { localStorage.setItem('elc.name', f.elements.name.value.trim()); } catch (x) {} S.cfg = null; invalidate(); var h = location.hash; goto(h && h.length > 2 ? h : '#/'); })
      .catch(function (x) { er.textContent = x.message; er.hidden = false; f.elements.pin.value = ''; f.elements.pin.focus(); })
      .then(function () { b.disabled = false; b.classList.remove('busy'); });
  });
  (name ? f.elements.pin : f.elements.name).focus();
}
var NAV = [['', 'home', 'ภาพรวม'], ['assets', 'box', 'ครุภัณฑ์'], ['loans', 'swap', 'ยืม-คืน'], ['scan', 'scan', 'สแกน'], ['print', 'qr', 'พิมพ์ QR'], ['log', 'log', 'ประวัติ']];
function shell() {
  if ($('#view')) return;
  var s = S.sess;
  $('#root').innerHTML = '<div class="top"><div><b>' + esc(C.ORG_NAME) + '</b><br><span>' + esc(s.name) + (s.role === 'admin' ? ' · ผู้ดูแล' : '') + '</span></div><button class="btn sm" data-do="logout" aria-label="ออกจากระบบ">' + icon('out') + '</button></div>' +
    '<div class="app"><aside class="side"><div class="brand"><span class="mk">' + icon('box') + '</span><span>' + esc(C.ORG_NAME) + '<small>' + esc(C.ORG_SUB || '') + '</small></span></div>' +
    '<nav class="nav" aria-label="เมนูหลัก">' + NAV.map(function (n) { return '<a href="#/' + n[0] + '" data-nav="' + n[0] + '">' + icon(n[1]) + '<span>' + n[2] + '</span></a>'; }).join('') + '</nav>' +
    '<div class="who"><b>' + esc(s.name) + '</b>' + (s.role === 'admin' ? 'ผู้ดูแลระบบ' : 'เจ้าหน้าที่') + (C.HOME_URL ? '<br><a href="' + esc(C.HOME_URL) + '">กลับระบบหลัก</a>' : '') + '<br><button class="btn sm" data-do="logout">' + icon('out') + 'ออกจากระบบ</button></div></aside>' +
    '<main class="main" id="view" tabindex="-1"></main></div>';
}
function markNav(key) {
  Array.prototype.forEach.call(document.querySelectorAll('.nav a'), function (a) { if (a.dataset.nav === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}

// ---------- ภาพรวม ----------
function viewDash(id) {
  API.call('dashboard').then(function (d) {
    if (id !== navId) return;
    var h = '<div class="ph"><div><h1>ภาพรวมวันนี้</h1><p>' + esc(fmtDate(d.today)) + '</p></div><div class="acts"><a class="btn" href="#/scan">' + icon('scan') + 'สแกน QR</a><a class="btn pri" href="#/asset/new">' + icon('plus') + 'เพิ่มครุภัณฑ์</a></div></div>';
    h += '<div class="sum"><div><b>' + d.total + '</b><span>รายการทั้งหมด</span></div><div><b>' + d.available + '</b><span>พร้อมให้ยืม</span></div><div><b>' + d.onLoan + '</b><span>กำลังถูกยืม</span></div><div><b>' + d.broken + '</b><span>ชำรุด / ซ่อม</span></div></div>';
    h += '<section class="sec"><h2>เกินกำหนดคืน <span class="cnt ' + (d.overdue ? 'bad' : '') + '">' + d.overdue + '</span></h2>' + listOrEmpty(d.overdueLoans.map(loanRow), 'ไม่มีรายการเกินกำหนดคืน') + '</section>';
    if (d.dueSoon.length) h += '<section class="sec"><h2>ใกล้ครบกำหนดคืน <span class="cnt warn">' + d.dueSoon.length + '</span></h2>' + listOrEmpty(d.dueSoon.map(loanRow), '') + '</section>';
    h += '<section class="sec"><h2>ถึงกำหนดตรวจสภาพ <span class="cnt ' + (d.checkDue ? 'warn' : '') + '">' + d.checkDue + '</span></h2>' + listOrEmpty(d.checkList.map(function (a) {
      return '<a class="li noth" href="#/asset/' + esc(a.assetId) + '/check"><div class="mn"><div class="t">' + esc((a.assetNo ? a.assetNo + ' · ' : '') + a.name) + '</div><div class="s">' + (a.never ? 'ยังไม่เคยตรวจ' : 'ครบกำหนด ' + esc(fmtDate(a.nextCheckDue))) + '</div></div><div class="end"><span class="btn sm">ตรวจสภาพ</span></div></a>';
    }), 'ไม่มีรายการที่ต้องตรวจ') + '</section>';
    if (d.noQr) h += '<section class="sec"><h2>ยังไม่มีป้าย QR <span class="cnt warn">' + d.noQr + '</span></h2><p class="hint" style="margin-bottom:10px">สร้างและพิมพ์ป้ายเพื่อติดที่ตัวเครื่อง</p><a class="btn pri" href="#/print">' + icon('print') + 'ไปหน้าพิมพ์ป้าย QR</a></section>';
    setView(h, 'ภาพรวม');
  }).catch(function (e) { fail(e, id); });
}

// ---------- รายการครุภัณฑ์ ----------
var F = { q: '', f: 'all' };
var FILTERS = [['all', 'ทั้งหมด'], ['avail', 'พร้อมให้ยืม'], ['onloan', 'ถูกยืม'], ['broken', 'ชำรุด / ซ่อม'], ['check', 'ถึงกำหนดตรวจ'], ['noqr', 'ยังไม่มี QR']];
function filterAssets(list) {
  var q = F.q.trim().toLowerCase();
  return list.filter(function (a) {
    if (a.status === 'จำหน่ายแล้ว' && F.f !== 'all') return false;
    if (F.f === 'avail' && !(a.loanable === 'Y' && a.status === 'ใช้งานได้' && !a.loan)) return false;
    if (F.f === 'onloan' && !a.loan) return false;
    if (F.f === 'broken' && a.status === 'ใช้งานได้') return false;
    if (F.f === 'check' && !a.checkDue) return false;
    if (F.f === 'noqr' && a.qrText) return false;
    if (!q) return true;
    return [a.assetNo, a.name, a.category, a.location, a.brand, a.model, a.serialNo, a.custodian, a.assetId].join(' ').toLowerCase().indexOf(q) >= 0;
  });
}
function viewAssets(id) {
  getAssets(true).then(function (list) {
    if (id !== navId) return;
    setView('<div class="ph"><div><h1>ครุภัณฑ์และอุปกรณ์</h1><p>' + list.length + ' รายการ</p></div><div class="acts"><a class="btn pri" href="#/asset/new">' + icon('plus') + 'เพิ่มรายการ</a></div></div>' +
      '<div class="tools"><div class="q">' + icon('search') + '<label class="sr" for="aq">ค้นหา</label><input id="aq" type="search" placeholder="ค้นหา เลขครุภัณฑ์ ชื่อ สถานที่ ยี่ห้อ" value="' + esc(F.q) + '" autocomplete="off"></div></div>' +
      '<div class="chips" role="group" aria-label="กรองรายการ">' + FILTERS.map(function (x) { return '<button class="chip" type="button" data-filter="' + x[0] + '" aria-pressed="' + (F.f === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<div id="aList" style="margin-top:12px"></div>', 'ครุภัณฑ์');
    paintAssets();
  }).catch(function (e) { fail(e, id); });
}
function paintAssets() {
  var el = $('#aList'); if (!el) return;
  var rows = filterAssets(S.assets || []);
  el.innerHTML = listOrEmpty(rows.slice(0, 300).map(assetRow), 'ไม่พบรายการที่ตรงกับเงื่อนไข') + (rows.length > 300 ? '<p class="hint" style="margin-top:8px">แสดง 300 รายการแรก — พิมพ์ค้นหาเพื่อกรองให้แคบลง</p>' : '');
  Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.filter === F.f)); });
}

// ---------- รายละเอียดครุภัณฑ์ ----------
function opts(list, sel) { return list.map(function (x) { return '<option' + (x === sel ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join(''); }
function fld(label, name, type, val, extra, req) {
  return '<div><label for="f-' + name + '">' + esc(label) + (req ? ' <em>*</em>' : '') + '</label><input id="f-' + name + '" name="' + name + '" type="' + type + '" value="' + esc(val == null ? '' : val) + '" ' + (extra || '') + (req ? ' required' : '') + '></div>';
}
function qrBox(a) {
  if (!a.qrText) return '<div class="code">' + icon('qr') + '</div><div><b>ยังไม่มีป้าย QR</b><p>สร้าง QR แล้วพิมพ์ไปติดที่ตัวเครื่อง</p><button class="btn sm pri" data-do="qrmake" data-id="' + esc(a.assetId) + '">สร้าง QR</button></div>';
  return '<div class="code">' + qrSvg(a.qrText, 'QR Code ' + (a.assetNo || a.assetId)) + '</div><div><b>ป้าย QR ประจำเครื่อง</b><p>สแกนด้วยกล้องมือถือเพื่อดูข้อมูล</p><button class="btn sm" data-do="printOne" data-id="' + esc(a.assetId) + '">' + icon('print') + 'พิมพ์ป้าย</button></div>';
}
function actionBar(a) {
  var u = '#/asset/' + esc(a.assetId), h = '<div class="bar">';
  if (a.loan) h += '<a class="btn pri" href="' + u + '/return">' + icon('swap') + 'รับคืน</a><a class="btn" href="' + u + '/extend">ต่อกำหนดคืน</a>';
  else if (a.loanable === 'Y' && a.status === 'ใช้งานได้') h += '<a class="btn pri" href="' + u + '/loan">' + icon('swap') + 'ให้ยืม</a>';
  h += '<a class="btn" href="' + u + '/check">' + icon('check') + 'ตรวจสภาพ</a><a class="btn" href="' + u + '/edit">' + icon('edit') + 'แก้ไข</a><button class="btn" data-do="photo" data-id="' + esc(a.assetId) + '">' + icon('cam') + 'แนบรูป</button>';
  if (S.sess.role === 'admin') h += '<a class="btn dng" href="' + u + '/void">ยกเลิกรายการ</a>';
  return h + '</div>';
}
function formShell(title, name, body, submit, a, danger) {
  return '<section class="panel"><h2>' + esc(title) + '</h2><form data-form="' + name + '" novalidate><input type="hidden" name="assetId" value="' + esc(a.assetId) + '">' + body +
    '<p class="err" role="alert" tabindex="-1" hidden></p><div class="foot"><button class="btn ' + (danger ? 'dng' : 'pri') + '" type="submit">' + esc(submit) + '</button><a class="btn" href="#/asset/' + esc(a.assetId) + '">ยกเลิก</a></div></form></section>';
}
function panelHtml(a, act) {
  var cfg = S.cfg, t = today();
  if (act === 'loan') {
    if (a.loan) return '<p class="err">รายการนี้ถูกยืมอยู่แล้ว</p>';
    if (a.loanable !== 'Y') return '<p class="err">รายการนี้ไม่ได้กำหนดให้ยืม — กด “แก้ไข” แล้วเปิด “ให้ยืมได้”</p>';
    if (a.status !== 'ใช้งานได้') return '<p class="err">รายการนี้ยังไม่พร้อมให้ยืม (สถานะ: ' + esc(a.status) + ')</p>';
    return formShell('บันทึกการยืม', 'loan',
      '<div class="fg">' + fld('ชื่อผู้ยืม', 'borrowerName', 'text', '', 'maxlength="100" autocomplete="off"', true) +
      '<div><label for="f-bt">ประเภทผู้ยืม <em>*</em></label><select id="f-bt" name="borrowerType">' + opts(cfg.borrowerTypes, '') + '</select></div>' +
      fld('HN / รหัสผู้ยืม', 'borrowerHN', 'text', '', 'maxlength="30" autocomplete="off"') + fld('เบอร์โทร', 'phone', 'tel', '', 'maxlength="20" inputmode="tel" autocomplete="off"') +
      fld('วันที่ยืม', 'loanDate', 'date', t, 'max="' + t + '"') + fld('กำหนดคืน', 'dueDate', 'date', addDays(t, cfg.defaultLoanDays), 'min="' + t + '"', true) +
      '<div class="full"><label for="f-co">สภาพเมื่อให้ยืม</label><input id="f-co" name="conditionOut" type="text" maxlength="200" value="สภาพปกติ"></div>' +
      '<div class="full"><label for="f-nt">หมายเหตุ</label><input id="f-nt" name="note" type="text" maxlength="300"></div></div>', 'บันทึกการยืม', a);
  }
  if (act === 'return') {
    if (!a.loan) return '<p class="err">รายการนี้ไม่ได้ถูกยืมอยู่</p>';
    return formShell('รับคืนอุปกรณ์', 'return',
      '<input type="hidden" name="loanId" value="' + esc(a.loan.loanId) + '"><p style="margin-bottom:12px"><b>' + esc(a.loan.borrowerName) + '</b> · ยืมเมื่อ ' + esc(fmtDate(a.loan.loanDate)) + ' · กำหนดคืน ' + esc(fmtDate(a.loan.dueDate)) + (a.loan.overdue ? ' <span class="badge bad">เกินกำหนด ' + a.loan.daysLate + ' วัน</span>' : '') + '</p>' +
      '<div class="fg"><div class="full"><label>สภาพเมื่อรับคืน</label><div class="radios"><label><input type="radio" name="damaged" value="N" checked>สภาพปกติ</label><label><input type="radio" name="damaged" value="Y">พบความเสียหาย</label></div><p class="hint">เลือก “พบความเสียหาย” ระบบจะเปลี่ยนสถานะเป็น ชำรุด / รอซ่อม ให้อัตโนมัติ</p></div>' +
      '<div class="full"><label for="f-ci">รายละเอียด (จำเป็นถ้าพบความเสียหาย)</label><textarea id="f-ci" name="conditionIn" maxlength="200"></textarea></div>' + fld('วันที่คืน', 'returnDate', 'date', t, 'max="' + t + '"') + '</div>', 'บันทึกการรับคืน', a);
  }
  if (act === 'extend') {
    if (!a.loan) return '<p class="err">รายการนี้ไม่ได้ถูกยืมอยู่</p>';
    return formShell('ต่อกำหนดคืน', 'extend', '<input type="hidden" name="loanId" value="' + esc(a.loan.loanId) + '"><p style="margin-bottom:12px">กำหนดคืนเดิม <b>' + esc(fmtDate(a.loan.dueDate)) + '</b> · ผู้ยืม ' + esc(a.loan.borrowerName) + '</p><div class="fg">' +
      fld('กำหนดคืนใหม่', 'dueDate', 'date', addDays(a.loan.dueDate, cfg.defaultLoanDays), 'min="' + addDays(a.loan.dueDate, 1) + '"', true) + fld('เหตุผล', 'reason', 'text', '', 'maxlength="200"') + '</div>', 'บันทึกการต่อกำหนด', a);
  }
  if (act === 'check') {
    return formShell('บันทึกการตรวจสภาพ', 'check', '<div class="fg"><div class="full"><label>ผลการตรวจ</label><div class="radios">' + cfg.checkResults.map(function (r, i) { return '<label><input type="radio" name="result" value="' + esc(r) + '"' + (i === 0 ? ' checked' : '') + '>' + esc(r) + '</label>'; }).join('') + '</div>' +
      '<p class="hint">เลือก “ชำรุด ใช้งานไม่ได้” ระบบจะเปลี่ยนสถานะเป็น ชำรุด / รอซ่อม ให้อัตโนมัติ' + (a.checkIntervalDays ? ' · วันตรวจครั้งถัดไปจะตั้งเป็นอีก ' + a.checkIntervalDays + ' วัน' : '') + '</p></div>' +
      '<div class="full"><label for="f-n">รายละเอียดที่พบ (จำเป็นถ้าไม่ใช่ “ปกติ”)</label><textarea id="f-n" name="note" maxlength="500" placeholder="เช่น สายไฟชำรุด ปุ่มปรับไม่ทำงาน หรือทำความสะอาดแล้ว"></textarea></div></div>', 'บันทึกการตรวจ', a);
  }
  if (act === 'void' && S.sess.role === 'admin') {
    return formShell('ยกเลิกรายการ', 'void', '<p style="margin-bottom:12px">รายการจะถูกซ่อนจากทะเบียน แต่ข้อมูลยังอยู่ในชีตและมีประวัติตรวจสอบย้อนหลัง</p><label for="f-r">เหตุผลที่ยกเลิก <em>*</em></label><textarea id="f-r" name="reason" maxlength="300" required></textarea>', 'ยืนยันยกเลิกรายการ', a, true);
  }
  return '';
}
var ACT = { create: 'เพิ่มรายการ', update: 'แก้ไขข้อมูล', void: 'ยกเลิกรายการ', photo_add: 'แนบรูป', photo_del: 'ถอดรูป', qr_gen: 'สร้าง QR', qr_print: 'พิมพ์ป้าย QR', check: 'ตรวจสภาพ', loan_out: 'ให้ยืม', loan_in: 'รับคืน', loan_extend: 'ต่อกำหนดคืน' };
var LBL = { assetNo: 'เลขครุภัณฑ์', name: 'ชื่อ', category: 'หมวด', brand: 'ยี่ห้อ', model: 'รุ่น', serialNo: 'Serial', spec: 'รายละเอียด', acquireMethod: 'วิธีได้มา', fundSource: 'แหล่งเงิน', unitPrice: 'ราคา', acquireDate: 'วันที่ได้มา', docRef: 'เอกสารอ้างอิง', vendor: 'ผู้ขาย', warrantyEnd: 'หมดประกัน', lifeYears: 'อายุใช้งาน', location: 'สถานที่', custodian: 'ผู้รับผิดชอบ', status: 'สถานะ', loanable: 'การให้ยืม', calibDue: 'สอบเทียบ', remark: 'หมายเหตุ', checkIntervalDays: 'รอบตรวจ' };
function logText(x) {
  var d = {}; try { d = JSON.parse(x.detail || '{}'); } catch (e) {}
  var t = ACT[x.action] || x.action;
  if (x.action === 'update') t += ': ' + Object.keys(d).map(function (k) { return LBL[k] || k; }).join(', ');
  else if (x.action === 'loan_out') t += ': ' + (d.borrower || '');
  else if (x.action === 'loan_in') t += d.damaged ? ' (พบความเสียหาย: ' + (d.condition || '') + ')' : (d.late ? ' (คืนช้า)' : '');
  else if (x.action === 'loan_extend') t += ' เป็น ' + fmtDate(d.to);
  else if (x.action === 'check') t += ': ' + (d.result || '') + (d.note ? ' — ' + d.note : '');
  else if (x.action === 'void') t += ': ' + (d.reason || '');
  return t;
}
function viewAsset(id, act, nid) {
  getAsset(id).then(function (a) {
    if (nid !== navId) return;
    var kv = [['หมวด', a.category], ['ยี่ห้อ / รุ่น', [a.brand, a.model].filter(Boolean).join(' / ')], ['Serial', a.serialNo], ['รายละเอียด', a.spec], ['สถานที่ตั้ง', a.location], ['ผู้รับผิดชอบ', a.custodian],
      ['การให้ยืม', a.loanable === 'Y' ? 'ให้ยืมได้' : 'ไม่ให้ยืม'], ['รอบตรวจสภาพ', a.checkIntervalDays ? 'ทุก ' + a.checkIntervalDays + ' วัน' : ''],
      ['ตรวจล่าสุด', a.lastCheckAt ? fmtDate(a.lastCheckAt) + ' · ' + (a.lastCheckResult || '') + ' · ' + (a.lastCheckBy || '') : 'ยังไม่เคยบันทึก'], ['ตรวจครั้งถัดไป', a.nextCheckDue ? fmtDate(a.nextCheckDue) : ''],
      ['วิธีได้มา', [a.acquireMethod, a.fundSource].filter(Boolean).join(' · ')], ['วันที่ได้มา', a.acquireDate ? fmtDate(a.acquireDate) : ''], ['ราคา', a.unitPrice !== '' ? Number(a.unitPrice).toLocaleString('th-TH', { minimumFractionDigits: 2 }) + ' บาท' : ''],
      ['เอกสารอ้างอิง', a.docRef], ['ผู้ขาย', a.vendor], ['หมดประกัน', a.warrantyEnd ? fmtDate(a.warrantyEnd) : ''], ['สอบเทียบครบ', a.calibDue ? fmtDate(a.calibDue) : ''], ['หมายเหตุ', a.remark],
      ['แก้ไขล่าสุด', a.updatedAt ? fmtDT(a.updatedAt) + ' · ' + (a.updatedBy || '') : '']].filter(function (r) { return r[1]; });
    var photos = a.photoIds.map(function (fid, i) {
      return '<figure><button class="pic" type="button" data-do="viewPhoto" data-fid="' + esc(fid) + '" aria-label="ดูรูปที่ ' + (i + 1) + '">' + (i === 0 && a.thumb ? '<img src="' + esc(a.thumb) + '" alt="">' : icon('cam')) + '</button><button class="x" type="button" data-do="rmPhoto" data-id="' + esc(a.assetId) + '" data-fid="' + esc(fid) + '" aria-label="ถอดรูปที่ ' + (i + 1) + '">' + icon('x') + '</button></figure>';
    }).join('');
    var h = '<a class="crumb" href="#/assets">' + icon('back') + 'ครุภัณฑ์ทั้งหมด</a><div class="hd"><div><div class="no">' + esc(a.assetNo || ('ยังไม่มีเลขครุภัณฑ์ · ' + a.assetId)) + '</div><h1>' + esc(a.name) + '</h1><div class="chips2">' + badges(a) + '</div></div><div class="qrbox">' + qrBox(a) + '</div></div>' +
      actionBar(a) + '<div id="slot">' + panelHtml(a, act) + '</div><div class="cols"><section><h2 style="margin-bottom:6px">ข้อมูลครุภัณฑ์</h2><dl class="kv">' + kv.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' +
      '<h2 style="margin:24px 0 8px">รูปภาพ (' + a.photoIds.length + ')</h2>' + (photos ? '<div class="ph-grid">' + photos + '</div>' : '<p class="hint">ยังไม่มีรูป — กด “แนบรูป”</p>') + '</section><section>' +
      '<h2 style="margin-bottom:6px">ประวัติการยืม-คืน</h2>' + (a.loans.length ? '<ul class="tl">' + a.loans.map(function (l) { return '<li><time>' + esc(fmtDate(l.loanDate)) + '</time><span>' + esc(l.borrowerName) + (l.borrowerType ? ' <small>(' + esc(l.borrowerType) + ')</small>' : '') + '<br><small>' + (l.status === 'ยืมอยู่' ? 'ยังไม่คืน · กำหนด ' + esc(fmtDate(l.dueDate)) : 'คืน ' + esc(fmtDate(l.returnDate)) + (l.conditionIn ? ' · ' + esc(l.conditionIn) : '')) + '</small></span></li>'; }).join('') + '</ul>' : '<p class="hint">ยังไม่เคยถูกยืม</p>') +
      '<h2 style="margin:24px 0 6px">ประวัติการตรวจสภาพ</h2>' + (a.checks.length ? '<ul class="tl">' + a.checks.map(function (r) { return '<li><time>' + esc(fmtDate(r.ts)) + '</time><span>' + esc(r.result) + (r.note ? ' — ' + esc(r.note) : '') + ' <small>โดย ' + esc(r.by) + '</small></span></li>'; }).join('') + '</ul>' : '<p class="hint">ยังไม่มีประวัติ</p>') +
      '<details class="more" style="margin-top:20px"><summary>บันทึกการเปลี่ยนแปลง (' + a.log.length + ')</summary><ul class="tl">' + a.log.map(function (x) { return '<li><time>' + esc(fmtDT(x.ts)) + '</time><span>' + esc(logText(x)) + ' <small>โดย ' + esc(x.by) + '</small></span></li>'; }).join('') + '</ul></details></section></div>';
    setView(h, a.assetNo || a.name);
    if (act) { var p = $('.panel'); if (p) { var first = p.querySelector('input:not([type=hidden]),textarea,select'); if (first) first.focus({ preventScroll: true }); p.scrollIntoView({ block: 'nearest' }); } }
  }).catch(function (e) { fail(e, nid); });
}

// ---------- ฟอร์มส่ง ----------
var FORMS = {
  loan: function (d) { return { action: 'loanCheckout', args: d, msg: 'บันทึกการยืมแล้ว', next: '#/asset/' + d.assetId }; },
  return: function (d) { return { action: 'loanReturn', args: { loanId: d.loanId, damaged: d.damaged === 'Y', conditionIn: d.conditionIn, returnDate: d.returnDate }, msg: function (r) { return r.statusChanged ? 'รับคืนแล้ว — เปลี่ยนสถานะเป็น ชำรุด / รอซ่อม' : 'รับคืนแล้ว'; }, next: '#/asset/' + d.assetId }; },
  extend: function (d) { return { action: 'loanExtend', args: { loanId: d.loanId, dueDate: d.dueDate, reason: d.reason }, msg: 'ต่อกำหนดคืนแล้ว', next: '#/asset/' + d.assetId }; },
  check: function (d) { return { action: 'assetCheckSave', args: { assetId: d.assetId, result: d.result, note: d.note }, msg: function (r) { return r.statusChanged ? 'บันทึกแล้ว — เปลี่ยนสถานะเป็น ชำรุด / รอซ่อม' : 'บันทึกการตรวจสภาพแล้ว'; }, next: '#/asset/' + d.assetId }; },
  void: function (d) { return { action: 'assetVoid', args: { id: d.assetId, reason: d.reason }, msg: 'ยกเลิกรายการแล้ว', next: '#/assets' }; },
  asset: function (d) { return { action: 'assetSave', args: d, msg: function (r) { return r.created ? 'เพิ่มรายการแล้ว' : (r.changed === false ? 'ไม่มีการเปลี่ยนแปลง' : 'บันทึกการแก้ไขแล้ว'); }, next: function (r) { return '#/asset/' + r.assetId; }, after: function (r) { if (r.qrError) toast('เพิ่มรายการแล้ว แต่สร้าง QR ไม่สำเร็จ: ' + r.qrError, true); } }; }
};
document.addEventListener('submit', function (e) {
  var f = e.target.closest('form[data-form]'); if (!f) return;
  e.preventDefault();
  var d = fd(f), spec = FORMS[f.dataset.form](d), btn = f.querySelector('[type=submit]'), er = f.querySelector('.err');
  er.hidden = true; btn.disabled = true; btn.classList.add('busy');
  API.call(spec.action, spec.args).then(function (r) {
    toast(typeof spec.msg === 'function' ? spec.msg(r) : spec.msg); invalidate();
    if (spec.after) spec.after(r);
    goto(typeof spec.next === 'function' ? spec.next(r) : spec.next);
  }).catch(function (x) { er.textContent = x.message; er.hidden = false; er.focus(); btn.disabled = false; btn.classList.remove('busy'); });
});

// ---------- เพิ่ม / แก้ไขครุภัณฑ์ ----------
function viewAssetForm(id, nid) {
  Promise.all([id ? getAsset(id) : Promise.resolve({ status: 'ใช้งานได้', loanable: 'Y', checkIntervalDays: 90 }), getAssets()]).then(function (r) {
    if (nid !== navId) return;
    var a = r[0], cfg = S.cfg, uniq = function (k) { var m = {}; r[1].forEach(function (x) { if (x[k]) m[x[k]] = 1; }); return Object.keys(m).sort(); };
    var dl = function (idn, k) { return '<datalist id="' + idn + '">' + uniq(k).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('') + '</datalist>'; };
    var ints = [['', 'ไม่กำหนด'], ['30', 'ทุก 1 เดือน'], ['90', 'ทุก 3 เดือน'], ['180', 'ทุก 6 เดือน'], ['365', 'ทุก 1 ปี']], iv = a.checkIntervalDays ? String(a.checkIntervalDays) : '';
    if (iv && !ints.some(function (x) { return x[0] === iv; })) ints.push([iv, 'ทุก ' + iv + ' วัน']);
    var ro = id && a.assetNo ? ' readonly' : '';
    setView('<a class="crumb" href="' + (id ? '#/asset/' + esc(id) : '#/assets') + '">' + icon('back') + 'กลับ</a><div class="ph"><h1>' + (id ? 'แก้ไขครุภัณฑ์' : 'เพิ่มครุภัณฑ์ / อุปกรณ์') + '</h1></div>' +
      '<form data-form="asset" novalidate class="panel" style="animation:none"><input type="hidden" name="assetId" value="' + esc(id || '') + '">' +
      '<h2 style="margin-bottom:12px">ข้อมูลหลัก</h2><div class="fg">' + fld('ชื่อรายการ', 'name', 'text', a.name, 'maxlength="160"', true) + fld('เลขครุภัณฑ์', 'assetNo', 'text', a.assetNo, 'maxlength="60"' + ro) +
      fld('หมวดหมู่', 'category', 'text', a.category, 'maxlength="60" list="dl-cat"') + fld('สถานที่ตั้ง', 'location', 'text', a.location, 'maxlength="100" list="dl-loc"') + fld('ผู้รับผิดชอบ', 'custodian', 'text', a.custodian, 'maxlength="100"') +
      '<div><label for="f-st">สถานะ</label><select id="f-st" name="status">' + opts(cfg.statuses, a.status) + '</select></div></div>' +
      '<h2 style="margin:24px 0 12px">การยืมและการตรวจสภาพ</h2><div class="fg"><div class="full"><label class="sw"><input type="checkbox" name="loanable"' + (a.loanable === 'Y' ? ' checked' : '') + '>ให้ยืมได้ (แสดงในศูนย์ยืม-คืน)</label></div>' +
      '<div><label for="f-iv">รอบตรวจสภาพ</label><select id="f-iv" name="checkIntervalDays">' + ints.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === iv ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select><p class="hint">ระบบเตือนในหน้าภาพรวมเมื่อครบกำหนด</p></div>' + fld('สอบเทียบครบกำหนด', 'calibDue', 'date', a.calibDue) + '</div>' +
      '<details class="more" ' + (id ? 'open' : '') + ' style="margin-top:20px"><summary>รายละเอียดเพิ่มเติม (ยี่ห้อ Serial ราคา การได้มา)</summary><div class="fg" style="margin-top:8px">' + fld('ยี่ห้อ', 'brand', 'text', a.brand, 'maxlength="80"') + fld('รุ่น', 'model', 'text', a.model, 'maxlength="80"') + fld('Serial No.', 'serialNo', 'text', a.serialNo, 'maxlength="80"') +
      '<div><label for="f-am">วิธีได้มา</label><select id="f-am" name="acquireMethod"><option value=""></option>' + opts(cfg.acquireMethods, a.acquireMethod) + '</select></div>' + fld('แหล่งเงิน', 'fundSource', 'text', a.fundSource, 'maxlength="60"') + fld('ราคาต่อหน่วย (บาท)', 'unitPrice', 'number', a.unitPrice, 'min="0" step="0.01" inputmode="decimal"') +
      fld('วันที่ได้มา', 'acquireDate', 'date', a.acquireDate) + fld('เอกสารอ้างอิง', 'docRef', 'text', a.docRef, 'maxlength="100"') + fld('ผู้ขาย / ผู้บริจาค', 'vendor', 'text', a.vendor, 'maxlength="120"') + fld('หมดประกัน', 'warrantyEnd', 'date', a.warrantyEnd) + fld('อายุใช้งาน (ปี)', 'lifeYears', 'number', a.lifeYears, 'min="0" step="1" inputmode="numeric"') +
      '<div class="full"><label for="f-sp">สเปก / รายละเอียด</label><textarea id="f-sp" name="spec" maxlength="500">' + esc(a.spec) + '</textarea></div><div class="full"><label for="f-rm">หมายเหตุ</label><textarea id="f-rm" name="remark" maxlength="500">' + esc(a.remark) + '</textarea></div></div></details>' +
      dl('dl-cat', 'category') + dl('dl-loc', 'location') + '<p class="err" role="alert" tabindex="-1" hidden></p><div class="foot"><button class="btn pri" type="submit">บันทึก</button><a class="btn" href="' + (id ? '#/asset/' + esc(id) : '#/assets') + '">ยกเลิก</a></div>' +
      (id ? '' : '<p class="hint" style="margin-top:10px">บันทึกแล้วระบบสร้างป้าย QR ให้อัตโนมัติ และบันทึกลงชีตให้ทันที</p>') + '</form>', id ? 'แก้ไข' : 'เพิ่มครุภัณฑ์');
  }).catch(function (e) { fail(e, nid); });
}

// ---------- รูปภาพ ----------
function compress(file, max, q) {
  return new Promise(function (res, rej) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var r = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * r)); c.height = Math.max(1, Math.round(img.height * r));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', q));
    };
    img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('อ่านไฟล์รูปไม่ได้')); };
    img.src = url;
  });
}
function thumbOf(file) { var q = 0.6; function go() { return compress(file, 96, q).then(function (u) { if (u.length > 18000 && q > 0.25) { q -= 0.15; return go(); } return u; }); } return go(); }
function pickPhoto(id) {
  var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
  inp.onchange = function () {
    var files = Array.prototype.slice.call(inp.files || []), n = 0; if (!files.length) return;
    toast('กำลังอัปโหลดรูป…');
    files.reduce(function (p, f) {
      return p.then(function () { return Promise.all([compress(f, 1280, 0.8), thumbOf(f)]).then(function (r) { return API.call('assetAddPhoto', { id: id, full: r[0], thumb: r[1] }, { timeout: 120000 }); }).then(function () { n++; }); });
    }, Promise.resolve()).then(function () { toast('แนบรูปแล้ว ' + n + ' รูป'); }).catch(function (e) { toast(e.message, true); }).then(function () { invalidate(); route(); });
  };
  inp.click();
}

// ---------- สร้าง / พิมพ์ป้าย QR ----------
var SIZES = { S: { w: 50, h: 28, q: 22, no: 9, nm: 7, name: 'เล็ก 50 × 28 มม.' }, M: { w: 70, h: 38, q: 30, no: 12, nm: 9, name: 'กลาง 70 × 38 มม.' }, L: { w: 95, h: 52, q: 42, no: 16, nm: 11, name: 'ใหญ่ 95 × 52 มม.' } };
function genQr(ids, force) {
  var out = { ok: 0, fail: 0 }, i = 0;
  return new Promise(function (res) {
    (function step() {
      if (i >= ids.length) return res(out);
      var from = i; i += 5;
      API.call('assetQrBatch', { ids: ids.slice(from, from + 5), force: !!force }, { timeout: 120000 }).then(function (r) {
        r.results.forEach(function (x) { if (x.ok) out.ok++; else out.fail++; }); step();
      }).catch(function (e) { out.fail += ids.length - from; out.err = e.message; res(out); });
    })();
  });
}
function printLabels(items, sizeKey, showTxt) {
  var sz = SIZES[sizeKey] || SIZES.M, org = C.ORG_NAME + (C.ORG_SUB ? ' · ' + C.ORG_SUB : '');
  var css = '#printRoot{font-family:Sarabun,Tahoma,sans-serif;color:#000;background:#fff}#printRoot .sheet{display:flex;flex-wrap:wrap;gap:2mm;padding:3mm}' +
    '#printRoot .lb{width:' + sz.w + 'mm;height:' + sz.h + 'mm;display:flex;align-items:center;gap:2mm;padding:2mm;border:.25mm dashed #777;overflow:hidden;break-inside:avoid;page-break-inside:avoid}' +
    '#printRoot .q{flex:none;width:' + sz.q + 'mm;height:' + sz.q + 'mm}#printRoot .q svg{display:block;width:100%;height:100%}#printRoot .t{flex:1;min-width:0;line-height:1.2}#printRoot .org{font-size:' + (sz.nm - 2) + 'pt;color:#333}' +
    '#printRoot .no{font-size:' + sz.no + 'pt;font-weight:700;overflow-wrap:anywhere}#printRoot .nm{font-size:' + sz.nm + 'pt;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}' +
    '#printRoot .loc{font-size:' + (sz.nm - 1) + 'pt;color:#222;overflow-wrap:anywhere}#printRoot .sc{margin-top:1mm;font-size:' + (sz.nm - 2.5) + 'pt;color:#333}';
  $('#printRoot').innerHTML = '<style>' + css + '</style><div class="sheet">' + items.map(function (a) {
    return '<div class="lb"><div class="q">' + qrSvg(a.qrText, 'QR ' + (a.assetNo || a.assetId)) + '</div><div class="t"><div class="org">' + esc(org) + '</div><div class="no">' + esc(a.assetNo || a.assetId) + '</div>' +
      (showTxt ? '<div class="nm">' + esc(a.name) + '</div>' + (a.location ? '<div class="loc">' + esc(a.location) + '</div>' : '') : '') + '<div class="sc">สแกนดูข้อมูล / ยืม-คืน</div></div></div>';
  }).join('') + '</div>';
  document.body.classList.add('is-printing');
  setTimeout(function () { window.print(); }, 200);
}
function viewPrint(nid) {
  getAssets(true).then(function (list) {
    if (nid !== navId) return;
    list = list.filter(function (a) { return a.status !== 'จำหน่ายแล้ว'; });
    var pre = {}; (S.preselect || []).forEach(function (i) { pre[i] = 1; }); var hasPre = !!S.preselect; S.preselect = null;
    var size = 'M', showTxt = true; try { size = localStorage.getItem('elc.size') || 'M'; } catch (e) {} if (!SIZES[size]) size = 'M';
    setView('<div class="ph"><div><h1>พิมพ์ป้าย QR</h1><p>เลือกรายการ ระบบสร้าง QR ที่ยังไม่มีให้อัตโนมัติ แล้วพิมพ์เป็นสติกเกอร์ A4</p></div></div>' +
      '<div class="tools"><div class="q">' + icon('search') + '<label class="sr" for="pq">ค้นหา</label><input id="pq" type="search" placeholder="ค้นหาในรายการ" autocomplete="off"></div><button class="btn sm" data-psel="all">เลือกทั้งหมด</button><button class="btn sm" data-psel="none">ล้าง</button><button class="btn sm" data-psel="noqr">เฉพาะที่ยังไม่มี QR</button></div>' +
      '<div class="list psel" id="psel">' + (list.length ? list.map(function (a) {
        return '<label data-q="' + esc([a.assetNo, a.name, a.location, a.assetId].join(' ').toLowerCase()) + '"><input type="checkbox" value="' + esc(a.assetId) + '"' + (hasPre ? (pre[a.assetId] ? ' checked' : '') : '') + '><span class="mn" style="flex:1;min-width:0"><span class="no" style="font-weight:700;color:var(--accent);font-size:.8125rem">' + esc(a.assetNo || a.assetId) + '</span><br>' + esc(a.name) + (a.location ? ' <small style="color:var(--ink2)">· ' + esc(a.location) + '</small>' : '') + '</span>' + (a.qrText ? '' : '<span class="badge">ยังไม่มี QR</span>') + '</label>';
      }).join('') : '<div class="empty">ยังไม่มีครุภัณฑ์</div>') + '</div>' +
      '<div class="prow"><div><label for="psz">ขนาดป้าย</label><select id="psz">' + Object.keys(SIZES).map(function (k) { return '<option value="' + k + '"' + (k === size ? ' selected' : '') + '>' + SIZES[k].name + '</option>'; }).join('') + '</select></div>' +
      '<label class="sw"><input type="checkbox" id="ptx" checked>แสดงชื่อและสถานที่บนป้าย</label><span id="pn" class="hint" aria-live="polite"></span><button class="btn pri" data-do="doPrint">' + icon('print') + 'พิมพ์ป้าย</button></div>' +
      '<p class="hint">ตั้งค่าการพิมพ์เป็น “ขนาดจริง (100%)” ไม่ย่อหน้า · แนะนำกระดาษสติกเกอร์ A4 แล้วตัดตามเส้นประ</p>' +
      (S.sess.role === 'admin' ? '<details class="more" style="margin-top:20px"><summary>สำหรับผู้ดูแล: สร้างรูป QR ใหม่ทั้งหมด</summary><p class="hint">ใช้เมื่อเปลี่ยนที่อยู่เว็บ (FRONTEND_URL) ป้ายที่ติดไปแล้วต้องพิมพ์ใหม่ทั้งหมด</p><button class="btn dng sm" data-do="regenAll" style="margin-top:8px">สร้าง QR ใหม่ทั้งหมด</button></details>' : ''), 'พิมพ์ป้าย QR');
    countSel();
  }).catch(function (e) { fail(e, nid); });
}
function selBoxes() { return Array.prototype.slice.call(document.querySelectorAll('#psel input[type=checkbox]')); }
function countSel() { var n = selBoxes().filter(function (b) { return b.checked; }).length, el = $('#pn'); if (el) el.textContent = 'เลือกแล้ว ' + n + ' รายการ'; }
function doPrint(btn) {
  var ids = selBoxes().filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
  if (!ids.length) { toast('เลือกอย่างน้อย 1 รายการ', true); return; }
  var size = $('#psz').value, showTxt = $('#ptx').checked; try { localStorage.setItem('elc.size', size); } catch (e) {}
  var need = ids.filter(function (i) { var a = findAsset(i); return a && !a.qrText; });
  btn.disabled = true; btn.classList.add('busy');
  (need.length ? (toast('กำลังสร้าง QR ' + need.length + ' รายการ…'), genQr(need, false)) : Promise.resolve({ ok: 0, fail: 0 })).then(function (r) {
    if (r.fail) toast('สร้าง QR ไม่สำเร็จ ' + r.fail + ' รายการ' + (r.err ? ' — ' + r.err : ''), true);
    return getAssets(true);
  }).then(function () {
    var items = ids.map(findAsset).filter(function (a) { return a && a.qrText; });
    if (!items.length) { toast('ไม่มีรายการที่มี QR ให้พิมพ์', true); return; }
    printLabels(items, size, showTxt);
    API.call('assetQrPrintLog', { ids: items.map(function (a) { return a.assetId; }), size: size }).catch(function () {});
  }).catch(function (e) { toast(e.message, true); }).then(function () { btn.disabled = false; btn.classList.remove('busy'); });
}

// ---------- สแกน QR ----------
function stopScan() { if (scanTimer) { clearInterval(scanTimer); scanTimer = null; } if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop(); }); scanStream = null; } }
function resolveCode(t) {
  t = String(t || '').trim(); if (!t) return Promise.resolve(null);
  var m = /[?&]id=(A\d{3,})/i.exec(t) || /^(A\d{3,})$/i.exec(t);
  if (m) return Promise.resolve(m[1].toUpperCase());
  return getAssets().then(function (l) {
    var q = t.toLowerCase(), ex = l.filter(function (a) { return String(a.assetNo).toLowerCase() === q; });
    if (ex.length === 1) return ex[0].assetId;
    var p = l.filter(function (a) { return (a.assetNo + ' ' + a.name).toLowerCase().indexOf(q) >= 0; });
    return p.length === 1 ? p[0].assetId : null;
  });
}
function openCode(t) {
  return resolveCode(t).then(function (id) { if (id) { stopScan(); goto('#/asset/' + id); } else toast('ไม่พบรายการที่ตรงกับรหัสนี้', true); return !!id; });
}
function viewScan() {
  setView('<div class="ph"><div><h1>สแกน QR</h1><p>สแกนป้ายบนเครื่องเพื่อเปิดรายการ แล้วกดให้ยืม / รับคืน / ตรวจสภาพ</p></div></div>' +
    '<div class="scanbox" id="sbox" hidden><video id="sv" playsinline muted></video><div class="frame"></div></div>' +
    '<div class="acts" style="margin:12px 0"><button class="btn pri" data-do="scanStart">' + icon('cam') + 'เปิดกล้องสแกน</button><button class="btn" data-do="scanStop" id="sstop" hidden>ปิดกล้อง</button></div>' +
    '<p class="hint" id="shint">ถ้าเบราว์เซอร์ไม่รองรับการสแกนในหน้านี้ ให้ใช้แอปกล้องของมือถือสแกนป้าย แล้วกด “เจ้าหน้าที่: เข้าสู่ระบบ” หรือพิมพ์รหัสด้านล่าง</p>' +
    '<form id="manual" style="max-width:520px;margin-top:20px"><label for="mc">พิมพ์เลขครุภัณฑ์ หรือวางลิงก์จากป้าย</label><div style="display:flex;gap:8px"><input id="mc" type="text" autocomplete="off" placeholder="เช่น WK-001"><button class="btn" type="submit">เปิด</button></div></form>', 'สแกน QR');
  $('#manual').addEventListener('submit', function (e) { e.preventDefault(); openCode($('#mc').value); });
  getAssets().catch(function () {});
}
function scanStart() {
  if (!navigator.mediaDevices || !window.BarcodeDetector) { toast('เบราว์เซอร์นี้ไม่รองรับการสแกนในหน้านี้ — ใช้แอปกล้องของมือถือแทนได้', true); return; }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(function (st) {
    scanStream = st; var v = $('#sv'); v.srcObject = st; $('#sbox').hidden = false; $('#sstop').hidden = false; v.play();
    var det = new window.BarcodeDetector({ formats: ['qr_code'] }), busy = false;
    scanTimer = setInterval(function () {
      if (busy || v.readyState < 2) return; busy = true;
      det.detect(v).then(function (r) { if (r && r.length) return openCode(r[0].rawValue); }).catch(function () {}).then(function () { busy = false; });
    }, 350);
  }).catch(function () { toast('เปิดกล้องไม่ได้ — ตรวจสอบการอนุญาตใช้กล้องของเบราว์เซอร์', true); });
}

// ---------- ยืม - คืน ----------
var LV = { tab: 'open', q: '', data: [] };
function paintLoans() {
  var el = $('#lList'); if (!el) return;
  var q = LV.q.trim().toLowerCase();
  var rows = LV.data.filter(function (l) { return !q || [l.assetNo, l.assetName, l.borrowerName, l.phone, l.borrowerHN].join(' ').toLowerCase().indexOf(q) >= 0; });
  el.innerHTML = listOrEmpty(rows.map(function (l) {
    if (LV.tab === 'open') return loanRow(l);
    var st = l.status === 'ยืมอยู่' ? '<span class="badge acc">ยืมอยู่</span>' : '<span class="badge ok">คืนแล้ว</span>';
    return '<a class="li noth" href="#/asset/' + esc(l.assetId) + '"><div class="mn"><div class="t">' + esc((l.assetNo ? l.assetNo + ' · ' : '') + l.assetName) + '</div><div class="s">' + esc(l.borrowerName) + ' · ยืม ' + esc(fmtDate(l.loanDate)) + (l.returnDate ? ' → คืน ' + esc(fmtDate(l.returnDate)) : ' · กำหนดคืน ' + esc(fmtDate(l.dueDate))) + (l.conditionIn ? ' · ' + esc(l.conditionIn) : '') + '</div></div><div class="end">' + st + '</div></a>';
  }), LV.tab === 'open' ? 'ตอนนี้ไม่มีอุปกรณ์ที่ถูกยืมอยู่' : 'ยังไม่มีประวัติการยืม');
}
function viewLoans(nid) {
  API.call('loanList', { scope: LV.tab, limit: 300 }).then(function (list) {
    if (nid !== navId) return;
    LV.data = list;
    setView('<div class="ph"><div><h1>ยืม-คืน</h1><p>' + (LV.tab === 'open' ? list.length + ' รายการที่ยังไม่คืน' : 'ประวัติล่าสุด ' + list.length + ' รายการ') + '</p></div><div class="acts"><a class="btn" href="#/scan">' + icon('scan') + 'สแกน QR เพื่อยืม-คืน</a></div></div>' +
      '<div class="tools"><div class="chips" role="group" aria-label="มุมมอง"><button class="chip" data-tab="open" aria-pressed="' + (LV.tab === 'open') + '">กำลังยืม</button><button class="chip" data-tab="all" aria-pressed="' + (LV.tab === 'all') + '">ประวัติทั้งหมด</button></div>' +
      '<div class="q">' + icon('search') + '<label class="sr" for="lq">ค้นหา</label><input id="lq" type="search" placeholder="ค้นหาผู้ยืม / อุปกรณ์" value="' + esc(LV.q) + '" autocomplete="off"></div></div><div id="lList"></div>', 'ยืม-คืน');
    paintLoans();
  }).catch(function (e) { fail(e, nid); });
}

// ---------- ประวัติ ----------
function viewLog(nid) {
  API.call('assetLogList', { limit: 150 }).then(function (rows) {
    if (nid !== navId) return;
    setView('<div class="ph"><div><h1>ประวัติการทำรายการ</h1><p>150 รายการล่าสุด</p></div></div>' + (rows.length ? '<div class="list" style="padding:4px 16px"><ul class="tl">' + rows.map(function (x) {
      return '<li><time>' + esc(fmtDT(x.ts)) + '</time><span><a href="#/asset/' + esc(x.assetId) + '"><b>' + esc(x.assetNo || x.assetId) + '</b></a> ' + esc(logText(x)) + ' <small>โดย ' + esc(x.by) + '</small></span></li>';
    }).join('') + '</ul></div>' : '<div class="list"><div class="empty">ยังไม่มีประวัติ</div></div>'), 'ประวัติ');
  }).catch(function (e) { fail(e, nid); });
}

// ---------- เหตุการณ์ ----------
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-do],[data-filter],[data-psel],[data-tab]'); if (!el) return;
  var id = el.dataset.id;
  if (el.dataset.filter) { F.f = el.dataset.filter; paintAssets(); return; }
  if (el.dataset.tab) { LV.tab = el.dataset.tab; route(); return; }
  if (el.dataset.psel) {
    var m = el.dataset.psel;
    selBoxes().forEach(function (c) { if (c.closest('label').hidden) return; var a = findAsset(c.value); c.checked = m === 'all' ? true : (m === 'none' ? false : !(a && a.qrText)); });
    countSel(); return;
  }
  switch (el.dataset.do) {
    case 'logout': API.logout().then(function () { S.sess = null; S.cfg = null; invalidate(); $('#root').innerHTML = ''; renderLogin(); }); break;
    case 'reload': route(); break;
    case 'photo': pickPhoto(id); break;
    case 'printOne': S.preselect = [id]; goto('#/print'); break;
    case 'qrmake': el.disabled = true; el.classList.add('busy'); genQr([id], false).then(function (r) { toast(r.fail ? 'สร้าง QR ไม่สำเร็จ' + (r.err ? ' — ' + r.err : '') : 'สร้าง QR แล้ว และบันทึกลงชีตแล้ว', !!r.fail); invalidate(); route(); }); break;
    case 'viewPhoto': el.disabled = true; API.call('assetGetPhoto', { fileId: el.dataset.fid }, { timeout: 90000 }).then(function (r) { dlg('<img src="' + esc(r.dataUri) + '" alt="รูปครุภัณฑ์">'); }).catch(function (x) { toast(x.message, true); }).then(function () { el.disabled = false; }); break;
    case 'rmPhoto': if (window.confirm('ถอดรูปนี้ออกจากรายการ? (ไฟล์ยังเก็บไว้ใน Drive เป็นหลักฐาน)')) API.call('assetRemovePhoto', { id: id, fileId: el.dataset.fid }).then(function () { toast('ถอดรูปแล้ว'); invalidate(); route(); }).catch(function (x) { toast(x.message, true); }); break;
    case 'doPrint': doPrint(el); break;
    case 'regenAll':
      if (window.confirm('สร้างรูป QR ใหม่ทั้งหมดด้วยที่อยู่เว็บปัจจุบัน? ป้ายที่ติดไปแล้วอาจสแกนไม่ได้ ต้องพิมพ์ใหม่')) {
        el.disabled = true; var ids = (S.assets || []).filter(function (a) { return a.qrText; }).map(function (a) { return a.assetId; });
        toast('กำลังสร้าง QR ' + ids.length + ' รายการ ใช้เวลาสักครู่…'); genQr(ids, true).then(function (r) { toast('เสร็จแล้ว สำเร็จ ' + r.ok + ' · ไม่สำเร็จ ' + r.fail, !!r.fail); invalidate(); route(); });
      } break;
    case 'scanStart': scanStart(); break;
    case 'scanStop': stopScan(); $('#sbox').hidden = true; $('#sstop').hidden = true; break;
  }
});
document.addEventListener('input', function (e) {
  var t = e.target;
  if (t.id === 'aq') { F.q = t.value; paintAssets(); }
  else if (t.id === 'lq') { LV.q = t.value; paintLoans(); }
  else if (t.id === 'pq') { var q = t.value.trim().toLowerCase(); Array.prototype.forEach.call(document.querySelectorAll('#psel label'), function (l) { l.hidden = !!q && (l.dataset.q || '').indexOf(q) < 0; }); }
});
document.addEventListener('change', function (e) { if (e.target.closest && e.target.closest('#psel')) countSel(); });
window.addEventListener('elc:auth', function () { S.sess = null; S.cfg = null; invalidate(); $('#root').innerHTML = ''; renderLogin('หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่'); });

// ---------- เราท์เตอร์ ----------
function route() {
  navId++; var nid = navId; stopScan(); document.body.classList.remove('is-printing'); var d = $('#dlg'); if (d && d.open) d.close();
  var sess = API.session();
  if (!sess) { S.sess = null; if (!$('#loginForm')) { $('#root').innerHTML = ''; renderLogin(); } return; }
  S.sess = sess; shell();
  var parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/'), k = parts[0] || '';
  markNav(k === 'asset' ? 'assets' : k); loading();
  (S.cfg ? Promise.resolve() : API.call('config').then(function (c) { S.cfg = c; })).then(function () {
    if (nid !== navId) return;
    if (k === 'asset') {
      var id = parts[1] || '';
      if (id === 'new') return viewAssetForm(null, nid);
      if (!/^A\d{3,}$/.test(id)) return goto('#/assets');
      if (parts[2] === 'edit') return viewAssetForm(id, nid);
      return viewAsset(id, ['loan', 'return', 'extend', 'check', 'void'].indexOf(parts[2]) >= 0 ? parts[2] : '', nid);
    }
    if (k === 'assets') return viewAssets(nid);
    if (k === 'loans') return viewLoans(nid);
    if (k === 'print') return viewPrint(nid);
    if (k === 'scan') return viewScan(nid);
    if (k === 'log') return viewLog(nid);
    return viewDash(nid);
  }).catch(function (e) { fail(e, nid); });
}
window.addEventListener('hashchange', route);
route();
})();
