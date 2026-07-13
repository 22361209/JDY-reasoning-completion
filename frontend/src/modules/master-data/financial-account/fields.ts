import type { MasterDataField } from "../types";

const bankAccountTypes = ["BANK", "DEPOSIT"];

export const financialAccountMasterFields: MasterDataField[] = [
  { name: "systemNo", label: "系统编号", placeholder: "保存后自动生成", section: "基本信息", readonly: true },
  { name: "code", label: "账户编码", placeholder: "如 ZH-001", section: "基本信息", required: true, readonlyWhenEditing: true },
  { name: "name", label: "账户名称", placeholder: "如 基本户、现金账户", section: "基本信息", required: true },
  {
    name: "accountType",
    label: "账户类型",
    section: "基本信息",
    required: true,
    defaultValue: "CASH",
    options: [
      { value: "CASH", label: "现金 / CASH" },
      { value: "BANK", label: "银行账户 / BANK" },
      { value: "DEPOSIT", label: "存款账户 / DEPOSIT" }
    ]
  },
  {
    name: "currency",
    label: "币种",
    section: "基本信息",
    required: true,
    defaultValue: "CNY",
    options: [
      { value: "CNY", label: "人民币 / CNY" },
      { value: "USD", label: "美元 / USD" }
    ]
  },
  {
    name: "bankName",
    label: "开户行",
    placeholder: "BANK/DEPOSIT 必填",
    section: "银行信息",
    visibleWhen: { field: "accountType", values: bankAccountTypes },
    requiredWhen: { field: "accountType", values: bankAccountTypes },
    clearWhenHidden: true
  },
  {
    name: "accountNo",
    label: "账号",
    placeholder: "按字符串保存，保留前导零",
    section: "银行信息",
    visibleWhen: { field: "accountType", values: bankAccountTypes },
    requiredWhen: { field: "accountType", values: bankAccountTypes },
    clearWhenHidden: true
  },
  {
    name: "accountHolder",
    label: "户名",
    placeholder: "BANK/DEPOSIT 必填",
    section: "银行信息",
    visibleWhen: { field: "accountType", values: bankAccountTypes },
    requiredWhen: { field: "accountType", values: bankAccountTypes },
    clearWhenHidden: true
  },
  { name: "status", label: "状态", section: "状态", options: ["启用", "禁用"], readonlyWhenEditing: true },
  { name: "remark", label: "备注", placeholder: "账户用途说明；不在此维护余额或汇率", section: "状态", type: "textarea", span: 2 }
];
