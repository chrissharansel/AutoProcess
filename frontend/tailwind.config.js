/** Tailwind is used for layout utilities. Preflight is OFF so the existing hand-written CSS keeps working unchanged. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)', card: 'var(--bg-card)', elevated: 'var(--bg-elevated)', hover: 'var(--bg-hover)', line: 'var(--border)',
        primary: 'var(--primary)', accent: 'var(--accent)', ok: 'var(--success)', warn: 'var(--warning)', bad: 'var(--danger)', muted: 'var(--text-muted)', ink: 'var(--text)',
      },
    },
  },
  plugins: [],
};
