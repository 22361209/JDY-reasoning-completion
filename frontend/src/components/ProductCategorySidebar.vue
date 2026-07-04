<template>
  <div class="product-category-sidebar" data-testid="product-category-sidebar">
    <button
      type="button"
      class="product-category-sidebar__item"
      :class="{ active: selectedCategory === '' }"
      data-testid="product-category-all"
      @click="emit('select', '')"
    >
      全部物料
    </button>
    <span class="product-category-sidebar__title">物料类别</span>
    <span v-if="loading" class="product-category-sidebar__empty">类别加载中...</span>
    <button
      v-for="category in categories"
      :key="category.code || category.name"
      type="button"
      class="product-category-sidebar__item"
      :class="{ active: selectedCategory === category.name }"
      :data-testid="`product-category-${category.code || category.name}`"
      @click="emit('select', category.name)"
    >
      <strong>{{ category.name }}</strong>
      <small v-if="category.code">{{ category.code }}</small>
    </button>
    <span v-if="!loading && categories.length === 0" class="product-category-sidebar__empty">
      {{ message || "暂无类别" }}
    </span>
  </div>
</template>

<script setup lang="ts">
import type { ProductCategoryFacet } from "./useProductCategoryFacet";

defineProps<{
  categories: ProductCategoryFacet[];
  selectedCategory: string;
  loading?: boolean;
  message?: string;
}>();

const emit = defineEmits<{
  select: [category: string];
}>();
</script>
