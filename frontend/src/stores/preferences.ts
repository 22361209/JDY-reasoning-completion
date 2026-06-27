import { ref } from "vue";

const compactDensity = ref(true);

export function usePreferenceStore() {
  return {
    compactDensity
  };
}
