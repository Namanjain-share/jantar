/**
 * Unknown path. Copy kept from v0.1: "That page does not exist." A place
 * whose switch is off at the Mac says so instead, with the command that
 * turns it on (`off`, after the CLI's name): a phone can never turn it on.
 */
import { CLI_NAME } from '@jantar/protocol';
import { Button } from '../kit/Button.js';
import { useNavigate } from '../context.js';

export function NotFound({ off }: { off?: string }) {
  const navigate = useNavigate();
  return (
    <section className="px-16 py-24 md:px-32">
      <h1 className="type-title text-ink">{off ? 'That is off on this Mac.' : 'That page does not exist.'}</h1>
      {off ? (
        <p className="mt-8 type-body text-ink-2">
          Turn it on at the Mac: <code className="type-mono">{`${CLI_NAME} ${off}`}</code>
        </p>
      ) : null}
      <Button className="mt-16" onClick={() => navigate('/')}>
        Go to the board
      </Button>
    </section>
  );
}
