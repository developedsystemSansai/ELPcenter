// ทดสอบหน้า scan.html (สาธารณะ): คีย์ถูก → แสดงข้อมูลพื้นฐาน, คีย์ผิด → ไม่แสดง, ไม่รั่วข้อมูลผู้ยืม/ราคา
const {JSDOM}=require('jsdom'),fs=require('fs'),path=require('path');
const {call,run}=require('./mock_gas.js');
const D=path.join(__dirname,'..','docs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const raw=fs.readFileSync(D+'/scan.html','utf8').replace(/<script src[^>]*><\/script>/g,'').replace(/<link[^>]*>/g,'');
async function open(qs){
  const dom=new JSDOM(raw,{url:'https://org.github.io/elc/scan.html'+qs,runScripts:'outside-only'});const w=dom.window;
  w.fetch=(u,o)=>{const b=JSON.parse(o.body);return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(call(b.action,b.args,b.token))})};
  w.eval(fs.readFileSync(D+'/config.js','utf8').replace(/https:\/\/script\.google\.com[^']*/,'https://mock/exec'));w.eval(fs.readFileSync(D+'/api.js','utf8'));
  const inline=/<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(D+'/scan.html','utf8').replace(/<script src[^>]*><\/script>/g,''))[1];
  w.eval(inline);await sleep(150);return w.document.getElementById('m').innerHTML;
}
(async()=>{
  let bad=0;const t=(n,c)=>{console.log(c?'PASS':'FAIL',n);if(!c)bad++};
  const st=call('login',{name:'ทดสอบ',pin:'staff-123'}).data.token;
  const id=call('assetSave',{name:'รถเข็นนั่ง',assetNo:'WC-001',loanable:'Y',unitPrice:12500,serialNo:'SN-SECRET'},st).data.assetId;
  const k=/k=([0-9a-f]{8})/.exec(call('assetGet',{id},st).data.qrText)[1];
  let h=await open(`?id=${id}&k=${k}`);
  t('valid key shows name',h.includes('รถเข็นนั่ง'));t('shows availability',h.includes('พร้อมให้ยืม'));
  t('no price/serial leak',!/12,?500|SN-SECRET/.test(h));
  const due=run(`addDays_(today_(),5)`);call('loanCheckout',{assetId:id,borrowerName:'ผู้ป่วย ลับ',borrowerType:'ผู้ป่วย / ญาติ',phone:'0812345678',dueDate:due},st);
  h=await open(`?id=${id}&k=${k}`);t('on loan shown',h.includes('ถูกยืมอยู่'));t('borrower hidden',!/ผู้ป่วย ลับ|0812345678/.test(h));
  h=await open(`?id=${id}&k=00000000`);t('wrong key → not found',h.includes('ไม่พบข้อมูลครุภัณฑ์')&&!h.includes('รถเข็นนั่ง'));
  h=await open('?id=<script>&k=zz');t('garbage params → not found',h.includes('ไม่พบข้อมูลครุภัณฑ์'));
  process.exit(bad?1:0);
})();
