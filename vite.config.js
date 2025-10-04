import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // increase warning limit to avoid noisy warnings for larger bundles
    chunkSizeWarningLimit: 1200, // in kB
    rollupOptions: {
      output: {
        // Split out large dependencies into separate chunks to keep main bundle smaller
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('node_modules/xlsx') || id.includes('/xlsx/')) return 'xlsx';
            if (id.includes('node_modules/firebase') || id.includes('/firebase/')) return 'firebase';
            if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react-vendors';
            return 'vendor';
          }
        }
      }
    }
  },
})
