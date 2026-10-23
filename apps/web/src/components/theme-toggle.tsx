/** Theme toggle — pure Tailwind, no dependencies. */

export function ThemeToggle(): React.JSX.Element {
  return (
    <button
      type="button"
      className="p-2 rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
      onClick={() => {
        const root = window.document.documentElement;
        root.classList.toggle('dark');
        localStorage.setItem('theme', root.classList.contains('dark') ? 'dark' : 'light');
      }}
      aria-label="Toggle theme"
      title="Toggle theme"
    >
      <span className="text-xl">☀️</span>
    </button>
  );
}
