const fs = require('fs');
const path = require('path');
var XLSX = require("xlsx");
const iconv = require('iconv-lite');


let currentBaseName = 'testing';

function getProxiesFilePath() {
  return process.env.PROXIES_FILE
    ? path.resolve(process.env.PROXIES_FILE)
    : path.join(__dirname, 'proxies.txt');
}

function removeDuplicates(arr) {
  const seen = new Set();
  return arr.filter(i => {
    const key = `${i.Артикул}|${i.Бренд}|${i.Продавец}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function byField(field) {
  return (a, b) => a[field] > b[field] ? 1 : -1;
}

function getDetails() {
  let fileToRead = '';
  const possibleFiles = [
    '/mnt/smb-share/выгрузки ежедневные клиентам/Выгрузка цен Инфопартс прайс1.txt',
    'testing.txt',
    'PKL3.txt'
  ];
  
  for (const f of possibleFiles) {
    if (fs.existsSync(f)) {
      fileToRead = f;
      break;
    }
  }

  if (!fileToRead) {
    console.error("ERROR: No input file found (checked: /mnt/smb-share/выгрузки ежедневные клиентам/Выгрузка цен Инфопартс прайс1.txt, testing.txt, PKL3.txt)!");
    return [];
  }

  currentBaseName = path.basename(fileToRead, path.extname(fileToRead));
  console.log(`Reading input details from ${fileToRead}...`);

  const ourdetalss = [];
  const buffer = fs.readFileSync(fileToRead);
  
  // Auto-detect encoding (UTF-8 vs Windows-1251)
  let allFileContents = '';
  try {
    const utf8Str = buffer.toString('utf8');
    if (!utf8Str.includes('\uFFFD')) {
      allFileContents = utf8Str;
    } else {
      allFileContents = iconv.decode(buffer, 'windows-1251');
    }
  } catch (e) {
    allFileContents = iconv.decode(buffer, 'windows-1251');
  }

  const lines = allFileContents.split(/\r?\n/);
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const s = line.split('\t');
    if (s.length >= 2) {
      ourdetalss.push({ 
        'Марка': s[0] ? s[0].trim() : '', 
        'Номер': s[1] ? s[1].trim() : '', 
        'Название': s[2] ? s[2].trim() : '', 
        'кол-во': s[3] ? s[3].trim() : '', 
        'цена': s[4] ? s[4].trim() : '', 
        'партия': s[5] ? s[5].trim() : '' 
      });
    }
  }
  return ourdetalss;
}

function getProxies() {
  const proxiesJson = [];
  const proxiesFile = getProxiesFilePath();
  if (!fs.existsSync(proxiesFile)) {
    console.log(`ERROR: proxies file not found: ${proxiesFile}`);
    return [];
  }
  const proxyfile = fs.readFileSync(proxiesFile, 'utf-8');
  const lines = proxyfile.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    
    // Normalize format: replace '@' with ':'
    line = line.replace('@', ':');
    
    const s = line.split(':');
    if (s.length >= 2) {
      let xeh = { 'host': s[0], 'port': s[1] };
      xeh['auth'] = {};
      xeh['auth']['username'] = s[2] || '';
      xeh['auth']['password'] = s.slice(3).join(':') || '';
      proxiesJson.push(xeh);
    }
  }
  return proxiesJson;
}

function final(finalvers) {
  let b = removeDuplicates(finalvers);
  const ws = XLSX.utils.json_to_sheet(b);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const filename = path.join(__dirname, `${currentBaseName} ${(new Date().toJSON().slice(0, 10))}.xlsx`);
  XLSX.writeFile(wb, filename);
  console.log(`final file has been written: ${filename}`);
}

function positions(finalvers, notuniquemasof) {
  let farrjson = Array.from(notuniquemasof);
  let farr = [];
  for (let a of farrjson) {
    farr.push(JSON.parse(a));
  }

  // Pre-group offers by brand and article key for O(N) lookup performance
  const lookupMap = new Map();
  for (const offer of finalvers) {
    const key = `${offer.Артикул.toLowerCase()}|${offer.Бренд.toLowerCase()}`;
    if (!lookupMap.has(key)) {
      lookupMap.set(key, []);
    }
    lookupMap.get(key).push(offer);
  }

  let fltarr = {};
  for (let b of farr) {
    const key = `${b.Артикул.toLowerCase()}|${b.Бренд.toLowerCase()}`;
    const result = lookupMap.get(key) || [];
    if (result.length === 0) continue;
    result.sort(byField('Цена'));
    let rs2 = [];
    if (result.length == 1) {
      rs2 = [result[0]];
    } else {
      rs2 = [result[0], result[1]];
    }
    fltarr[b.Артикул + '-someonetolove-' + b.Бренд + "-someonetolove-" + result[0].Наша_Цена + '-someonetolove-' + result[0].Мин_Цена + '-someonetolove-' + result.length] = rs2;
  }
  let firstarr = [];
  for (const [k, v] of Object.entries(fltarr)) {
    let artm = k.split('-someonetolove-');
    let sobj = {};
    if (v.length == 1) {
      sobj = { 
        'Артикул': artm[0], 
        'Бренд': artm[1], 
        'Наша_Цена': artm[2], 
        'Мин_Цена': artm[3], 
        'Кол-во_Предложений': artm[4], 
        '1-ая_Цена': v[0].Цена, 
        'Магазин': v[0].Продавец, 
        'Наличие': v[0].Наличие 
      };
    } else {
      sobj = { 
        'Артикул': artm[0], 
        'Бренд': artm[1], 
        'Наша_Цена': artm[2], 
        'Мин_Цена': artm[3], 
        'Кол-во_Предложений': artm[4], 
        '1-ая_Цена': v[0].Цена, 
        'Магазин': v[0].Продавец, 
        'Наличие': v[0].Наличие, 
        '2-ая_Цена': v[1].Цена, 
        '2-ой Магазин': v[1].Продавец, 
        'Наличие 2-ого': v[1].Наличие 
      };
    }
    firstarr.push(sobj);
  }
  const ws = XLSX.utils.json_to_sheet(firstarr);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const filename = path.join(__dirname, `${currentBaseName}_Positions ${(new Date().toJSON().slice(0, 10))}.xlsx`);
  XLSX.writeFile(wb, filename);
  console.log(`positions file has been written: ${filename}`);
}

function horizontal(finalvers, notuniquemasof) {
  var mas = [];
  for (let c of finalvers) {
    mas.push(c.Продавец);
  }
  fmas = Array.from(new Set(mas));
  farrjson = Array.from(notuniquemasof);
  farr = [];
  for (let a of farrjson) {
    farr.push(JSON.parse(a));
  }

  // Pre-group offers by brand and article key for O(N) lookup performance
  const lookupMap = new Map();
  for (const offer of finalvers) {
    const key = `${offer.Артикул.toLowerCase()}|${offer.Бренд.toLowerCase()}`;
    if (!lookupMap.has(key)) {
      lookupMap.set(key, []);
    }
    lookupMap.get(key).push(offer);
  }

  fltarr = {};
  for (let b of farr) {
    const key = `${b.Артикул.toLowerCase()}|${b.Бренд.toLowerCase()}`;
    const result = lookupMap.get(key) || [];
    if (result.length === 0) continue;
    const prod = result[0].Продукт || '';
    fltarr[b.Артикул + '-someonetolove-' + b.Бренд + "-someonetolove-" + result[0].Наша_Цена + '-someonetolove-' + result[0].Мин_Цена + '-someonetolove-' + result.length + '-someonetolove-' + prod] = result;
  }
  somearr = [];
  for (const [key, value] of Object.entries(fltarr)) {
    let em = {};
    let obj = [];
    for (let jj of value) {
      myobj = {};
      a = fmas.filter((dd) => dd == jj.Продавец);
      myobj[a[0]] = [jj.Цена, jj.Наличие];
      obj.push(myobj);
    }
    em[key] = obj;
    somearr.push(em);
  }
  var somefl = [];
  for (let m of somearr) {
    for (const [key, value] of Object.entries(m)) {
      artm = key.split('-someonetolove-');
      sobj = { 'Артикул': artm[0], 'Бренд': artm[1], 'Продукт': artm[5], 'Наша_Цена': artm[2], 'Мин_Цена': artm[3], 'Кол-во_Предложений': artm[4] };
      for (let inner of value) {
        for (const [ke, va] of Object.entries(inner)) {
          sobj["Цена " + ke] = va[0];
          sobj["Наличие " + ke] = va[1];
        }
      }
      somefl.push(sobj);
    }
  }
  const ws = XLSX.utils.json_to_sheet(somefl);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const filename = path.join(__dirname, `${currentBaseName}_Horizontal ${(new Date().toJSON().slice(0, 10))}.xlsx`);
  XLSX.writeFile(wb, filename);
  console.log(`horizontal file has been written: ${filename}`);
}

module.exports = { getDetails, getProxies, getProxiesFilePath, final, positions, horizontal };
