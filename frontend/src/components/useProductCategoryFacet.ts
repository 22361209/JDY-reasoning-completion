import { ref } from "vue";
import { fetchListRows } from "../services/listApi";

export interface ProductCategoryFacet {
  code: string;
  name: string;
}

export function useProductCategoryFacet() {
  const categories = ref<ProductCategoryFacet[]>([]);
  const loadingCategories = ref(false);
  const categoryMessage = ref("");
  let categoryRequestSeq = 0;

  async function loadCategories() {
    const seq = categoryRequestSeq + 1;
    categoryRequestSeq = seq;
    loadingCategories.value = true;
    categoryMessage.value = "";
    const result = await fetchListRows("product-category-list", {
      keyword: "",
      status: "",
      page: 1,
      pageSize: 500,
      columnFilters: {
        auditStatus: { operator: "等于", value: "已审核" },
        status: { operator: "等于", value: "启用" }
      }
    });
    if (seq !== categoryRequestSeq) {
      return;
    }
    loadingCategories.value = false;
    if (!result.ok || !result.data) {
      categories.value = [];
      categoryMessage.value = result.message || "物料类别加载失败。";
      return;
    }
    categories.value = result.data.rows.map((row) => ({
      code: String(row.code ?? ""),
      name: String(row.name ?? "")
    })).filter((category) => category.name);
  }

  return {
    categories,
    loadingCategories,
    categoryMessage,
    loadCategories
  };
}
