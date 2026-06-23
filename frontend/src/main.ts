import { createApp } from "vue";
import VXETable from "vxe-table";
import App from "./app/App.vue";
import "./styles/base.css";
import "vxe-table/lib/style.css";

createApp(App).use(VXETable).mount("#app");
