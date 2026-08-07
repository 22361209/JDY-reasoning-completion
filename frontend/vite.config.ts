import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [vue()],
    server: {
      host: "127.0.0.1",
      port: Number(env.JDY_WEB_PORT || "5173"),
      strictPort: true,
      proxy: {
        "/api": env.JDY_API_BASE || "http://127.0.0.1:8080"
      }
    }
  };
});
