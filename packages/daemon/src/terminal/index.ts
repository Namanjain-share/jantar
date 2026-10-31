/**
 * Terminal I/O (work package D): the Terminal.app backend plus the pure
 * screen helpers every backend shares (input box, dialog detection, menus,
 * foreground classification, tty names).
 */
export * from './terminal-app/index.js';
export * from './screen.js';
export * from './menu.js';
export * from './foreground.js';
export * from './tty.js';
export * from './session-ops.js';
