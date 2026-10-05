import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server, base, dir, dbFile;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "calib-"));
  dbFile = join(dir, "test.json");
  process.env.DB_PATH = dbFile;
  const mod = await import("../server.js");
  server = mod.server;
  await new Promise(resolve => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function api(path, options) {
  const res = await fetch(base + path, {
    ...(options || {}),
    headers: { "Content-Type": "application/json", ...((options && options.headers) || {}) }
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function createModel(code, extra = {}) {
  const { status, data } = await api("/api/items", {
    method: "POST",
    body: JSON.stringify({ code, shipType: "福船", scale: "1:48", mastCount: 3, riggingMaterial: "蜡线", owner: "测试", dueDate: "2026-07-01", ...extra })
  });
  assert.equal(status, 201);
  return data;
}

test("旧记录缺字段时补全后仍能读回：桅位、材料版本、操作号", async () => {
  // 首次读取触发 seed 落盘 + 补全
  const { data: items } = await api("/api/items");
  const seed = items.find(i => i.code === "MR-001");
  assert.ok(seed, "seed 模型存在");
  assert.ok(seed.materialVersion, "材料版本已补全");
  for (const t of seed.tasks) {
    assert.ok(t.mastPosition, "桅位已补全");
    assert.ok(t.materialVersion, "任务材料版本已补全");
    assert.ok(t.operationNo, "操作号已补全");
  }
  // 落盘的文件也应带补全字段
  const raw = JSON.parse(await readFile(dbFile, "utf8"));
  const rawSeed = raw.items.find(i => i.code === "MR-001");
  assert.ok(rawSeed.materialVersion);
  assert.ok(rawSeed.tasks.every(t => t.mastPosition && t.materialVersion && t.operationNo));
});

test("每项带桅位、材料版本、操作号", async () => {
  const item = await createModel("MR-FIELD");
  const { status, data } = await api(`/api/items/${item.id}/calibrate`, {
    method: "POST",
    body: JSON.stringify({ mastPosition: "前桅侧支索", operationNo: "OP-FIELD-1", materialVersion: "v1", tension: "0.5" })
  });
  assert.equal(status, 201);
  const b = data.batch;
  assert.equal(b.mastPosition, "前桅侧支索");
  assert.equal(b.materialVersion, "v1");
  assert.equal(b.operationNo, "OP-FIELD-1");
  assert.equal(b.status, "生效");
  assert.ok(["合格", "不合格", "待定"].includes(b.tensionConclusion));
});

test("同号重传只留首次", async () => {
  const item = await createModel("MR-DUP");
  const first = await api(`/api/items/${item.id}/calibrate`, {
    method: "POST",
    body: JSON.stringify({ mastPosition: "前桅侧支索", operationNo: "OP-DUP-1", tension: "0.5" })
  });
  assert.equal(first.status, 201);
  const second = await api(`/api/items/${item.id}/calibrate`, {
    method: "POST",
    body: JSON.stringify({ mastPosition: "前桅侧支索", operationNo: "OP-DUP-1", tension: "0.9" })
  });
  assert.equal(second.status, 200, "重传返回 200 而非新建");
  assert.equal(second.data.batch.id, first.data.batch.id, "同号返回同一批次");
  assert.equal(second.data.batch.measurements[0].value, 0.5, "首次测量值保留，未被覆盖");
  const { data: batches } = await api("/api/batches");
  const same = batches.filter(b => b.operationNo === "OP-DUP-1");
  assert.equal(same.length, 1, "同号全局只留一条");
});

test("同一模型同一桅位同时提交：先到者占用，后到者保留现场测量等复核", async () => {
  const item = await createModel("MR-RACE");
  const a = await api(`/api/items/${item.id}/calibrate`, {
    method: "POST",
    body: JSON.stringify({ mastPosition: "前桅侧支索", operationNo: "OP-RACE-1", tension: "0.5" })
  });
  assert.equal(a.status, 201);
  assert.equal(a.data.batch.status, "生效");
  const b = await api(`/api/items/${item.id}/calibrate`, {
    method: "POST",
    body: JSON.stringify({ mastPosition: "前桅侧支索", operationNo: "OP-RACE-2", tension: "0.6" })
  });
  assert.equal(b.status, 202, "后到者返回 202 待复核");
  assert.equal(b.data.batch.status, "待复核");
  assert.equal(b.data.occupied, true);
  assert.equal(b.data.batch.measurements[0].value, 0.6, "后到现场测量被保留");
  const { data: batches } = await api(`/api/batches?model=${item.id}`);
  const active = batches.filter(x => x.mastPosition === "前桅侧支索" && x.status === "生效");
  const pending = batches.filter(x => x.mastPosition === "前桅侧支索" && x.status === "待复核");
  assert.equal(active.length, 1, "桅位只有一个生效占用者");
  assert.equal(pending.length, 1, "后到者进入待复核");
});

test("材料变更：张力结论与交接状态失效重算", async () => {
  const item = await createModel("MR-MAT");
  const c = await api(`/api/items/${item.id}/calibrate`, {
    method: "POST",
    body: JSON.stringify({ mastPosition: "前桅侧支索", operationNo: "OP-MAT-1", tension: "0.5" })
  });
  assert.equal(c.status, 201);
  // 先交接
  const h = await api(`/api/batches/${c.data.batch.id}/handover`, { method: "POST", body: JSON.stringify({ by: "周宁" }) });
  assert.equal(h.status, 200);
  assert.equal(h.data.batch.handoverStatus, "已交接");
  // 变更材料
  const m = await api(`/api/items/${item.id}/material`, { method: "POST", body: JSON.stringify({ riggingMaterial: "尼龙线" }) });
  assert.equal(m.status, 200);
  assert.equal(m.data.riggingMaterial, "尼龙线");
  assert.equal(m.data.materialVersion, "v2", "材料版本递增");
  const { data: batches } = await api(`/api/batches?model=${item.id}`);
  const b = batches.find(x => x.id === c.data.batch.id);
  assert.equal(b.status, "已失效", "批次失效");
  assert.equal(b.handoverStatus, "交接失效", "交接状态失效");
  assert.equal(b.materialVersion, "v2", "材料版本已更新");
  assert.ok(b.invalidReason, "记录失效原因");
  // 失效后不能直接交接
  const h2 = await api(`/api/batches/${b.id}/handover`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(h2.status, 409, "失效批次交接被拒绝");
  // 重算后恢复
  const r = await api(`/api/batches/${b.id}/recompute`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.data.batch.status, "生效");
  assert.equal(r.data.batch.handoverStatus, "未交接", "重算后交接回到未交接，需重做");
});

test("桅位变更：相关张力结论与交接状态失效重算", async () => {
  const item = await createModel("MR-POS");
  const c = await api(`/api/items/${item.id}/calibrate`, {
    method: "POST",
    body: JSON.stringify({ mastPosition: "前桅侧支索", operationNo: "OP-POS-1", tension: "0.5" })
  });
  const taskId = c.data.batch.taskId;
  await api(`/api/batches/${c.data.batch.id}/handover`, { method: "POST", body: JSON.stringify({}) });
  const p = await api(`/api/items/${item.id}/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ mastPosition: "后桅升帆索" })
  });
  assert.equal(p.status, 200);
  const { data: batches } = await api(`/api/batches?model=${item.id}`);
  const b = batches.find(x => x.id === c.data.batch.id);
  assert.equal(b.mastPosition, "后桅升帆索");
  assert.equal(b.status, "已失效");
  assert.equal(b.handoverStatus, "交接失效");
});

test("外部测量导入失败后保留原批次再重试", async () => {
  const item = await createModel("MR-IMP");
  // 先有一个原批次
  const orig = await api(`/api/items/${item.id}/calibrate`, {
    method: "POST",
    body: JSON.stringify({ mastPosition: "前桅侧支索", operationNo: "OP-ORIG-1", tension: "0.5" })
  });
  assert.equal(orig.status, 201);
  // 导入含无效行（缺桅位）→ 失败，原批次保留
  const bad = await api("/api/import/measurements", {
    method: "POST",
    body: JSON.stringify({ measurements: [{ modelCode: item.code, value: 0.4 }] })
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, "import_failed");
  const { data: afterFail } = await api(`/api/batches?model=${item.id}`);
  assert.equal(afterFail.length, 1, "失败后批次数量不变");
  assert.equal(afterFail[0].id, orig.data.batch.id, "原批次保留");
  // 重试修正后的数据 → 成功
  const good = await api("/api/import/measurements", {
    method: "POST",
    body: JSON.stringify({ measurements: [{ modelCode: item.code, mastPosition: "前桅侧支索", value: 0.4, operationNo: "OP-IMP-1" }] })
  });
  assert.equal(good.status, 200);
  assert.equal(good.data.imported, 1);
  // 同号重传导入 → 只留首次
  const again = await api("/api/import/measurements", {
    method: "POST",
    body: JSON.stringify({ measurements: [{ modelCode: item.code, mastPosition: "前桅侧支索", value: 0.9, operationNo: "OP-IMP-1" }] })
  });
  assert.equal(again.status, 200);
  assert.equal(again.data.results[0].duplicated, true, "导入同号重传只留首次");
  const { data: batches } = await api(`/api/batches?model=${item.id}`);
  const same = batches.filter(b => b.operationNo === "OP-IMP-1");
  assert.equal(same.length, 1);
  assert.equal(same[0].measurements[0].value, 0.4, "首次导入值保留");
});

test("导入失败不产生任何写入（原子性）", async () => {
  const item = await createModel("MR-ATOM");
  const before = (await api(`/api/batches?model=${item.id}`)).data.length;
  const bad = await api("/api/import/measurements", {
    method: "POST",
    body: JSON.stringify({
      measurements: [
        { modelCode: item.code, mastPosition: "前桅侧支索", value: 0.4, operationNo: "OP-ATOM-1" },
        { modelCode: "NOT-EXIST", mastPosition: "前桅侧支索", value: 0.4 }
      ]
    })
  });
  assert.equal(bad.status, 400);
  const after = (await api(`/api/batches?model=${item.id}`)).data.length;
  assert.equal(after, before, "整批校验失败时不写入任何批次");
});
