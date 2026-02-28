/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/web/**/*.{html,tsx,ts}",
    "./node_modules/@apteva/apteva-kit/dist/**/*.{js,mjs}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
        sans: ['"Inter"', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
