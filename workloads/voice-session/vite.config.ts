import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    root: "src/ui",
    base: "/voice/",
    plugins: [react()],
    build: {
        outDir: "../../dist/client",
        emptyOutDir: true,
    },
});
