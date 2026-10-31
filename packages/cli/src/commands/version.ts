import { CLI_NAME, PROTOCOL_VERSION } from '@jantar/protocol';
import type { Command } from '../command.js';
import { CLI_VERSION } from '../version.js';

const version: Command = {
  name: 'version',
  summary: 'Print the CLI version and protocol version.',
  usage: 'jantar version',
  owner: 'A',
  async run(_args, ctx) {
    ctx.io.out(`${CLI_NAME} ${CLI_VERSION} (protocol ${PROTOCOL_VERSION})\n`);
    return 0;
  },
};
export default version;
