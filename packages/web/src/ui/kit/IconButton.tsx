/** A square icon-only button (28 px, 44 under a coarse pointer). Needs an aria-label. */
import clsx from 'clsx';
import type { ButtonHTMLAttributes, Ref } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label': string;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ className, type = 'button', ref, ...rest }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        'inline-flex size-28 flex-none items-center justify-center rounded-btn text-ink-2 transition duration-120 ease-hover',
        'hover:not-disabled:bg-hover hover:not-disabled:text-ink disabled:cursor-default disabled:opacity-40 coarse:size-44',
        className,
      )}
      {...rest}
    />
  );
}
