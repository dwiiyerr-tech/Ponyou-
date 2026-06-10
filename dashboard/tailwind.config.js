/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        cyber: {
          page:   '#080c08',
          panel:  '#0d120d',
          header: '#111811',
          card:   '#0f150f',
          border: '#1a2e1a',
          bright: '#254025',
        },
        neon: {
          ok:     '#39ff14',
          cyan:   '#00e5ff',
          warn:   '#ffaa00',
          title:  '#e8a000',
          tool:   '#9988ff',
          api:    '#ff77cc',
          trade:  '#ffe066',
          pos:    '#00ff66',
          neg:    '#ff4444',
          blue:   '#4499ff',
        },
      },
      fontFamily: {
        title: ['"VT323"', '"Share Tech Mono"', 'monospace'],
        mono:  ['"Share Tech Mono"', '"JetBrains Mono"', 'monospace'],
      },
      animation: {
        'blink':      'blink 1s step-start infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'slide-in':   'slide-in 0.2s ease-out',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.8' },
          '50%': { opacity: '1' },
        },
        'slide-in': {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to:   { transform: 'translateY(0)',   opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
