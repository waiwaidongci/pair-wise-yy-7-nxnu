# 古船模型帆索校准

运行：

```bash
npm start
```

访问`http://localhost:3038`。数据保存在`data/model-rigging-calibration.json`。

## 校准批次

模型档案、帆索任务和交接记录串联为校准批次，每项批次带桅位、材料版本和操作号：

- `POST /api/batches` 提交批次：同号重传只留首次；同一模型同一桅位同时提交时先到者占用，后到者保留现场测量待复核。
- `POST /api/batches/import` 外部测量导入：整体校验通过才落库，失败保留原批次，可修正后重试。
- `POST /api/batches/:id/review` 复核待复核批次（`adopt` 通过并取代原占用 / `reject` 驳回留档）。
- `POST /api/batches/:id/handover` 生成交接记录，记清结论按哪版材料算过。
- `PATCH /api/items/:id`（换材料）或 `PATCH /api/batches/:id`（改桅位/材料版本）后，相关张力结论和交接状态失效重算。
- 旧记录缺字段时读取即自动补全（桅位、材料版本、操作号等），补全后仍能读回。
