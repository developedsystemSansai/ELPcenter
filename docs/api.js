// ตัวเรียก backend (Google Apps Script) — ใช้ร่วมกันทั้งหน้าเจ้าหน้าที่และหน้าสแกน
(function () {
  var C = window.ELC_CONFIG || {};
  var KEY = 'elc.session';
  function load() { try { var s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && s.token && s.exp > Date.now()) return s; } catch (e) {} return null; }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }
  function ApiErr(code, msg) { var e = new Error(msg); e.code = code; return e; }

  function call(action, args, opts) {
    opts = opts || {};
    if (!C.API_URL || /PASTE_DEPLOYMENT_ID_HERE/.test(C.API_URL)) return Promise.reject(ApiErr('CONFIG', 'ยังไม่ได้ตั้งค่า API_URL ในไฟล์ config.js'));
    var s = load(), ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, opts.timeout || 60000);
    // ส่งเป็น text/plain เพื่อเลี่ยง CORS preflight (Apps Script ไม่รองรับ OPTIONS)
    return fetch(C.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: action, token: s ? s.token : '', args: args || {} }), redirect: 'follow', signal: ctl.signal })
      .then(function (r) { if (!r.ok) throw ApiErr('NETWORK', 'เชื่อมต่อระบบไม่สำเร็จ (' + r.status + ')'); return r.json(); })
      .then(function (j) {
        if (!j || j.ok !== true) {
          var code = j && j.code || 'INTERNAL';
          if (code === 'AUTH_REQUIRED') { clear(); window.dispatchEvent(new Event('elc:auth')); }
          throw ApiErr(code, j && j.error || 'เกิดข้อผิดพลาด');
        }
        return j.data;
      })
      .catch(function (e) {
        if (e && e.code) throw e;
        if (e && e.name === 'AbortError') throw ApiErr('TIMEOUT', 'ระบบตอบสนองช้า กรุณาลองใหม่อีกครั้ง');
        throw ApiErr('NETWORK', 'เชื่อมต่อระบบไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
      })
      .then(function (d) { clearTimeout(t); return d; }, function (e) { clearTimeout(t); throw e; });
  }
  function login(name, pin) {
    return call('login', { name: name, pin: pin }).then(function (d) {
      save({ token: d.token, name: d.name, role: d.role, exp: Date.now() + (d.expiresIn - 120) * 1000 });
      return d;
    });
  }
  function logout() { var p = load() ? call('logout').catch(function () {}) : Promise.resolve(); return p.then(clear); }
  window.ELC_API = { call: call, login: login, logout: logout, session: load, clear: clear };
})();
