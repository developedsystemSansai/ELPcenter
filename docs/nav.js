/* SANSAI portal nav (สำเนาสำหรับ ELPcenter) — ปุ่มลอยเมนู "ระบบทั้งหมด" ใช้ร่วมกันทุกเว็บ
   เพิ่ม/แก้ลิงก์ที่รายการ SITES ด้านล่างที่เดียว ทุกเว็บอัปเดตตามทันที
   ปิดเฉพาะหน้า: <html data-no-portal> หรือ window.SANSAI_NAV_OFF = true */
(function () {
  var HUB = 'portal.html';
  var SITES = [
    { g: 'บริการผู้ป่วย', n: 'ศูนย์ยืม-คืนอุปกรณ์', d: 'ทะเบียนครุภัณฑ์ และ QR Code', u: location.origin + '/' },
    { g: 'บริหารและธุรการ', n: 'ระบบสารบรรณอิเล็กทรอนิกส์', d: 'รับ-ส่งหนังสือภายในหน่วยงาน', u: 'https://developedsystemsansai.github.io/sarabunsansaihos/' },
    { g: 'บริหารและธุรการ', n: 'ระบบบริหารจัดการโครงการ', d: 'ติดตามโครงการและแผนงาน', u: 'https://developedsystemsansai.github.io/sansaiplan/' },
    { g: 'บริหารและธุรการ', n: 'แผนที่ยุทธศาสตร์', d: 'รวบรวมมุมมองกลุ่มงาน แผนยุทธศาสตร์', u: 'https://sansai-strategy-map.vercel.app/' },
    { g: 'บริหารและธุรการ', n: 'ระบบ HRD', d: 'บันทึกหน่วยกิตและติดตามผล งบ 2569', u: 'https://hrdsansai.vercel.app/' },
    { g: 'บริหารและธุรการ', n: 'EC Online Submission', d: 'ยื่นขอรับการพิจารณาจริยธรรมการวิจัย', u: 'https://developedsystemsansai.github.io/ec-sansai/' },
    { g: 'บริหารและธุรการ', n: 'SAND ระบบยานพาหนะ', d: 'บันทึกการใช้รถ แจ้งซ่อม ตารางเวร', u: 'https://developedsystemsansai.github.io/carsystemsansai/' },
    { g: 'บริการผู้ป่วย', n: 'PT Station กายภาพบำบัด', d: 'รพ.สต.บางขะแยง', u: 'https://ploypailinphysicaltherapy.github.io/Ploypailin-Physical-Therapy/' },
    { g: 'บริการผู้ป่วย', n: 'จุดรับยาค้าง', d: 'ข้อมูลจุดรับยาค้าง', u: 'https://developedsystemsansai.github.io/refillmed/' },
    { g: 'บริการผู้ป่วย', n: 'ระบบเยี่ยมบ้าน', d: 'ลงทะเบียน แผนที่ และแอปเจ้าหน้าที่', u: 'https://developedsystemsansai.github.io/HomeVisit/' },
    { g: 'กิจกรรมและเครื่องมือ', n: 'เช็คอินและจัดที่นั่งสัมมนา', d: 'QR เช็คอิน แผนผังที่นั่ง', u: 'https://developedsystemsansai.github.io/QRScan/' },
    { g: 'กิจกรรมและเครื่องมือ', n: 'Kippy ตารางเวร', d: 'ตารางเวรบนมือถือผ่าน LINE', u: 'https://kippytable.vercel.app/' },
    { g: 'กิจกรรมและเครื่องมือ', n: 'Let me ทาย', d: 'เกมปาร์ตี้ทายคำ', u: 'https://developedsystemsansai.github.io/mixedgames/' }
  ];
  window.SANSAI_SITES = SITES;
  window.SANSAI_HUB = HUB;
  if (window.SANSAI_NAV_OFF || window.self !== window.top || document.documentElement.hasAttribute('data-no-portal')) return;

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var href = location.href, cur = null;
  SITES.forEach(function (s) { if (href.indexOf(s.u) === 0) cur = s; });

  var html = '', g = '';
  SITES.forEach(function (s) {
    if (s.g !== g) { g = s.g; html += '<h2>' + esc(g) + '</h2>'; }
    html += '<a class="it' + (s === cur ? ' cur' : '') + '" href="' + esc(s.u) + '"' + (s === cur ? ' aria-current="page"' : '') + '><b>' + esc(s.n) + '</b><span>' + esc(s.d) + '</span></a>';
  });

  var host = document.createElement('div');
  host.id = 'sansai-portal';
  host.style.cssText = 'all:initial;position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483000;font-family:Sarabun,"Noto Sans Thai",system-ui,sans-serif';
  var r = host.attachShadow({ mode: 'open' });
  r.innerHTML = '<style>' +
    '*{box-sizing:border-box;margin:0}' +
    '.fab{width:44px;height:44px;border-radius:50%;border:0;background:#1a56db;color:#fff;display:grid;place-items:center;cursor:pointer;opacity:.88;box-shadow:0 6px 16px -6px rgba(0,0,0,.45);transition:opacity .15s,transform .15s}' +
    '.fab:hover,.fab[aria-expanded=true]{opacity:1}.fab:active{transform:scale(.96)}.fab svg{width:22px;height:22px}' +
    '.fab:focus-visible,.pn a:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}' +
    '.pn{position:absolute;left:0;bottom:56px;width:min(320px,calc(100vw - 24px));max-height:min(70vh,520px);overflow:auto;background:#fff;color:#1f2937;border:1px solid #e5e7eb;border-radius:16px;padding:8px;box-shadow:0 18px 40px -12px rgba(0,0,0,.35)}' +
    '.pn[hidden]{display:none}' +
    '.pn h2{font-size:.75rem;font-weight:600;color:#6b7280;padding:10px 10px 4px}' +
    '.pn a{display:block;text-decoration:none;color:inherit;padding:9px 10px;border-radius:10px;line-height:1.35}' +
    '.pn a:hover{background:#eff4ff}' +
    '.pn .hub{background:#1a56db;color:#fff;font-weight:700;text-align:center;margin-bottom:2px}.pn .hub:hover{background:#1647b8}' +
    '.it b{display:block;font-size:.92rem;font-weight:600}.it span{display:block;font-size:.78rem;color:#6b7280}' +
    '.it.cur{background:#eff4ff;box-shadow:inset 0 0 0 1.5px #1a56db}' +
    '@media print{.fab,.pn{display:none!important}}@media (prefers-reduced-motion:reduce){*{transition:none!important}}' +
    '</style>' +
    '<button class="fab" type="button" aria-label="เมนูระบบทั้งหมด" aria-expanded="false" title="ระบบทั้งหมดของ รพ.สันทราย"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg></button>' +
    '<nav class="pn" hidden aria-label="ระบบทั้งหมด">' + html + '</nav>';
  var fab = r.querySelector('.fab'), pn = r.querySelector('.pn');
  function set(o) { pn.hidden = !o; fab.setAttribute('aria-expanded', o ? 'true' : 'false'); }
  fab.addEventListener('click', function (e) { e.stopPropagation(); set(pn.hidden); });
  document.addEventListener('click', function (e) { if (!host.contains(e.target)) set(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pn.hidden) { set(false); fab.focus(); } });
  (document.body || document.documentElement).appendChild(host);
})();
