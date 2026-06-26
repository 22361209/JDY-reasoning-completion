import { createApp } from "vue";
import VXETable from "vxe-table";
import App from "./app/App.vue";
import "vxe-table/lib/style.css";
import "./styles/base.css";

VXETable.setup({
  table: {
    fit: false
  }
});

createApp(App).use(VXETable).mount("#app");
