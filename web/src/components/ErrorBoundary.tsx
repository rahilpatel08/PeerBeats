import { Component, type ReactNode } from 'react';

/** If a page ever breaks, say so and offer a way out, rather than leaving a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <h1 className="text-xl font-semibold">Something went wrong on this page</h1>
        <p className="mt-2 text-sm text-fg-2">Your account and stored music are safe.</p>
        <button onClick={() => window.location.reload()} className="mt-4 px-4 py-2 text-sm font-semibold border border-fg hover:bg-fg hover:text-ink">
          Reload
        </button>
      </div>
    );
  }
}
