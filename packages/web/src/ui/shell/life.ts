/**
 * Today's places (v0.4 Life, v0.7 Posts): nested under Today in the touch
 * sidebar (Sidebar.tsx) and Today's strip of them (life/today/Today.tsx).
 * Its own module, so their six icons load with those two lazy chunks and
 * never with the shell.
 */
import { CheckSquareIcon, CoffeeIcon, ForkKnifeIcon, MegaphoneIcon, PillIcon, WalletIcon, type Icon } from '@phosphor-icons/react';
import type { Route } from '../../lib/router.js';

export interface LifeItem {
  route: Route['name'];
  /** The Life module that switches it (life status `modules`). */
  module: 'todos' | 'medicines' | 'food' | 'places' | 'finance' | 'posts';
  href: string;
  label: string;
  icon: Icon;
}

export const LIFE: readonly LifeItem[] = [
  { route: 'todos', module: 'todos', href: '/todos', label: 'Todos', icon: CheckSquareIcon },
  { route: 'meds', module: 'medicines', href: '/meds', label: 'Medicines', icon: PillIcon },
  { route: 'food', module: 'food', href: '/food', label: 'Food', icon: ForkKnifeIcon },
  { route: 'places', module: 'places', href: '/places', label: 'Cafés', icon: CoffeeIcon },
  { route: 'money', module: 'finance', href: '/money', label: 'Finance', icon: WalletIcon },
  { route: 'posts', module: 'posts', href: '/posts', label: 'Posts', icon: MegaphoneIcon },
];
