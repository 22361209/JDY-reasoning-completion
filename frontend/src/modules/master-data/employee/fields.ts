import type { MasterDataField } from "../types";

export const employeeMasterFields: MasterDataField[] = [
  { name: "systemNo", label: "系统编号", placeholder: "保存后自动生成", section: "基本信息", readonly: true },
  { name: "code", label: "员工编码", placeholder: "如 YG-001", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "员工姓名", placeholder: "输入员工姓名", section: "基本信息", required: true },
  { name: "position", label: "岗位", placeholder: "如 仓管员、采购员", section: "基本信息" },
  { name: "department", label: "部门", placeholder: "可选文本，不限于生产车间", section: "基本信息" },
  { name: "phone", label: "手机", placeholder: "可选", section: "联系方式" },
  { name: "email", label: "邮箱", placeholder: "可选", section: "联系方式" },
  { name: "status", label: "状态", section: "状态", options: ["启用", "禁用"], readonlyWhenEditing: true },
  { name: "remark", label: "备注", placeholder: "员工职责或业务说明", section: "状态", type: "textarea", span: 2 }
];
