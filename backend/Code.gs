/**
 * ศูนย์ยืม-คืนอุปกรณ์ / ทะเบียนครุภัณฑ์ — Backend API (Google Apps Script)
 * v1.0.0
 *
 * ทำหน้าที่เป็น JSON API ให้ frontend (GitHub Pages / ระบบอื่น) เรียกใช้ — ไม่ได้เสิร์ฟหน้าเว็บเอง
 *   POST  <WebApp>/exec   body = JSON ส่งเป็น text/plain   {"action":"...","token":"...","args":{...}}
 *   GET   <WebApp>/exec?action=ping
 *
 * ความปลอดภัย: ตรวจสิทธิ์ที่เซิร์ฟเวอร์ทุกครั้ง (PIN → token อายุ 6 ชม. เก็บใน CacheService)
 *   · ชื่อผู้ทำรายการในประวัติมาจาก session ไม่เชื่อค่าที่ client ส่งมา
 *   · action สาธารณะมีแค่ ping / login / scan (scan ต้องมีคีย์สุ่มของป้าย QR และไม่เปิดเผยราคา/Serial/ชื่อผู้ยืม)
 *
 * ตั้งค่าครั้งแรก: แก้ค่าใน setConfig() แล้วกด Run ครั้งเดียว → จากนั้นรัน setupLoanCenter()
 * รายละเอียดดู README.md
 */

const APP_VERSION = '1.0.0';
const TIMEZONE = 'Asia/Bangkok';
const SCHEMA_VER = '1';
const SESSION_TTL = 21600;          // วินาที (สูงสุดของ CacheService = 6 ชม.)
const LOGIN_MAX_FAIL = 5;           // ใส่ PIN ผิดครบนี้ → ล็อกการเข้าสู่ระบบชั่วคราว
const LOGIN_LOCK_SEC = 600;
const MAX_BODY = 6000000;           // ตัวอักษร (รูปแนบ ≤ 3 MB เป็น base64)
const DEFAULT_LOAN_DAYS = 7;
const MAX_LOAN_DAYS = 90;
const THUMB_MAX = 20000;            // ตัวอักษรของรูปย่อ (data URI) ที่เก็บในชีต

const ASSET_FOLDER_NAME = 'Equipment Loan Center - Photos';
const ASSET_QR_FOLDER_NAME = 'Equipment Loan Center - QR';

const ASSET_HEADERS = ['assetId','assetNo','name','category','brand','model','serialNo','spec','acquireMethod','fundSource','unitPrice','acquireDate','docRef','vendor','warrantyEnd','lifeYears','location','custodian','status','loanable','calibDue','remark','photoIds','thumb','voided','createdAt','createdBy','updatedAt','updatedBy','checkIntervalDays','qrKey','qrText','qrFileId','qrImg','qrAt','lastCheckAt','lastCheckBy','lastCheckResult','nextCheckDue'];
const ASSET_FIELDS = ['assetNo','name','category','brand','model','serialNo','spec','acquireMethod','fundSource','unitPrice','acquireDate','docRef','vendor','warrantyEnd','lifeYears','location','custodian','status','loanable','calibDue','remark','checkIntervalDays'];
const DATE_KEYS = ['acquireDate','warrantyEnd','calibDue','nextCheckDue','loanDate','dueDate','returnDate'];
const LOG_HEADERS = ['ts','assetId','assetNo','action','by','detail'];
const LOAN_HEADERS = ['loanId','assetId','assetNo','assetName','borrowerName','borrowerHN','phone','loanDate','dueDate','returnDate','status','conditionOut','conditionIn','note','createdAt','createdBy','updatedAt','borrowerType','returnedBy'];
const CHECK_HEADERS = ['checkId','ts','assetId','assetNo','assetName','result','note','by','nextDue'];

const STATUSES = ['ใช้งานได้','ชำรุด / รอซ่อม','ส่งซ่อม','รอจำหน่าย','จำหน่ายแล้ว'];
const CHECK_RESULTS = ['ปกติ','ต้องปรับปรุง / ซ่อมเล็กน้อย','ชำรุด ใช้งานไม่ได้'];
const BORROWER_TYPES = ['บุคลากร','ผู้ป่วย / ญาติ','อสม. / ชุมชน','หน่วยงานอื่น'];
const ACQUIRE_METHODS = ['ซื้อ','บริจาค','โอน / รับโอน','ยืมใช้','อื่นๆ'];
const LOAN_OPEN = 'ยืมอยู่';
const LOAN_DONE = 'คืนแล้ว';

// ================================================================
//  ข้อผิดพลาด / ยูทิลิตี
// ================================================================
class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function bad_(msg) { return new ApiError('BAD_REQUEST', msg); }

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function txt_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().substring(0, max || 200); }
function nowStr_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd'); }
function isoOk_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
function date_(v) { v = String(v || '').trim(); return isoOk_(v) ? v : ''; }
function addDays_(iso, n) { const m = iso.split('-'); return new Date(Date.UTC(+m[0], +m[1] - 1, +m[2] + n)).toISOString().slice(0, 10); }
function daysBetween_(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function val_(v, key) {
  if (v instanceof Date) return Utilities.formatDate(v, TIMEZONE, DATE_KEYS.indexOf(key) >= 0 ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
  return v == null ? '' : v;
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw new ApiError('BUSY', 'ระบบกำลังบันทึกข้อมูลของผู้ใช้อื่นอยู่ กรุณาลองใหม่อีกครั้ง'); }
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ================================================================
//  ชีต
// ================================================================
let _ss = null;
function ss_() {
  if (!_ss) {
    const id = prop_('SPREADSHEET_ID');
    _ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    if (!_ss) throw new ApiError('CONFIG', 'ยังไม่ได้ตั้งค่า SPREADSHEET_ID — ผู้ดูแลต้องรัน setConfig()');
  }
  return _ss;
}
function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  const cur = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  const out = headers.map(function (h, i) { return cur[i] || h; });
  if (out.some(function (v, i) { return v !== cur[i]; })) sh.getRange(1, 1, 1, headers.length).setValues([out]).setFontWeight('bold');
  try { sh.setFrozenRows(1); } catch (e) {}
  return sh;
}
function sheets_() {
  const ss = ss_(), p = PropertiesService.getScriptProperties();
  const names = ['AssetRegister', 'AssetLog', 'AssetLoans', 'AssetChecks'];
  let ok = p.getProperty('SCHEMA_VER') === SCHEMA_VER;
  names.forEach(function (n) { if (!ss.getSheetByName(n)) ok = false; });
  if (!ok) {
    ensureSheet_(ss, 'AssetRegister', ASSET_HEADERS); ensureSheet_(ss, 'AssetLog', LOG_HEADERS);
    ensureSheet_(ss, 'AssetLoans', LOAN_HEADERS); ensureSheet_(ss, 'AssetChecks', CHECK_HEADERS);
    p.setProperty('SCHEMA_VER', SCHEMA_VER);
  }
  return { reg: ss.getSheetByName('AssetRegister'), log: ss.getSheetByName('AssetLog'), loan: ss.getSheetByName('AssetLoans'), chk: ss.getSheetByName('AssetChecks') };
}
function ix_() { const o = {}; ASSET_HEADERS.forEach(function (h, i) { o[h] = i; }); return o; }

function readAssets_(sh) { const last = sh.getLastRow(); return last >= 2 ? sh.getRange(2, 1, last - 1, ASSET_HEADERS.length).getValues() : []; }
function rowToAsset_(row) {
  const o = {};
  ASSET_HEADERS.forEach(function (h, i) { o[h] = val_(row[i], h); });
  o.unitPrice = o.unitPrice === '' ? '' : Number(o.unitPrice) || 0;
  o.lifeYears = o.lifeYears === '' ? '' : Number(o.lifeYears) || 0;
  o.checkIntervalDays = o.checkIntervalDays === '' ? '' : Number(o.checkIntervalDays) || 0;
  o.voided = String(o.voided) === 'Y';
  let ids = []; try { ids = JSON.parse(o.photoIds || '[]'); } catch (e) {}
  o.photoIds = Array.isArray(ids) ? ids : [];
  delete o.qrImg; delete o.qrFileId;
  return o;
}
function writeAssetRow_(sh, rowNo, arr) {
  const fm = ASSET_HEADERS.map(function (h) { return h === 'unitPrice' ? '#,##0.00' : ((h === 'lifeYears' || h === 'checkIntervalDays') ? '0' : '@'); });
  const qi = ASSET_HEADERS.indexOf('qrImg');   // เซลล์รูป QR — ห้ามเขียนทับ
  [[0, qi], [qi + 1, ASSET_HEADERS.length]].forEach(function (s) {
    if (s[1] <= s[0]) return;
    const rg = sh.getRange(rowNo, s[0] + 1, 1, s[1] - s[0]);
    rg.setNumberFormats([fm.slice(s[0], s[1])]); rg.setValues([arr.slice(s[0], s[1])]);
  });
}
function findRow_(rows, id) {
  const k = ix_().assetId;
  for (let i = 0; i < rows.length; i++) if (String(rows[i][k]) === String(id)) return i;
  return -1;
}
function log_(sh, assetId, assetNo, action, by, detail) {
  const t = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, LOG_HEADERS.length).setNumberFormats([['@','@','@','@','@','@']]).setValues([[nowStr_(), assetId, assetNo, action, by, t.substring(0, 1500)]]);
}
function driveFolder_(propKey, name) {
  const p = PropertiesService.getScriptProperties(), id = p.getProperty(propKey);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* สร้างใหม่ */ } }
  const it = DriveApp.getFoldersByName(name);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  p.setProperty(propKey, f.getId());
  return f;
}

// ================================================================
//  ตั้งค่า (รันจากตัวแก้ไข Apps Script)
// ================================================================
function hashPin_(pin, salt) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return d.map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
}
function safeEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * ✏️ แก้ค่าด้านล่าง แล้วกด Run ครั้งเดียว — เสร็จแล้วให้ลบ PIN ออกจากโค้ดทันที
 *   SPREADSHEET_ID : ID ของ Google Sheet ที่เก็บข้อมูล (เว้นว่างได้ถ้าสคริปต์ผูกกับชีตนั้น)
 *   FRONTEND_URL   : ลิงก์หน้าเว็บ frontend ที่เผยแพร่แล้ว (ลงท้ายด้วย / ) — ใช้เป็นปลายทางของ QR
 *   STAFF_PIN      : รหัสเจ้าหน้าที่ (อย่างน้อย 6 ตัว) — ยืม/คืน ตรวจสภาพ เพิ่ม/แก้ครุภัณฑ์ พิมพ์ QR
 *   ADMIN_PIN      : รหัสผู้ดูแล (อย่างน้อย 6 ตัว ต้องต่างจากของเจ้าหน้าที่) — ยกเลิกรายการ สร้าง QR ซ้ำทั้งหมด
 */
function setConfig() {
  const CFG = {
    SPREADSHEET_ID: '',
    FRONTEND_URL: 'https://YOUR-NAME.github.io/equipment-loan-center/',
    STAFF_PIN: '',
    ADMIN_PIN: ''
  };
  const p = PropertiesService.getScriptProperties();
  if (CFG.SPREADSHEET_ID) p.setProperty('SPREADSHEET_ID', CFG.SPREADSHEET_ID.trim());
  if (CFG.FRONTEND_URL) {
    let u = CFG.FRONTEND_URL.trim();
    if (!/^https:\/\//.test(u)) throw new Error('FRONTEND_URL ต้องขึ้นต้นด้วย https://');
    if (u.slice(-1) !== '/') u += '/';
    p.setProperty('FRONTEND_URL', u);
  }
  if (CFG.STAFF_PIN || CFG.ADMIN_PIN) {
    if (String(CFG.STAFF_PIN).length < 6 || String(CFG.ADMIN_PIN).length < 6) throw new Error('PIN ต้องมีอย่างน้อย 6 ตัวอักษร (ทั้งของเจ้าหน้าที่และผู้ดูแล)');
    if (CFG.STAFF_PIN === CFG.ADMIN_PIN) throw new Error('PIN ของเจ้าหน้าที่และผู้ดูแลต้องไม่ซ้ำกัน');
    const salt = Utilities.getUuid();
    p.setProperty('PIN_SALT', salt);
    p.setProperty('STAFF_PIN_HASH', hashPin_(String(CFG.STAFF_PIN), salt));
    p.setProperty('ADMIN_PIN_HASH', hashPin_(String(CFG.ADMIN_PIN), salt));
  }
  Logger.log('บันทึกการตั้งค่าแล้ว — ลบ STAFF_PIN / ADMIN_PIN ออกจากโค้ดได้เลย แล้วรัน setupLoanCenter()');
}

function setupLoanCenter() {
  const S = sheets_();
  const rep = {
    spreadsheet: ss_().getName(),
    sheets: ['AssetRegister', 'AssetLog', 'AssetLoans', 'AssetChecks'],
    frontendUrl: prop_('FRONTEND_URL') || '(ยังไม่ตั้ง — รัน setConfig)',
    pinsSet: !!(prop_('STAFF_PIN_HASH') && prop_('ADMIN_PIN_HASH')),
    assets: Math.max(0, S.reg.getLastRow() - 1)
  };
  if (rep.frontendUrl.charAt(0) === '(') Logger.log('⚠ ยังไม่ได้ตั้ง FRONTEND_URL');
  if (!rep.pinsSet) Logger.log('⚠ ยังไม่ได้ตั้ง PIN');
  Logger.log(JSON.stringify(rep));
  return rep;
}
/** สร้าง QR ให้ครุภัณฑ์ทุกรายการที่ยังไม่มี (รันจากตัวแก้ไข ใช้ตอนนำเข้าข้อมูลเก่า) */
function backfillQr() { return qrRun_(false, 'backfillQr'); }
/** ใช้เมื่อ FRONTEND_URL เปลี่ยน: สร้างรูป QR ของทุกรายการใหม่ แล้วต้องพิมพ์ป้ายใหม่ไปติด */
function regenerateAllQr() { return qrRun_(true, 'regenerateAllQr'); }

// ================================================================
//  ระบบสิทธิ์ (PIN → token)
// ================================================================
function apiLogin_(a) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('LOGIN_FAILS') || 0);
  if (fails >= LOGIN_MAX_FAIL) throw new ApiError('LOCKED', 'ใส่รหัสผิดหลายครั้ง ระบบล็อกการเข้าสู่ระบบชั่วคราว 10 นาที');
  const name = txt_(a.name, 60), pin = String(a.pin == null ? '' : a.pin);
  if (name.length < 2) throw bad_('กรุณากรอกชื่อผู้ใช้งาน (อย่างน้อย 2 ตัวอักษร)');
  const salt = prop_('PIN_SALT'), sh = prop_('STAFF_PIN_HASH'), ah = prop_('ADMIN_PIN_HASH');
  if (!salt || !sh) throw new ApiError('CONFIG', 'ระบบยังไม่ได้ตั้งรหัสผ่าน — ผู้ดูแลต้องรัน setConfig() ใน Apps Script');
  const h = hashPin_(pin, salt);
  let role = '';
  if (ah && safeEq_(h, ah)) role = 'admin'; else if (safeEq_(h, sh)) role = 'staff';
  if (!role) { cache.put('LOGIN_FAILS', String(fails + 1), LOGIN_LOCK_SEC); throw new ApiError('AUTH', 'รหัสผ่านไม่ถูกต้อง'); }
  cache.remove('LOGIN_FAILS');
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('S_' + token, JSON.stringify({ name: name, role: role, at: Date.now() }), SESSION_TTL);
  return { token: token, name: name, role: role, expiresIn: SESSION_TTL };
}
function session_(token, need) {
  token = String(token || '');
  if (!/^[0-9a-f]{64}$/.test(token)) throw new ApiError('AUTH_REQUIRED', 'กรุณาเข้าสู่ระบบ');
  const raw = CacheService.getScriptCache().get('S_' + token);
  if (!raw) throw new ApiError('AUTH_REQUIRED', 'หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่');
  const s = JSON.parse(raw);
  if (need === 'admin' && s.role !== 'admin') throw new ApiError('FORBIDDEN', 'ต้องใช้สิทธิ์ผู้ดูแลระบบ');
  s.token = token;
  return s;
}
function apiLogout_(a, s) { CacheService.getScriptCache().remove('S_' + s.token); return { ok: true }; }

// ================================================================
//  ตัวรับคำขอ
// ================================================================
const ROUTES = {
  ping:        { role: '',      fn: function () { return { name: 'Equipment Loan Center', version: APP_VERSION, time: nowStr_(), configured: { frontend: !!prop_('FRONTEND_URL'), pins: !!prop_('STAFF_PIN_HASH') } }; } },
  login:       { role: '',      fn: apiLogin_ },
  scan:        { role: '',      fn: apiScan_ },
  logout:      { role: 'staff', fn: apiLogout_ },
  me:          { role: 'staff', fn: function (a, s) { return { name: s.name, role: s.role }; } },
  config:      { role: 'staff', fn: apiConfig_ },
  dashboard:   { role: 'staff', fn: apiDashboard_ },
  assetList:   { role: 'staff', fn: apiAssetList_ },
  assetGet:    { role: 'staff', fn: apiAssetGet_ },
  assetSave:   { role: 'staff', fn: apiAssetSave_ },
  assetAddPhoto:    { role: 'staff', fn: apiAddPhoto_ },
  assetGetPhoto:    { role: 'staff', fn: apiGetPhoto_ },
  assetRemovePhoto: { role: 'staff', fn: apiRemovePhoto_ },
  assetQrBatch:     { role: 'staff', fn: apiQrBatch_ },
  assetQrPrintLog:  { role: 'staff', fn: apiQrPrintLog_ },
  assetCheckSave:   { role: 'staff', fn: apiCheckSave_ },
  assetCheckList:   { role: 'staff', fn: apiCheckList_ },
  assetLogList:     { role: 'staff', fn: apiLogList_ },
  loanList:      { role: 'staff', fn: apiLoanList_ },
  loanCheckout:  { role: 'staff', fn: apiLoanCheckout_ },
  loanReturn:    { role: 'staff', fn: apiLoanReturn_ },
  loanExtend:    { role: 'staff', fn: apiLoanExtend_ },
  assetVoid:     { role: 'admin', fn: apiAssetVoid_ }
};
function handle_(req) {
  if (!req || typeof req !== 'object') throw bad_('คำขอไม่ถูกต้อง');
  const def = Object.prototype.hasOwnProperty.call(ROUTES, req.action) ? ROUTES[req.action] : null;
  if (!def) throw bad_('ไม่รู้จักคำสั่งนี้');
  const s = def.role ? session_(req.token, def.role) : null;
  const args = (req.args && typeof req.args === 'object') ? req.args : {};
  return def.fn(args, s);
}
function out_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function errOut_(err) {
  if (err instanceof ApiError) return { ok: false, code: err.code, error: err.message };
  Logger.log('INTERNAL: ' + (err && err.stack || err));
  return { ok: false, code: 'INTERNAL', error: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่ หากยังเป็นอีกให้แจ้งผู้ดูแล' };
}
function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents || '';
    if (!raw || raw.length > MAX_BODY) throw bad_('ข้อมูลที่ส่งมาไม่ถูกต้องหรือมีขนาดใหญ่เกินไป');
    let req; try { req = JSON.parse(raw); } catch (pe) { throw bad_('รูปแบบข้อมูลไม่ถูกต้อง'); }
    return out_({ ok: true, data: handle_(req) });
  } catch (err) { return out_(errOut_(err)); }
}
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    return out_({ ok: true, data: handle_({ action: p.action || 'ping', args: p.action === 'scan' ? { id: p.id, k: p.k } : {} }) });
  } catch (err) { return out_(errOut_(err)); }
}

// ================================================================
//  Config / Dashboard / รายการ
// ================================================================
function apiConfig_() {
  return {
    statuses: STATUSES, checkResults: CHECK_RESULTS, borrowerTypes: BORROWER_TYPES, acquireMethods: ACQUIRE_METHODS,
    defaultLoanDays: DEFAULT_LOAN_DAYS, maxLoanDays: MAX_LOAN_DAYS, frontendUrl: prop_('FRONTEND_URL'), today: today_()
  };
}
function loanRowToObj_(r) {
  const o = {}; LOAN_HEADERS.forEach(function (h, i) { o[h] = val_(r[i], h); });
  return o;
}
function readLoans_(sh) {
  const last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, LOAN_HEADERS.length).getValues().map(loanRowToObj_);
}
function decorateLoan_(l, today) {
  const open = l.status === LOAN_OPEN;
  l.overdue = open && !!l.dueDate && l.dueDate < today;
  l.daysLate = l.overdue ? daysBetween_(l.dueDate, today) : 0;
  l.daysLeft = open && l.dueDate ? daysBetween_(today, l.dueDate) : null;
  return l;
}
function openLoanMap_(loans, today) {
  const m = {};
  loans.forEach(function (l) { if (l.status === LOAN_OPEN) m[l.assetId] = decorateLoan_(l, today); });
  return m;
}
function checkInfo_(o, today) {
  if (o.status === STATUSES[4]) return false;
  if (!o.checkIntervalDays && !o.nextCheckDue) return false;
  if (!o.lastCheckAt) return !!o.checkIntervalDays;
  return !!o.nextCheckDue && o.nextCheckDue <= today;
}
function liveAssets_(S) { return readAssets_(S.reg).map(rowToAsset_).filter(function (o) { return !o.voided; }); }

function apiAssetList_() {
  const S = sheets_(), today = today_(), open = openLoanMap_(readLoans_(S.loan), today);
  return liveAssets_(S).map(function (o) {
    o.loan = open[o.assetId] ? publicLoan_(open[o.assetId]) : null;
    o.checkDue = checkInfo_(o, today);
    return o;
  });
}
function publicLoan_(l) {
  return { loanId: l.loanId, borrowerName: l.borrowerName, borrowerType: l.borrowerType, phone: l.phone, loanDate: l.loanDate, dueDate: l.dueDate, overdue: l.overdue, daysLate: l.daysLate, daysLeft: l.daysLeft };
}
function apiAssetGet_(a) {
  const S = sheets_(), today = today_();
  const rows = readAssets_(S.reg), i = findRow_(rows, a.id);
  if (i < 0) throw bad_('ไม่พบรายการ');
  const o = rowToAsset_(rows[i]);
  const loans = readLoans_(S.loan).filter(function (l) { return l.assetId === o.assetId; }).map(function (l) { return decorateLoan_(l, today); }).reverse();
  const cur = loans.filter(function (l) { return l.status === LOAN_OPEN; })[0] || null;
  o.loan = cur ? publicLoan_(cur) : null;
  o.checkDue = checkInfo_(o, today);
  o.loans = loans.slice(0, 15);
  const lg = [], last = S.log.getLastRow();
  if (last >= 2) {
    const lr = S.log.getRange(2, 1, last - 1, LOG_HEADERS.length).getValues();
    for (let k = lr.length - 1; k >= 0 && lg.length < 40; k--) {
      if (String(lr[k][1]) === o.assetId) lg.push({ ts: val_(lr[k][0], 'ts'), action: lr[k][3], by: lr[k][4], detail: lr[k][5] });
    }
  }
  o.log = lg;
  return o;
}
function apiDashboard_() {
  const S = sheets_(), today = today_();
  const loans = readLoans_(S.loan), open = openLoanMap_(loans, today), assets = liveAssets_(S);
  const d = { today: today, total: 0, available: 0, onLoan: 0, overdue: 0, broken: 0, checkDue: 0, noQr: 0, overdueLoans: [], dueSoon: [], checkList: [], noQrList: [] };
  assets.forEach(function (o) {
    if (o.status === STATUSES[4]) return;
    d.total++;
    const l = open[o.assetId];
    if (l) { d.onLoan++; } else if (o.status === STATUSES[0] && o.loanable === 'Y') d.available++;
    if (o.status !== STATUSES[0]) d.broken++;
    if (!o.qrText) { d.noQr++; if (d.noQrList.length < 12) d.noQrList.push({ assetId: o.assetId, assetNo: o.assetNo, name: o.name }); }
    if (checkInfo_(o, today)) { d.checkDue++; if (d.checkList.length < 12) d.checkList.push({ assetId: o.assetId, assetNo: o.assetNo, name: o.name, nextCheckDue: o.nextCheckDue, never: !o.lastCheckAt }); }
  });
  Object.keys(open).forEach(function (id) {
    const l = open[id], row = { loanId: l.loanId, assetId: l.assetId, assetNo: l.assetNo, assetName: l.assetName, borrowerName: l.borrowerName, phone: l.phone, dueDate: l.dueDate, daysLate: l.daysLate, daysLeft: l.daysLeft };
    if (l.overdue) { d.overdue++; d.overdueLoans.push(row); } else if (l.daysLeft !== null && l.daysLeft <= 2) d.dueSoon.push(row);
  });
  d.overdueLoans.sort(function (x, y) { return y.daysLate - x.daysLate; });
  d.dueSoon.sort(function (x, y) { return x.daysLeft - y.daysLeft; });
  return d;
}

// ================================================================
//  เพิ่ม / แก้ครุภัณฑ์
// ================================================================
function cleanAsset_(d) {
  const price = Number(d.unitPrice), life = Number(d.lifeYears), iv = Number(d.checkIntervalDays);
  return {
    assetNo: txt_(d.assetNo, 60), name: txt_(d.name, 160), category: txt_(d.category, 60),
    brand: txt_(d.brand, 80), model: txt_(d.model, 80), serialNo: txt_(d.serialNo, 80), spec: txt_(d.spec, 500),
    acquireMethod: txt_(d.acquireMethod, 40), fundSource: txt_(d.fundSource, 60),
    unitPrice: (d.unitPrice === '' || d.unitPrice == null || !isFinite(price) || price < 0) ? '' : Math.round(price * 100) / 100,
    acquireDate: date_(d.acquireDate), docRef: txt_(d.docRef, 100), vendor: txt_(d.vendor, 120), warrantyEnd: date_(d.warrantyEnd),
    lifeYears: (d.lifeYears === '' || d.lifeYears == null || !isFinite(life) || life < 0) ? '' : Math.round(life),
    location: txt_(d.location, 100), custodian: txt_(d.custodian, 100),
    status: STATUSES.indexOf(d.status) >= 0 ? d.status : STATUSES[0],
    loanable: d.loanable === 'Y' ? 'Y' : 'N', calibDue: date_(d.calibDue), remark: txt_(d.remark, 500),
    checkIntervalDays: (d.checkIntervalDays === '' || d.checkIntervalDays == null || !isFinite(iv) || iv <= 0) ? '' : Math.min(3650, Math.round(iv))
  };
}
function apiAssetSave_(d, s) {
  const c = cleanAsset_(d), by = s.name;
  if (!c.name) throw bad_('กรุณากรอกชื่อรายการ');
  const S = sheets_(), sh = S.reg, ix = ix_();
  return withLock_(function () {
    const rows = readAssets_(sh), editId = txt_(d.assetId, 20);
    let rowIdx = -1, maxN = 0;
    rows.forEach(function (r, i) {
      const id = String(r[ix.assetId]), m = /^A(\d+)$/.exec(id);
      if (m) maxN = Math.max(maxN, Number(m[1]));
      if (editId && id === editId) rowIdx = i;
    });
    if (c.assetNo) {
      const key = c.assetNo.toLowerCase();
      rows.forEach(function (r) {
        if (String(r[ix.voided]) !== 'Y' && String(r[ix.assetNo]).trim().toLowerCase() === key && String(r[ix.assetId]) !== editId)
          throw bad_('เลขครุภัณฑ์ซ้ำกับรายการ: ' + r[ix.name]);
      });
    }
    const now = nowStr_();
    if (editId) {
      if (rowIdx < 0) throw bad_('ไม่พบรายการ');
      const old = rows[rowIdx];
      if (String(old[ix.voided]) === 'Y') throw bad_('รายการนี้ถูกยกเลิกแล้ว');
      const oldNo = String(old[ix.assetNo] || '').trim();
      if (oldNo && oldNo !== c.assetNo) throw bad_('เลขครุภัณฑ์แก้ไขไม่ได้ เพื่อให้ตรวจสอบย้อนหลังได้');
      const nu = old.slice(), diff = {};
      ASSET_FIELDS.forEach(function (k) {
        const ov = val_(old[ix[k]], k);
        if (String(ov) !== String(c[k])) diff[k] = [ov, c[k]];
        nu[ix[k]] = c[k];
      });
      if (!Object.keys(diff).length) return { assetId: editId, changed: false };
      nu[ix.updatedAt] = now; nu[ix.updatedBy] = by;
      writeAssetRow_(sh, rowIdx + 2, nu);
      log_(S.log, editId, c.assetNo || oldNo, 'update', by, diff);
      return { assetId: editId, changed: true };
    }
    const id = 'A' + ('00000' + (maxN + 1)).slice(-5);
    const row = ASSET_HEADERS.map(function () { return ''; });
    ASSET_FIELDS.forEach(function (k) { row[ix[k]] = c[k]; });
    row[ix.assetId] = id; row[ix.photoIds] = '[]';
    row[ix.createdAt] = now; row[ix.createdBy] = by; row[ix.updatedAt] = now; row[ix.updatedBy] = by;
    const newRowNo = sh.getLastRow() + 1;
    writeAssetRow_(sh, newRowNo, row);
    log_(S.log, id, c.assetNo, 'create', by, { name: c.name, status: c.status });
    let qrError = '';
    try { qrApply_(S, newRowNo, row, by, false); } catch (qe) { qrError = qe.message; Logger.log('auto QR ' + id + ': ' + qe.message); }
    return { assetId: id, created: true, qrError: qrError };
  });
}
function apiAssetVoid_(a, s) {
  const reason = txt_(a.reason, 300);
  if (!reason) throw bad_('กรุณาระบุเหตุผลที่ยกเลิก');
  const S = sheets_(), ix = ix_();
  return withLock_(function () {
    const rows = readAssets_(S.reg), i = findRow_(rows, a.id);
    if (i < 0) throw bad_('ไม่พบรายการ');
    if (readLoans_(S.loan).some(function (l) { return l.assetId === String(a.id) && l.status === LOAN_OPEN; })) throw bad_('รายการนี้ยังถูกยืมอยู่ ต้องรับคืนก่อนจึงจะยกเลิกได้');
    const r = i + 2;
    S.reg.getRange(r, ix.voided + 1).setNumberFormat('@').setValue('Y');
    S.reg.getRange(r, ix.updatedAt + 1, 1, 2).setNumberFormat('@').setValues([[nowStr_(), s.name]]);
    log_(S.log, String(a.id), String(rows[i][ix.assetNo] || ''), 'void', s.name, { reason: reason });
    return { ok: true };
  });
}

// ================================================================
//  รูปภาพ
// ================================================================
function apiAddPhoto_(a, s) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(a.full || ''));
  if (!m) throw bad_('ไฟล์รูปไม่ถูกต้อง');
  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 3000000) throw bad_('รูปใหญ่เกิน 3 MB');
  const S = sheets_(), ix = ix_();
  return withLock_(function () {
    const rows = readAssets_(S.reg), i = findRow_(rows, a.id);
    if (i < 0) throw bad_('ไม่พบรายการ');
    const o = rowToAsset_(rows[i]);
    if (o.voided) throw bad_('รายการนี้ถูกยกเลิกแล้ว');
    if (o.photoIds.length >= 12) throw bad_('แนบรูปได้สูงสุด 12 รูปต่อรายการ');
    const ext = m[1] === 'image/png' ? 'png' : (m[1] === 'image/webp' ? 'webp' : 'jpg');
    const name = String(o.assetNo || o.assetId).replace(/[^A-Za-z0-9ก-๙_.-]/g, '_') + '_' + Utilities.formatDate(new Date(), TIMEZONE, 'yyyyMMdd_HHmmss') + '_' + (o.photoIds.length + 1) + '.' + ext;
    const file = driveFolder_('PHOTO_FOLDER_ID', ASSET_FOLDER_NAME).createFile(Utilities.newBlob(bytes, m[1], name));
    o.photoIds.push(file.getId());
    const r = i + 2;
    S.reg.getRange(r, ix.photoIds + 1).setNumberFormat('@').setValue(JSON.stringify(o.photoIds));
    const th = String(a.thumb || '');
    if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(th) && th.length <= THUMB_MAX && !o.thumb) S.reg.getRange(r, ix.thumb + 1).setNumberFormat('@').setValue(th);
    S.reg.getRange(r, ix.updatedAt + 1, 1, 2).setNumberFormat('@').setValues([[nowStr_(), s.name]]);
    log_(S.log, o.assetId, o.assetNo, 'photo_add', s.name, { fileId: file.getId() });
    return { fileId: file.getId(), count: o.photoIds.length };
  });
}
function apiGetPhoto_(a) {
  const fileId = txt_(a.fileId, 80);
  if (!/^[\w-]{10,}$/.test(fileId)) throw bad_('รหัสรูปไม่ถูกต้อง');
  const folderId = driveFolder_('PHOTO_FOLDER_ID', ASSET_FOLDER_NAME).getId(), f = DriveApp.getFileById(fileId);
  let ok = false; const ps = f.getParents();
  while (ps.hasNext()) { if (ps.next().getId() === folderId) ok = true; }
  if (!ok) throw new ApiError('FORBIDDEN', 'ไม่อนุญาต');
  const b = f.getBlob();
  return { dataUri: 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()) };
}
function apiRemovePhoto_(a, s) {
  const S = sheets_(), ix = ix_();
  return withLock_(function () {
    const rows = readAssets_(S.reg), i = findRow_(rows, a.id);
    if (i < 0) throw bad_('ไม่พบรายการ');
    const o = rowToAsset_(rows[i]);
    const left = o.photoIds.filter(function (x) { return x !== a.fileId; });
    if (left.length === o.photoIds.length) throw bad_('ไม่พบรูปนี้ในรายการ');
    const r = i + 2;
    S.reg.getRange(r, ix.photoIds + 1).setNumberFormat('@').setValue(JSON.stringify(left));
    if (!left.length) S.reg.getRange(r, ix.thumb + 1).setNumberFormat('@').setValue('');
    S.reg.getRange(r, ix.updatedAt + 1, 1, 2).setNumberFormat('@').setValues([[nowStr_(), s.name]]);
    log_(S.log, o.assetId, o.assetNo, 'photo_del', s.name, { fileId: a.fileId });   // ไฟล์ยังอยู่ใน Drive เป็นหลักฐาน
    return { count: left.length };
  });
}
function apiLogList_(a) {
  const S = sheets_(), n = Math.max(1, Math.min(300, Number(a.limit) || 120)), last = S.log.getLastRow();
  if (last < 2) return [];
  const start = Math.max(2, last - n + 1);
  return S.log.getRange(start, 1, last - start + 1, LOG_HEADERS.length).getValues().reverse().map(function (r) {
    return { ts: val_(r[0], 'ts'), assetId: r[1], assetNo: r[2], action: r[3], by: r[4], detail: r[5] };
  });
}

// ================================================================
//  ยืม - คืน
// ================================================================
function lix_() { const o = {}; LOAN_HEADERS.forEach(function (h, i) { o[h] = i; }); return o; }
function apiLoanList_(a) {
  const S = sheets_(), today = today_(), scope = a.scope === 'all' ? 'all' : 'open';
  let list = readLoans_(S.loan).map(function (l) { return decorateLoan_(l, today); });
  if (scope === 'open') {
    list = list.filter(function (l) { return l.status === LOAN_OPEN; });
    list.sort(function (x, y) { return (y.daysLate - x.daysLate) || String(x.dueDate).localeCompare(String(y.dueDate)); });
    return list;
  }
  return list.reverse().slice(0, Math.max(1, Math.min(500, Number(a.limit) || 200)));
}
function apiLoanCheckout_(d, s) {
  const name = txt_(d.borrowerName, 100);
  if (name.length < 2) throw bad_('กรุณากรอกชื่อผู้ยืม');
  const type = BORROWER_TYPES.indexOf(d.borrowerType) >= 0 ? d.borrowerType : '';
  if (!type) throw bad_('กรุณาเลือกประเภทผู้ยืม');
  const phone = txt_(d.phone, 20);
  if (phone && !/^[0-9+\-\s()]+$/.test(phone)) throw bad_('เบอร์โทรไม่ถูกต้อง');
  const today = today_(), loanDate = date_(d.loanDate) || today, dueDate = date_(d.dueDate);
  if (loanDate > today) throw bad_('วันที่ยืมต้องไม่เกินวันนี้');
  if (!dueDate) throw bad_('กรุณาระบุวันกำหนดคืน');
  if (dueDate < loanDate) throw bad_('วันกำหนดคืนต้องไม่ก่อนวันที่ยืม');
  if (daysBetween_(loanDate, dueDate) > MAX_LOAN_DAYS) throw bad_('ยืมได้นานสุด ' + MAX_LOAN_DAYS + ' วัน หากต้องการนานกว่านี้ให้ต่อกำหนดคืนภายหลัง');
  const S = sheets_();
  return withLock_(function () {
    const rows = readAssets_(S.reg), i = findRow_(rows, d.assetId);
    if (i < 0) throw bad_('ไม่พบรายการ');
    const a = rowToAsset_(rows[i]);
    if (a.voided) throw bad_('รายการนี้ถูกยกเลิกแล้ว');
    if (a.loanable !== 'Y') throw bad_('รายการนี้ไม่ได้กำหนดให้ยืม (แก้ไขรายการแล้วเปิด "ให้ยืมได้" ก่อน)');
    if (a.status !== STATUSES[0]) throw bad_('รายการนี้ยังไม่พร้อมให้ยืม (สถานะ: ' + a.status + ')');
    const loans = readLoans_(S.loan);
    if (loans.some(function (l) { return l.assetId === a.assetId && l.status === LOAN_OPEN; })) throw bad_('รายการนี้ถูกยืมอยู่แล้ว');
    let maxN = 0; loans.forEach(function (l) { const m = /^L(\d+)$/.exec(String(l.loanId)); if (m) maxN = Math.max(maxN, Number(m[1])); });
    const id = 'L' + ('00000' + (maxN + 1)).slice(-5), now = nowStr_(), L = lix_();
    const row = LOAN_HEADERS.map(function () { return ''; });
    row[L.loanId] = id; row[L.assetId] = a.assetId; row[L.assetNo] = a.assetNo; row[L.assetName] = a.name;
    row[L.borrowerName] = name; row[L.borrowerType] = type; row[L.borrowerHN] = txt_(d.borrowerHN, 30); row[L.phone] = phone;
    row[L.loanDate] = loanDate; row[L.dueDate] = dueDate; row[L.status] = LOAN_OPEN;
    row[L.conditionOut] = txt_(d.conditionOut, 200); row[L.note] = txt_(d.note, 300);
    row[L.createdAt] = now; row[L.createdBy] = s.name; row[L.updatedAt] = now;
    const r = S.loan.getLastRow() + 1;
    S.loan.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    log_(S.log, a.assetId, a.assetNo, 'loan_out', s.name, { loanId: id, borrower: name, due: dueDate });
    return { loanId: id };
  });
}
function findLoan_(S, loanId) {
  const last = S.loan.getLastRow();
  if (last < 2) return null;
  const rows = S.loan.getRange(2, 1, last - 1, LOAN_HEADERS.length).getValues();
  for (let i = 0; i < rows.length; i++) if (String(rows[i][0]) === String(loanId)) return { rowNo: i + 2, obj: loanRowToObj_(rows[i]) };
  return null;
}
function apiLoanReturn_(d, s) {
  const S = sheets_(), L = lix_(), today = today_();
  const cond = txt_(d.conditionIn, 200), damaged = d.damaged === true || d.damaged === 'Y';
  if (damaged && !cond) throw bad_('กรุณาระบุความเสียหายที่พบ');
  return withLock_(function () {
    const f = findLoan_(S, d.loanId);
    if (!f) throw bad_('ไม่พบรายการยืม');
    if (f.obj.status !== LOAN_OPEN) throw bad_('รายการนี้คืนแล้ว');
    const retDate = date_(d.returnDate) || today;
    if (retDate > today) throw bad_('วันที่คืนต้องไม่เกินวันนี้');
    if (retDate < f.obj.loanDate) throw bad_('วันที่คืนต้องไม่ก่อนวันที่ยืม');
    const r = f.rowNo, now = nowStr_();
    const set = function (col, v) { S.loan.getRange(r, L[col] + 1).setNumberFormat('@').setValue(v); };
    set('returnDate', retDate); set('status', LOAN_DONE); set('conditionIn', cond); set('updatedAt', now); set('returnedBy', s.name);
    let statusChanged = false;
    if (damaged) {
      const ix = ix_(), rows = readAssets_(S.reg), i = findRow_(rows, f.obj.assetId);
      if (i >= 0 && String(rows[i][ix.status]) === STATUSES[0]) {
        S.reg.getRange(i + 2, ix.status + 1).setNumberFormat('@').setValue(STATUSES[1]);
        S.reg.getRange(i + 2, ix.updatedAt + 1, 1, 2).setNumberFormat('@').setValues([[now, s.name]]);
        statusChanged = true;
      }
    }
    log_(S.log, f.obj.assetId, f.obj.assetNo, 'loan_in', s.name, { loanId: f.obj.loanId, damaged: damaged, condition: cond, late: retDate > f.obj.dueDate });
    return { statusChanged: statusChanged, late: retDate > f.obj.dueDate };
  });
}
function apiLoanExtend_(d, s) {
  const S = sheets_(), L = lix_(), nd = date_(d.dueDate), reason = txt_(d.reason, 200);
  if (!nd) throw bad_('กรุณาระบุวันกำหนดคืนใหม่');
  return withLock_(function () {
    const f = findLoan_(S, d.loanId);
    if (!f) throw bad_('ไม่พบรายการยืม');
    if (f.obj.status !== LOAN_OPEN) throw bad_('รายการนี้คืนแล้ว');
    if (nd <= f.obj.dueDate) throw bad_('วันกำหนดคืนใหม่ต้องหลังวันกำหนดเดิม');
    if (daysBetween_(f.obj.loanDate, nd) > MAX_LOAN_DAYS * 2) throw bad_('รวมระยะเวลายืมเกินกว่าที่ระบบอนุญาต กรุณาให้ผู้ดูแลพิจารณา');
    S.loan.getRange(f.rowNo, L.dueDate + 1).setNumberFormat('@').setValue(nd);
    S.loan.getRange(f.rowNo, L.updatedAt + 1).setNumberFormat('@').setValue(nowStr_());
    log_(S.log, f.obj.assetId, f.obj.assetNo, 'loan_extend', s.name, { loanId: f.obj.loanId, from: f.obj.dueDate, to: nd, reason: reason });
    return { dueDate: nd };
  });
}

// ================================================================
//  ตรวจสภาพ
// ================================================================
function apiCheckSave_(d, s) {
  const result = String(d.result || '');
  if (CHECK_RESULTS.indexOf(result) < 0) throw bad_('กรุณาเลือกผลการตรวจ');
  const note = txt_(d.note, 500);
  if (result !== CHECK_RESULTS[0] && !note) throw bad_('กรุณาระบุรายละเอียดที่พบ');
  const S = sheets_(), ix = ix_(), sh = S.reg;
  return withLock_(function () {
    const rows = readAssets_(sh), r = findRow_(rows, d.assetId);
    if (r < 0) throw bad_('ไม่พบรายการ');
    const o = rowToAsset_(rows[r]);
    if (o.voided) throw bad_('รายการนี้ถูกยกเลิกแล้ว');
    const rowNo = r + 2, now = nowStr_(), days = Number(o.checkIntervalDays) || 0;
    const nextDue = days > 0 ? addDays_(today_(), days) : '';
    sh.getRange(rowNo, ix.lastCheckAt + 1, 1, 4).setNumberFormat('@').setValues([[now, s.name, result, nextDue]]);
    let statusChanged = false;
    if (result === CHECK_RESULTS[2] && o.status === STATUSES[0]) { sh.getRange(rowNo, ix.status + 1).setNumberFormat('@').setValue(STATUSES[1]); statusChanged = true; }
    sh.getRange(rowNo, ix.updatedAt + 1, 1, 2).setNumberFormat('@').setValues([[now, s.name]]);
    let maxN = 0; const last = S.chk.getLastRow();
    if (last >= 2) S.chk.getRange(2, 1, last - 1, 1).getValues().forEach(function (x) { const m = /^C(\d+)$/.exec(String(x[0])); if (m) maxN = Math.max(maxN, Number(m[1])); });
    const cid = 'C' + ('00000' + (maxN + 1)).slice(-5);
    S.chk.getRange(last + 1, 1, 1, CHECK_HEADERS.length).setNumberFormat('@').setValues([[cid, now, o.assetId, o.assetNo, o.name, result, note, s.name, nextDue]]);
    log_(S.log, o.assetId, o.assetNo, 'check', s.name, { result: result, note: note, statusChanged: statusChanged });
    return { nextDue: nextDue, statusChanged: statusChanged };
  });
}
function apiCheckList_(a) {
  const S = sheets_(), n = Math.max(1, Math.min(60, Number(a.limit) || 12)), last = S.chk.getLastRow();
  if (last < 2) return [];
  const rows = S.chk.getRange(2, 1, last - 1, CHECK_HEADERS.length).getValues(), out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < n; i--) {
    if (String(rows[i][2]) === String(a.id)) out.push({ ts: val_(rows[i][1], 'ts'), result: rows[i][5], note: rows[i][6], by: rows[i][7], nextDue: val_(rows[i][8], 'nextCheckDue') });
  }
  return out;
}

// ================================================================
//  QR Code — สร้างรูปเอง (ไม่พึ่งบริการภายนอก) บันทึกลง Drive + แปะรูปในเซลล์ชีต
//  qrcode-generator 1.4.4 (Kazuhiko Arase, MIT License)
// ================================================================
const PT_QRCODE_ = (function () { var qrcode=function(){var t=function(t,r){var e=t,n=g[r],o=null,i=0,a=null,u=[],f={},c=function(t,r){o=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(i=4*e+17),l(0,0),l(i-7,0),l(0,i-7),s(),h(),d(t,r),e>=7&&v(t),null==a&&(a=p(e,n,u)),w(a,r)},l=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||i<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||i<=r+n||(o[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},h=function(){for(var t=8;t<i-8;t+=1)null==o[t][6]&&(o[t][6]=t%2==0);for(var r=8;r<i-8;r+=1)null==o[6][r]&&(o[6][r]=r%2==0)},s=function(){for(var t=B.getPatternPosition(e),r=0;r<t.length;r+=1)for(var n=0;n<t.length;n+=1){var i=t[r],a=t[n];if(null==o[i][a])for(var u=-2;u<=2;u+=1)for(var f=-2;f<=2;f+=1)o[i+u][a+f]=-2==u||2==u||-2==f||2==f||0==u&&0==f}},v=function(t){for(var r=B.getBCHTypeNumber(e),n=0;n<18;n+=1){var a=!t&&1==(r>>n&1);o[Math.floor(n/3)][n%3+i-8-3]=a}for(n=0;n<18;n+=1){a=!t&&1==(r>>n&1);o[n%3+i-8-3][Math.floor(n/3)]=a}},d=function(t,r){for(var e=n<<3|r,a=B.getBCHTypeInfo(e),u=0;u<15;u+=1){var f=!t&&1==(a>>u&1);u<6?o[u][8]=f:u<8?o[u+1][8]=f:o[i-15+u][8]=f}for(u=0;u<15;u+=1){f=!t&&1==(a>>u&1);u<8?o[8][i-u-1]=f:u<9?o[8][15-u-1+1]=f:o[8][15-u-1]=f}o[i-8][8]=!t},w=function(t,r){for(var e=-1,n=i-1,a=7,u=0,f=B.getMaskFunction(r),c=i-1;c>0;c-=2)for(6==c&&(c-=1);;){for(var g=0;g<2;g+=1)if(null==o[n][c-g]){var l=!1;u<t.length&&(l=1==(t[u]>>>a&1)),f(n,c-g)&&(l=!l),o[n][c-g]=l,-1==(a-=1)&&(u+=1,a=7)}if((n+=e)<0||i<=n){n-=e,e=-e;break}}},p=function(t,r,e){for(var n=A.getRSBlocks(t,r),o=b(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw"code length overflow. ("+o.getLengthInBits()+">"+8*u+")";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=k(i[u],l.getLength()-1).mod(l);for(a[u]=new Array(l.getLength()-1),g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=s>=0?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};f.addData=function(t,r){var e=null;switch(r=r||"Byte"){case"Numeric":e=M(t);break;case"Alphanumeric":e=x(t);break;case"Byte":e=m(t);break;case"Kanji":e=L(t);break;default:throw"mode:"+r}u.push(e),a=null},f.isDark=function(t,r){if(t<0||i<=t||r<0||i<=r)throw t+","+r;return o[t][r]},f.getModuleCount=function(){return i},f.make=function(){if(e<1){for(var t=1;t<40;t++){for(var r=A.getRSBlocks(t,n),o=b(),i=0;i<u.length;i++){var a=u[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var g=0;for(i=0;i<r.length;i++)g+=r[i].dataCount;if(o.getLengthInBits()<=8*g)break}e=t}c(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){c(!0,e);var n=B.getLostPoint(f);(0==e||t>n)&&(t=n,r=e)}return r}())},f.createTableTag=function(t,r){t=t||2;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+(r=void 0===r?4*t:r)+"px;",e+='">',e+="<tbody>";for(var n=0;n<f.getModuleCount();n+=1){e+="<tr>";for(var o=0;o<f.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+t+"px;",e+=" height: "+t+"px;",e+=" background-color: ",e+=f.isDark(n,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>"},f.createSvgTag=function(t,r,e,n){var o={};"object"==typeof arguments[0]&&(t=(o=arguments[0]).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e="string"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,(n="string"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||"qrcode-title":null;var i,a,u,c,g=f.getModuleCount()*t+2*r,l="";for(c="l"+t+",0 0,"+t+" -"+t+",0 0,-"+t+"z ",l+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',l+=o.scalable?"":' width="'+g+'px" height="'+g+'px"',l+=' viewBox="0 0 '+g+" "+g+'" ',l+=' preserveAspectRatio="xMinYMin meet"',l+=n.text||e.text?' role="img" aria-labelledby="'+y([n.id,e.id].join(" ").trim())+'"':"",l+=">",l+=n.text?'<title id="'+y(n.id)+'">'+y(n.text)+"</title>":"",l+=e.text?'<description id="'+y(e.id)+'">'+y(e.text)+"</description>":"",l+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',l+='<path d="',a=0;a<f.getModuleCount();a+=1)for(u=a*t+r,i=0;i<f.getModuleCount();i+=1)f.isDark(a,i)&&(l+="M"+(i*t+r)+","+u+c);return l+='" stroke="transparent" fill="black"/>',l+="</svg>"},f.createDataURL=function(t,r){t=t||2,r=void 0===r?4*t:r;var e=f.getModuleCount()*t+2*r,n=r,o=e-r;return I(e,e,function(r,e){if(n<=r&&r<o&&n<=e&&e<o){var i=Math.floor((r-n)/t),a=Math.floor((e-n)/t);return f.isDark(a,i)?0:1}return 1})},f.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=f.getModuleCount()*t+2*r,o="";return o+="<img",o+=' src="',o+=f.createDataURL(t,r),o+='"',o+=' width="',o+=n,o+='"',o+=' height="',o+=n,o+='"',e&&(o+=' alt="',o+=y(e),o+='"'),o+="/>"};var y=function(t){for(var r="",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case"<":r+="&lt;";break;case">":r+="&gt;";break;case"&":r+="&amp;";break;case'"':r+="&quot;";break;default:r+=n}}return r};return f.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*f.getModuleCount()+2*t,u=t,c=a-t,g={"██":"█","█ ":"▀"," █":"▄","  ":" "},l={"██":"▀","█ ":"▀"," █":" ","  ":" "},h="";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i="█",u<=e&&e<c&&u<=r&&r<c&&f.isDark(n,Math.floor((e-u)/1))&&(i=" "),u<=e&&e<c&&u<=r+1&&r+1<c&&f.isDark(o,Math.floor((e-u)/1))?i+=" ":i+="█",h+=t<1&&r+1>=c?l[i]:g[i];h+="\n"}return a%2&&t>0?h.substring(0,h.length-a-1)+Array(a+1).join("▀"):h.substring(0,h.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=f.getModuleCount()*t+2*r,u=r,c=a-r,g=Array(t+1).join("██"),l=Array(t+1).join("  "),h="",s="";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),s="",n=0;n<a;n+=1)i=1,u<=n&&n<c&&u<=e&&e<c&&f.isDark(o,Math.floor((n-u)/t))&&(i=0),s+=i?g:l;for(o=0;o<t;o+=1)h+=s+"\n"}return h.substring(0,h.length-1)},f.renderTo2dContext=function(t,r){r=r||2;for(var e=f.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=f.isDark(n,o)?"black":"white",t.fillRect(n*r,o*r,r,r)},f};t.stringToBytes=(t.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,t.createStringToBytes=function(t,r){var e=function(){for(var e=S(t),n=function(){var t=e.read();if(-1==t)throw"eof";return t},o=0,i={};;){var a=e.read();if(-1==a)break;var u=n(),f=n()<<8|n();i[String.fromCharCode(a<<8|u)]=f,o+=1}if(o!=r)throw o+" != "+r;return i}(),n="?".charCodeAt(0);return function(t){for(var r=[],o=0;o<t.length;o+=1){var i=t.charCodeAt(o);if(i<128)r.push(i);else{var a=e[t.charAt(o)];"number"==typeof a?(255&a)==a?r.push(a):(r.push(a>>>8),r.push(255&a)):r.push(n)}}return r}};var r,e,n,o,i,a=1,u=2,f=4,c=8,g={L:1,M:0,Q:3,H:2},l=0,h=1,s=2,v=3,d=4,w=5,p=6,y=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],e=1335,n=7973,i=function(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r},(o={}).getBCHTypeInfo=function(t){for(var r=t<<10;i(r)-i(e)>=0;)r^=e<<i(r)-i(e);return 21522^(t<<10|r)},o.getBCHTypeNumber=function(t){for(var r=t<<12;i(r)-i(n)>=0;)r^=n<<i(r)-i(n);return t<<12|r},o.getPatternPosition=function(t){return r[t-1]},o.getMaskFunction=function(t){switch(t){case l:return function(t,r){return(t+r)%2==0};case h:return function(t,r){return t%2==0};case s:return function(t,r){return r%3==0};case v:return function(t,r){return(t+r)%3==0};case d:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case w:return function(t,r){return t*r%2+t*r%3==0};case p:return function(t,r){return(t*r%2+t*r%3)%2==0};case y:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw"bad maskPattern:"+t}},o.getErrorCorrectPolynomial=function(t){for(var r=k([1],0),e=0;e<t;e+=1)r=r.multiply(k([1,C.gexp(e)],0));return r},o.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case f:case c:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case f:return 16;case c:return 10;default:throw"mode:"+t}else{if(!(r<41))throw"type:"+r;switch(t){case a:return 14;case u:return 13;case f:return 16;case c:return 12;default:throw"mode:"+t}}},o.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);i>5&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},o),C=function(){for(var t=new Array(256),r=new Array(256),e=0;e<8;e+=1)t[e]=1<<e;for(e=8;e<256;e+=1)t[e]=t[e-4]^t[e-5]^t[e-6]^t[e-8];for(e=0;e<255;e+=1)r[t[e]]=e;var n={glog:function(t){if(t<1)throw"glog("+t+")";return r[t]},gexp:function(r){for(;r<0;)r+=255;for(;r>=256;)r-=255;return t[r]}};return n}();function k(t,r){if(void 0===t.length)throw t.length+"/"+r;var e=function(){for(var e=0;e<t.length&&0==t[e];)e+=1;for(var n=new Array(t.length-e+r),o=0;o<t.length-e;o+=1)n[o]=t[o+e];return n}(),n={getAt:function(t){return e[t]},getLength:function(){return e.length},multiply:function(t){for(var r=new Array(n.getLength()+t.getLength()-1),e=0;e<n.getLength();e+=1)for(var o=0;o<t.getLength();o+=1)r[e+o]^=C.gexp(C.glog(n.getAt(e))+C.glog(t.getAt(o)));return k(r,0)},mod:function(t){if(n.getLength()-t.getLength()<0)return n;for(var r=C.glog(n.getAt(0))-C.glog(t.getAt(0)),e=new Array(n.getLength()),o=0;o<n.getLength();o+=1)e[o]=n.getAt(o);for(o=0;o<t.getLength();o+=1)e[o]^=C.gexp(C.glog(t.getAt(o))+r);return k(e,0).mod(t)}};return n}var A=function(){var t=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],r=function(t,r){var e={};return e.totalCount=t,e.dataCount=r,e},e={};return e.getRSBlocks=function(e,n){var o=function(r,e){switch(e){case g.L:return t[4*(r-1)+0];case g.M:return t[4*(r-1)+1];case g.Q:return t[4*(r-1)+2];case g.H:return t[4*(r-1)+3];default:return}}(e,n);if(void 0===o)throw"bad rs block @ typeNumber:"+e+"/errorCorrectionLevel:"+n;for(var i=o.length/3,a=[],u=0;u<i;u+=1)for(var f=o[3*u+0],c=o[3*u+1],l=o[3*u+2],h=0;h<f;h+=1)a.push(r(c,l));return a},e}(),b=function(){var t=[],r=0,e={getBuffer:function(){return t},getAt:function(r){var e=Math.floor(r/8);return 1==(t[e]>>>7-r%8&1)},put:function(t,r){for(var n=0;n<r;n+=1)e.putBit(1==(t>>>r-n-1&1))},getLengthInBits:function(){return r},putBit:function(e){var n=Math.floor(r/8);t.length<=n&&t.push(0),e&&(t[n]|=128>>>r%8),r+=1}};return e},M=function(t){var r=a,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+2<r.length;)t.put(o(r.substring(n,n+3)),10),n+=3;n<r.length&&(r.length-n==1?t.put(o(r.substring(n,n+1)),4):r.length-n==2&&t.put(o(r.substring(n,n+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);throw"illegal char :"+t};return n},x=function(t){var r=u,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+1<r.length;)t.put(45*o(r.charAt(n))+o(r.charAt(n+1)),11),n+=2;n<r.length&&t.put(o(r.charAt(n)),6)}},o=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);if("A"<=t&&t<="Z")return t.charCodeAt(0)-"A".charCodeAt(0)+10;switch(t){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+t}};return n},m=function(r){var e=f,n=t.stringToBytes(r),o={getMode:function(){return e},getLength:function(t){return n.length},write:function(t){for(var r=0;r<n.length;r+=1)t.put(n[r],8)}};return o},L=function(r){var e=c,n=t.stringToBytesFuncs.SJIS;if(!n)throw"sjis not supported.";!function(){var t=n("友");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw"sjis not supported."}();var o=n(r),i={getMode:function(){return e},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw"illegal char at "+(e+1)+"/"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw"illegal char at "+(e+1)}};return i},D=function(){var t=[],r={writeByte:function(r){t.push(255&r)},writeShort:function(t){r.writeByte(t),r.writeByte(t>>>8)},writeBytes:function(t,e,n){e=e||0,n=n||t.length;for(var o=0;o<n;o+=1)r.writeByte(t[o+e])},writeString:function(t){for(var e=0;e<t.length;e+=1)r.writeByte(t.charCodeAt(e))},toByteArray:function(){return t},toString:function(){var r="";r+="[";for(var e=0;e<t.length;e+=1)e>0&&(r+=","),r+=t[e];return r+="]"}};return r},S=function(t){var r=t,e=0,n=0,o=0,i={read:function(){for(;o<8;){if(e>=r.length){if(0==o)return-1;throw"unexpected end of file./"+o}var t=r.charAt(e);if(e+=1,"="==t)return o=0,-1;t.match(/^\s$/)||(n=n<<6|a(t.charCodeAt(0)),o+=6)}var i=n>>>o-8&255;return o-=8,i}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw"c:"+t};return i},I=function(t,r,e){for(var n=function(t,r){var e=t,n=r,o=new Array(t*r),i={setPixel:function(t,r,n){o[r*e+t]=n},write:function(t){t.writeString("GIF87a"),t.writeShort(e),t.writeShort(n),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(","),t.writeShort(0),t.writeShort(0),t.writeShort(e),t.writeShort(n),t.writeByte(0);var r=a(2);t.writeByte(2);for(var o=0;r.length-o>255;)t.writeByte(255),t.writeBytes(r,o,255),o+=255;t.writeByte(r.length-o),t.writeBytes(r,o,r.length-o),t.writeByte(0),t.writeString(";")}},a=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,i=u(),a=0;a<r;a+=1)i.add(String.fromCharCode(a));i.add(String.fromCharCode(r)),i.add(String.fromCharCode(e));var f,c,g,l=D(),h=(f=l,c=0,g=0,{write:function(t,r){if(t>>>r!=0)throw"length over";for(;c+r>=8;)f.writeByte(255&(t<<c|g)),r-=8-c,t>>>=8-c,g=0,c=0;g|=t<<c,c+=r},flush:function(){c>0&&f.writeByte(g)}});h.write(r,n);var s=0,v=String.fromCharCode(o[s]);for(s+=1;s<o.length;){var d=String.fromCharCode(o[s]);s+=1,i.contains(v+d)?v+=d:(h.write(i.indexOf(v),n),i.size()<4095&&(i.size()==1<<n&&(n+=1),i.add(v+d)),v=d)}return h.write(i.indexOf(v),n),h.write(e,n),h.flush(),l.toByteArray()},u=function(){var t={},r=0,e={add:function(n){if(e.contains(n))throw"dup key:"+n;t[n]=r,r+=1},size:function(){return r},indexOf:function(r){return t[r]},contains:function(r){return void 0!==t[r]}};return e};return i}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=D();n.write(a);for(var u=function(){var t=0,r=0,e=0,n="",o={},i=function(t){n+=String.fromCharCode(a(63&t))},a=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw"n:"+t};return o.writeByte=function(n){for(t=t<<8|255&n,r+=8,e+=1;r>=6;)i(t>>>r-6),r-=6},o.flush=function(){if(r>0&&(i(t<<6-r),t=0,r=0),e%3!=0)for(var o=3-e%3,a=0;a<o;a+=1)n+="="},o.toString=function(){return n},o}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),"data:image/gif;base64,"+u};return t}();qrcode.stringToBytesFuncs["UTF-8"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||n>=57344?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)}; return qrcode; })();

function qrBase_() {
  const u = prop_('FRONTEND_URL');
  if (!u) throw new ApiError('CONFIG', 'ยังไม่ได้ตั้งค่า FRONTEND_URL — ผู้ดูแลต้องรัน setConfig()');
  return u;
}
function qrNewKey_() { return Utilities.getUuid().replace(/-/g, '').substring(0, 8); }
function qrMatrix_(text) {
  const qr = PT_QRCODE_(0, 'M'); qr.addData(String(text), 'Byte'); qr.make();
  const n = qr.getModuleCount(), m = [];
  for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(!!qr.isDark(r, c)); m.push(row); }
  return m;
}
let _crcT = null;
function crc32_(u8) {
  if (!_crcT) {
    _crcT = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crcT[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < u8.length; i++) c = _crcT[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function concat_(parts) {
  let len = 0; parts.forEach(function (p) { len += p.length; });
  const out = new Uint8Array(len); let o = 0;
  parts.forEach(function (p) { out.set(p, o); o += p.length; });
  return out;
}
function u32_(v) { return Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
function pngChunk_(type, data) {
  const t = Uint8Array.of(type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3));
  const td = concat_([t, data]);
  return concat_([u32_(data.length), td, u32_(crc32_(td))]);
}
function qrPngBytes_(text) {
  const m = qrMatrix_(text), n = m.length, S = 8, Q = 4, W = (n + 2 * Q) * S, H = W, rb = Math.ceil(W / 8);
  const raw = new Uint8Array((rb + 1) * H);
  let p = 0;
  for (let y = 0; y < H; y++) {
    const r = Math.floor(y / S) - Q;
    raw[p++] = 0;
    for (let x = 0; x < W; x++) {
      const c = Math.floor(x / S) - Q;
      const dark = r >= 0 && r < n && c >= 0 && c < n && m[r][c];
      if (!dark) raw[p + (x >> 3)] |= (0x80 >> (x & 7));
    }
    p += rb;
  }
  const z = [Uint8Array.of(0x78, 0x01)];
  for (let off = 0; off < raw.length;) {
    const sz = Math.min(65535, raw.length - off), fin = (off + sz >= raw.length) ? 1 : 0;
    z.push(Uint8Array.of(fin, sz & 255, (sz >> 8) & 255, (~sz) & 255, ((~sz) >> 8) & 255), raw.subarray(off, off + sz));
    off += sz;
  }
  let a = 1, b = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  z.push(u32_(((b << 16) | a) >>> 0));
  const ihdr = concat_([u32_(W), u32_(H), Uint8Array.of(1, 0, 0, 0, 0)]);
  return concat_([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk_('IHDR', ihdr), pngChunk_('IDAT', concat_(z)), pngChunk_('IEND', new Uint8Array(0))]);
}
function qrBlob_(text, name) {
  const u8 = qrPngBytes_(text);
  return Utilities.newBlob(Array.from(u8, function (b) { return b > 127 ? b - 256 : b; }), 'image/png', name);
}
// ใส่รูป QR ลงเซลล์ — ลองตามลำดับ: data URI → ลิงก์ Drive → ลิงก์ข้อความ (คืนวิธีที่สำเร็จ)
function qrCellImage_(sh, row, col, blob, file, label, text) {
  try { sh.setRowHeight(row, 84); } catch (e) {}
  try {
    const im = SpreadsheetApp.newCellImage().setSourceUrl('data:image/png;base64,' + Utilities.base64Encode(blob.getBytes()))
      .setAltTextTitle('QR ' + label).setAltTextDescription(text).build();
    sh.getRange(row, col).setNumberFormat('General').setValue(im); return 'data';
  } catch (e1) { /* ลองวิธีถัดไป */ }
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const im2 = SpreadsheetApp.newCellImage().setSourceUrl('https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w400').setAltTextTitle('QR ' + label).build();
    sh.getRange(row, col).setNumberFormat('General').setValue(im2); return 'drive';
  } catch (e2) { /* ลองวิธีถัดไป */ }
  try {
    sh.getRange(row, col).setNumberFormat('General').setFormula('=HYPERLINK("https://drive.google.com/file/d/' + file.getId() + '/view","เปิดรูป QR")'); return 'link';
  } catch (e3) { return ''; }
}
// สร้าง/สร้างซ้ำ QR ของแถวเดียว (ผู้เรียกต้องถือ lock เอง) — คีย์เดิมคงอยู่ ป้ายที่ติดไปแล้วยังสแกนได้ถ้า FRONTEND_URL ไม่เปลี่ยน
function qrApply_(S, rowNo, rowArr, by, force) {
  const ix = ix_(), sh = S.reg, id = String(rowArr[ix.assetId] || '');
  if (!force && rowArr[ix.qrText] && rowArr[ix.qrFileId]) return { assetId: id, ok: true, skipped: true };
  const key = String(rowArr[ix.qrKey] || '') || qrNewKey_();
  const text = qrBase_() + 'scan.html?id=' + encodeURIComponent(id) + '&k=' + key;
  const no = String(rowArr[ix.assetNo] || '').trim();
  const blob = qrBlob_(text, 'QR_' + (no || id).replace(/[^A-Za-z0-9ก-๙_.-]/g, '_') + '_' + id + '.png');
  const file = driveFolder_('QR_FOLDER_ID', ASSET_QR_FOLDER_NAME).createFile(blob);
  const oldFile = String(rowArr[ix.qrFileId] || '');
  if (oldFile) { try { DriveApp.getFileById(oldFile).setTrashed(true); } catch (e) {} }
  sh.getRange(rowNo, ix.qrKey + 1, 1, 3).setNumberFormat('@').setValues([[key, text, file.getId()]]);
  sh.getRange(rowNo, ix.qrAt + 1).setNumberFormat('@').setValue(nowStr_());
  const how = qrCellImage_(sh, rowNo, ix.qrImg + 1, blob, file, no || id, text);
  log_(S.log, id, no, 'qr_gen', by, { fileId: file.getId(), sheetImage: how || 'none' });
  return { assetId: id, ok: true, fileId: file.getId(), sheetImage: how };
}
function apiQrBatch_(a, s) {
  const force = a.force === true;
  if (force && s.role !== 'admin') throw new ApiError('FORBIDDEN', 'การสร้าง QR ซ้ำต้องใช้สิทธิ์ผู้ดูแลระบบ');
  const ids = (Array.isArray(a.ids) ? a.ids : []).map(String).slice(0, 10);
  if (!ids.length) return { results: [] };
  qrBase_();
  const S = sheets_(), ix = ix_();
  return withLock_(function () {
    const rows = readAssets_(S.reg), pos = {};
    rows.forEach(function (r, i) { pos[String(r[ix.assetId])] = i; });
    try { S.reg.setColumnWidth(ix.qrImg + 1, 96); } catch (e) {}
    return { results: ids.map(function (id) {
      try {
        const i = pos[id];
        if (i == null) throw new Error('ไม่พบรายการ');
        if (String(rows[i][ix.voided]) === 'Y') throw new Error('รายการนี้ถูกยกเลิกแล้ว');
        return qrApply_(S, i + 2, rows[i], s.name, force);
      } catch (e) { Logger.log('QR ' + id + ': ' + e.message); return { assetId: id, ok: false, error: 'สร้าง QR ไม่สำเร็จ' }; }
    }) };
  });
}
function apiQrPrintLog_(a, s) {
  const ids = (Array.isArray(a.ids) ? a.ids : []).map(String).slice(0, 300), size = txt_(a.size, 10);
  if (!ids.length) return { count: 0 };
  const S = sheets_(), ix = ix_(), no = {};
  readAssets_(S.reg).forEach(function (r) { no[String(r[ix.assetId])] = String(r[ix.assetNo] || ''); });
  const now = nowStr_();
  const out = ids.filter(function (id) { return no[id] != null; }).map(function (id) { return [now, id, no[id], 'qr_print', s.name, JSON.stringify({ size: size })]; });
  if (out.length) S.log.getRange(S.log.getLastRow() + 1, 1, out.length, LOG_HEADERS.length).setNumberFormat('@').setValues(out);
  return { count: out.length };
}
function qrRun_(force, who) {
  const S = sheets_(), ix = ix_();
  qrBase_();
  let ok = 0, fail = 0;
  withLock_(function () {
    try { S.reg.setColumnWidth(ix.qrImg + 1, 96); } catch (e) {}
    readAssets_(S.reg).forEach(function (r, i) {
      if (String(r[ix.voided]) === 'Y' || !r[ix.assetId]) return;
      if (!force && r[ix.qrText] && r[ix.qrFileId]) return;
      try { qrApply_(S, i + 2, r, who, force); ok++; } catch (e) { fail++; Logger.log('QR ' + r[ix.assetId] + ': ' + e.message); }
    });
  });
  Logger.log(who + ' เสร็จ — สร้าง QR ' + ok + ' รายการ, ไม่สำเร็จ ' + fail);
  return { ok: ok, fail: fail };
}

// ================================================================
//  หน้าสแกน (สาธารณะ) — เปิดเผยเฉพาะข้อมูลพื้นฐาน ไม่มีราคา / Serial / ชื่อผู้ยืม
// ================================================================
function apiScan_(a) {
  const id = String(a.id || ''), k = String(a.k || '');
  if (!/^A\d{3,}$/.test(id) || !/^[0-9a-f]{8}$/.test(k)) return { valid: false };
  const S = sheets_(), today = today_();
  const o = liveAssets_(S).filter(function (x) { return x.assetId === id; })[0];
  if (!o || !o.qrKey || !safeEq_(o.qrKey, k)) return { valid: false };
  let loanState = 'none', due = '';
  if (o.loanable === 'Y') {
    const l = openLoanMap_(readLoans_(S.loan), today)[o.assetId];
    if (l) { loanState = l.overdue ? 'overdue' : 'onLoan'; due = l.dueDate; }
    else loanState = o.status === STATUSES[0] ? 'available' : 'unavailable';
  }
  return {
    valid: true, assetId: o.assetId, assetNo: o.assetNo, name: o.name, category: o.category, location: o.location, custodian: o.custodian,
    status: o.status, loanState: loanState, dueDate: due, lastCheckAt: o.lastCheckAt, lastCheckResult: o.lastCheckResult,
    nextCheckDue: o.nextCheckDue, checkDue: checkInfo_(o, today), thumb: o.thumb || ''
  };
}
