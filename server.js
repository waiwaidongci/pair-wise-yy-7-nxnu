import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = join(__dirname, "data", "model-rigging-calibration.json");
function dbPath() { return process.env.DB_PATH || defaultDbPath; }
const port = Number(process.env.PORT || 3038);

const seed = {
  "items": [
    {
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "status": "调整中",
          "logs": [
            {
              "at": "2026-06-12",
              "note": "已缩短2mm"
            }
          ]
        },
        {
          "id": "T-1782013829186",
          "position": "后桅升帆索",
          "tension": "偏紧",
          "status": "待检查",
          "logs": [
            {
              "at": "2026-06-21T03:50:29.186Z",
              "note": "回退半圈"
            }
          ]
        }
      ],
      "logs": [
        {
          "at": "2026-06-21T03:50:29.186Z",
          "step": "帆索",
          "note": "后桅升帆索 · 偏紧"
        }
      ]
    }
  ],
  "batches": []
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const stages = ["待检查","校准中","待复核","已交付"];
const statLabels = ["待检查","校准中","待复核","已交付"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];

// 校准批次状态：生效（占用桅位）/ 待复核（先到者占用后暂存测量）/ 已失效（材料或桅位变更）
const BATCH = { ACTIVE: "生效", PENDING: "待复核", INVALID: "已失效" };
const HANDOVER = { NONE: "未交接", DONE: "已交接", REVOKED: "交接失效" };

// 材料规格：决定张力结论是否合格
const MATERIAL_SPECS = {
  "蜡线": { tensionMin: 0.30, tensionMax: 0.70 },
  "尼龙线": { tensionMin: 0.35, tensionMax: 0.75 },
  "钢丝绳": { tensionMin: 0.40, tensionMax: 0.80 }
};
const DEFAULT_SPEC = { tensionMin: 0.30, tensionMax: 0.70 };

async function loadDb() {
  const p = dbPath();
  if (!existsSync(p)) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(p, "utf8"));
  const { changed } = normalizeDb(db);
  if (changed) await saveDb(db);
  return db;
}
async function saveDb(db) { await writeFile(dbPath(), JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "MR-" + Date.now(); }
function nextBatchId() { return "B-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return (h >>> 0).toString(36); }

// 旧记录缺字段时补全：补全桅位、材料版本、操作号，保证仍能读回
function normalizeDb(db) {
  let changed = false;
  if (!Array.isArray(db.batches)) { db.batches = []; changed = true; }
  for (const item of db.items || []) {
    if (!item.materialVersion) { item.materialVersion = "v1"; changed = true; }
    if (!Array.isArray(item.tasks)) { item.tasks = []; changed = true; }
    for (const t of item.tasks) {
      if (!t.mastPosition) { t.mastPosition = t.position || "未命名桅位"; changed = true; }
      if (!t.materialVersion) { t.materialVersion = item.materialVersion; changed = true; }
      if (!t.operationNo) { t.operationNo = t.id; changed = true; }
    }
  }
  return { db, changed };
}

function findItem(db, idOrCode) {
  return db.items.find(x => x.id === idOrCode || x.code === idOrCode);
}
function findBatch(db, id) {
  return db.batches.find(b => b.id === id);
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}

function specFor(materialName) {
  return MATERIAL_SPECS[materialName] || DEFAULT_SPEC;
}
function tensionToValue(s) {
  const map = { "偏松": 0.2, "适中": 0.5, "偏紧": 0.8, "合格": 0.5, "不合格": 0.9 };
  return map[String(s).trim()] ?? NaN;
}
function toMeasurements(input) {
  if (Array.isArray(input.measurements) && input.measurements.length) {
    return input.measurements.map(m => ({
      point: m.point || m.position || "",
      value: Number(m.value ?? m.tensionValue ?? (m.tension != null ? tensionToValue(m.tension) : NaN))
    }));
  }
  if (input.tension != null && input.tension !== "") {
    const n = Number(input.tension);
    return [{ point: input.position || input.mastPosition || "", value: Number.isFinite(n) ? n : tensionToValue(input.tension) }];
  }
  return [];
}
// 依据测量值与材料规格推导张力结论
function deriveConclusion(measurements, materialName) {
  const spec = specFor(materialName);
  const nums = measurements.map(m => m.value).filter(v => Number.isFinite(v));
  if (!nums.length) return "待定";
  const ok = nums.every(v => v >= spec.tensionMin && v <= spec.tensionMax);
  return ok ? "合格" : "不合格";
}

function findActiveOccupant(db, modelId, mastPosition) {
  return db.batches.find(b => b.modelId === modelId && b.mastPosition === mastPosition && b.status === BATCH.ACTIVE);
}

// 提交校准批次：同号重传只留首次；同一模型同一桅位先到者占用，后到者保留现场测量等复核
function createCalibration(db, item, input) {
  const mastPosition = String(input.mastPosition || input.position || "").trim();
  const operationNo = input.operationNo ? String(input.operationNo).trim() : "";
  const materialName = item.riggingMaterial;
  const materialVersion = input.materialVersion || item.materialVersion || "v1";
  const measurements = toMeasurements(input);

  if (operationNo) {
    const dup = db.batches.find(b => b.operationNo === operationNo);
    if (dup) return { batch: dup, duplicated: true, occupied: false };
  }

  const tensionConclusion = deriveConclusion(measurements, materialName);
  const occupant = mastPosition ? findActiveOccupant(db, item.id, mastPosition) : null;
  const status = occupant ? BATCH.PENDING : BATCH.ACTIVE;

  const batch = {
    id: nextBatchId(),
    modelId: item.id,
    modelCode: item.code,
    taskId: null,
    mastPosition,
    materialVersion,
    operationNo,
    status,
    tensionConclusion,
    handoverStatus: HANDOVER.NONE,
    measurements,
    handover: null,
    invalidReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.batches.push(batch);

  // 连接帆索任务
  item.tasks ||= [];
  let task = item.tasks.find(t => t.mastPosition === mastPosition && !t.batchId);
  if (!task) {
    task = {
      id: "T-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      position: mastPosition,
      mastPosition,
      tension: input.tension || "",
      status: status === BATCH.ACTIVE ? "待检查" : "待复核",
      materialVersion,
      operationNo: operationNo || undefined,
      batchId: batch.id,
      logs: []
    };
    item.tasks.push(task);
  } else {
    task.batchId = batch.id;
    task.materialVersion = materialVersion;
    if (operationNo) task.operationNo = operationNo;
  }
  batch.taskId = task.id;

  item.status = "校准中";
  item.logs ||= [];
  item.logs.push({
    at: new Date().toISOString(),
    step: "校准",
    note: (status === BATCH.PENDING ? "待复核（先到者占用，保留现场测量）：" : "") + mastPosition + " · " + tensionConclusion
  });

  return { batch, duplicated: false, occupied: !!occupant };
}

// 材料变更：相关张力结论与交接状态失效重算
function changeMaterial(db, item, newMaterialName) {
  const old = item.riggingMaterial;
  item.riggingMaterial = newMaterialName;
  const v = parseInt(String(item.materialVersion || "v1").replace(/^v/, ""), 10) || 1;
  item.materialVersion = "v" + (v + 1);
  const reason = "材料由「" + old + "」变更为「" + newMaterialName + "」，张力结论已按新材料重算，交接失效需重做";
  for (const b of db.batches) {
    if (b.modelId !== item.id) continue;
    b.materialVersion = item.materialVersion;
    b.tensionConclusion = deriveConclusion(b.measurements, newMaterialName);
    b.status = BATCH.INVALID;
    b.handoverStatus = HANDOVER.REVOKED;
    b.invalidReason = reason;
    b.updatedAt = new Date().toISOString();
  }
  item.logs ||= [];
  item.logs.push({ at: new Date().toISOString(), step: "材料", note: reason });
  return item;
}

// 桅位变更：相关张力结论与交接状态失效重算
function changeTaskPosition(db, item, task, newPosition) {
  const old = task.mastPosition || task.position;
  task.position = newPosition;
  task.mastPosition = newPosition;
  const batch = db.batches.find(b => b.taskId === task.id);
  if (batch) {
    batch.mastPosition = newPosition;
    batch.status = BATCH.INVALID;
    batch.handoverStatus = HANDOVER.REVOKED;
    batch.invalidReason = "桅位由「" + old + "」变更为「" + newPosition + "」，结论与交接失效重算";
    batch.updatedAt = new Date().toISOString();
  }
  item.logs ||= [];
  item.logs.push({ at: new Date().toISOString(), step: "桅位", note: "帆索桅位由「" + old + "」变更为「" + newPosition + "」" });
  return task;
}

// 重算：按当前材料重导张力结论，重新占用桅位，交接回到未交接
function recomputeBatch(db, item, batch) {
  const materialName = item.riggingMaterial;
  batch.tensionConclusion = deriveConclusion(batch.measurements, materialName);
  batch.materialVersion = item.materialVersion || batch.materialVersion;
  const occupant = batch.mastPosition ? findActiveOccupant(db, item.id, batch.mastPosition) : null;
  batch.status = occupant && occupant.id !== batch.id ? BATCH.PENDING : BATCH.ACTIVE;
  batch.handoverStatus = HANDOVER.NONE;
  batch.invalidReason = null;
  batch.updatedAt = new Date().toISOString();
  item.logs ||= [];
  item.logs.push({ at: new Date().toISOString(), step: "重算", note: batch.mastPosition + " · " + batch.tensionConclusion });
  return batch;
}

// 交接：已失效的批次必须先重算，不能直接交接
function handoverBatch(db, item, batch, input) {
  if (batch.status === BATCH.INVALID) {
    const err = new Error("批次已失效，请先重算后再交接");
    err.code = "batch_invalid";
    throw err;
  }
  batch.handoverStatus = HANDOVER.DONE;
  batch.handover = { at: new Date().toISOString(), by: input.by || "", note: input.note || "" };
  batch.updatedAt = new Date().toISOString();
  item.logs ||= [];
  item.logs.push({ at: new Date().toISOString(), step: "交接", note: batch.mastPosition + " 已交接" });
  return batch;
}

// 外部测量导入：先校验后写入，失败时原批次保留不变，可重试
function importMeasurements(db, input) {
  const rows = Array.isArray(input.measurements) ? input.measurements : [];
  const errors = [];
  const prepared = [];
  rows.forEach((r, i) => {
    const label = "第" + (i + 1) + "行";
    const item = findItem(db, r.modelCode || r.code || r.modelId);
    if (!item) { errors.push(label + "模型不存在：" + (r.modelCode || r.code || r.modelId || "(空)")); return; }
    const mastPosition = String(r.mastPosition || r.position || "").trim();
    if (!mastPosition) { errors.push(label + "缺少桅位"); return; }
    const value = r.value != null ? Number(r.value) : (r.tension != null ? tensionToValue(r.tension) : NaN);
    if (!Number.isFinite(value)) { errors.push(label + "缺少测量值"); return; }
    prepared.push({ item, r, mastPosition, value });
  });
  if (errors.length) {
    const err = new Error("外部测量导入失败，原批次已保留");
    err.code = "import_failed";
    err.errors = errors;
    throw err;
  }
  const results = prepared.map(({ item, r, mastPosition, value }) => {
    const operationNo = r.operationNo || input.operationNo || ("IMP-" + hash([item.code, mastPosition, value, r.point || ""].join("|")));
    const res = createCalibration(db, item, {
      mastPosition,
      materialVersion: input.materialVersion,
      operationNo,
      measurements: [{ point: r.point || "", value }],
      tension: r.tension
    });
    return { modelCode: item.code, operationNo: res.batch.operationNo, status: res.batch.status, duplicated: res.duplicated, occupied: res.occupied };
  });
  return results;
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --pending:#8a6d3b; --invalid:#7a4a4a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.danger { background:var(--warn); }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.active { background:#e7efe2; color:var(--accent); border-color:var(--accent); } .pill.pending { background:#f6ecd9; color:var(--pending); border-color:var(--pending); } .pill.invalid { background:#f3e3e3; color:var(--invalid); border-color:var(--invalid); }
    .batch { border-top:1px dashed var(--line); padding-top:8px; display:grid; gap:4px; } .batch .row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">模型档案、帆索任务、交接记录接成校准批次</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="calibrateForm" style="margin-top:14px"><h2>提交校准批次</h2><label>选择模型</label><select name="id" id="calItemSelect"></select><label>桅位</label><input name="mastPosition" placeholder="如：前桅侧支索" required><label>操作号</label><input name="operationNo" placeholder="同号重传只留首次" required><label>材料版本（可空）</label><input name="materialVersion" placeholder="如 v1"><label>测量值（0-1）</label><input name="tension" type="number" step="0.01" placeholder="0.5"><button>提交校准</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>每项校准带桅位、材料版本、操作号；同号重传只留首次，同模型同桅位先到者占用。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = ${JSON.stringify(fields)};
    const stages = ${JSON.stringify(stages)};
    const extraFields = ${JSON.stringify(extraFields)};
    const BATCH = ${JSON.stringify(BATCH)};
    const HANDOVER = ${JSON.stringify(HANDOVER)};
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const calibrateForm = document.querySelector('#calibrateForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const calItemSelect = document.querySelector('#calItemSelect');
    let items = [], batches = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || (data.errors && data.errors.join('；')) || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function pillClass(s){ return s===BATCH.ACTIVE?'active':(s===BATCH.PENDING?'pending':'invalid'); }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.shipType || '')+'</option>').join('');
      calItemSelect.innerHTML = itemSelect.innerHTML;
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      bindCard();
    }
    function batchesFor(item){ return batches.filter(b => b.modelId === item.id || b.modelCode === item.code); }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const itemBatches = batchesFor(item);
      const batchHtml = itemBatches.length ? itemBatches.map(b => '<div class="batch"><div class="row"><span class="pill '+pillClass(b.status)+'">'+b.status+'</span><b>'+b.mastPosition+'</b><span class="meta">材料 '+b.materialVersion+'</span><span class="meta">操作号 '+b.operationNo+'</span></div><div class="meta">张力结论：'+b.tensionConclusion+' · 交接：'+b.handoverStatus+'</div>'+(b.invalidReason?'<div class="warn">'+b.invalidReason+'</div>':'')+'<div class="row">'+(b.status===BATCH.INVALID?'<button class="secondary" data-recompute="'+b.id+'">重算</button>':'')+(b.handoverStatus!==HANDOVER.DONE && b.status!==BATCH.INVALID?'<button data-handover="'+b.id+'">交接</button>':'')+'</div></div>').join('') : '<div class="meta">暂无校准批次</div>';
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+'<div class="meta">材料版本 '+item.materialVersion+'</div>'+batchHtml+tasks+'<div class="row"><button class="secondary" data-material="'+(item.id||item.code)+'">变更材料</button><button class="secondary" data-note="'+(item.id||item.code)+'">追加备注</button></div><label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function bindCard(){
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-material]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.material; const m = prompt('变更为新材料（如 尼龙线）'); if (m) { await api('/api/items/'+id+'/material', { method:'POST', body: JSON.stringify({ riggingMaterial: m }) }); await load(); } });
      document.querySelectorAll('[data-recompute]').forEach(btn => btn.onclick = async () => { await api('/api/batches/'+btn.dataset.recompute+'/recompute', { method:'POST' }); await load(); });
      document.querySelectorAll('[data-handover]').forEach(btn => btn.onclick = async () => { await api('/api/batches/'+btn.dataset.handover+'/handover', { method:'POST', body: JSON.stringify({}) }); await load(); });
    }
    async function load() { items = await api('/api/items'); batches = await api('/api/batches'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    calibrateForm.onsubmit = async event => { event.preventDefault(); const f = Object.fromEntries(new FormData(calibrateForm).entries()); await api('/api/items/'+calItemSelect.value+'/calibrate', { method:'POST', body: JSON.stringify(f) }); calibrateForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "GET" && url.pathname === "/api/batches") {
      const model = url.searchParams.get("model");
      const list = model ? db.batches.filter(b => b.modelId === model || b.modelCode === model) : db.batches;
      return send(res, 200, list);
    }
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), materialVersion: "v1", ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }] };
      item.tasks = [];
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const calibrate = url.pathname.match(/^\/api\/items\/([^/]+)\/calibrate$/);
    if (calibrate && req.method === "POST") {
      const item = findItem(db, calibrate[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      if (!input.operationNo) return send(res, 400, { error: "operation_no_required" });
      if (!input.mastPosition && !input.position) return send(res, 400, { error: "mast_position_required" });
      const result = createCalibration(db, item, input);
      await saveDb(db);
      if (result.duplicated) return send(res, 200, { batch: result.batch, duplicated: true });
      if (result.occupied) return send(res, 202, { batch: result.batch, occupied: true });
      return send(res, 201, { batch: result.batch });
    }
    const material = url.pathname.match(/^\/api\/items\/([^/]+)\/material$/);
    if (material && req.method === "POST") {
      const item = findItem(db, material[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const next = input.riggingMaterial || input.material;
      if (!next) return send(res, 400, { error: "material_required" });
      changeMaterial(db, item, next);
      await saveDb(db);
      return send(res, 200, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      if (input.riggingMaterial && input.riggingMaterial !== item.riggingMaterial) {
        changeMaterial(db, item, input.riggingMaterial);
      } else {
        Object.assign(item, input);
      }
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(db, log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = findItem(db, action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.tasks ||= [];
      item.tasks.push({
        id: "T-" + Date.now(),
        position: input.position,
        mastPosition: input.position,
        tension: input.tension,
        status: "待检查",
        materialVersion: item.materialVersion || "v1",
        operationNo: input.operationNo,
        logs: [{ at: new Date().toISOString(), note: input.note || "新增帆索任务" }]
      });
      item.status = "校准中";
      item.logs.push({ at: new Date().toISOString(), step: "帆索", note: input.position + " · " + input.tension });
      await saveDb(db);
      return send(res, 201, item);
    }
    const taskPatch = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskPatch && req.method === "PATCH") {
      const item = findItem(db, taskPatch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const task = (item.tasks || []).find(t => t.id === taskPatch[2]);
      if (!task) return send(res, 404, { error: "task_not_found" });
      const input = await body(req);
      const nextPosition = input.mastPosition || input.position;
      if (nextPosition && nextPosition !== (task.mastPosition || task.position)) {
        changeTaskPosition(db, item, task, nextPosition);
      } else {
        Object.assign(task, input);
      }
      await saveDb(db);
      return send(res, 200, item);
    }
    const recompute = url.pathname.match(/^\/api\/batches\/([^/]+)\/recompute$/);
    if (recompute && req.method === "POST") {
      const batch = findBatch(db, recompute[1]);
      if (!batch) return send(res, 404, { error: "batch_not_found" });
      const item = findItem(db, batch.modelId || batch.modelCode);
      if (!item) return send(res, 404, { error: "item_not_found" });
      recomputeBatch(db, item, batch);
      await saveDb(db);
      return send(res, 200, { batch });
    }
    const handover = url.pathname.match(/^\/api\/batches\/([^/]+)\/handover$/);
    if (handover && req.method === "POST") {
      const batch = findBatch(db, handover[1]);
      if (!batch) return send(res, 404, { error: "batch_not_found" });
      const item = findItem(db, batch.modelId || batch.modelCode);
      if (!item) return send(res, 404, { error: "item_not_found" });
      try {
        handoverBatch(db, item, batch, await body(req));
      } catch (e) {
        return send(res, 409, { error: e.code || "handover_failed", message: e.message });
      }
      await saveDb(db);
      return send(res, 200, { batch });
    }
    const importRoute = url.pathname === "/api/import/measurements";
    if (importRoute && req.method === "POST") {
      try {
        const results = importMeasurements(db, await body(req));
        await saveDb(db);
        return send(res, 200, { imported: results.length, results });
      } catch (e) {
        if (e.code === "import_failed") return send(res, 400, { error: e.code, errors: e.errors });
        throw e;
      }
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
}

export { server, normalizeDb, deriveConclusion, createCalibration, changeMaterial, changeTaskPosition, recomputeBatch, handoverBatch, importMeasurements, BATCH, HANDOVER };
