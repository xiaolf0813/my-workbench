import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  appType: "custom",
  plugins: [react()],
  build: {
    cssCodeSplit: false,
  },
});
