/**
 * Buttons. Three variants only, and ember is NEVER a fill:
 *
 *   primary  --ink fill, --bg label (the one action that moves things on)
 *   outline  1 px --line-strong, --ink label
 *   text     --ink-2 label, no box
 *
 * Sizes: sm 24, md 32 (default), lg 40 (dock, receipts), xl 48 (phone
 * primary). Every size grows to 44 px under a coarse pointer (rule 28).
 * Press: scale .97 over 120 ms; none with reduced motion.
 */
import clsx from 'clsx';
import type { ButtonHTMLAttributes, Ref } from 'react';

export type ButtonVariant = 'primary' | 'outline' | 'text';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

export const BUTTON_BASE =
  'relative inline-flex items-center justify-center gap-8 whitespace-nowrap rounded-btn font-medium select-none ' +
  'transition duration-120 ease-hover active:not-disabled:scale-97 motion-reduce:active:not-disabled:scale-100 ' +
  'disabled:cursor-default coarse:min-h-44';

export const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-bg hover:not-disabled:bg-ink-2 disabled:bg-line disabled:text-ink-3',
  outline: 'border border-line-strong text-ink hover:not-disabled:bg-hover disabled:border-line disabled:text-ink-3',
  text: 'text-ink-2 hover:not-disabled:text-ink disabled:text-ink-3',
};

export const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-24 text-small',
  md: 'h-32 text-small',
  lg: 'h-40 text-row',
  xl: 'h-48 text-row',
};

/** Side padding per size; a text button has no box, so it keeps 8 px at every size. */
const BUTTON_PAD: Record<ButtonSize, string> = { sm: 'px-8', md: 'px-12', lg: 'px-16', xl: 'px-16' };

export function buttonClass(variant: ButtonVariant = 'outline', size: ButtonSize = 'md', className?: string): string {
  // One padding class only: two would be settled by stylesheet order, not by this code.
  return clsx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], variant === 'text' ? 'px-8' : BUTTON_PAD[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = 'outline', size = 'md', className, type = 'button', ref, ...rest }: ButtonProps) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...rest} />;
}
