import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "frontend",
  // Files in frontend/public/ are copied to the dist root unchanged, such as /SKILL.md.
  publicDir: "public",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "frontend") } },
  input: {
    upload: resolve(import.meta.dirname, "frontend/index.html"),
    viewer: resolve(import.meta.dirname, "frontend/shell.html"),
    missing: resolve(import.meta.dirname, "frontend/404.html"),
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
