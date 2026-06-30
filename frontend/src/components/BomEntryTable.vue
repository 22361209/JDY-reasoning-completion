<template>
  <div class="entry-tools">
    <button type="button" data-testid="bom-entry-column-settings" @click="columnDialogOpen = true">列设置</button>
  </div>
  <TableCore
    kind="entry"
    test-id="bom-entry-table-core"
    frame-class="entry-table bom-entry-table"
    table-class="entry-native-table"
    :columns="visibleBomEntryColumns"
    :rows="lines"
    :min-width="1280"
    :max-resize-width="420"
    :row-visible="rowMatchesFilters"
    :row-attrs="bomRowAttrs"
    :cell-attrs="bomCellAttrs"
    :row-draggable="false"
    @column-resize="resizeBomColumn"
  >
    <template #header-cell="{ column, startResize }">
      <TableCoreHeaderCell
        :title="column.title"
        :column-key="column.key"
        :test-id="`bom-column-drag-${column.key}`"
        :filter-test-id="`bom-column-filter-${column.key}`"
        :resize-test-id="`bom-column-resize-${column.key}`"
        :filterable="column.key !== 'rowNo'"
        :filter-active="isFilterActive(column.key)"
        :resizable="column.resizable !== false"
        @filter="openBomColumnFilter(column, $event)"
        @resize-start="startResize(column, $event)"
      />
    </template>
    <template #cell="{ row: line, column, rowIndex }">
      <span v-if="column.key === 'rowNo'" class="entry-row-no">
        <span class="entry-row-no__value">{{ rowIndex + 1 }}</span>
        <span class="entry-row-no__quick-actions">
          <button
            type="button"
            :disabled="!isDraft"
            :data-testid="`bom-line-insert-${rowIndex + 1}`"
            title="在下方新增子件"
            @click.stop="emit('insertLineAfter', rowIndex)"
          >+</button>
          <button
            type="button"
            :disabled="!isDraft || lines.length <= 1"
            :data-testid="`bom-line-delete-${rowIndex + 1}`"
            title="删除本行"
            @click.stop="emit('removeLine', rowIndex)"
          >-</button>
        </span>
      </span>
      <span v-else-if="column.key === 'materialCode'" class="master-selector in-cell">
        <input
          v-model.trim="line.materialCode"
          :disabled="!isDraft"
          :data-testid="`bom-line-material-${rowIndex + 1}`"
          @focus="openMaterialLookup(rowIndex)"
          @input="handleMaterialInput(line, rowIndex)"
          @keydown.down.prevent="moveMaterialLookup(1)"
          @keydown.up.prevent="moveMaterialLookup(-1)"
          @keydown.enter.prevent="confirmMaterialLookup(line, rowIndex)"
          @blur="closeMaterialLookupLater"
        />
        <span v-if="activeMaterialLookupIndex === rowIndex" class="master-selector__menu">
          <button
            v-for="(option, optionIndex) in filteredMaterialOptions(line.materialCode)"
            :key="option.code"
            type="button"
            :class="{ selected: optionIndex === materialLookupCursor }"
            @mousedown.prevent="selectLineMaterial(line, option)"
          >
            <strong>{{ option.code }}</strong>
            <span>{{ option.name }}</span>
          </button>
          <em v-if="filteredMaterialOptions(line.materialCode).length === 0">没有匹配物料</em>
        </span>
      </span>
      <span v-else-if="column.key === 'materialName'" class="entry-cell-value">{{ line.materialName }}</span>
      <span v-else-if="column.key === 'spec'" class="entry-cell-value">{{ line.spec }}</span>
      <span v-else-if="column.key === 'unit'" class="entry-cell-value">{{ line.unit }}</span>
      <input v-else-if="column.key === 'productQty'" v-model.number="line.productQty" :disabled="!isDraft" type="number" min="0" step="0.01" @input="updateUnitQty(line)" />
      <input v-else-if="column.key === 'materialQty'" v-model.number="line.materialQty" :disabled="!isDraft" :data-testid="`bom-line-qty-${rowIndex + 1}`" type="number" min="0" step="0.01" @input="updateUnitQty(line)" />
      <input v-else-if="column.key === 'unitQty'" v-model.number="line.unitQty" :disabled="!isDraft" type="number" min="0" step="0.0001" @input="emit('markDirty')" />
      <select v-else-if="column.key === 'issueMethod'" v-model="line.issueMethod" :disabled="!isDraft" @change="emit('markDirty')">
        <option>按单领料</option>
        <option>倒冲领料</option>
        <option>不领料</option>
      </select>
      <input v-else-if="column.key === 'issueWarehouseCode'" v-model.trim="line.issueWarehouseCode" :disabled="!isDraft" placeholder="默认取物料仓库" @input="emit('markDirty')" />
      <input v-else-if="column.key === 'fixedLossQty'" v-model.number="line.fixedLossQty" :disabled="!isDraft" type="number" min="0" step="0.01" @input="emit('markDirty')" />
      <input v-else-if="column.key === 'lossRate'" v-model.number="line.lossRate" :disabled="!isDraft" type="number" min="0" step="0.01" @input="emit('markDirty')" />
      <input v-else-if="column.key === 'childBomCode'" v-model.trim="line.childBomCode" :disabled="!isDraft" placeholder="可空" @input="emit('markDirty')" />
    </template>
  </TableCore>

  <ColumnSettingsDialog
    :open="columnDialogOpen"
    title="列设置"
    :columns="configurableBomEntryColumns"
    dialog-test-id="bom-entry-column-settings-dialog"
    ok-test-id="bom-entry-column-settings-ok"
    @reset="resetBomColumns"
    @confirm="columnDialogOpen = false"
  />

  <ColumnFilterPopover
    :open="filterDialogOpen && Boolean(activeFilterColumn)"
    :operators="tableFilterOperators"
    :operator="activeFilterOperator"
    :value="activeFilterValue"
    :left="filterPopoverLeft"
    :top="filterPopoverTop"
    test-id="bom-entry-column-filter-dialog"
    @update:operator="activeFilterOperator = $event"
    @update:value="activeFilterValue = $event"
    @apply="applyColumnFilter"
    @clear="clearColumnFilter"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import ColumnFilterPopover from "./table/ColumnFilterPopover.vue";
import ColumnSettingsDialog from "./table/ColumnSettingsDialog.vue";
import TableCore, { type TableCoreColumn } from "./table/TableCore.vue";
import TableCoreHeaderCell from "./table/TableCoreHeaderCell.vue";
import { tableFilterOperators, useColumnFilters } from "./table/useColumnFilters";

export interface BomEntryLine {
  localId: string;
  materialCode: string;
  materialName: string;
  spec: string;
  unit: string;
  productQty: number;
  materialQty: number;
  unitQty: number;
  issueMethod: string;
  issueWarehouseCode: string;
  fixedLossQty: number;
  lossRate: number;
  childBomCode: string;
  childBomVersionNo: string;
}

export interface BomMaterialOption {
  code: string;
  name: string;
  spec: string;
  unit: string;
  defaultWarehouseCode: string;
  searchText: string;
}

interface BomEntryColumn extends TableCoreColumn {
  visible: boolean;
  configurable?: boolean;
}

const props = defineProps<{
  lines: BomEntryLine[];
  isDraft: boolean;
  materialOptions: BomMaterialOption[];
}>();

const emit = defineEmits<{
  markDirty: [];
  insertLineAfter: [index: number];
  removeLine: [index: number];
}>();

const activeMaterialLookupIndex = ref<number | null>(null);
const materialLookupCursor = ref(0);
const columnDialogOpen = ref(false);
const lines = computed(() => props.lines);
const isDraft = computed(() => props.isDraft);
const defaultBomEntryColumns: BomEntryColumn[] = [
  { key: "rowNo", title: "序号", width: 48, minWidth: 48, fixed: "left", align: "center", resizable: false, visible: true, configurable: false, headerClass: "entry-row-no-cell entry-frozen-cell", cellClass: "entry-row-no-cell entry-frozen-cell" },
  { key: "materialCode", title: "子件物料编码", width: 150, minWidth: 96, visible: true },
  { key: "materialName", title: "物料名称", width: 170, minWidth: 96, visible: true },
  { key: "spec", title: "规格型号", width: 150, minWidth: 96, visible: true },
  { key: "unit", title: "单位", width: 76, minWidth: 64, visible: true },
  { key: "productQty", title: "母件数量", width: 104, minWidth: 84, align: "right", visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "materialQty", title: "子件数量", width: 104, minWidth: 84, align: "right", visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "unitQty", title: "单位用量", width: 104, minWidth: 84, align: "right", visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "issueMethod", title: "领料方式", width: 118, minWidth: 96, visible: true },
  { key: "issueWarehouseCode", title: "发料仓库", width: 130, minWidth: 96, visible: true },
  { key: "fixedLossQty", title: "固定损耗", width: 104, minWidth: 84, align: "right", visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "lossRate", title: "损耗率%", width: 98, minWidth: 80, align: "right", visible: true, headerClass: "entry-number-cell", cellClass: "entry-number-cell" },
  { key: "childBomCode", title: "子件BOM", width: 136, minWidth: 96, visible: true }
];
const bomEntryColumns = ref<BomEntryColumn[]>(defaultBomEntryColumns.map((column) => ({ ...column })));
const visibleBomEntryColumns = computed(() => bomEntryColumns.value.filter((column) => column.visible));
const configurableBomEntryColumns = computed(() => bomEntryColumns.value.filter((column) => column.configurable !== false));
const {
  activeFilterColumn,
  filterDialogOpen,
  activeFilterOperator,
  activeFilterValue,
  filterPopoverLeft,
  filterPopoverTop,
  openColumnFilter,
  applyColumnFilter,
  clearColumnFilter,
  rowMatchesFilters,
  isFilterActive
} = useColumnFilters<BomEntryColumn>(bomEntryColumnValue);

function resizeBomColumn(payload: { column: TableCoreColumn; width: number }) {
  payload.column.width = payload.width;
}

function resetBomColumns() {
  bomEntryColumns.value = defaultBomEntryColumns.map((column) => ({ ...column }));
}

function openBomColumnFilter(column: TableCoreColumn, event: MouseEvent) {
  const targetColumn = bomEntryColumns.value.find((item) => item.key === column.key);
  if (targetColumn && targetColumn.key !== "rowNo") {
    openColumnFilter(targetColumn, event);
  }
}

function bomRowAttrs(_line: BomEntryLine, index: number) {
  return { "data-testid": `bom-entry-row-${index + 1}` };
}

function bomCellAttrs(_line: BomEntryLine, column: TableCoreColumn) {
  return {
    class: {
      "entry-row-no-cell": column.key === "rowNo",
      "entry-frozen-cell": column.key === "rowNo"
    }
  };
}

function bomEntryColumnValue(row: unknown, rowIndex: number, key: string) {
  const line = row as BomEntryLine;
  const values: Record<string, string> = {
    rowNo: String(rowIndex + 1),
    materialCode: line.materialCode,
    materialName: line.materialName,
    spec: line.spec,
    unit: line.unit,
    productQty: String(line.productQty ?? ""),
    materialQty: String(line.materialQty ?? ""),
    unitQty: String(line.unitQty ?? ""),
    issueMethod: line.issueMethod,
    issueWarehouseCode: line.issueWarehouseCode,
    fixedLossQty: String(line.fixedLossQty ?? ""),
    lossRate: String(line.lossRate ?? ""),
    childBomCode: line.childBomCode
  };
  return values[key] ?? "";
}

function openMaterialLookup(index: number) {
  activeMaterialLookupIndex.value = index;
  materialLookupCursor.value = 0;
}

function closeMaterialLookupLater() {
  window.setTimeout(() => {
    activeMaterialLookupIndex.value = null;
  }, 120);
}

function handleMaterialInput(line: BomEntryLine, index: number) {
  openMaterialLookup(index);
  applyExactMaterialMatch(line);
  emit("markDirty");
}

function filteredMaterialOptions(keyword: string) {
  const normalized = normalizeLookupText(keyword);
  const options = normalized
    ? props.materialOptions.filter((option) => option.searchText.includes(normalized))
    : props.materialOptions;
  return options.slice(0, 24);
}

function moveMaterialLookup(delta: number) {
  const activeIndex = activeMaterialLookupIndex.value;
  if (activeIndex == null) {
    return;
  }
  const options = filteredMaterialOptions(props.lines[activeIndex]?.materialCode ?? "");
  if (!options.length) {
    materialLookupCursor.value = 0;
    return;
  }
  materialLookupCursor.value = (materialLookupCursor.value + delta + options.length) % options.length;
}

function confirmMaterialLookup(line: BomEntryLine, _index: number) {
  const options = filteredMaterialOptions(line.materialCode);
  const selected = options[materialLookupCursor.value] ?? options[0];
  if (selected) {
    selectLineMaterial(line, selected);
  }
}

function selectLineMaterial(line: BomEntryLine, option: BomMaterialOption) {
  line.materialCode = option.code;
  line.materialName = option.name;
  line.spec = option.spec;
  line.unit = option.unit;
  if (!line.issueWarehouseCode && option.defaultWarehouseCode) {
    line.issueWarehouseCode = option.defaultWarehouseCode;
  }
  activeMaterialLookupIndex.value = null;
  emit("markDirty");
}

function applyExactMaterialMatch(line: BomEntryLine) {
  const normalized = normalizeLookupText(line.materialCode);
  const option = props.materialOptions.find((item) => normalizeLookupText(item.code) === normalized || normalizeLookupText(item.name) === normalized);
  if (option) {
    line.materialName = option.name;
    line.spec = option.spec;
    line.unit = option.unit;
    if (!line.issueWarehouseCode && option.defaultWarehouseCode) {
      line.issueWarehouseCode = option.defaultWarehouseCode;
    }
  }
}

function normalizeLookupText(value: string) {
  return value.trim().toLowerCase();
}

function updateUnitQty(line: BomEntryLine) {
  const productQty = Number(line.productQty) || 0;
  const materialQty = Number(line.materialQty) || 0;
  if (productQty > 0 && materialQty > 0) {
    line.unitQty = Number((materialQty / productQty).toFixed(6));
  }
  emit("markDirty");
}

</script>
