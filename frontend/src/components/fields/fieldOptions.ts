import type { FieldOption } from "./types";

export function fieldOptionValue(option: FieldOption | undefined) {
  if (option === undefined) {
    return "";
  }
  return typeof option === "string" ? option : option.value;
}

export function fieldOptionLabel(option: FieldOption | undefined) {
  if (option === undefined) {
    return "";
  }
  return typeof option === "string" ? option : option.label;
}
