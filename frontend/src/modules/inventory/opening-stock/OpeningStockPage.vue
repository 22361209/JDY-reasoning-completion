<template>
  <section class="role-permission-page settings-page opening-stock-page" data-testid="opening-stock-page">
    <header class="role-permission-head">
      <div>
        <h2>库存期初数</h2>
        <p>按当前账套录入期初库存。保存后同步库存余额，并记录一条期初库存流水。</p>
      </div>
      <div class="role-permission-head__actions">
        <button type="button" data-testid="opening-stock-add-row" @click="addRow">新增行</button>
        <button type="button" data-testid="opening-stock-refresh" @click="loadRows">刷新</button>
        <button class="primary-action" type="button" data-testid="opening-stock-save" @click="saveRows">保存</button>
      </div>
    </header>
    <div class="settings-table opening-stock-table">
      <table>
        <thead>
          <tr>
            <th>物料编码</th>
            <th>物料名称</th>
            <th>规格型号</th>
            <th>单位</th>
            <th>仓库编码</th>
            <th>仓库名称</th>
            <th>期初数量</th>
            <th>单位成本</th>
            <th>期初金额</th>
            <th>备注</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in rows" :key="row.id || index">
            <td>
              <input v-model.trim="row.productCode" :data-testid="`opening-product-code-${index + 1}`" />
            </td>
            <td>{{ row.productName }}</td>
            <td>{{ row.spec }}</td>
            <td>{{ row.unit }}</td>
            <td>
              <input v-model.trim="row.warehouseCode" :data-testid="`opening-warehouse-code-${index + 1}`" />
            </td>
            <td>{{ row.warehouseName }}</td>
            <td>
              <input v-model="row.qty" type="number" min="0" step="0.0001" :data-testid="`opening-qty-${index + 1}`" @input="updateAmount(row)" />
            </td>
            <td>
              <input v-model="row.unitCost" type="number" min="0" step="0.000001" :data-testid="`opening-unit-cost-${index + 1}`" @input="updateAmount(row)" />
            </td>
            <td class="number-cell">{{ row.amount }}</td>
            <td>
              <input v-model.trim="row.remark" :data-testid="`opening-remark-${index + 1}`" />
            </td>
            <td>
              <button type="button" :data-testid="`opening-remove-${index + 1}`" @click="removeRow(index)">删除</button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="11" class="empty-row">暂无期初库存。点击“新增行”录入物料和仓库。</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="message" class="form-message settings-message" data-testid="opening-stock-message">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchOpeningStockRows, saveOpeningStockRows, type OpeningStockRow } from "../../../services/openingStockApi";

const rows = ref<OpeningStockRow[]>([]);
const message = ref("");

onMounted(() => {
  void loadRows();
});

async function loadRows() {
  const result = await fetchOpeningStockRows();
  rows.value = result.rows;
  message.value = result.message;
}

function addRow() {
  rows.value.push({
    productCode: "",
    warehouseCode: "",
    qty: 0,
    unitCost: "",
    amount: "",
    remark: ""
  });
}

function removeRow(index: number) {
  rows.value.splice(index, 1);
}

function updateAmount(row: OpeningStockRow) {
  const qty = Number(row.qty || 0);
  const unitCost = row.unitCost === "" || row.unitCost == null ? NaN : Number(row.unitCost);
  row.amount = Number.isFinite(unitCost) ? (qty * unitCost).toFixed(2) : "";
}

async function saveRows() {
  const result = await saveOpeningStockRows(rows.value);
  if (result.ok) {
    rows.value = result.rows;
  }
  message.value = result.message;
}
</script>
