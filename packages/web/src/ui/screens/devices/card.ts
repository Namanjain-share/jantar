/**
 * Devices in a wide pane (0.11, build plan 2.11): from a pane of 760 the
 * sections sit in two columns and each is a card, as the other wide places'
 * sections are; below that, 0.10's rails and hairline rows. Devices.tsx
 * measures its pane and says which through DeviceCards. Only the Devices
 * screen's own (lazy) parts import this file.
 */
import { createContext, useContext } from 'react';

export const DeviceCards = createContext(false);

/** A section's look: its class and its rail's ground and class (`top`: 0.10's space above the rail). */
export function useDeviceSection(top: string): { section: string | undefined; ground: 'bg' | 'raised'; rail: string } {
  const card = useContext(DeviceCards);
  return card
    ? { section: 'mt-24 rounded-dock border border-line bg-raised px-16 pb-4 first:mt-0', ground: 'raised', rail: 'h-44' }
    : { section: undefined, ground: 'bg', rail: top };
}
