# ศูนย์ยืม-คืนอุปกรณ์ / ทะเบียนครุภัณฑ์ + QR Code

ระบบดูแลเครื่องมือ ครุภัณฑ์ และศูนย์ยืม-คืนอุปกรณ์ แยกเป็น 2 ส่วน:

| ส่วน | โฟลเดอร์ | เผยแพร่ที่ |
|---|---|---|
| **Frontend** (หน้าเว็บเจ้าหน้าที่ + หน้าสแกนสาธารณะ) | `docs/` | GitHub Pages / Vercel / เว็บไซต์ใดก็ได้ |
| **Backend** (JSON API บน Google Apps Script + ข้อมูลใน Google Sheets / Drive) | `backend/` | Apps Script Web App |

ไม่ได้ใช้ลิงก์ Apps Script เป็นหน้าเว็บ — Apps Script ทำหน้าที่เป็น API อย่างเดียว ระบบอื่นลิงก์มาที่ frontend ได้ตรง ๆ

## ทำอะไรได้
- **ทะเบียนครุภัณฑ์** เพิ่ม/แก้ไข ค้นหา กรอง แนบรูป ยกเลิกรายการ (soft delete) พร้อมประวัติทุกการเปลี่ยนแปลง
- **QR Code ประจำเครื่อง** สร้างอัตโนมัติเมื่อเพิ่มรายการ · บันทึกลงชีต `AssetRegister` ทั้งรูปในเซลล์ + ลิงก์ + ไฟล์ PNG ใน Drive · พิมพ์ป้ายสติกเกอร์ A4 (3 ขนาด)
- **ยืม-คืน** ให้ยืม / รับคืน / ต่อกำหนดคืน · กันยืมซ้ำ · เตือนเกินกำหนดในหน้าภาพรวม · รับคืนแล้วพบความเสียหาย → เปลี่ยนสถานะเป็น "ชำรุด / รอซ่อม" ให้เอง
- **ตรวจสภาพ** กำหนดรอบตรวจ เตือนเมื่อครบกำหนด บันทึกผลทุกครั้ง
- **สแกน** ใช้กล้องมือถือสแกนป้าย → หน้าสาธารณะแสดงข้อมูลพื้นฐาน (ไม่มีราคา / Serial / ชื่อผู้ยืม) · เจ้าหน้าที่กดเข้าไปทำรายการต่อ · มีสแกนในแอปด้วย (เบราว์เซอร์ที่รองรับ BarcodeDetector)

## โครงสร้าง
```
backend/Code.gs         Apps Script API (วางทั้งไฟล์)
backend/appsscript.json manifest (timezone, scopes, web app = Anyone)
docs/index.html         แอปเจ้าหน้าที่ (hash routes: #/ #/assets #/asset/A00001 #/loans #/print #/scan #/log)
docs/scan.html          หน้าสาธารณะที่ QR ชี้มา
docs/config.js          ★ ตั้งค่า API_URL ที่นี่
docs/app.js api.js qr.js style.css
test/                   ชุดทดสอบ (จำลอง Apps Script + jsdom)
```

## ติดตั้ง (ทำครั้งเดียว)

### 1) Backend
1. สร้าง Google Sheet ใหม่ (หรือใช้ชีตเดิมของระบบ) → คัดลอก **Spreadsheet ID** จาก URL
2. ไปที่ [script.google.com](https://script.google.com) → New project → วางเนื้อหา `backend/Code.gs`
   (ถ้าต้องการให้ manifest ตรงกัน: Project Settings → ติ๊ก *Show "appsscript.json"* แล้ววางเนื้อหา `backend/appsscript.json`)
3. ใน `setConfig()` แก้ 4 ค่า: `SPREADSHEET_ID`, `FRONTEND_URL` (ลิงก์หน้าเว็บที่จะเผยแพร่ ลงท้าย `/`), `STAFF_PIN`, `ADMIN_PIN` (≥ 6 ตัว ต่างกัน) → กด **Run `setConfig`** → อนุญาตสิทธิ์
   แล้ว **ลบ PIN ออกจากโค้ด** (ระบบเก็บเฉพาะค่าแฮช)
4. Run `setupLoanCenter()` → สร้างชีต `AssetRegister`, `AssetLog`, `AssetLoans`, `AssetChecks`
5. **Deploy → New deployment → Web app** · Execute as: **Me** · Who has access: **Anyone** → คัดลอก URL `…/exec`

### 2) Frontend
1. แก้ `docs/config.js` → ใส่ `API_URL` (URL จากข้อ 1.5), ชื่อหน่วยงาน, และ `HOME_URL` (ถ้าต้องการปุ่มกลับระบบหลัก)
2. เผยแพร่โฟลเดอร์ `docs/`
   - **GitHub Pages**: Settings → Pages → Branch `main` / folder `/docs`
   - **Vercel**: Import repo แล้ว Deploy ได้เลย (มี `vercel.json` ตั้ง output เป็น `docs` ให้แล้ว ไม่ต้องตั้งค่าเพิ่ม)
3. กลับไปตรวจว่า `FRONTEND_URL` ใน backend ตรงกับลิงก์จริง (ถ้าเปลี่ยน ให้รัน `setConfig()` ใหม่ แล้วรัน `regenerateAllQr()` และพิมพ์ป้ายใหม่)

### 3) ใช้งาน
เปิด frontend → เข้าสู่ระบบด้วยชื่อ + PIN → เพิ่มครุภัณฑ์ → ไปเมนู **พิมพ์ QR** → ติดป้ายที่ตัวเครื่อง

## สิทธิ์
| ทำอะไร | เจ้าหน้าที่ (STAFF_PIN) | ผู้ดูแล (ADMIN_PIN) |
|---|:--:|:--:|
| ดู / เพิ่ม / แก้ไข / แนบรูป / ตรวจสภาพ / พิมพ์ QR | ✓ | ✓ |
| ให้ยืม / รับคืน / ต่อกำหนดคืน | ✓ | ✓ |
| ยกเลิกรายการ · สร้าง QR ใหม่ทั้งหมด | – | ✓ |

## ลิงก์จากระบบอื่น
ใช้ลิงก์ตรงเข้าหน้าที่ต้องการได้ (ถ้ายังไม่ล็อกอินจะถามรหัสก่อนแล้วพาไปต่อ):
```
https://<โดเมน>/index.html#/loans            รายการที่กำลังยืม
https://<โดเมน>/index.html#/assets           ทะเบียนครุภัณฑ์
https://<โดเมน>/index.html#/asset/A00001     รายการเดียว
https://<โดเมน>/index.html#/asset/A00001/loan    เปิดฟอร์มให้ยืม (/return /extend /check)
```

## ย้ายจาก PT Station V28/V29
หัวตาราง `AssetRegister` เหมือนเดิมทุกคอลัมน์ → ตั้ง `SPREADSHEET_ID` เป็นชีตเดิมได้เลย ข้อมูลเก่าใช้ต่อได้ (ชีต `AssetLoans` จะเพิ่มคอลัมน์ `borrowerType`, `returnedBy` ต่อท้ายให้เอง)
QR เดิมชี้ไปลิงก์ Apps Script → รัน `regenerateAllQr()` แล้วพิมพ์ป้ายใหม่ (คีย์สุ่มของแต่ละป้ายคงเดิม)

## ความปลอดภัย (สรุป)
- ตรวจสิทธิ์และข้อมูลทุกอย่าง **ที่เซิร์ฟเวอร์** (PIN แฮช SHA-256 + salt, token สุ่ม 256 บิตเก็บใน CacheService อายุ 6 ชม.)
- ชื่อผู้ทำรายการในประวัติมาจาก session ไม่รับจาก client
- ใส่ PIN ผิดครบ 5 ครั้ง ล็อกการเข้าสู่ระบบ 10 นาที (ล็อกทั้งระบบ เพราะ Apps Script ไม่เห็น IP ผู้ใช้)
- หน้าสแกนสาธารณะต้องมีคีย์สุ่มของป้าย และแสดงเฉพาะข้อมูลพื้นฐาน
- ค่าที่ขึ้นต้นด้วย `=` ถูกเก็บเป็นข้อความ ไม่ถูกตีความเป็นสูตรในชีต
- แก้โค้ด backend แล้วต้อง **Deploy → Manage deployments → Edit → New version** ลิงก์ `/exec` เดิมจึงใช้โค้ดใหม่

## ทดสอบ
```
npm install
npm test
```
ครอบคลุม: ไวยากรณ์ทุกไฟล์ · API 56 กรณี (สิทธิ์ ตรวจข้อมูล ยืม-คืน QR รูปภาพ ล็อกอินล็อกเอาต์) · หน้าเว็บทั้งเส้นทางด้วย jsdom · หน้าสแกนสาธารณะ

## ลิขสิทธิ์ของไลบรารี
QR: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 — MIT License © Kazuhiko Arase (ฝังในไฟล์ `docs/qr.js` และ `backend/Code.gs`)
