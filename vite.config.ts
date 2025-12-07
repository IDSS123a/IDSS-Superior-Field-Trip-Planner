import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  // Set the third parameter to '' to load all env regardless of the `VITE_` prefix.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    define: {
      // Vital for using process.env in browser
      'process.env.API_KEY': JSON.stringify(env.VITE_API_KEY || env.API_KEY),
      'process.env.VITE_GEMINI_API_KEYS': JSON.stringify(env.VITE_GEMINI_API_KEYS),
      // Polyfill for other process.env checks to prevent crashes
      'process.env': {}
    },
  };
});