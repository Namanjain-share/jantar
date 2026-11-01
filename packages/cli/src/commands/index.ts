/**
 * The command registry. Each command lives in its own file. The order is
 * the help order: everyday commands, then the v0.3 switches and roots the
 * daemon's "turn it on at your Mac" sentences name, then v0.4's Life, Intel
 * (v0.5.3: the alert switches and the MCP server after it) and kept
 * accounts, v0.5's Meetings, v0.5.3's Ask, v0.6's Fleet (fleet, node), then
 * setup. v0.7's post sits right after life: Posts are a Life module.
 */
import type { Command } from '../command.js';
import accounts from './accounts.js';
import ask from './ask.js';
import controls from './controls.js';
import devices from './devices.js';
import doctor from './doctor.js';
import files from './files.js';
import fleet from './fleet.js';
import folders from './folders.js';
import hooks from './hooks.js';
import importCcwV2 from './import-ccw-v2.js';
import init from './init.js';
import install from './install.js';
import intel from './intel.js';
import launch from './launch.js';
import life from './life.js';
import mcp from './mcp.js';
import meetings from './meetings.js';
import newSession from './new.js';
import notify from './notify.js';
import node from './node.js';
import open from './open.js';
import pair from './pair.js';
import post from './post.js';
import remote from './remote.js';
import rewrite from './rewrite.js';
import screenshots from './screenshots.js';
import send from './send.js';
import status from './status.js';
import uninstall from './uninstall.js';
import version from './version.js';

export const COMMANDS: readonly Command[] = [
  status,
  send,
  newSession,
  open,
  pair,
  devices,
  files,
  folders,
  launch,
  rewrite,
  controls,
  screenshots,
  // v0.4
  life,
  // v0.7 (a Life module's own command, after life)
  post,
  intel,
  // v0.5.3
  notify,
  mcp,
  accounts,
  // v0.5
  meetings,
  // v0.5.3
  ask,
  // v0.6
  fleet,
  node,
  remote,
  hooks,
  doctor,
  init,
  install,
  importCcwV2,
  uninstall,
  version,
];
