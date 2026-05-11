import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3939",
        changeOrigin: true
      },
      "/mcp": {
        target: "http://127.0.0.1:3939",
        changeOrigin: true
      }
    }
  }
});
