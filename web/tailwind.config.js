/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // "ink" is the page, "fg" is the text on it.
        ink: { DEFAULT: '#ffffff', 2: '#ffffff', 3: '#f2f2f2', 4: '#d9d9d9' },
        line: '#dcdcdc',
        fg: { DEFAULT: '#111111', 2: '#444444', 3: '#6b6b6b' },
        accent: { DEFAULT: '#0645ad', dim: '#0b0080' },
        danger: '#c0001a',
        warn: '#8a5300',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: { sm: '0', DEFAULT: '0', md: '0', lg: '0', xl: '0', '2xl': '0' },
    },
  },
  plugins: [],
};
