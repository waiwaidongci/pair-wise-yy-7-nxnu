import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
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
        }
      ],
      "logs": []
    }
  ],
  "batches": [
    {
      "id": "B-1",
      "itemCode": "MR-001",
      "mastPosition": "前桅",
      "materialVersion": "蜡线-v1",
      "operationNo": "OP-0001",
      "tension": "偏松",
      "measuredValue": "2.4N",
      "note": "首次校准",
      "source": "manual",
      "status": "有效",
      "conclusionValid": true,
      "handoverStatus": "未交接",
      "createdAt": "2026-06-12T08:00:00.000Z",
      "logs": [
        { "at": "2026-06-12T08:00:00.000Z", "note": "占用前桅，结论生效" }
      ]
    }
  ],
  "handovers": [],
  "seq": 1
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const stages = ["待检查","校准中","待复核","已交付"];
const statLabels = ["待检查","校准中","待复核","已交付"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
const batchStatuses = ["有效","待复核","失效"];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (migrate(db)) await saveDb(db);
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
// 旧记录缺字段时补全：批次、交接、序号缺啥补啥，补完仍能读回
function migrate(db) {
  let changed = false;
  if (!Array.isArray(db.items)) { db.items = []; changed = true; }
  if (!Array.isArray(db.batches)) { db.batches = []; changed = true; }
  if (!Array.isArray(db.handovers)) { db.handovers = []; changed = true; }
  for (const item of db.items) {
    if (!Array.isArray(item.logs)) { item.logs = []; changed = true; }
    if (!Array.isArray(item.tasks)) { item.tasks = []; changed = true; }
    if (!item.status) { item.status = "待检查"; changed = true; }
    for (const task of item.tasks) {
      if (!Array.isArray(task.logs)) { task.logs = []; changed = true; }
      if (!task.status) { task.status = "待检查"; changed = true; }
    }
  }
  for (const batch of db.batches) {
    if (!batch.id) { batch.id = "B-LEGACY-" + (db.batches.indexOf(batch) + 1); changed = true; }
    if (!batch.itemCode) { batch.itemCode = "未关联"; changed = true; }
    if (!batch.mastPosition) { batch.mastPosition = "未标注桅位"; changed = true; }
    if (!batch.materialVersion) {
      const item = findItem(db, batch.itemCode);
      batch.materialVersion = defaultMaterialVersion(item);
      changed = true;
    }
    if (!batch.operationNo) { batch.operationNo = "OP-LEGACY-" + batch.id; changed = true; }
    if (!batch.status) { batch.status = "有效"; changed = true; }
    if (typeof batch.conclusionValid !== "boolean") { batch.conclusionValid = batch.status === "有效"; changed = true; }
    if (!batch.handoverStatus) { batch.handoverStatus = "未交接"; changed = true; }
    if (!batch.source) { batch.source = "manual"; changed = true; }
    if (!batch.createdAt) { batch.createdAt = new Date().toISOString(); changed = true; }
    if (!Array.isArray(batch.logs)) { batch.logs = []; changed = true; }
  }
  for (const handover of db.handovers) {
    if (!handover.status) { handover.status = "有效"; changed = true; }
  }
  if (typeof db.seq !== "number") {
    db.seq = [...db.batches, ...db.handovers].reduce((n, x) => {
      const m = /-(\d+)$/.exec((x && x.id) || "");
      return m ? Math.max(n, Number(m[1])) : n;
    }, 0);
    changed = true;
  }
  return changed;
}
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
function findItem(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}
function defaultMaterialVersion(item) {
  return ((item && item.riggingMaterial) || "未标注材料") + "-v1";
}
function nextSeq(db, prefix) {
  db.seq = (typeof db.seq === "number" ? db.seq : 0) + 1;
  return prefix + "-" + db.seq;
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
// 同号重传只留首次；同一模型同一桅位先到者占用，后到者保留现场测量待复核
function applyBatch(db, input, source) {
  const item = findItem(db, String(input.itemCode || input.itemId || ""));
  const operationNo = String(input.operationNo || "").trim();
  const mastPosition = String(input.mastPosition || "").trim();
  const existing = db.batches.find(b => b.operationNo === operationNo);
  if (existing) return { batch: existing, dedup: true, conflict: false };
  const at = new Date().toISOString();
  const batch = {
    id: nextSeq(db, "B"),
    itemCode: item.code || item.id,
    mastPosition,
    materialVersion: String(input.materialVersion || "").trim() || defaultMaterialVersion(item),
    operationNo,
    tension: input.tension || "",
    measuredValue: input.measuredValue ?? null,
    note: input.note || "",
    source,
    status: "有效",
    conclusionValid: true,
    handoverStatus: "未交接",
    createdAt: at,
    logs: []
  };
  const occupying = db.batches.find(b => b.itemCode === batch.itemCode && b.mastPosition === batch.mastPosition && b.status === "有效");
  let conflict = false;
  if (occupying) {
    conflict = true;
    batch.status = "待复核";
    batch.conclusionValid = false;
    batch.conflictWith = occupying.operationNo;
    batch.logs.push({ at, note: "操作号 " + occupying.operationNo + " 已占用该桅位，现场测量保留待复核" });
  } else {
    batch.logs.push({ at, note: "占用" + mastPosition + "，结论生效" });
  }
  db.batches.push(batch);
  item.logs ||= [];
  item.logs.push({ at, step: "批次", note: operationNo + " · " + mastPosition + " · " + batch.materialVersion + " · " + batch.status });
  if (item.status === "待检查") item.status = "校准中";
  return { batch, dedup: false, conflict };
}
// 材料或桅位一变，相关张力结论和交接状态失效重算
function invalidateBatches(db, predicate, reason) {
  const at = new Date().toISOString();
  const affected = [];
  for (const batch of db.batches) {
    if (batch.status === "失效" || !predicate(batch)) continue;
    batch.status = "失效";
    batch.conclusionValid = false;
    if (batch.handoverStatus === "已交接") batch.handoverStatus = "已失效";
    batch.logs.push({ at, note: reason + "，张力结论与交接状态失效，需重算" });
    for (const handover of db.handovers) {
      if (handover.batchId === batch.id && handover.status === "有效") {
        handover.status = "失效";
        handover.invalidatedAt = at;
        handover.reason = reason;
      }
    }
    affected.push(batch);
  }
  return affected;
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.ok { background:#e7f0e3; border-color:#b9cfb0; } .pill.hold { background:#fbf0dc; border-color:#e6cf9f; } .pill.dead { background:#f6e3de; border-color:#dbb3a7; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">模型档案、帆索任务与交接记录串联为校准批次</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>新增帆索任务</h2><label>选择模型</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
      <form id="batchForm" style="margin-top:14px"><h2>提交校准批次</h2><label>选择模型</label><select name="itemCode" id="batchItemSelect"></select><label>桅位</label><input name="mastPosition" required placeholder="如：前桅"><label>材料版本</label><input name="materialVersion" placeholder="留空按模型当前材料"><label>操作号</label><input name="operationNo" required placeholder="如：OP-1001"><label>松紧状态</label><input name="tension"><label>现场测量值</label><input name="measuredValue"><label>备注</label><input name="note"><button>提交批次</button></form>
      <form id="importForm" style="margin-top:14px"><h2>外部测量导入</h2><label>测量记录（JSON数组）</label><textarea name="records" placeholder='[{"itemCode":"MR-001","mastPosition":"后桅","operationNo":"OP-1002","tension":"偏紧","measuredValue":"3.1N"}]'></textarea><button>导入</button><div class="meta" style="margin-top:8px">整体校验失败不会改动现有批次，可修正后重试；同号重传只留首次。</div></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>模型档案</h2><div class="meta" style="margin-bottom:10px">创建模型后可拆分帆索任务，逐条记录松紧状态、调整备注和完成时间。</div><div class="grid" id="cards"></div></div>
      <div class="panel" style="margin-top:14px"><h2>校准批次</h2><div class="meta" style="margin-bottom:10px">每项带桅位、材料版本和操作号；同号重传只留首次；同模型同桅位先到者占用，后到者保留现场测量待复核。</div><div class="grid" id="batchCards"></div></div>
      <div class="panel" style="margin-top:14px"><h2>交接记录</h2><div class="meta" style="margin-bottom:10px">交接时记清结论按哪版材料算过；材料或桅位变更后相关记录失效。</div><div class="grid" id="handoverCards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const batchForm = document.querySelector('#batchForm');
    const importForm = document.querySelector('#importForm');
    const cards = document.querySelector('#cards');
    const batchCards = document.querySelector('#batchCards');
    const handoverCards = document.querySelector('#handoverCards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const batchItemSelect = document.querySelector('#batchItemSelect');
    let items = [];
    let batches = [];
    let handovers = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.message || data.error || '请求失败'); err.data = data; throw err; }
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      batchItemSelect.innerHTML = items.map(item => '<option value="'+(item.code || item.id)+'">'+(item.code || item.id)+' · '+(item.shipType || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      stats['有效批次'] = batches.filter(b => b.status === '有效').length;
      stats['待复核批次'] = batches.filter(b => b.status === '待复核').length;
      stats['失效批次'] = batches.filter(b => b.status === '失效').length;
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      batchCards.innerHTML = batches.map(batchCard).join('') || '<div class="meta">暂无批次</div>';
      handoverCards.innerHTML = handovers.map(handoverCard).join('') || '<div class="meta">暂无交接记录</div>';
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-material]').forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.material;
        const item = items.find(x => (x.id || x.code) === id);
        const material = prompt('新帆索材料（变更后相关批次结论与交接状态失效重算）', (item && item.riggingMaterial) || '');
        if (material && item && material !== item.riggingMaterial) { await api('/api/items/'+id, { method:'PATCH', body: JSON.stringify({ riggingMaterial: material }) }); await load(); }
      });
      document.querySelectorAll('[data-adopt]').forEach(btn => btn.onclick = async () => { await api('/api/batches/'+btn.dataset.adopt+'/review', { method:'POST', body: JSON.stringify({ action:'adopt' }) }); await load(); });
      document.querySelectorAll('[data-reject]').forEach(btn => btn.onclick = async () => { await api('/api/batches/'+btn.dataset.reject+'/review', { method:'POST', body: JSON.stringify({ action:'reject' }) }); await load(); });
      document.querySelectorAll('[data-handover]').forEach(btn => btn.onclick = async () => { await api('/api/batches/'+btn.dataset.handover+'/handover', { method:'POST', body: '{}' }); await load(); });
      document.querySelectorAll('[data-change]').forEach(btn => btn.onclick = async () => {
        const batch = batches.find(x => x.id === btn.dataset.change);
        if (!batch) return;
        const mastPosition = prompt('新桅位（留空不变）', batch.mastPosition);
        const materialVersion = prompt('新材料版本（留空不变）', batch.materialVersion);
        const patch = {};
        if (mastPosition && mastPosition !== batch.mastPosition) patch.mastPosition = mastPosition;
        if (materialVersion && materialVersion !== batch.materialVersion) patch.materialVersion = materialVersion;
        if (Object.keys(patch).length) { await api('/api/batches/'+batch.id, { method:'PATCH', body: JSON.stringify(patch) }); alert('已变更，原张力结论与交接状态失效，需重新提交批次重算'); await load(); }
      });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><div class="actions"><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><button class="secondary" data-material="'+(item.id || item.code)+'">换材料</button></div><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function batchCard(b) {
      const cls = b.status === '有效' ? 'ok' : b.status === '待复核' ? 'hold' : 'dead';
      const hCls = b.handoverStatus === '已交接' ? 'ok' : b.handoverStatus === '已失效' ? 'dead' : '';
      const conflict = b.status === '待复核' && b.conflictWith ? '<div class="warn">与操作号 '+b.conflictWith+' 占用同一桅位，现场测量已保留待复核</div>' : '';
      const actions = [];
      if (b.status === '待复核') {
        actions.push('<button data-adopt="'+b.id+'">复核通过</button>');
        actions.push('<button class="secondary" data-reject="'+b.id+'">复核驳回</button>');
      }
      if (b.status === '有效' && b.handoverStatus === '未交接') actions.push('<button data-handover="'+b.id+'">生成交接</button>');
      if (b.status === '有效') actions.push('<button class="secondary" data-change="'+b.id+'">变更桅位/材料</button>');
      const logs = (b.logs || []).slice(-3).map(l => '<div>'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+b.operationNo+' · '+b.itemCode+'</h3>'
        + '<div><span class="pill '+cls+'">'+b.status+'</span> <span class="pill '+hCls+'">交接：'+b.handoverStatus+'</span></div>'
        + '<div><b>桅位</b> '+b.mastPosition+' · <b>材料版本</b> '+b.materialVersion+'</div>'
        + '<div><b>张力</b> '+(b.tension || '—')+' · <b>测量值</b> '+(b.measuredValue ?? '—')+(b.conclusionValid ? '' : ' <span class="warn">结论未生效</span>')+'</div>'
        + '<div class="meta">来源 '+(b.source === 'import' ? '外部导入' : '手动提交')+' · '+(b.createdAt || '').slice(0,19).replace('T',' ')+'</div>'
        + conflict
        + (actions.length ? '<div class="actions">'+actions.join('')+'</div>' : '')
        + '<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function handoverCard(h) {
      const cls = h.status === '有效' ? 'ok' : 'dead';
      return '<article class="card"><h3>'+h.id+' · '+h.itemCode+'</h3>'
        + '<span class="pill '+cls+'">'+h.status+'</span>'
        + '<div><b>桅位</b> '+h.mastPosition+' · <b>材料版本</b> '+h.materialVersion+'</div>'
        + '<div><b>张力结论</b> '+(h.tension || '—')+' · <b>操作号</b> '+h.operationNo+'</div>'
        + '<div class="meta">交接时间 '+(h.at || '').slice(0,19).replace('T',' ')+(h.reason ? ' · '+h.reason : '')+'</div></article>';
    }
    async function load() {
      const results = await Promise.all([api('/api/items'), api('/api/batches'), api('/api/handovers')]);
      items = results[0]; batches = results[1]; handovers = results[2];
      render();
    }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    batchForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(batchForm).entries());
      if (!data.materialVersion) delete data.materialVersion;
      try {
        const res = await api('/api/batches', { method:'POST', body: JSON.stringify(data) });
        if (res.dedup) alert('操作号已存在，同号重传只留首次');
        else if (res.conflict) alert('该桅位已被操作号 ' + res.batch.conflictWith + ' 占用，本次现场测量保留为待复核');
        batchForm.reset();
        await load();
      } catch (err) { alert(err.message); }
    };
    importForm.onsubmit = async event => {
      event.preventDefault();
      const raw = new FormData(importForm).get('records');
      let payload;
      try { payload = JSON.parse(raw); } catch { alert('JSON 解析失败，原批次未改动，可修正后重试'); return; }
      try {
        const res = await api('/api/batches/import', { method:'POST', body: JSON.stringify(Array.isArray(payload) ? { records: payload } : payload) });
        alert('导入完成：新增 ' + res.created + ' 条，同号留首 ' + res.dedup + ' 条，待复核 ' + res.conflict + ' 条');
        importForm.reset();
        await load();
      } catch (err) {
        const details = err.data && err.data.details ? '\\n' + err.data.details.join('\\n') : '';
        alert('导入失败：' + err.message + details);
      }
    };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }] };
      item.tasks = [];
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, decodeURIComponent(patch[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const before = item.riggingMaterial;
      Object.assign(item, input);
      item.logs ||= [];
      const at = new Date().toISOString();
      item.logs.push({ at, step: "状态", note: "更新为" + item.status });
      if (input.riggingMaterial && input.riggingMaterial !== before) {
        const keys = [item.code, item.id].filter(Boolean);
        const affected = invalidateBatches(db, b => keys.includes(b.itemCode), "材料由" + (before || "未标注") + "变更为" + input.riggingMaterial);
        item.logs.push({ at, step: "材料", note: "材料变更，" + affected.length + " 个批次结论失效待重算" });
      }
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(log[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = findItem(db, decodeURIComponent(action[1]));
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.tasks ||= [];
      item.tasks.push({ id: "T-" + Date.now(), position: input.position, tension: input.tension, status: "待检查", logs: [{ at: new Date().toISOString(), note: input.note || "新增帆索任务" }] });
      item.status = "校准中";
      item.logs.push({ at: new Date().toISOString(), step: "帆索", note: input.position + " · " + input.tension });
      await saveDb(db);
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/api/batches") {
      return send(res, 200, db.batches.map(b => {
        const item = findItem(db, b.itemCode);
        return { ...b, shipType: (item && item.shipType) || "" };
      }));
    }
    if (req.method === "POST" && url.pathname === "/api/batches") {
      const input = await body(req);
      const item = findItem(db, String(input.itemCode || input.itemId || ""));
      if (!item) return send(res, 404, { error: "item_not_found", message: "模型不存在" });
      const missing = [];
      if (!String(input.mastPosition || "").trim()) missing.push("桅位");
      if (!String(input.operationNo || "").trim()) missing.push("操作号");
      if (missing.length) return send(res, 400, { error: "missing_fields", fields: missing, message: "缺少字段：" + missing.join("、") });
      const result = applyBatch(db, input, "manual");
      if (!result.dedup) await saveDb(db);
      return send(res, result.dedup ? 200 : 201, result);
    }
    // 外部测量导入：先整体校验再落库，失败保留原批次，可修正后重试
    if (req.method === "POST" && url.pathname === "/api/batches/import") {
      const input = await body(req).catch(() => null);
      if (input === null || input === undefined) {
        return send(res, 400, { error: "invalid_json", message: "导入内容不是有效JSON，原批次已保留", kept: db.batches.length });
      }
      const records = Array.isArray(input) ? input : input.records;
      if (!Array.isArray(records) || records.length === 0) {
        return send(res, 400, { error: "records_required", message: "没有可导入的测量记录，原批次已保留", kept: db.batches.length });
      }
      const errors = [];
      records.forEach((record, index) => {
        const no = "第" + (index + 1) + "条";
        if (!record || typeof record !== "object" || Array.isArray(record)) { errors.push(no + "不是有效记录"); return; }
        if (!findItem(db, String(record.itemCode || record.itemId || ""))) errors.push(no + "模型不存在");
        if (!String(record.mastPosition || "").trim()) errors.push(no + "缺桅位");
        if (!String(record.operationNo || "").trim()) errors.push(no + "缺操作号");
      });
      if (errors.length) {
        return send(res, 400, { error: "import_failed", message: "校验失败，原批次已保留，可修正后重试", details: errors, kept: db.batches.length });
      }
      const work = JSON.parse(JSON.stringify(db));
      const results = records.map(record => applyBatch(work, record, "import"));
      await saveDb(work);
      return send(res, 201, {
        created: results.filter(r => !r.dedup).length,
        dedup: results.filter(r => r.dedup).length,
        conflict: results.filter(r => r.conflict).length,
        results: results.map(r => ({ operationNo: r.batch.operationNo, status: r.batch.status, dedup: r.dedup, conflict: r.conflict }))
      });
    }
    const review = url.pathname.match(/^\/api\/batches\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      const batch = db.batches.find(b => b.id === review[1]);
      if (!batch) return send(res, 404, { error: "batch_not_found" });
      if (batch.status !== "待复核") return send(res, 409, { error: "not_pending", message: "只有待复核批次需要复核" });
      const input = await body(req);
      const at = new Date().toISOString();
      if (input.action === "adopt") {
        const current = db.batches.find(b => b !== batch && b.itemCode === batch.itemCode && b.mastPosition === batch.mastPosition && b.status === "有效");
        if (current) {
          current.status = "失效";
          current.conclusionValid = false;
          if (current.handoverStatus === "已交接") current.handoverStatus = "已失效";
          current.logs.push({ at, note: "复核后由操作号 " + batch.operationNo + " 取代，原结论失效" });
          for (const handover of db.handovers) {
            if (handover.batchId === current.id && handover.status === "有效") {
              handover.status = "失效";
              handover.invalidatedAt = at;
              handover.reason = "复核替换为 " + batch.operationNo;
            }
          }
        }
        batch.status = "有效";
        batch.conclusionValid = true;
        batch.reviewedAt = at;
        batch.logs.push({ at, note: "复核通过，占用" + batch.mastPosition + "，结论生效" });
      } else {
        batch.status = "失效";
        batch.conclusionValid = false;
        batch.reviewedAt = at;
        batch.logs.push({ at, note: "复核驳回，现场测量仅留档" });
      }
      const item = findItem(db, batch.itemCode);
      if (item) { item.logs ||= []; item.logs.push({ at, step: "复核", note: batch.operationNo + " · " + (input.action === "adopt" ? "通过" : "驳回") }); }
      await saveDb(db);
      return send(res, 200, batch);
    }
    const handover = url.pathname.match(/^\/api\/batches\/([^/]+)\/handover$/);
    if (handover && req.method === "POST") {
      const batch = db.batches.find(b => b.id === handover[1]);
      if (!batch) return send(res, 404, { error: "batch_not_found" });
      if (batch.status !== "有效" || !batch.conclusionValid) return send(res, 409, { error: "batch_not_valid", message: "只有结论生效的批次才能交接" });
      if (batch.handoverStatus === "已交接") return send(res, 409, { error: "already_handed_over", message: "该批次已交接" });
      const at = new Date().toISOString();
      const record = {
        id: nextSeq(db, "H"),
        batchId: batch.id,
        itemCode: batch.itemCode,
        mastPosition: batch.mastPosition,
        materialVersion: batch.materialVersion,
        operationNo: batch.operationNo,
        tension: batch.tension,
        measuredValue: batch.measuredValue,
        status: "有效",
        at
      };
      db.handovers.push(record);
      batch.handoverStatus = "已交接";
      batch.logs.push({ at, note: "已交接船厂，结论按材料版本 " + batch.materialVersion + " 存档" });
      const item = findItem(db, batch.itemCode);
      if (item) { item.logs ||= []; item.logs.push({ at, step: "交接", note: batch.operationNo + " · " + batch.mastPosition + " · " + batch.materialVersion }); }
      await saveDb(db);
      return send(res, 201, record);
    }
    const batchPatch = url.pathname.match(/^\/api\/batches\/([^/]+)$/);
    if (batchPatch && req.method === "PATCH") {
      const batch = db.batches.find(b => b.id === batchPatch[1]);
      if (!batch) return send(res, 404, { error: "batch_not_found" });
      const input = await body(req);
      const changes = [];
      if (input.mastPosition && input.mastPosition !== batch.mastPosition) {
        changes.push("桅位由" + batch.mastPosition + "变更为" + input.mastPosition);
        batch.mastPosition = input.mastPosition;
      }
      if (input.materialVersion && input.materialVersion !== batch.materialVersion) {
        changes.push("材料版本由" + batch.materialVersion + "变更为" + input.materialVersion);
        batch.materialVersion = input.materialVersion;
      }
      if (changes.length && batch.status !== "失效") {
        const at = new Date().toISOString();
        batch.status = "失效";
        batch.conclusionValid = false;
        if (batch.handoverStatus === "已交接") batch.handoverStatus = "已失效";
        batch.logs.push({ at, note: changes.join("；") + "，张力结论与交接状态失效，需重算" });
        for (const record of db.handovers) {
          if (record.batchId === batch.id && record.status === "有效") {
            record.status = "失效";
            record.invalidatedAt = at;
            record.reason = changes.join("；");
          }
        }
        const item = findItem(db, batch.itemCode);
        if (item) { item.logs ||= []; item.logs.push({ at, step: "失效", note: batch.operationNo + " · " + changes.join("；") }); }
      }
      await saveDb(db);
      return send(res, 200, batch);
    }
    if (req.method === "GET" && url.pathname === "/api/handovers") return send(res, 200, db.handovers);
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const batches = Object.fromEntries(batchStatuses.map(s => [s, db.batches.filter(b => b.status === s).length]));
      return send(res, 200, { items: computeStats(db.items), batches, handovers: db.handovers.length });
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
}

// 请求串行处理：同一模型同一桅位同时提交时，先到者占用
let queue = Promise.resolve();
const server = http.createServer((req, res) => {
  queue = queue.then(() => handle(req, res)).catch(error => {
    if (!res.headersSent) send(res, 500, { error: error.message });
  });
});
server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
