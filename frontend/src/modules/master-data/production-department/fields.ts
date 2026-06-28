import type { MasterDataField } from "../types";

export const productionDepartmentFields: MasterDataField[] = [
  { name: "systemNo", label: "系统编号", placeholder: "保存后自动生成", section: "基本信息", readonly: true, defaultValue: "保存后生成" },
  { name: "code", label: "部门编码", placeholder: "如 HJ", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "部门名称", placeholder: "如 焊接车间", section: "基本信息", required: true },
  { name: "manager", label: "负责人", placeholder: "默认负责人", section: "基本信息" },
  { name: "status", label: "状态", section: "基本信息", options: ["启用", "禁用"] },
  { name: "remark", label: "备注", placeholder: "生产计划、任务和委外交接用途说明", section: "基本信息", type: "textarea", span: 2 }
];
