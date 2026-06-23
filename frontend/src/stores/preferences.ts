import { ref } from "vue";

const compactDensity = ref(true);
const showAssistantRail = ref(true);

export function usePreferenceStore() {
  return {
    compactDensity,
    showAssistantRail
  };
}
