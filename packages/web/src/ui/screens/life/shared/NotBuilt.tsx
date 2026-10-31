/**
 * WP0's placeholder page for a Life or Intel screen whose package has not
 * landed yet: its title and one line. Each screen's package replaces the
 * stub that renders it.
 */
export function NotBuilt({ title }: { title: string }) {
  return (
    <div className="px-16 pb-48 pt-16 animate-enter md:px-32 md:pt-24">
      <h1 data-display className="type-display text-ink">
        {title}
      </h1>
      <p className="mt-12 type-small text-ink-2">Not built yet.</p>
    </div>
  );
}
